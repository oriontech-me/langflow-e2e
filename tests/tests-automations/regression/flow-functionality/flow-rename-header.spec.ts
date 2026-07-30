import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { renameFlow } from "../../../helpers/flows/rename-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

const FLOW_BASE = {
  description: "Flow rename test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

// The UI test below created a flow per run and never deleted it, so every run of
// this file left one behind (#1154). Accumulated flows are not cosmetic: they are
// what makes another worker's residual card overlap a target's absolute-inset
// `list-card-open-button` and swallow a hit-tested click (#580/#588).
//
// The sibling API test keeps its own `finally` DELETE. It creates through the
// `request` fixture, a separate `APIRequestContext` that emits no page-level
// response events, so this tracker cannot see that flow (#1147) — two cleanup
// paths here is the correct shape, not a leftover.
let flows: FlowTracker | undefined;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  const tracker = flows;
  // Null out BEFORE awaiting. `flows?.` alone only protects the FIRST test in a
  // worker: for a later test whose `beforeEach` threw, the binding still holds
  // the PREVIOUS test's tracker, and the optional chain waves it through. (The
  // three pre-#1154 adopters declare `flows` non-nullable, which also makes
  // their `?.` a guard TypeScript treats as dead.)
  flows = undefined;
  // Default (log and continue), not `strict`: this file had no teardown at all
  // before, so failing an otherwise-green test on a cleanup blip would be a new
  // contract rather than a preserved one. The failure is still printed.
  await tracker?.cleanup(request);
});

test.describe("Flow Rename via Header", () => {
  test(
    "flow can be renamed via the header edit",
    { tag: ["@release", "@workspace", "@stable"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });

      const newName = `My Renamed Flow ${Date.now()}`;
      await renameFlow(page, { flowName: newName });

      // Header reflects the new name (renameFlow's waitForFunction already confirms the DOM
      // committed before returning — this expect is the test-framework-visible guard)
      await expect(page.getByTestId("flow_name")).toHaveText(newName, {
        timeout: 10000,
      });
    },
  );

  test(
    "flow name persists after rename via API PATCH and GET",
    { tag: ["@release", "@workspace", "@api", "@stable"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const originalName = `Rename Test Flow - ${Date.now()}`;
      const updatedName = `Renamed Flow - ${Date.now()}`;

      // Create a flow
      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: originalName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      try {
        // Rename via PATCH
        const patchRes = await request.patch(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
          data: { name: updatedName },
        });
        expect(patchRes.status()).toBe(200);
        const patchBody = await patchRes.json();
        expect(patchBody.name).toBe(updatedName);

        // GET the flow and verify the name persisted
        const getRes = await request.get(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
        });
        expect(getRes.status()).toBe(200);
        const getBody = await getRes.json();
        expect(getBody.name).toBe(updatedName);
        // Original name should no longer match
        expect(getBody.name).not.toBe(originalName);
      } finally {
        // Cleanup
        await deleteFlow(request, id, { headers: { Authorization: authToken } });
      }
    },
  );
});
