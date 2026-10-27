import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { createApiKey, deleteApiKey } from "../../../helpers/auth/create-api-key";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  buildBundleWrite,
  bundleSets,
  describeBundleSets,
  isBundlePristine,
  type PolicyBundleResponse,
  type PolicyBundleSets,
  readPolicyBundle,
  restorePolicyBundle,
  sameBundleSets,
} from "../../../helpers/governance/policy-state";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../helpers/integrations/create-connection";

// Integration policy (blocked actions, provider ceiling) enforced at discovery,
// mutation and execution. Spec doc: docs/governance/integration-policy-enforcement.md
//
// @destructive: the policy bundle is instance-global, so a blocked action is
// blocked for every worker sharing the Langflow. Serial, and every test that
// writes the bundle puts it back in `finally`; `afterAll` checks the result.
//
// Connections, the flow and the API key belong to a throwaway non-superuser
// (#2295): its connection-write and /health buckets are its own, and it is the
// non-operator test 5 needs. Only the bundle itself is written as the superuser.
test.describe.configure({ mode: "serial" });

const ACTION_KEY = "integrations.google.gmail.send";
const CAPABILITY_ID = "google.gmail.send";
const COMPONENT_KEY = "ext:google:GmailSendComponent@official";
/** Another Google component, which a block on Gmail Send must leave alone. */
const CONTROL_COMPONENT_KEY = "ext:google:GoogleDriveListComponent@official";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** #2301's fake registrations, which every lane carries. */
const GOOGLE_REGISTRATION = "e2e-google";
const MICROSOFT_REGISTRATION = "e2e-microsoft";
const REASON = "e2e #2299 integration policy enforcement";

// Exact copy, measured on 1.13.0.dev47.
const POLICY_BLOCKED = {
  error_code: "policy-blocked",
  message: "This integration action is not available under the current integration policy.",
  hint: "Ask an administrator to approve the integration or unblock the action.",
  provider: "google",
};
const RUN_BLOCKED_ACTION =
  "This integration action is not available: 'integrations.google.gmail.send' is blocked by the current integration policy. Ask an administrator to enable it.";
const RUN_UNAPPROVED_PROVIDER =
  "The 'google' integration is not available: it is outside the approved integration set. Ask an administrator to approve it.";
/** Gmail Send's own input validation: proof that the component body ran. */
const COMPONENT_OWN_ERROR = "At least one recipient address is required.";
const OAUTH_NOT_CONFIGURED = "OAuth registration ID is not configured.";

interface Capability {
  id: string;
  allowed: boolean;
  blocked_policy_key: string | null;
  policy_keys: string[];
  component_ref: string | null;
}
interface ProviderRow {
  provider_id: string;
  capabilities: Capability[];
}
interface EffectivePolicy {
  approved_provider_ids: string[];
  blocked_action_keys: string[];
  loaded_provider_ids: string[];
  unrestricted: boolean;
  managed_externally: boolean;
  policy_revision: number;
}

