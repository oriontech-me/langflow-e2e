import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  describePolicyState,
  isPolicyPristine,
  readCatalogTypes,
  readPolicyBundle,
  restorePolicy,
  singleNodeFlow,
  snapshotPolicy,
  type PolicySnapshot,
} from "../../../../helpers/governance/policy-state";

// Catalog policy — component blocklist enforcement (QA-CHECKLIST §21.1).
// Spec doc: docs/governance/catalog-policy/component-blocklist-enforcement.md
//
// The policy is instance-global, so this file is @destructive: it is excluded
// from every normal run by playwright.config.ts and runs alone under
// PW_DESTRUCTIVE=1 at workers=1. Serial mode is not a style choice — the tests
// share one policy write, and the restore is the last of them.
test.describe.configure({ mode: "serial" });

// Target: non-legacy (so the sidebar renders it at all) and referenced by no
// other spec (so the blocked window cannot break someone else's fixture).
const BLOCKED_TYPE = "DynamicCreateData";
const BLOCKED_DISPLAY_NAME = "Dynamic Create Data";
const BLOCKED_CARD = `processing${BLOCKED_DISPLAY_NAME}`;
// A component nobody blocks, proving the catalog was filtered and not emptied.
const CONTROL_TYPE = "ChatInput";
const SIDEBAR_EMPTY_STATE = "No components found.";

test.describe("governance — catalog policy blocks a component end to end", () => {
  let token: string;
  let snapshot: PolicySnapshot;
  let pristine = false;
  let skipReason = "";
  /** Type set of a policy-free instance, captured by the control test. */
  let baselineTypes = new Set<string>();
  /** Flow saved BEFORE the block — its survival is asserted after it. */
  let preBlockFlowId = "";
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
    const bundle = await readPolicyBundle(request, token);
    pristine = isPolicyPristine(bundle);
    skipReason = `instance already carries a catalog policy (${describePolicyState(bundle)}) — every "absent after blocking" assertion here would be unfalsifiable`;
    if (pristine) {
      snapshot = await snapshotPolicy(request, token);
    }
  });

  test.afterAll(async ({ request }) => {
    // Safety net, not the assertion: the last test restores and verifies. This
    // runs so an early failure cannot leave the shared instance with a
    // component missing for the rest of the lane.
    if (pristine) {
      await restorePolicy(request, token, snapshot);
    }
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: token },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  test(
    "an unconfigured instance hides nothing and saves a flow using the target component",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await test.step("the config flag reports governance off", async () => {
        const config = await request.get("/api/v1/config", {
          headers: { Authorization: token },
        });
        expect(config.status()).toBe(200);
        expect((await config.json()).catalog_governance_enabled).toBe(false);
      });

      await test.step("the catalog lists the target component", async () => {
        baselineTypes = await readCatalogTypes(request, token);
        expect(baselineTypes.has(BLOCKED_TYPE)).toBe(true);
        expect(baselineTypes.has(CONTROL_TYPE)).toBe(true);
      });

      await test.step("a flow carrying it saves", async () => {
        preBlockFlowId = await createFlow(
          request,
          singleNodeFlow(`gov-pre-block-${Date.now()}`, BLOCKED_TYPE),
          { headers: { Authorization: token } },
        );
        createdFlowIds.push(preBlockFlowId);
      });
    },
  );

  test(
    "blocking the component removes it from the catalog and refuses the write path",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await test.step("the policy write is accepted and echoed", async () => {
        const put = await request.put("/api/v1/catalog-policy/components", {
          headers: { Authorization: token },
          data: { blocked: [BLOCKED_TYPE] },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).blocked).toContain(BLOCKED_TYPE);
      });

      await test.step("the config flag tracks the policy", async () => {
        const config = await request.get("/api/v1/config", {
          headers: { Authorization: token },
        });
        expect((await config.json()).catalog_governance_enabled).toBe(true);
      });

      await test.step("the catalog drops it and keeps everything else", async () => {
        const types = await readCatalogTypes(request, token);
        expect(types.has(BLOCKED_TYPE)).toBe(false);
        // Filtered, not emptied: the control survives and the set shrank.
        expect(types.has(CONTROL_TYPE)).toBe(true);
        expect(types.size).toBeLessThan(baselineTypes.size);
      });

      await test.step("saving a flow that uses it is refused, naming it", async () => {
        // Deliberate 4xx: the fixture's HTTP monitor is advisory, but this keeps
        // the log honest about which failures the spec provoked on purpose.
        const response = await request.post("/api/v1/flows/", {
          headers: { Authorization: token },
          data: singleNodeFlow(`gov-post-block-${Date.now()}`, BLOCKED_TYPE),
        });
        // A 500 here is a failure, not an equivalent refusal: the block is a
        // policy decision the API is expected to make cleanly.
        expect(response.status()).toBe(400);
        expect(await response.text()).toContain(BLOCKED_TYPE);
      });

      await test.step("a flow saved before the block is untouched", async () => {
        const response = await request.get(`/api/v1/flows/${preBlockFlowId}`, {
          headers: { Authorization: token },
        });
        expect(response.status()).toBe(200);
        const flow = await response.json();
        expect(
          flow.data.nodes.map((node: { data: { type: string } }) => node.data.type),
        ).toEqual([BLOCKED_TYPE]);
      });
    },
  );

  test(
    "the blocked component is not findable in the flow-editor sidebar",
    { tag: ["@destructive", "@components", "@governance"] },
    async ({ page, request }) => {
      test.skip(!pristine, skipReason);

      const flowId = await createFlow(
        request,
        {
          name: `gov-sidebar-${Date.now()}`,
          description: "Empty canvas for the §21.1 sidebar assertion",
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
        { headers: { Authorization: token } },
      );
      createdFlowIds.push(flowId);

      await page.goto(`/flow/${flowId}`);
      const search = page.getByTestId("sidebar-search-input");
      await expect(search).toBeVisible({ timeout: 30000 });
      const sidebar = page.getByTestId("shad-sidebar");

      await test.step("searching its display name yields the empty state", async () => {
        await search.fill(BLOCKED_DISPLAY_NAME);

        await expect(sidebar.getByText(SIDEBAR_EMPTY_STATE)).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId(BLOCKED_CARD)).toHaveCount(0);
      });

      await test.step("an unblocked component is still findable", async () => {
        // Without this the empty state could mean "search is broken", which
        // would pass whether or not the policy did anything.
        await search.fill("Chat Input");

        await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
          timeout: 15000,
        });
      });

      // Unmount the editor before the afterAll delete: it polls the flow's
      // event stream.
      await page.goto("/").catch(() => {});
    },
  );

  test(
    "clearing the policy puts the catalog back",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await restorePolicy(request, token, snapshot);

      await test.step("the component is listed again", async () => {
        const types = await readCatalogTypes(request, token);
        expect(types.has(BLOCKED_TYPE)).toBe(true);
        expect(types.size).toBe(baselineTypes.size);
      });

      await test.step("the config flag reports governance off again", async () => {
        const config = await request.get("/api/v1/config", {
          headers: { Authorization: token },
        });
        expect((await config.json()).catalog_governance_enabled).toBe(false);
      });
    },
  );
});
