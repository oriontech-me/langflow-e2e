import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { renameFlow } from "../../../helpers/flows/rename-flow";

const FLOW_BASE = {
  description: "Flow rename test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test.describe("Flow Rename via Header", () => {
  test(
    "flow can be renamed via the header edit",
    { tag: ["@release", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);
      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Wait for canvas to load (sidebar-search-input visible means editor is ready)
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // Use the shared renameFlow utility (handles dirty-state and save)
      const newName = `My Renamed Flow ${Date.now()}`;
      await renameFlow(page, { flowName: newName });

      // The header must show the new name
      await expect(page.getByTestId("flow_name")).toHaveText(newName, {
        timeout: 10000,
      });
    },
  );

  test(
    "flow name persists after rename via API PATCH and GET",
    { tag: ["@release", "@regression"] },
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
        await request.delete(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
        });
      }
    },
  );
});