test.describe("governance — integration policy enforced at discovery, mutation and execution", () => {
  let superHeaders: Record<string, string>;
  let snapshot: PolicyBundleSets;
  let pristine = false;
  let skipReason = "";
  let owner: ConnectionsOwner;
  let catalog: Record<string, unknown>;
  /** Gmail Send's own code, read from the catalog while it is unblocked. */
  let gmailCode = "";
  const rows: CreatedConnection[] = [];
  const cleanups: Array<(request: APIRequestContext) => Promise<void>> = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    const auth = await getAuthToken(request);
    superHeaders = { Authorization: auth };
    const bundle = await readPolicyBundle(request, auth);
    snapshot = bundleSets(bundle);
    pristine = isBundlePristine(bundle);
    skipReason = `instance already carries a policy (${describeBundleSets(bundle)}) — a "blocked ⇒ absent" assertion would be unfalsifiable`;
    if (!pristine) return;
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "intpolicy",
    );
    catalog = await fetchComponentCatalog(request, superHeaders);
    const gmail = (catalog.google as Record<string, { template: { code: { value: string } } }>)?.[COMPONENT_KEY];
    expect(gmail, `${COMPONENT_KEY} in GET /api/v1/all`).toBeTruthy();
    gmailCode = gmail.template.code.value;
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup(request).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow, key and connection this test created is deleted").toEqual([]);
  });

  test.afterAll(async ({ request }) => {
    if (!pristine) return;
    try {
      await restorePolicyBundle(request, superHeaders.Authorization, snapshot, `${REASON} — restore`);
      const after = bundleSets(await readPolicyBundle(request, superHeaders.Authorization));
      expect(sameBundleSets(after, snapshot), "the bundle is back to the snapshot").toBe(true);
    } finally {
      // Deleting the owner takes any row it still owns with it.
      await owner?.dispose();
    }
  });

  /** Writes the bundle with `overrides`, asserting the write and its revision step. */
  async function setPolicy(
    request: APIRequestContext,
    overrides: Partial<PolicyBundleSets>,
  ): Promise<PolicyBundleResponse> {
    const current = await readPolicyBundle(request, superHeaders.Authorization);
    const res = await request.put("/api/v1/policy-bundle", {
      headers: superHeaders,
      data: buildBundleWrite(current, overrides, REASON),
    });
    expect(res.status(), await res.text()).toBe(200);
    const written = (await res.json()) as PolicyBundleResponse;
    expect(written.revision, "a write is one new revision").toBe((current.revision ?? 0) + 1);
    return written;
  }

  async function restore(request: APIRequestContext): Promise<void> {
    await restorePolicyBundle(request, superHeaders.Authorization, snapshot, `${REASON} — restore`);
  }

  async function providers(
    request: APIRequestContext,
    headers: Record<string, string>,
    includeBlocked = false,
  ): Promise<ProviderRow[]> {
    const res = await request.get(`/api/v1/integrations${includeBlocked ? "?include_blocked=true" : ""}`, {
      headers,
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { providers: ProviderRow[] }).providers;
  }

  function capability(rows: ProviderRow[], id: string): Capability | undefined {
    return rows.flatMap((p) => p.capabilities).find((c) => c.id === id);
  }

  /** Every component key in `/api/v1/all`, metadata map excluded. */
  async function catalogKeys(request: APIRequestContext, includeBlocked = false): Promise<Set<string>> {
    const res = await request.get(`/api/v1/all${includeBlocked ? "?include_blocked=true" : ""}`, {
      headers: superHeaders,
    });
    expect(res.status()).toBe(200);
    const keys = new Set<string>();
    for (const [category, entries] of Object.entries((await res.json()) as Record<string, object>)) {
      if (category === "component_display_names" || !entries || typeof entries !== "object") continue;
      for (const key of Object.keys(entries)) keys.add(key);
    }
    return keys;
  }

  async function effective(request: APIRequestContext, headers: Record<string, string>): Promise<EffectivePolicy> {
    const res = await request.get("/api/v1/integrations/policy/effective", { headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as EffectivePolicy;
  }

  /** `POST /api/v1/custom_component` with Gmail Send's own code. */
  function buildGmail(request: APIRequestContext): Promise<APIResponse> {
    return request.post("/api/v1/custom_component", { headers: superHeaders, data: { code: gmailCode } });
  }

  async function plantGoogleRow(request: APIRequestContext, label: string): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, { label: `intpolicy_${label}` });
    rows.push(row);
    return row;
  }

  /** The owner's row, as the list reads it now. */
  async function ownerRow(request: APIRequestContext, id: string): Promise<ConnectionRead | undefined> {
    const res = await request.get("/api/v1/connections", { headers: owner.headers });
    expect(res.status()).toBe(200);
    return ((await res.json()) as ConnectionRead[]).find((row) => row.id === id);
  }

  /** A create the policy must refuse: the exact body, and no row left behind. */
  async function expectCreateRefused(request: APIRequestContext, label: string): Promise<void> {
    const name = `intpolicy_${label}_${Date.now().toString(36)}`;
    const res = await request.post("/api/v1/connections", {
      headers: owner.headers,
      data: {
        provider_key: "google",
        name,
        display_name: `E2E ${name}`,
        executing_identity: { identity: "user_delegated" },
        credentials: { access_token: `E2E-PLANTED-${randomUUID()}` },
      },
    });
    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).detail).toEqual(POLICY_BLOCKED);
    const list = await request.get("/api/v1/connections", { headers: owner.headers });
    expect(((await list.json()) as ConnectionRead[]).map((row) => row.name), "a refused create stores nothing").not.toContain(
      name,
    );
  }

  /**
   * `oauth/start` as the owner. With no registration given it names one that does
   * not exist, so an allowed provider stops at the registration check (`400`).
   */
  function oauthStart(request: APIRequestContext, id: string, registrationId: string = randomUUID()): Promise<APIResponse> {
    return request.post(`/api/v1/connections/${id}/oauth/start`, {
      headers: owner.headers,
      data: { registration_id: registrationId, scopes: [GMAIL_SEND_SCOPE] },
    });
  }

  /** The registrations the owner's Add dialog would offer. */
  async function registrationIds(request: APIRequestContext): Promise<string[]> {
    const res = await request.get("/api/v1/connections/oauth/registrations", { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { registrations: Array<{ id: string }> }).registrations.map((r) => r.id);
  }

  /**
   * The policy keys of a provider's triggers. The manifest has no field for a
   * trigger; the catalog marks its component with `metadata.trigger_kind`.
   */
  function triggerPolicyKeys(provider: ProviderRow): string[] {
    const entries = (catalog[provider.provider_id] ?? {}) as Record<string, { metadata?: { trigger_kind?: string } }>;
    const triggers = provider.capabilities.filter(
      (c) => c.component_ref && entries[`ext:${provider.provider_id}:${c.component_ref}@official`]?.metadata?.trigger_kind,
    );
    return [...new Set(triggers.flatMap((c) => c.policy_keys))];
  }

  test(
    "a blocked action disappears from discovery and its component no longer builds",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/policy-bundle",
        "GET /api/v1/integrations",
        "GET /api/v1/integrations/policy/effective",
        "GET /api/v1/all",
        "POST /api/v1/connections",
        "POST /api/v1/connections/{connection_id}/health",
      ]);
      try {
        await test.step("baseline: the action is listed, catalogued and builds", async () => {
          expect(capability(await providers(request, superHeaders), CAPABILITY_ID)?.allowed).toBe(true);
          expect(await catalogKeys(request)).toContain(COMPONENT_KEY);
          expect((await buildGmail(request)).status()).toBe(200);
        });

        await test.step("the block is written and echoed", async () => {
          const written = await setPolicy(request, { blocked_integration_action_keys: [ACTION_KEY] });
          expect(written.blocked_integration_action_keys).toEqual([ACTION_KEY]);
        });

        await test.step("the manifest omits the capability, and keeps its provider", async () => {
          const listed = await providers(request, superHeaders);
          expect(capability(listed, CAPABILITY_ID)).toBeUndefined();
          expect(listed.map((p) => p.provider_id)).toContain("google");
          const withBlocked = capability(await providers(request, superHeaders, true), CAPABILITY_ID);
          expect(withBlocked).toMatchObject({ allowed: false, blocked_policy_key: ACTION_KEY });
        });

        await test.step("the catalog drops the component and keeps another Google one", async () => {
          const keys = await catalogKeys(request);
          expect(keys).not.toContain(COMPONENT_KEY);
          expect(keys).toContain(CONTROL_COMPONENT_KEY);
          expect(await catalogKeys(request, true), "include_blocked shows it to the operator").toContain(COMPONENT_KEY);
        });

        await test.step("its code no longer builds", async () => {
          const res = await buildGmail(request);
          expect(res.status()).toBe(404);
          expect(await res.json()).toEqual({ detail: "Integration not found" });
        });

        await test.step("the effective policy reports the key, and no ceiling", async () => {
          const policy = await effective(request, superHeaders);
          expect(policy.blocked_action_keys).toEqual([ACTION_KEY]);
          // `unrestricted` describes the provider ceiling only (the schema says so).
          expect(policy.unrestricted).toBe(true);
        });

        await test.step("a partial block refuses no mutation", async () => {
          const row = await plantGoogleRow(request, "partial");
          const health = await request.post(`/api/v1/connections/${row.id}/health`, { headers: owner.headers });
          expect(health.status(), await health.text()).toBe(200);
          expect((await ownerRow(request, row.id))?.health_checked_at, "an allowed check writes its time").not.toBeNull();
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "a provider ceiling hides the other providers and refuses their mutations",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/policy-bundle",
        "GET /api/v1/integrations",
        "GET /api/v1/integrations/policy/effective",
        "GET /api/v1/all",
        "POST /api/v1/connections",
        "POST /api/v1/connections/{connection_id}/test",
        "POST /api/v1/connections/{connection_id}/health",
        "POST /api/v1/connections/{connection_id}/oauth/start",
      ]);
      const manifest = await providers(request, superHeaders);
      const hiddenComponents = await catalogKeysOf(request, manifest, ["google", "slack"]);
      const row = await plantGoogleRow(request, "ceiling");
      try {
        await test.step("control: oauth/start reaches the registration check while Google is allowed", async () => {
          const res = await oauthStart(request, row.id);
          expect(res.status()).toBe(400);
          expect(await res.json()).toEqual({ detail: OAUTH_NOT_CONFIGURED });
        });

        await setPolicy(request, { approved_integration_provider_ids: ["microsoft"] });

        await test.step("only the approved provider is listed, and the ceiling is reported", async () => {
          expect((await providers(request, superHeaders)).map((p) => p.provider_id)).toEqual(["microsoft"]);
          const policy = await effective(request, superHeaders);
          expect(policy.unrestricted).toBe(false);
          expect(policy.approved_provider_ids).toEqual(["microsoft"]);
          // Every provider loaded stays loaded: the ceiling only stops listing them.
          expect([...policy.loaded_provider_ids].sort()).toEqual(manifest.map((p) => p.provider_id).sort());
        });

        await test.step("no Google or Slack connector component is left in the catalog", async () => {
          expect(hiddenComponents.length, "manifest components resolved").toBeGreaterThan(0);
          const keys = await catalogKeys(request);
          expect(hiddenComponents.filter((key) => keys.has(key))).toEqual([]);
        });

        await test.step("a Google connection cannot be created", async () => {
          await expectCreateRefused(request, "ceiling_new");
        });

        await test.step("test, health and oauth/start are refused, and the check writes nothing", async () => {
          const before = await ownerRow(request, row.id);
          const calls: Array<[string, () => Promise<APIResponse>]> = [
            ["test", () => request.post(`/api/v1/connections/${row.id}/test`, { headers: owner.headers, data: {} })],
            ["health", () => request.post(`/api/v1/connections/${row.id}/health`, { headers: owner.headers })],
            ["oauth/start", () => oauthStart(request, row.id)],
          ];
          for (const [name, call] of calls) {
            const res = await call();
            expect(res.status(), `${name}: ${await res.text()}`).toBe(403);
            expect((await res.json()).detail, name).toEqual(POLICY_BLOCKED);
          }
          const after = await ownerRow(request, row.id);
          expect(after?.health_checked_at).toBe(before?.health_checked_at);
          expect(after?.status).toBe(before?.status);
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "blocking every action of an approved provider refuses its connections and its consent, not its checks, and one allowed trigger keeps it offered",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/policy-bundle",
        "GET /api/v1/integrations",
        "GET /api/v1/connections/oauth/registrations",
        "POST /api/v1/connections",
        "POST /api/v1/connections/{connection_id}/oauth/start",
        "POST /api/v1/connections/{connection_id}/health",
      ]);
      const google = (await providers(request, superHeaders)).find((p) => p.provider_id === "google");
      expect(google, "the manifest serves Google").toBeDefined();
      const googleKeys = [...new Set(google!.capabilities.flatMap((c) => c.policy_keys))];
      expect(googleKeys.length, "Google's policy keys, from the manifest").toBeGreaterThan(1);
      const triggerKeys = triggerPolicyKeys(google!);
      expect(triggerKeys.length, "Google's trigger keys, from the catalog's trigger_kind").toBeGreaterThan(0);
      const actionKeys = googleKeys.filter((key) => !triggerKeys.includes(key));
      expect(actionKeys.length, "Google has actions that are not triggers").toBeGreaterThan(0);
      const row = await plantGoogleRow(request, "allblocked");
      try {
        await test.step("control: the registration list offers Google while it is allowed", async () => {
          expect(await registrationIds(request)).toContain(GOOGLE_REGISTRATION);
        });

        await setPolicy(request, { blocked_integration_action_keys: googleKeys });

        await test.step("Google is no longer listed", async () => {
          expect((await providers(request, superHeaders)).map((p) => p.provider_id)).not.toContain("google");
        });

        await test.step("the registration list stops offering Google, and only Google", async () => {
          const ids = await registrationIds(request);
          expect(ids).not.toContain(GOOGLE_REGISTRATION);
          expect(ids).toContain(MICROSOFT_REGISTRATION);
        });

        await test.step("a Google connection cannot be created", async () => {
          await expectCreateRefused(request, "allblocked_new");
        });

        await test.step("consent cannot start on an existing Google connection, even with its real registration", async () => {
          const res = await oauthStart(request, row.id, GOOGLE_REGISTRATION);
          expect(res.status(), await res.text()).toBe(403);
          expect((await res.json()).detail).toEqual(POLICY_BLOCKED);
        });

        await test.step("an existing Google connection can still be checked", async () => {
          const health = await request.post(`/api/v1/connections/${row.id}/health`, { headers: owner.headers });
          expect(health.status(), await health.text()).toBe(200);
        });

        await setPolicy(request, { blocked_integration_action_keys: actionKeys });

        await test.step("with only its triggers allowed, Google is offered again and consent starts", async () => {
          expect(await registrationIds(request)).toContain(GOOGLE_REGISTRATION);
          const res = await oauthStart(request, row.id, GOOGLE_REGISTRATION);
          expect(res.status(), await res.text()).toBe(200);
          const { authorization_url } = (await res.json()) as { authorization_url: string };
          expect(new URL(authorization_url).origin).toBe("https://accounts.google.com");
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "a saved flow is refused at run time, before its component runs",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare(["PUT /api/v1/policy-bundle", "POST /api/v1/run/{flow_id_or_name}"]);
      const flowId = await createCatalogFlow(
        request,
        catalog,
        { nodes: [{ id: "gmail", type: COMPONENT_KEY }], edges: [] },
        { name: `e2e-2299-run-${Date.now().toString(36)}`, headers: owner.headers },
      );
      cleanups.push((req) => deleteFlow(req, flowId, { headers: owner.headers }));
      const apiKey = await createApiKey(request, owner.headers, { namePrefix: "e2e-2299" });
      cleanups.push((req) => deleteApiKey(req, apiKey.id, owner.headers));
      const run = () =>
        request.post(`/api/v1/run/${flowId}?stream=false`, {
          headers: { "x-api-key": apiKey.key },
          data: { input_value: "e2e" },
        });

      try {
        await test.step("allowed: the component itself runs, and stops at its own validation", async () => {
          const res = await run();
          expect(res.status()).toBe(500);
          expect(await res.text()).toContain(COMPONENT_OWN_ERROR);
        });

        await test.step("action blocked: refused naming the key, before the component runs", async () => {
          await setPolicy(request, { blocked_integration_action_keys: [ACTION_KEY] });
          const res = await run();
          const text = await res.text();
          expect(res.status(), text).toBe(403);
          expect(JSON.parse(text).detail).toMatchObject({
            error_code: "policy-blocked",
            message: RUN_BLOCKED_ACTION,
            provider: "google",
            retryable: false,
            details: { policy_key: ACTION_KEY },
          });
          expect(text).not.toContain(COMPONENT_OWN_ERROR);
        });

        await test.step("provider outside the ceiling: refused as an unapproved integration", async () => {
          await setPolicy(request, { blocked_integration_action_keys: [], approved_integration_provider_ids: ["microsoft"] });
          const res = await run();
          const text = await res.text();
          expect(res.status(), text).toBe(403);
          expect(JSON.parse(text).detail).toMatchObject({
            error_code: "policy-blocked",
            message: RUN_UNAPPROVED_PROVIDER,
            provider: "google",
          });
          expect(text).not.toContain(COMPONENT_OWN_ERROR);
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "policy data is operator-only",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/policy-bundle",
        "GET /api/v1/policy-bundle",
        "GET /api/v1/integrations",
        "GET /api/v1/integrations/policy/effective",
        "GET /api/v1/all",
      ]);
      try {
        await setPolicy(request, { blocked_integration_action_keys: [ACTION_KEY] });

        await test.step("include_blocked is refused to a non-superuser", async () => {
          const integrations = await request.get("/api/v1/integrations?include_blocked=true", { headers: owner.headers });
          expect(integrations.status()).toBe(403);
          expect(await integrations.json()).toEqual({ detail: "Only superusers can include blocked integrations." });
          const all = await request.get("/api/v1/all?include_blocked=true", { headers: owner.headers });
          expect(all.status()).toBe(403);
          expect(await all.json()).toEqual({ detail: "Only superusers can include blocked catalog components." });
        });

        await test.step("the bundle is neither readable nor writable by a non-superuser", async () => {
          const read = await request.get("/api/v1/policy-bundle", { headers: owner.headers });
          expect(read.status()).toBe(403);
          const current = await readPolicyBundle(request, superHeaders.Authorization);
          const write = await request.put("/api/v1/policy-bundle", {
            headers: owner.headers,
            data: buildBundleWrite(current, { blocked_integration_action_keys: [] }, REASON),
          });
          expect(write.status()).toBe(403);
          expect((await readPolicyBundle(request, superHeaders.Authorization)).revision).toBe(current.revision);
        });

        await test.step("the deny-list is hidden from the user, not from the operator", async () => {
          expect((await effective(request, owner.headers)).blocked_action_keys).toEqual([]);
          expect((await effective(request, superHeaders)).blocked_action_keys).toEqual([ACTION_KEY]);
        });

        await test.step("the user's discovery is filtered too", async () => {
          expect(capability(await providers(request, owner.headers), CAPABILITY_ID)).toBeUndefined();
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "the write validates what it can, and a refused write stores nothing",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare(["PUT /api/v1/policy-bundle", "GET /api/v1/policy-bundle"]);
      const put = (data: unknown) => request.put("/api/v1/policy-bundle", { headers: superHeaders, data });
      try {
        const current = await readPolicyBundle(request, superHeaders.Authorization);

        await test.step("a key outside the integrations namespace is malformed", async () => {
          const res = await put(buildBundleWrite(current, { blocked_integration_action_keys: ["nope"] }, REASON));
          expect(res.status()).toBe(422);
          const [error] = (await res.json()).detail as Array<{ loc: string[]; msg: string }>;
          expect(error.loc).toEqual(["body", "blocked_integration_action_keys"]);
          expect(error.msg).toContain("Integration action policy keys must start with 'integrations.'");
        });

        await test.step("an action a loaded provider does not declare is refused, naming it", async () => {
          const res = await put(
            buildBundleWrite(current, { blocked_integration_action_keys: ["integrations.google.nope"] }, REASON),
          );
          expect(res.status()).toBe(422);
          const { detail } = (await res.json()) as { detail: string };
          expect(detail).toContain(
            "Blocked integration action keys must match an action the loaded provider declares: provider 'google' does not declare integrations.google.nope",
          );
          expect(detail, "the refusal lists what Google does declare").toContain(ACTION_KEY);
        });

        await test.step("a stale expected_revision is a conflict", async () => {
          const stale = { ...buildBundleWrite(current, {}, REASON), expected_revision: (current.revision ?? 0) + 1 };
          const res = await put(stale);
          expect(res.status()).toBe(409);
          expect((await res.json()).detail).toEqual({
            message: "Policy bundle revision conflict",
            expected_revision: stale.expected_revision,
            active_revision: current.revision,
          });
        });

        await test.step("none of the three refusals moved the revision", async () => {
          expect((await readPolicyBundle(request, superHeaders.Authorization)).revision).toBe(current.revision);
        });

        await test.step("a key under a provider that is not loaded is accepted", async () => {
          // Pre-configuration: an operator may block an action before installing its provider.
          await setPolicy(request, { blocked_integration_action_keys: ["integrations.e2enotloaded.send"] });
        });
      } finally {
        await restore(request);
      }
    },
  );

  test(
    "rollback restores discovery",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/policy-bundle",
        "POST /api/v1/policy-bundle/rollback/{revision}",
        "GET /api/v1/integrations",
        "GET /api/v1/all",
      ]);
      try {
        const before = await readPolicyBundle(request, superHeaders.Authorization);
        const blocked = await setPolicy(request, { blocked_integration_action_keys: [ACTION_KEY] });

        await test.step("the block took effect", async () => {
          expect(capability(await providers(request, superHeaders), CAPABILITY_ID)).toBeUndefined();
          expect(await catalogKeys(request)).not.toContain(COMPONENT_KEY);
        });

        await test.step("rolling back writes a new revision with the earlier content", async () => {
          const res = await request.post(`/api/v1/policy-bundle/rollback/${before.revision}`, {
            headers: superHeaders,
            data: { expected_revision: blocked.revision },
          });
          expect(res.status(), await res.text()).toBe(200);
          expect(await res.json()).toMatchObject({
            revision: (blocked.revision ?? 0) + 1,
            source: "rollback",
            rollback_of_revision: before.revision,
            blocked_integration_action_keys: [],
          });
        });

        await test.step("the action is discoverable and buildable again", async () => {
          expect(capability(await providers(request, superHeaders), CAPABILITY_ID)?.allowed).toBe(true);
          expect(await catalogKeys(request)).toContain(COMPONENT_KEY);
          expect((await buildGmail(request)).status()).toBe(200);
        });

        await test.step("a revision that does not exist cannot be rolled back to", async () => {
          const active = await readPolicyBundle(request, superHeaders.Authorization);
          const res = await request.post("/api/v1/policy-bundle/rollback/99999999", {
            headers: superHeaders,
            data: { expected_revision: active.revision },
          });
          expect(res.status()).toBe(404);
          expect(await res.json()).toEqual({ detail: "Policy bundle revision 99999999 is missing" });
        });
      } finally {
        await restore(request);
      }
    },
  );

  /** The catalog keys of every manifest component the given providers own. */
  async function catalogKeysOf(
    request: APIRequestContext,
    manifest: ProviderRow[],
    providerIds: string[],
  ): Promise<string[]> {
    const keys = await catalogKeys(request);
    const refs = manifest
      .filter((p) => providerIds.includes(p.provider_id))
      .flatMap((p) => p.capabilities.map((c) => ({ provider: p.provider_id, ref: c.component_ref })))
      .filter((c): c is { provider: string; ref: string } => Boolean(c.ref));
    return [...new Set(refs.map((c) => `ext:${c.provider}:${c.ref}@official`))].filter((key) => keys.has(key));
  }
});
