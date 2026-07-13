import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

// Id of the flow the running test created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively building mid-run (#515/#589).
let createdFlowId: string | undefined;

/**
 * Clear chat is available via chat-header-more-menu (not the session more-menu).
 * The option fires clearDefaultSession directly — no confirmation dialog.
 */

async function setupChatEchoFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });

  // Capture the id from the flow-creation POST so teardown can delete only this
  // flow (scoped), NOT from the canvas URL: the URL id is a transient
  // client-side handle on this Langflow version and does not match the
  // persisted flow (deleting it 404s and silently leaks the real one).
  const flowCreation = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByTestId("blank-flow").click();
  const created = (await (await flowCreation).json()) as { id?: string };
  if (!created.id) {
    throw new Error("blank-flow creation returned no flow id");
  }
  createdFlowId = created.id;

  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  await page.getByTestId("sidebar-search-input").fill("chat input");
  await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Input")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

async function openPlayground(page: Page): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground")).toBeVisible({
    timeout: 15000,
  });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").fill(text);
  await page.getByTestId("button-send").click();
  await expect(page.getByTestId("input-chat-playground")).toHaveValue("", {
    timeout: 15000,
  });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 15000 });
}

test.describe("Playground – Clear Session History", () => {
  test.afterEach(async ({ page }) => {
    const flowId = createdFlowId;
    createdFlowId = undefined;
    if (!flowId) return;

    // Delete ONLY the flow this test created (scoped teardown, #515/#589).
    // Navigate off the editor first so the unmounted flow page stops polling
    // the flow we are about to delete, then pass an explicit auth header —
    // page.request is unauthenticated under AUTO_LOGIN and would 401 otherwise.
    // Not swallowed: a failed cleanup surfaces instead of silently leaking.
    await page.goto("/");
    const authHeader = await getAuthToken(page.request);
    const opts = authHeader
      ? { headers: { Authorization: authHeader } }
      : undefined;
    await deleteFlow(page.request, flowId, opts);
  });

  test(
    "clear-chat removes all messages from Default Session",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await openPlayground(page);
        },
      );

      await test.step("Send a message and wait for bot response", async () => {
        await sendMessage(page, "hello clear test");
        await expect(page.getByTestId("div-chat-message")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Assert at least one message exists (pre-condition)", async () => {
        const count = await page.getByTestId("div-chat-message").count();
        expect(count).toBeGreaterThanOrEqual(1);
      });

      await test.step("Open chat header more-menu", async () => {
        // Native element click via evaluate bypasses the framer-motion overlay
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("clear-chat-option")).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step(
        "Click clear-chat-option and assert all messages are removed",
        async () => {
          await page.getByTestId("clear-chat-option").click();
          await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
            timeout: 8000,
          });
        },
      );
    },
  );
});
