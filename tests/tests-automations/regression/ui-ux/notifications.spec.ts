import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Expand the currently focused node from minimized to full view. Chat Input
// defaults to `minimized = True`; without expanding, the run button rendered on
// the node body is not present in the DOM. Idempotent: if the node is already
// expanded (no `hide-node-content` in the DOM) the helper is a no-op.
async function expandFocusedNode(page: Page) {
  if ((await page.getByTestId("hide-node-content").count()) === 0) return;
  await page.getByTestId("more-options-modal").click();
  await expect(page.getByTestId("expand-button-modal")).toBeVisible({
    timeout: 10000,
  });
  await page.getByTestId("expand-button-modal").click();
  await expect(page.getByTestId("hide-node-content")).toHaveCount(0, {
    timeout: 5000,
  });
}

test(
  "User should be able to interact notifications tab",
  { tag: ["@stable", "@release", "@ui-ux"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();

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
