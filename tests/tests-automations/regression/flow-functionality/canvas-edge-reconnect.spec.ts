import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { separateOverlappingNodes } from "../../../helpers/ui/separate-overlapping-nodes";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.3 — Delete an edge / reconnect an existing edge.
 *
 * The persisted flow is the final witness in both directions: an edge removed
 * from the canvas but left in `data.edges` reappears on reload, and a recreated
 * edge that never persists is lost the same way.
 *
 * Creating a first connection (and rejecting incompatible ones) is
 * `canvas-connect-components.spec.ts`. The inherited third test here — delete
 * and reconnect "multiple times" — was dropped: repeating the same two
 * assertions adds runtime, not signal.
 */

const CHAT_INPUT_SOURCE = "handle-chatinput-noshownode-chat message-source";
const CHAT_OUTPUT_TARGET = "handle-chatoutput-noshownode-inputs-target";

test.describe("Canvas — deleting and recreating an edge", () => {
  let createdFlowId: string | null = null;

  /** Edges as the backend currently has them. */
  async function fetchEdges(
    request: import("@playwright/test").APIRequestContext,
    flowId: string,
  ) {
    const bearer = await getAuthToken(request);
    const response = await request.get(`/api/v1/flows/${flowId}`, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    return (body?.data?.edges ?? []) as unknown[];
  }

  test.beforeEach(async ({ page, request }) => {
    createdFlowId = await setupBlankFlow(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    await addComponentFromSidebar(
      page,
      "chat input",
      "add-component-button-chat-input",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 30000,
    });
    await addComponentFromSidebar(
      page,
      "chat output",
      "add-component-button-chat-output",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 30000,
    });
    // Sidebar-added components land stacked; separate them so the handle
    // clicks below are not intercepted by the top node.
    await separateOverlappingNodes(page);

    await page.getByTestId(CHAT_INPUT_SOURCE).click();
    await page.getByTestId(CHAT_OUTPUT_TARGET).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 10000,
    });

    // Gate on server truth before the delete assertions: without this a test
    // could "prove" the edge is gone from a flow that never held it.
    await expect
      .poll(async () => (await fetchEdges(request, createdFlowId!)).length, {
        timeout: 30000,
        message: "the edge should be persisted before it is deleted",
      })
      .toBe(1);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("deleting an edge from its context menu removes it from the canvas and the flow",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Delete the edge through its context menu", async () => {
        await page
          .getByTestId("edge-context-menu-trigger")
          .click({ button: "right" });
        await page.getByTestId("context-menu-item-destructive").click();
        await expect(edges).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("The edge is gone from the flow too", async () => {
        await expect
          .poll(
            async () => (await fetchEdges(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the deleted edge should be gone from the flow",
            },
          )
          .toBe(0);
      });
    },
  );

  test("an edge can be recreated after it is deleted",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Delete the edge", async () => {
        await page
          .getByTestId("edge-context-menu-trigger")
          .click({ button: "right" });
        await page.getByTestId("context-menu-item-destructive").click();
        await expect(edges).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("Connect the same two handles again", async () => {
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("The recreated edge reached the backend", async () => {
        await expect
          .poll(
            async () => (await fetchEdges(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the recreated edge should be persisted to the flow",
            },
          )
          .toBe(1);
      });
    },
  );
});
