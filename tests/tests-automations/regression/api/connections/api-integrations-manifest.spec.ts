import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { createConnectionViaApi, uniqueConnectionName } from "../../../../helpers/integrations/create-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

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
   * The `IntegrationListRead` body, sorted. `deployment_context` arrived on
   * `1.13.0.dev26` with upstream #15333 (#2074) — an intended addition, and the
   * reason this stays an EXACT set: the key-set check is what surfaced it.
   */
  const MANIFEST_KEYS = ["deployment_context", "providers"];

  /**
   * `IntegrationListRead.deployment_context`'s declared literal. Narrower than
   * the capability-level `DEPLOYMENT_CONTEXTS` below, which also has `headless`.
   */
  const INSTANCE_DEPLOYMENT_CONTEXTS = ["self_managed", "hosted", "desktop"];

  /**
   * What an instance with `LANGFLOW_CONNECTION_OAUTH_CONTEXT` unset must read —
   * every lane of this repo. The upstream unit test always SETS the variable,
   * so this default is covered nowhere else, and it decides whether the
   * add-connection dialog offers the Slack token method (`offersSlackToken`).
   */
  const EXPECTED_DEPLOYMENT_CONTEXT = "self_managed";

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

  /**
   * `manual_token_profiles` joined the provider row on `1.14.0.dev4` with upstream
   * #15947 (#2336): the api_key auth profiles whose credential the provider itself
   * validates. Intended, and surfaced by the exact set as the two keys above were.
   * The 1.13 line never gets it, so the set is chosen by the served version
   * (`servedVersionAtLeast`), and the RC runs of 1.13.x keep the old set.
   */
  const MANUAL_TOKEN_PROFILES_SINCE = "1.14.0.dev4";
  /** `ManualTokenProfileRead`, measured in the `1.14.0.dev4` wheel. */
  const MANUAL_TOKEN_PROFILE_KEYS = ["id", "identity", "required_scopes", "requires_expiry"];
  /**
   * Providers whose `manual_token_profiles` is always `[]`. A profile is listed
   * only for a provider that `services/triggers/providers/registry.py` loads from
   * the `langflow.trigger_providers` entry points, and that registry refuses these
   * built-in ids (`_BUILTINS`); no lane installs such an entry point. So the
   * value is pinned here, and a built-in that starts listing a profile surfaces as
   * a change of contract, like a new key would.
   */
  const BUILTIN_TRIGGER_PROVIDERS = ["google", "microsoft", "slack"];

  /**
   * The 15 fields of `IntegrationCapabilityRead`, same reasoning. `required_scopes`
   * and `conditional_scopes` arrived on `1.13.0.dev47` with upstream #15810 (#2310)
   * — intended, and surfaced by this exact set, as `deployment_context` was.
   */
  const CAPABILITY_KEYS = [
    "allowed",
    "auth_profile_id",
    "blocked_policy_key",
    "component_ref",
    "conditional_scopes",
    "deployment_contexts",
    "display_name",
    "id",
    "identity",
    "maturity",
    "mcp_tool",
    "policy_keys",
    "required_scopes",
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

  // `ConditionalScopeRequirement` and its `ScopeCondition`, both `extra="forbid"`
  // upstream, so their key sets are asserted exactly too. Declared domains again:
  // only `optional` and `input_truthy` are in use on 1.13.0.dev47.
  const CONDITIONAL_SCOPE_KEYS = ["condition", "role", "scope"];
  const SCOPE_CONDITION_KEYS = ["input", "kind"];
  const SCOPE_ROLES = ["optional", "alternative"];
  const SCOPE_CONDITION_KINDS = ["input_present", "input_truthy"];
  /** `ScopeCondition.input`: the component input whose value switches the scope on. */
  const SCOPE_CONDITION_INPUT = /^[a-z][a-z0-9_]*$/;

  /** `PROVIDER_ID_PATTERN` and the capability/profile id patterns upstream declares. */
  const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
  const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]*$/;
  const AUTH_PROFILE_ID = /^[a-z0-9][a-z0-9_-]*$/;

  /** `_ALLOWED_KEY_CHARACTERS` after case-folding, and the `integrations.` prefix. */
  const POLICY_KEY_CHARACTERS = /^[a-z0-9._-]+$/;
  const POLICY_KEY_PREFIX = "integrations.";
  const POLICY_KEY_MIN_SEGMENTS = 3;

  // This file's provider and its control. Test 3 reads them as a throwaway owner of
  // its own (#2317): a superuser's connection_count holds EVERY user's rows, so
  // #2306's slack row (another user's) moved the control. A non-superuser counts
  // only its own rows plus instance rows, and no spec seeds an instance row for
  // either provider — instance seeds are all `google`, which is never read here.
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
    required_scopes: string[];
    conditional_scopes: ConditionalScope[];
  }

  interface ConditionalScope {
    scope: string;
    role: string;
    condition: { kind: string; input: string };
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
    /** From `1.14.0.dev4` only (`MANUAL_TOKEN_PROFILES_SINCE`). */
    manual_token_profiles?: Array<{
      id: string;
      identity: string;
      required_scopes: string[];
      requires_expiry: boolean;
    }>;
  }

  interface EffectivePolicy {
    approved_provider_ids: string[];
    blocked_action_keys: string[];
    loaded_provider_ids: string[];
    unrestricted: boolean;
    managed_externally: boolean;
    policy_revision: number | null;
  }

  // Test 3's owner. Only test 3 writes; deleting the owner takes any row it still
  // owns with it, including one a lost response left behind.
  let owner: ConnectionsOwner | undefined;

  test.afterEach(async () => {
    const current = owner;
    owner = undefined;
    await current?.dispose();
  });

  async function readManifestBody(
    request: APIRequestContext,
    headers: Record<string, string>,
  ): Promise<{ providers: Provider[]; deploymentContext: string }> {
    const res = await request.get(MANIFEST, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort(), `${MANIFEST} carries exactly the IntegrationListRead keys`).toEqual(
      MANIFEST_KEYS,
    );
    expect(
      INSTANCE_DEPLOYMENT_CONTEXTS,
      `${MANIFEST} deployment_context "${body.deployment_context}" is a declared instance context`,
    ).toContain(body.deployment_context);
    expect(Array.isArray(body.providers), `${MANIFEST} returns providers as a list`).toBe(true);
    // The floor, not a count: every assertion below runs inside a loop, so an
    // empty manifest would pass all of them having checked nothing (#1092).
    expect(body.providers.length, `${MANIFEST} lists at least one provider`).toBeGreaterThan(0);
    return { providers: body.providers as Provider[], deploymentContext: body.deployment_context as string };
  }

  async function readManifest(request: APIRequestContext, headers: Record<string, string>): Promise<Provider[]> {
    return (await readManifestBody(request, headers)).providers;
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
      const withManualTokens = await servedVersionAtLeast(request, MANUAL_TOKEN_PROFILES_SINCE);
      const providerKeys = withManualTokens ? [...PROVIDER_KEYS, "manual_token_profiles"].sort() : PROVIDER_KEYS;

      await test.step("the provider list is sorted, unique and carries the IntegrationProviderRead shape", async () => {
        const ids = providers.map((provider) => provider.provider_id);
        expect(ids, "providers come back sorted by provider_id").toEqual([...ids].sort());
        expect(new Set(ids).size, "provider ids are unique").toBe(ids.length);

        for (const provider of providers) {
          const id = provider.provider_id;
          expect(id, `provider id "${id}" matches PROVIDER_ID_PATTERN`).toMatch(PROVIDER_ID);
          expect(Object.keys(provider).sort(), `${id} carries exactly the IntegrationProviderRead keys`).toEqual(
            providerKeys,
          );
          if (withManualTokens) {
            expect(Array.isArray(provider.manual_token_profiles), `${id} manual_token_profiles is a list`).toBe(true);
            if (BUILTIN_TRIGGER_PROVIDERS.includes(id)) {
              expect(provider.manual_token_profiles, `${id} is built in, so it lists no manual token profile`).toEqual(
                [],
              );
            }
          }
          // Live only for a provider installed through the entry points (none on any
          // lane today), and kept so such a provider is checked the day one appears.
          for (const profile of provider.manual_token_profiles ?? []) {
            const at = `${id} manual token profile "${profile.id}"`;
            expect(Object.keys(profile).sort(), `${at} carries exactly the ManualTokenProfileRead keys`).toEqual(
              MANUAL_TOKEN_PROFILE_KEYS,
            );
            expect(profile.id, `${at} id matches the auth profile id pattern`).toMatch(AUTH_PROFILE_ID);
            expect(IDENTITIES, `${at} identity "${profile.identity}" is a declared identity`).toContain(
              profile.identity,
            );
            expect(Array.isArray(profile.required_scopes), `${at} required_scopes is a list`).toBe(true);
            expect(typeof profile.requires_expiry, `${at} requires_expiry is a boolean`).toBe("boolean");
          }
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

      await test.step("every capability carries the 15 fields, with each enum inside its declared domain", async () => {
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

      await test.step("every capability declares its scopes in the declared shape", async () => {
        // Upstream defaults both lists to empty, so neither is asserted non-empty per
        // capability (measured: all 30 carry a required scope, 4 a conditional one).
        // The floors below only keep the loops from passing having checked nothing.
        let withRequiredScope = 0;
        let conditionalChecked = 0;
        for (const provider of providers) {
          for (const capability of provider.capabilities) {
            const at = `${provider.provider_id} / ${capability.id}`;
            const required = capability.required_scopes;
            expect(Array.isArray(required), `${at} required_scopes is a list`).toBe(true);
            for (const scope of required) {
              expect(typeof scope, `${at} required scope ${JSON.stringify(scope)} is a string`).toBe("string");
              expect(scope.trim(), `${at} required scope is not blank`).not.toBe("");
            }
            expect(new Set(required).size, `${at} required_scopes has no duplicate`).toBe(required.length);
            withRequiredScope += Number(required.length > 0);

            expect(Array.isArray(capability.conditional_scopes), `${at} conditional_scopes is a list`).toBe(true);
            for (const entry of capability.conditional_scopes) {
              const where = `${at} conditional scope ${JSON.stringify(entry)}`;
              expect(Object.keys(entry).sort(), `${where} carries exactly the ConditionalScopeRequirement keys`).toEqual(
                CONDITIONAL_SCOPE_KEYS,
              );
              expect(typeof entry.scope, `${where}: scope is a string`).toBe("string");
              expect(entry.scope.trim(), `${where}: scope is not blank`).not.toBe("");
              expect(SCOPE_ROLES, `${where}: role is a declared role`).toContain(entry.role);
              expect(Object.keys(entry.condition).sort(), `${where}: condition carries exactly the ScopeCondition keys`).toEqual(
                SCOPE_CONDITION_KEYS,
              );
              expect(SCOPE_CONDITION_KINDS, `${where}: condition kind is a declared kind`).toContain(entry.condition.kind);
              expect(entry.condition.input, `${where}: condition input names a component input`).toMatch(
                SCOPE_CONDITION_INPUT,
              );
              conditionalChecked += 1;
            }
          }
        }
        expect(withRequiredScope, "at least one capability declares a required scope").toBeGreaterThan(0);
        expect(conditionalChecked, "at least one conditional scope was checked").toBeGreaterThan(0);
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
    async ({ playwright, request, apiCoverage }, testInfo) => {
      apiCoverage.declare([
        `GET ${MANIFEST}`,
        "POST /api/v1/connections",
        "DELETE /api/v1/connections/{connection_id}",
      ]);
      // Seeded AND read as this owner, on the test's own `request` so apiCoverage
      // records every call. What it reads holds its own rows and instance rows, never
      // another user's — so no other spec's row can move the control.
      owner = await createConnectionsOwner(
        () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
        "manifest",
      );
      const headers = owner.headers;
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
      const { providers, deploymentContext } = await readManifestBody(request, headers);

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

      await test.step("the instance names the default deployment context those lists are compared against", async () => {
        // Not a skip, like test 4's `unrestricted`: no lane sets
        // LANGFLOW_CONNECTION_OAUTH_CONTEXT, so anything else is a configuration
        // change or a broken default. The server applies no context filter
        // (measured on dev26 under `hosted`), so no per-capability claim is made.
        expect(
          deploymentContext,
          `${MANIFEST} reports the ${EXPECTED_DEPLOYMENT_CONTEXT} context an unconfigured instance defaults to`,
        ).toBe(EXPECTED_DEPLOYMENT_CONTEXT);
      });
    },
  );
});
