import { expect, test } from "../../../fixtures/fixtures";
import { loadTemplateByName } from "../../../helpers/flows/load-template-by-name";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

/**
 * Dedicated proof of the "create a flow from a starter template" journey
 * (QA-CHECKLIST §12.1): picking a template in the New Flow modal instantiates a
 * flow pre-populated with the template's components, opens its editor, and
 * persists a non-empty graph named after the template.
 *
 * Exercised implicitly as a setup step across the suite (via loadTemplateByName)
 * but no spec asserted the behavior itself. Mirror of create-blank-flow.spec.ts
 * (#676): blank asserts a ZERO-node graph, this asserts the template's content
 * ARRIVED. Distinct from duplicate-flow.spec.ts (clone) and the JSON-import path.
 *
 * Uses "Basic Prompting" (not the Agent templates) to keep the canvas render
 * light and deterministic and avoid the Simple-Agent trace hang (#490). The real
 * flow id comes from the template-instantiation POST 201 (the canvas URL id is
 * transient on 1.11 — #505); loadTemplateByName returns it.
 */
const TEMPLATE_NAME = "Basic Prompting";

test.describe("Flow Functionality — Create Flow from Template", () => {
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

  test("user can create a flow from a starter template",
    { tag: ["@stable", "@release", "@regression", "@workspace"] },
    async ({ page, request }) => {
      await test.step("Open the templates modal and pick the Basic Prompting template", async () => {
        // loadTemplateByName captures the real flow id from the POST 201 and
        // resolves once canvas_controls_dropdown is visible (editor open).
        createdFlowId = await loadTemplateByName(page, TEMPLATE_NAME);
        expect(createdFlowId).toBeTruthy();
      });

      await test.step("Confirm the template's components loaded on the canvas", async () => {
        await expect(page.locator(".react-flow__node").first()).toBeVisible({
          timeout: 15000,
        });
        expect(
          await page.locator(".react-flow__node").count(),
        ).toBeGreaterThan(0);
      });

      await test.step("Confirm the persisted flow has the template's content and name", async () => {
        const authToken = await getAuthToken(request);
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/flows/${createdFlowId}`, {
                headers: { Authorization: authToken },
              });
              if (res.status() !== 200) return null;
              const flow = (await res.json()) as {
                name?: string;
                data?: { nodes?: unknown[] };
              };
              return {
                hasNodes: (flow.data?.nodes?.length ?? 0) > 0,
                nameMatches: (flow.name ?? "").includes(TEMPLATE_NAME),
              };
            },
            { timeout: 10000, intervals: [500, 1000, 2000] },
          )
          .toEqual({ hasNodes: true, nameMatches: true });
      });
    },
  );
});
