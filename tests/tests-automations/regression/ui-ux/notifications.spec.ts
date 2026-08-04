import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { expandFocusedNode } from "../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";

test.describe("Notifications tab", () => {
  let createdFlowId: string | null = null;

  // Before the first document load — the only point at which the assistant
  // onboarding tooltip can be suppressed, because upstream reads its flag once at
  // mount of the canvas-controls bar and then arms a 10 s timer. `expandFocusedNode`
  // asserts this ran; the probe it used to make instead fired ~2 s after that mount
  // and never saw the tooltip in 39 measured executions (#1220).
  test.beforeEach(async ({ page }) => {
    await seedAssistantDiscovered(page);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate home first so pending polling GETs for the flow settle before
      // the DELETE, avoiding spurious 404 fixture errors.
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "User should be able to interact notifications tab",
    { tag: ["@stable", "@release", "@ui-ux"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      // Capture the blank flow's id so afterEach can delete it id-scoped.
      const flowCreationPromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/v1/flows") &&
          resp.request().method() === "POST" &&
          resp.status() === 201,
        { timeout: 15000 },
      );
      await page.getByTestId("blank-flow").click();
      const creationResponse = await flowCreationPromise;
      createdFlowId = (await creationResponse.json()).id ?? null;

      // Add a Chat Input and run it to produce a "Flow built successfully"
      // notification. Text Input (the original trigger) is `legacy` on 1.10.0 and
      // hidden from the sidebar — Chat Input is the durable equivalent.
      await page.getByTestId("sidebar-search-input").fill("chat input");
      await page
        .getByTestId("input_outputChat Input")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-chat-input").click();
        });
      await expect(page.locator(".react-flow__node")).toHaveCount(1, {
        timeout: 10000,
      });

      // Chat Input is added minimized — expand it so the run button is in the DOM.
      await page.getByTestId("title-Chat Input").click();
      await expandFocusedNode(page);

      await page.getByTestId("button_run_chat input").click();
      await expect(page.getByText("built successfully").last()).toBeVisible({
        timeout: 30000,
      });

      await page.getByTestId("notification_button").click();

      await test.step("notifications tab shows the build-success entry", async () => {
        const notificationsText = page
          .getByText("Notifications", { exact: true })
          .last();
        await expect(notificationsText).toBeVisible({ timeout: 10000 });

        const trashIcon = page.getByTestId("icon-Trash2").last();
        await expect(trashIcon).toBeVisible();

        const builtSuccessfullyText = page
          .getByText("Flow built successfully", { exact: true })
          .last();
        await expect(builtSuccessfullyText).toBeVisible();
      });
    },
  );
});
