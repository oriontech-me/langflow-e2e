import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import {
  buildBundleV2Write,
  buildBundleWrite,
  bundleV2Sets,
  describeBundleV2,
  INTEGRATION_DENY_ALL_MARKER,
  isBundleV2Pristine,
  type PolicyBundleV2Response,
  type PolicyBundleV2Sets,
  readPolicyBundle,
  readPolicyBundleV2,
  restorePolicyBundleV2,
  writePolicyBundleV2,
} from "../../../helpers/governance/policy-state";
import { servedVersionAtLeast } from "../../../helpers/other/served-version";

// Integration deny-all through the v2 policy bundle (#2451).
// Spec doc: docs/governance/integration-policy-v2.md
//
// On v2, `approved_integration_provider_ids` is tri-state: `null` is unrestricted and
// `[]` denies every integration. v1 keeps reading `[]` as unrestricted and spells
// deny-all as a reserved marker. Deny-all is instance-global, so this file is
// @destructive and refuses to run unless the bundle is pristine. What an approved
// subset and blocked actions enforce is governance/integration-policy-enforcement.spec.ts.
test.describe.configure({ mode: "serial" });

test.describe("governance — integration deny-all through the v2 policy bundle", () => {
  // The v2 bundle and its tri-state integration set: upstream #16227, first in 1.14.0.dev21.
  const SINCE = "1.14.0.dev21";
  // The picker's own Add connection: upstream #16332, first in 1.14.0.dev23.
  const PICKER_SINCE = "1.14.0.dev23";
  const REASON = "e2e #2451 integration deny-all";
  const MARKER_REFUSED =
    "Value error, The integration policy marker is reserved; use an empty list to deny all integrations in API v2";
  const UNAVAILABLE =
    "This integration is unavailable. An administrator controls which providers and actions can be used.";
  const GMAIL_SEND = "ext:google:GmailSendComponent@official";
  const FIELD = "connectionref_connection_ref_connection";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let auth = "";
  let headers: Record<string, string> = {};
  let snapshot: PolicyBundleV2Sets | undefined;
  let skipReason = "";
  /** The providers `GET /api/v1/integrations` lists while unrestricted. */
  let unrestricted: string[] = [];

  test.beforeAll(async ({ request }) => {
    auth = await getAuthToken(request);
    headers = { Authorization: auth };
    if (!(await servedVersionAtLeast(request, SINCE))) {
      skipReason = `the v2 policy bundle ships in ${SINCE} (upstream #16227); this build does not carry it`;
      return;
    }
    const bundle = await readPolicyBundleV2(request, auth);
    if (!isBundleV2Pristine(bundle)) {
      skipReason = `instance already carries a policy (${describeBundleV2(bundle)}) — a deny-all assertion would be unfalsifiable`;
      return;
    }
    snapshot = bundleV2Sets(bundle);
    unrestricted = await listedProviders(request);
  });

  test.beforeEach(() => {
    test.skip(snapshot === undefined, skipReason);
  });

  test.afterEach(async ({ page, request }) => {
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  test.afterAll(async ({ request }) => {
    if (snapshot === undefined) return;
    await restorePolicyBundleV2(request, auth, snapshot, `${REASON} — restore`);
  });

  async function listedProviders(request: APIRequestContext): Promise<string[]> {
    const res = await request.get("/api/v1/integrations", { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return ((JSON.parse(text) as { providers: Array<{ provider_id: string }> }).providers ?? [])
      .map((provider) => provider.provider_id)
      .sort();
  }

  async function setIntegrations(request: APIRequestContext, ids: string[] | null): Promise<PolicyBundleV2Response> {
    const written = await writePolicyBundleV2(request, auth, { approved_integration_provider_ids: ids }, REASON);
    expect(written.approved_integration_provider_ids ?? null, "the write answers the new value").toEqual(ids);
    return written;
  }

  async function v2Integrations(request: APIRequestContext): Promise<string[] | null> {
    return (await readPolicyBundleV2(request, auth)).approved_integration_provider_ids ?? null;
  }

  /** A v1 bundle write: the six v1 sets with the integration set replaced. */
  async function writeV1Integrations(request: APIRequestContext, ids: string[]): Promise<string[]> {
    const current = await readPolicyBundle(request, auth);
    const res = await request.put("/api/v1/policy-bundle", {
      headers,
      data: buildBundleWrite(current, { approved_integration_provider_ids: ids }, `${REASON} — v1 writer`),
    });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text).approved_integration_provider_ids as string[];
  }

  test(
    "an empty v2 list denies every integration, which v1 reads as the reserved marker",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request }) => {
      expect(unrestricted, "the unrestricted listing names google").toContain("google");

      await test.step("[] lists no provider, and v1 reads the marker", async () => {
        await setIntegrations(request, []);
        expect(await listedProviders(request)).toEqual([]);
        expect((await readPolicyBundle(request, auth)).approved_integration_provider_ids).toEqual([
          INTEGRATION_DENY_ALL_MARKER,
        ]);
      });

      await test.step("a model-provider write keeps the deny-all", async () => {
        const approved = (await readPolicyBundle(request, auth)).approved_provider_ids ?? [];
        const res = await request.put("/api/v1/model-provider-policy", { headers, data: { approved_provider_ids: approved } });
        expect(res.status(), await res.text()).toBe(200);
        expect(await v2Integrations(request)).toEqual([]);
        expect(await listedProviders(request)).toEqual([]);
      });

      await test.step("v2 refuses the marker", async () => {
        const current = await readPolicyBundleV2(request, auth);
        const res = await request.put("/api/v2/policy-bundle", {
          headers,
          data: buildBundleV2Write(current, { approved_integration_provider_ids: [INTEGRATION_DENY_ALL_MARKER] }, REASON),
        });
        const text = await res.text();
        expect(res.status(), text).toBe(422);
        expect(JSON.parse(text).detail).toEqual([
          expect.objectContaining({ loc: ["body", "approved_integration_provider_ids"], msg: MARKER_REFUSED }),
        ]);
      });

      await test.step("null lists every provider again", async () => {
        await setIntegrations(request, null);
        expect(await listedProviders(request)).toEqual(unrestricted);
      });
    },
  );

  test(
    "v1 reads an empty list as unrestricted and writes deny-all only as the marker",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request }) => {
      await test.step("a v1 [] is unrestricted", async () => {
        expect(await writeV1Integrations(request, [])).toEqual([]);
        expect(await v2Integrations(request)).toBeNull();
        expect(await listedProviders(request)).toEqual(unrestricted);
      });

      await test.step("the v1 marker denies every integration", async () => {
        expect(await writeV1Integrations(request, [INTEGRATION_DENY_ALL_MARKER])).toEqual([INTEGRATION_DENY_ALL_MARKER]);
        expect(await v2Integrations(request)).toEqual([]);
        expect(await listedProviders(request)).toEqual([]);
      });

      await setIntegrations(request, null);
    },
  );

  test(
    "v2 history keeps deny-all apart from unrestricted, a stale write conflicts, and rollback appends",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request }) => {
      const denyAll = (await setIntegrations(request, [])).revision as number;
      const lifted = (await setIntegrations(request, null)).revision as number;
      expect(lifted).toBeGreaterThan(denyAll);

      await test.step("history lists both revisions, [] and null apart", async () => {
        const res = await request.get("/api/v2/policy-bundle/history?limit=2", { headers });
        expect(res.status()).toBe(200);
        const history = (await res.json()) as { items: PolicyBundleV2Response[]; next_before_revision: number | null };
        expect(history.items.map((item) => [item.revision, item.approved_integration_provider_ids, item.reason])).toEqual([
          [lifted, null, REASON],
          [denyAll, [], REASON],
        ]);
        expect(history.next_before_revision, "a full page names where the next one starts").toBe(denyAll);
      });

      await test.step("a stale expected_revision is refused 409, naming both revisions", async () => {
        const current = await readPolicyBundleV2(request, auth);
        const res = await request.put("/api/v2/policy-bundle", {
          headers,
          data: { ...buildBundleV2Write(current, {}, REASON), expected_revision: lifted - 1 },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(409);
        expect(JSON.parse(text).detail).toEqual({
          message: "Policy bundle revision conflict",
          expected_revision: lifted - 1,
          active_revision: lifted,
        });
      });

      await test.step("a rollback to the deny-all revision appends it, and it is enforced", async () => {
        const res = await request.post(`/api/v2/policy-bundle/rollback/${denyAll}`, {
          headers,
          data: { expected_revision: lifted, reason: `${REASON} — rollback` },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const rolled = JSON.parse(text) as PolicyBundleV2Response;
        expect(rolled.revision).toBeGreaterThan(lifted);
        expect(rolled.source).toBe("rollback");
        expect(rolled.rollback_of_revision).toBe(denyAll);
        expect(rolled.approved_integration_provider_ids).toEqual([]);
        expect(await listedProviders(request)).toEqual([]);
      });

      await test.step("a rollback to a missing revision answers 404", async () => {
        const current = await readPolicyBundleV2(request, auth);
        const res = await request.post("/api/v2/policy-bundle/rollback/99999999", {
          headers,
          data: { expected_revision: current.revision },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(404);
        expect(JSON.parse(text).detail).toBe("Policy bundle revision 99999999 is missing");
      });

      await setIntegrations(request, null);
    },
  );

  test(
    "under deny-all the connection picker says the integration is unavailable and offers no Add connection",
    { tag: ["@destructive", "@api", "@components", "@integrations", "@governance"] },
    async ({ page, request }) => {
      test.skip(
        !(await servedVersionAtLeast(request, PICKER_SINCE)),
        `the picker's Add connection ships in ${PICKER_SINCE} (upstream #16332)`,
      );
      const catalog = await fetchComponentCatalog(request, headers);
      const flowId = await createCatalogFlow(request, catalog, { nodes: [{ id: "gmail", type: GMAIL_SEND }], edges: [] }, {
        name: `E2E integration deny-all picker ${run}`,
        headers,
      });
      flowIds.push(flowId);
      const node = page.getByTestId("rf__node-gmail");
      const field = node.getByTestId(FIELD);
      const add = node.getByTestId(`add-connection-${FIELD}`);
      const unavailable = node.getByText(UNAVAILABLE, { exact: true });

      async function openPicker(): Promise<void> {
        await expect(field).toBeVisible({ timeout: 20_000 });
        await field.click();
        await expect(node.getByTestId(`refresh-connections-${FIELD}`), "the picker popover is open").toBeVisible();
      }

      await test.step("deny-all: the picker names the policy and Add connection is disabled", async () => {
        await setIntegrations(request, []);
        await openFlowById(page, flowId);
        await openPicker();
        await expect(unavailable).toBeVisible();
        await expect(add).toBeDisabled();
        await page.keyboard.press("Escape");
      });

      await test.step("the palette no longer offers Gmail", async () => {
        await page.getByTestId("sidebar-search-input").fill("chat output");
        await expect(page.getByTestId("input_output_chat output_draggable"), "the search has rendered").toBeVisible();
        await page.getByTestId("sidebar-search-input").fill("gmail");
        await expect(page.locator('[data-testid$="_draggable"]')).toHaveCount(0);
      });

      await test.step("lifted: the sentence is gone and Add connection is enabled", async () => {
        await setIntegrations(request, null);
        await page.reload();
        await openPicker();
        await expect(add).toBeEnabled();
        await expect(unavailable).toHaveCount(0);
        await page.keyboard.press("Escape");
      });
    },
  );
});
