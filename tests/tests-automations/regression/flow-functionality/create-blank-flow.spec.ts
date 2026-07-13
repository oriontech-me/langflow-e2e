import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

/**
 * Dedicated proof of the "create a blank flow" journey (QA-CHECKLIST §12.1):
 * clicking Blank Flow in the new-project modal creates a new flow, opens its
 * editor, and the persisted flow has an empty graph.
 *
 * Exercised implicitly as a setup step across the suite (e.g. setupPlayground),
 * but no spec asserted the behavior itself. Distinct from the §12.1 siblings:
 * duplicate-flow.spec.ts (clone) and the template/JSON-import paths (create from
 * content) — this covers the EMPTY creation path.
 *
 * The real flow id comes from the creation POST 201, not page.url() — the canvas
 * URL id is transient on 1.11 and 404s on delete (repo convention #505).
 */
test.describe("Flow Functionality — Create Blank Flow", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page, request }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(request, createdFlowId, {
        headers: { Authorization: await getAuthToken(request) },
      });
      createdFlowId = null;
    }
  });

  test("user can create a blank flow from the new-project modal",
    { tag: ["@stable", "@release", "@regression", "@workspace"] },
    async ({ page, request }) => {
      await test.step("Open the app and land on the new-project modal", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("Click Blank Flow and capture the created flow id", async () => {
        // Register before the click: the 201 body carries the real, persisted id
        // (page.url() would give a transient id that 404s on delete — #505).
        const creationResponsePromise = page.waitForResponse(
          (resp) =>
            resp.url().includes("/api/v1/flows") &&
            resp.request().method() === "POST" &&
            resp.status() === 201,
          { timeout: 15000 },
        );

        await page.getByTestId("blank-flow").click();

        const creationResponse = await creationResponsePromise;
        createdFlowId = ((await creationResponse.json()) as { id: string }).id;
        expect(createdFlowId).toBeTruthy();
      });

      await test.step("Confirm the flow editor opened", async () => {
        await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("Confirm the canvas is blank (no nodes)", async () => {
        await expect(page.locator(".react-flow__node")).toHaveCount(0, {
          timeout: 10000,
        });
      });

      await test.step("Confirm the persisted flow has an empty graph", async () => {
        const authToken = await getAuthToken(request);
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/flows/${createdFlowId}`, {
                headers: { Authorization: authToken },
              });
              if (res.status() !== 200) return null;
              const flow = (await res.json()) as {
                data?: { nodes?: unknown[]; edges?: unknown[] };
              };
              return {
                nodes: flow.data?.nodes?.length ?? -1,
                edges: flow.data?.edges?.length ?? -1,
              };
            },
            { timeout: 10000, intervals: [500, 1000, 2000] },
          )
          .toEqual({ nodes: 0, edges: 0 });
      });
    },
  );
});
