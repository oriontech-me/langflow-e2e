import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type ConnectionRead,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";

// The capability manifest (GET /api/v1/integrations), the operator ceiling
// (GET /api/v1/integrations/policy/effective), and the cross-check between the
// manifest and the component catalog (GET /api/v1/all).
// Spec doc: docs/api/connections/api-integrations-manifest.md
//
// The cross-check is why this file exists: the manifest's component_ref is a
// promise that a component exists, the catalog answers independently, and NO
// upstream test crosses the two. A component renamed on one side is a node a
// user can place and cannot resolve.
test.describe("Integrations API — capability manifest and effective policy", () => {
  const MANIFEST = "/api/v1/integrations";
  const POLICY = "/api/v1/integrations/policy/effective";
  const CATALOG = "/api/v1/all";

  /**
   * The provider row as `IntegrationProviderRead` declares it, measured on
   * `1.13.0.dev21` and identical on `dev19`. Asserted as the EXACT set: a
   * per-field `toHaveProperty` would pass a row that grew a key, and this
   * endpoint sits next to the connection store whose whole promise is that no
   * credential material reaches a client.
   */
  const PROVIDER_KEYS = [
    "approved",
    "capabilities",
    "connection_count",
    "display_name",
    "docs_url",
    "enabled",
    "icon",
    "provider_id",
  ];

  /** The 13 fields of `IntegrationCapabilityRead`, same reasoning. */
  const CAPABILITY_KEYS = [
    "allowed",
    "auth_profile_id",
    "blocked_policy_key",
    "component_ref",
    "deployment_contexts",
    "display_name",
    "id",
    "identity",
    "maturity",
    "mcp_tool",
    "policy_keys",
    "risk",
    "substrate",
  ];

  /** The 6 fields of `EffectiveIntegrationPolicyRead`. */
  const POLICY_KEYS = [
    "approved_provider_ids",
    "blocked_action_keys",
    "loaded_provider_ids",
    "managed_externally",
    "policy_revision",
    "unrestricted",
  ];

  // The DECLARED domains (lfx/integrations/capabilities.py), never the measured
  // ones. Only `read`/`write`, `sdk`/`rest`, `user_delegated`/`bot` and `ga` are
  // in use on 1.13, so asserting what is shipped would redden this file the day
  // INT-10..12 lands a `destructive` or `mcp` capability — the same mistake as
  // asserting the counts, which the owning issue rules out for the same reason.
  const RISKS = ["read", "write", "destructive"];
  const IDENTITIES = ["user_delegated", "bot", "service"];
  const SUBSTRATES = ["sdk", "rest", "mcp"];
  const MATURITIES = ["ga", "preview", "developer_preview", "beta", "deprecated"];
  const DEPLOYMENT_CONTEXTS = ["hosted", "self_managed", "desktop", "headless"];

  /** `PROVIDER_ID_PATTERN` and the capability/profile id patterns upstream declares. */
  const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
  const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]*$/;
  const AUTH_PROFILE_ID = /^[a-z0-9][a-z0-9_-]*$/;

  /** `_ALLOWED_KEY_CHARACTERS` after case-folding, and the `integrations.` prefix. */
  const POLICY_KEY_CHARACTERS = /^[a-z0-9._-]+$/;
  const POLICY_KEY_PREFIX = "integrations.";
  const POLICY_KEY_MIN_SEGMENTS = 3;

  // This file's provider and its control. Every other spin in the batch seeds
  // `google` (the helper's default), so google's connection_count is contended
  // between workers and is never read here. `slack` is touched by nothing, which
  // is what lets test 3 prove the derivation is per provider and not a global flag.
  const SUBJECT_PROVIDER = "microsoft";
  const CONTROL_PROVIDER = "slack";

  /**
   * `component_display_names` is a metadata map keyed by the LOWERCASED type
   * name, not a category — its entries read `ext:google:gmailsendcomponent@official`.
   * Indexing it would let the cross-check pass on a component the canvas cannot
   * place, which is the one thing this test exists to catch.
   */
  const CATALOG_METADATA_KEY = "component_display_names";

  interface Capability {
    id: string;
    display_name: string;
    policy_keys: string[];
    risk: string;
    maturity: string;
    substrate: string;
    identity: string;
    auth_profile_id: string;
    deployment_contexts: string[];
    component_ref: string | null;
    mcp_tool: string | null;
    allowed: boolean;
    blocked_policy_key: string | null;
  }

  interface Provider {
    provider_id: string;
    display_name: string;
    icon: string | null;
    docs_url: string | null;
    approved: boolean;
    enabled: boolean;
    connection_count: number;
    capabilities: Capability[];
  }

  interface EffectivePolicy {
    approved_provider_ids: string[];
    blocked_action_keys: string[];
    loaded_provider_ids: string[];
    unrestricted: boolean;
    managed_externally: boolean;
    policy_revision: number | null;
  }

  // Markers registered BEFORE the write that carries them, so teardown can find a
  // row a lost response left behind. Only test 3 writes.
  const sent: string[] = [];

  test.afterEach(async ({ request }) => {
    const markers = sent.splice(0);
    if (markers.length === 0) return;
    const headers = { Authorization: await getAuthToken(request) };
    const res = await request.get("/api/v1/connections", { headers });
    if (!res.ok()) {
      console.warn(`⚠️ Connection sweep could not list (${res.status()}) — markers left: ${markers.join(", ")}`);
      return;
    }
    const rows = (await res.json()) as ConnectionRead[];
    // One list read, then a DELETE only for rows still present: a DELETE that
    // answers 404 is still charged to the per-user write bucket.
    const mine = rows.filter((row) => markers.some((marker) => row.display_name.includes(marker)));
    for (const row of mine) {
      await deleteConnection(request, row.id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan connection left behind (${row.name}): ${error}`);
      });
    }
  });

  async function readManifest(
    request: APIRequestContext,
    headers: Record<string, string>,
  ): Promise<Provider[]> {
    const res = await request.get(MANIFEST, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body), `${MANIFEST} answers a single "providers" key`).toEqual(["providers"]);
    expect(Array.isArray(body.providers), `${MANIFEST} returns providers as a list`).toBe(true);
    // The floor, not a count: every assertion below runs inside a loop, so an
    // empty manifest would pass all of them having checked nothing (#1092).
    expect(body.providers.length, `${MANIFEST} lists at least one provider`).toBeGreaterThan(0);
    return body.providers as Provider[];
  }

  /**
   * `enabled = approved and connection_count > 0` — the derivation, straight out
   * of `list_integrations`. Race-proof, so it is asserted on every row of every
   * read rather than only where the round trip looks at it.
   */
  function expectDerivedEnabled(providers: Provider[], when: string): void {
    for (const provider of providers) {
      expect(
        provider.enabled,
        `${when}: ${provider.provider_id} enabled must be approved && connection_count > 0 ` +
          `(approved=${provider.approved}, connection_count=${provider.connection_count})`,
      ).toBe(provider.approved && provider.connection_count > 0);
    }
  }

  function providerRow(providers: Provider[], providerId: string): Provider {
    const row = providers.find((provider) => provider.provider_id === providerId);
    expect(row, `${MANIFEST} lists the ${providerId} provider`).toBeDefined();
    return row as Provider;
  }

  /** The capability's promised component identity, as a saved flow spells it. */
  function namespacedId(providerId: string, componentRef: string): string {
    return `ext:${providerId}:${componentRef}@official`;
  }

  test(
    "every provider row and every capability declares its full field set, with each enum-valued field inside its declared domain",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${MANIFEST}`]);
      const headers = { Authorization: await getAuthToken(request) };
      const providers = await readManifest(request, headers);

      await test.step("the provider list is sorted, unique and carries the IntegrationProviderRead shape", async () => {
        const ids = providers.map((provider) => provider.provider_id);
        expect(ids, "providers come back sorted by provider_id").toEqual([...ids].sort());
        expect(new Set(ids).size, "provider ids are unique").toBe(ids.length);

        for (const provider of providers) {
          const id = provider.provider_id;
          expect(id, `provider id "${id}" matches PROVIDER_ID_PATTERN`).toMatch(PROVIDER_ID);
          expect(Object.keys(provider).sort(), `${id} carries exactly the IntegrationProviderRead keys`).toEqual(
            PROVIDER_KEYS,
          );
          expect(provider.display_name, `${id} has a display name`).not.toBe("");
          expect(Number.isInteger(provider.connection_count), `${id} connection_count is an integer`).toBe(true);
          expect(provider.connection_count, `${id} connection_count is not negative`).toBeGreaterThanOrEqual(0);
          // A provider outside the ceiling is OMITTED from the default listing,
          // so a false here means the omission itself broke — not a policy change.
          expect(provider.approved, `${id} is listed, so it must be approved`).toBe(true);
          expect(provider.capabilities.length, `${id} advertises at least one capability`).toBeGreaterThan(0);
        }
        expectDerivedEnabled(providers, "the manifest as listed");
      });

      await test.step("every capability carries the 13 fields, with each enum inside its declared domain", async () => {
        for (const provider of providers) {
          const capabilityIds = provider.capabilities.map((capability) => capability.id);
          expect(new Set(capabilityIds).size, `${provider.provider_id} capability ids are unique`).toBe(
            capabilityIds.length,
          );

          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            expect(Object.keys(capability).sort(), `${at} carries exactly the IntegrationCapabilityRead keys`).toEqual(
              CAPABILITY_KEYS,
            );
            expect(capability.id, `${at} id matches the capability id pattern`).toMatch(CAPABILITY_ID);
            expect(capability.id.startsWith(`${provider.provider_id}.`), `${at} id is inside its provider namespace`).toBe(
              true,
            );
            expect(capability.display_name, `${at} has a display name`).not.toBe("");
            expect(capability.auth_profile_id, `${at} auth_profile_id matches its pattern`).toMatch(AUTH_PROFILE_ID);
            expect(RISKS, `${at} risk "${capability.risk}" is a declared risk`).toContain(capability.risk);
            expect(IDENTITIES, `${at} identity "${capability.identity}" is a declared identity`).toContain(
              capability.identity,
            );
            expect(SUBSTRATES, `${at} substrate "${capability.substrate}" is a declared substrate`).toContain(
              capability.substrate,
            );
            expect(MATURITIES, `${at} maturity "${capability.maturity}" is a declared maturity`).toContain(
              capability.maturity,
            );
          }
        }
      });

      await test.step("every capability names an execution target, and an MCP one names its tool", async () => {
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            const target = capability.component_ref ?? capability.mcp_tool;
            // Upstream refuses to build a capability with neither. Asserted here
            // because a null component_ref is what would make the cross-check in
            // the next test silently check nothing.
            expect(target, `${at} declares a component_ref or an mcp_tool`).toBeTruthy();
            if (capability.component_ref !== null) {
              expect(typeof capability.component_ref, `${at} component_ref is a string`).toBe("string");
              expect(capability.component_ref, `${at} component_ref is not blank`).not.toBe("");
            }
            if (capability.substrate === "mcp") {
              expect(capability.mcp_tool, `${at} runs on MCP, so it must pin its tool`).toBeTruthy();
            }
          }
        }
      });

      await test.step("capabilities sharing an auth profile declare the same identity", async () => {
        // The observable half of upstream's profile-identity check, and what makes
        // the slack.bot / slack.user split (bot against user_delegated) asserted
        // without hardcoding that slack ships both.
        const identityByProfile = new Map<string, { identity: string; declaredBy: string }>();
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            const key = `${provider.provider_id}:${capability.auth_profile_id}`;
            const seen = identityByProfile.get(key);
            if (seen === undefined) {
              identityByProfile.set(key, { identity: capability.identity, declaredBy: capability.id });
              continue;
            }
            expect(
              capability.identity,
              `${capability.id} declares identity "${capability.identity}" on auth profile ` +
                `"${capability.auth_profile_id}", which ${seen.declaredBy} declares as "${seen.identity}"`,
            ).toBe(seen.identity);
          }
        }
        expect(identityByProfile.size, "at least one auth profile was checked").toBeGreaterThan(0);
      });
    },
  );

  test(
    "every capability's component_ref resolves to a catalog entry that identifies itself by the same namespaced id",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${MANIFEST}`, `GET ${CATALOG}`]);
      const headers = { Authorization: await getAuthToken(request) };
      const providers = await readManifest(request, headers);

      const catalogEntry = new Map<string, { category: string; entry: Record<string, unknown> }>();
      const categories: string[] = [];

      await test.step("index the component catalog over its real categories", async () => {
        const res = await request.get(CATALOG, { headers });
        expect(res.status(), await res.text()).toBe(200);
        const catalog = (await res.json()) as Record<string, unknown>;
        for (const [category, value] of Object.entries(catalog)) {
          if (category === CATALOG_METADATA_KEY) continue;
          if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
          categories.push(category);
          for (const [type, entry] of Object.entries(value as Record<string, unknown>)) {
            if (catalogEntry.has(type)) continue;
            catalogEntry.set(type, { category, entry: entry as Record<string, unknown> });
          }
        }
        expect(categories.length, `${CATALOG} carries at least one category`).toBeGreaterThan(0);
        expect(catalogEntry.size, `${CATALOG} carries at least one component type`).toBeGreaterThan(0);
      });

      let crossChecked = 0;
      let declaringComponentRef = 0;

      await test.step("each capability's promised component is in the catalog under its own namespaced id", async () => {
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            if (capability.component_ref === null) continue;
            declaringComponentRef += 1;
            const expected = namespacedId(provider.provider_id, capability.component_ref);
            const found = catalogEntry.get(expected);
            expect(
              found,
              `capability ${capability.id} promises component "${capability.component_ref}", so ` +
                `${CATALOG} must carry "${expected}" — searched ${categories.length} categories ` +
                `(${categories.sort().join(", ")})`,
            ).toBeDefined();
            const { category, entry } = found as { category: string; entry: Record<string, unknown> };
            // Present under the key is not enough: the entry must identify ITSELF
            // by that id, or a catalog built off a stale mapping still passes.
            expect(
              entry.namespaced_id,
              `the ${category} catalog entry reached through "${expected}" (capability ${capability.id}) ` +
                `must carry that same namespaced_id`,
            ).toBe(expected);
            crossChecked += 1;
          }
        }
      });

      await test.step("the cross-check was not vacuous", async () => {
        // component_ref is nullable upstream, so a loop that skipped every null
        // would pass having asserted nothing — the silence this file exists to end.
        expect(declaringComponentRef, "at least one capability declares a component_ref").toBeGreaterThan(0);
        expect(crossChecked, "every capability that declares a component_ref was cross-checked").toBe(
          declaringComponentRef,
        );
      });
    },
  );

  test(
    "a provider's enabled flag and connection count are derived from its connections, and only its own",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `GET ${MANIFEST}`,
        "POST /api/v1/connections",
        "DELETE /api/v1/connections/{connection_id}",
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const marker = uniqueConnectionName("manifest_derived");
      let baselineCount = 0;
      let control: { approved: boolean; enabled: boolean; connection_count: number } | undefined;

      await test.step(`read the baseline for ${SUBJECT_PROVIDER} and the untouched ${CONTROL_PROVIDER} control`, async () => {
        const providers = await readManifest(request, headers);
        expectDerivedEnabled(providers, "before the connection exists");
        baselineCount = providerRow(providers, SUBJECT_PROVIDER).connection_count;
        const controlRow = providerRow(providers, CONTROL_PROVIDER);
        control = {
          approved: controlRow.approved,
          enabled: controlRow.enabled,
          connection_count: controlRow.connection_count,
        };
      });

      // Registered BEFORE the write, so teardown finds the row even if the
      // response is lost. The helper generates the name; the marker travels in
      // the display name, which is what the sweep matches on.
      sent.push(marker);
      const created = await createConnectionViaApi(request, headers, {
        label: "manifest_derived",
        providerKey: SUBJECT_PROVIDER,
        displayName: `E2E ${marker}`,
      });

      await test.step(`one connection raises ${SUBJECT_PROVIDER} and leaves ${CONTROL_PROVIDER} alone`, async () => {
        const providers = await readManifest(request, headers);
        expectDerivedEnabled(providers, "while the connection exists");
        const subject = providerRow(providers, SUBJECT_PROVIDER);
        expect(subject.connection_count, `${SUBJECT_PROVIDER} counts the connection just created`).toBe(
          baselineCount + 1,
        );
        expect(subject.enabled, `${SUBJECT_PROVIDER} is enabled while it holds a connection`).toBe(true);
        const controlRow = providerRow(providers, CONTROL_PROVIDER);
        expect(
          {
            approved: controlRow.approved,
            enabled: controlRow.enabled,
            connection_count: controlRow.connection_count,
          },
          `${CONTROL_PROVIDER} is untouched by a ${SUBJECT_PROVIDER} connection`,
        ).toEqual(control);
      });

      // The status is deliberately not the assertion: a write's 2xx precedes the
      // commit, and a DELETE's does not prove removal (#1759/#1777/#1807). The
      // manifest re-read below is the proof. The helper throws on anything that
      // is not 2xx or 404, so a failed delete still fails the test.
      await created.deleteConnection();

      await test.step(`deleting it puts ${SUBJECT_PROVIDER} back, with ${CONTROL_PROVIDER} still untouched`, async () => {
        const providers = await readManifest(request, headers);
        expectDerivedEnabled(providers, "after the connection is deleted");
        const subject = providerRow(providers, SUBJECT_PROVIDER);
        expect(subject.connection_count, `${SUBJECT_PROVIDER} is back to its baseline count`).toBe(baselineCount);
        expect(subject.enabled, `${SUBJECT_PROVIDER} enabled follows its own baseline count`).toBe(baselineCount > 0);
        const controlRow = providerRow(providers, CONTROL_PROVIDER);
        expect(
          {
            approved: controlRow.approved,
            enabled: controlRow.enabled,
            connection_count: controlRow.connection_count,
          },
          `${CONTROL_PROVIDER} is still untouched after the delete`,
        ).toEqual(control);
      });
    },
  );

  test(
    "the manifest and the effective policy agree that the instance is unrestricted",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${MANIFEST}`, `GET ${POLICY}`]);
      const headers = { Authorization: await getAuthToken(request) };
      let policy: EffectivePolicy | undefined;

      await test.step("the effective policy reports no ceiling and no deny-list", async () => {
        const res = await request.get(POLICY, { headers });
        expect(res.status(), await res.text()).toBe(200);
        policy = (await res.json()) as EffectivePolicy;
        expect(Object.keys(policy).sort(), `${POLICY} carries exactly the EffectiveIntegrationPolicyRead keys`).toEqual(
          POLICY_KEYS,
        );
        // Not a skip: integration policy is instance-global, so a ceiling
        // appearing here is a configuration change this file should surface.
        expect(policy.unrestricted, `${POLICY} reports an unrestricted instance`).toBe(true);
        expect(policy.blocked_action_keys, `${POLICY} carries no action deny-list`).toEqual([]);
        expect(policy.managed_externally, `${POLICY} has no externally managed ceiling`).toBe(false);
        expect(
          policy.policy_revision === null || Number.isInteger(policy.policy_revision),
          `${POLICY} policy_revision is an integer or null (got ${policy.policy_revision})`,
        ).toBe(true);
        expect(policy.approved_provider_ids.length, `${POLICY} approves at least one provider`).toBeGreaterThan(0);
        expect(policy.approved_provider_ids, `${POLICY} approved_provider_ids come back sorted`).toEqual(
          [...policy.approved_provider_ids].sort(),
        );
        // What `unrestricted` MEANS, asserted rather than trusted.
        expect(
          policy.approved_provider_ids,
          "an unrestricted instance approves every loaded provider",
        ).toEqual(policy.loaded_provider_ids);
      });

      await test.step("the manifest advertises the approved set and nothing else", async () => {
        const providers = await readManifest(request, headers);
        expect(
          providers.map((provider) => provider.provider_id),
          `${MANIFEST} lists exactly the providers ${POLICY} approves`,
        ).toEqual((policy as EffectivePolicy).approved_provider_ids);
      });

      await test.step("every capability agrees it is allowed", async () => {
        const providers = await readManifest(request, headers);
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            expect(capability.allowed, `${at} is allowed while the instance is unrestricted`).toBe(true);
            expect(capability.blocked_policy_key, `${at} names no blocking policy key`).toBeNull();
          }
        }
      });
    },
  );

  test(
    "every capability is governable — its policy keys use the grammar for its own provider, and its deployment contexts are declared",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${MANIFEST}`]);
      const headers = { Authorization: await getAuthToken(request) };
      const providers = await readManifest(request, headers);

      await test.step("every policy key parses as integrations.<provider_id>.<action>", async () => {
        for (const provider of providers) {
          const prefix = `${POLICY_KEY_PREFIX}${provider.provider_id}.`;
          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            expect(capability.policy_keys.length, `${at} declares at least one policy key`).toBeGreaterThan(0);
            expect(new Set(capability.policy_keys).size, `${at} policy keys are unique`).toBe(
              capability.policy_keys.length,
            );
            for (const key of capability.policy_keys) {
              // The grammar case-folds, so the comparison does too. A key outside
              // it is a manifest bug: governance blocks on these, so an operator
              // could never block that action.
              const normalized = key.trim().toLowerCase();
              expect(normalized, `${at} policy key "${key}" uses lowercase identifier syntax`).toMatch(
                POLICY_KEY_CHARACTERS,
              );
              expect(
                normalized.startsWith(prefix),
                `${at} policy key "${key}" must sit inside its own provider namespace "${prefix}"`,
              ).toBe(true);
              const segments = normalized.split(".");
              expect(
                segments.length,
                `${at} policy key "${key}" needs at least ${POLICY_KEY_MIN_SEGMENTS} segments`,
              ).toBeGreaterThanOrEqual(POLICY_KEY_MIN_SEGMENTS);
              expect(
                segments.every((segment) => segment.length > 0),
                `${at} policy key "${key}" has no empty segment`,
              ).toBe(true);
            }
          }
        }
      });

      await test.step("every capability declares where it may run", async () => {
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            const contexts = capability.deployment_contexts;
            expect(contexts.length, `${at} declares at least one deployment context`).toBeGreaterThan(0);
            expect(new Set(contexts).size, `${at} deployment contexts are unique`).toBe(contexts.length);
            for (const context of contexts) {
              expect(DEPLOYMENT_CONTEXTS, `${at} deployment context "${context}" is a declared one`).toContain(context);
            }
          }
        }
      });
    },
  );
});
