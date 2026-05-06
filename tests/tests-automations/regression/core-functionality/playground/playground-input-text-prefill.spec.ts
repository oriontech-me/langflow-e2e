import { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Pre-fill behavior of the Playground textarea driven by the ChatInput
 * node's "Input Text" field (`input_value`).
 *
 * The pre-fill effect lives in `flow-page-sliding-container.tsx` and writes
 * the ChatInput template's `input_value` into the playground textarea
 * whenever `chatHistory.length === 0`. If this effect breaks, users lose the
 * pre-fill UX silently — none of the existing playground specs verify the
 * initial textarea value because they all call `.fill()` immediately.
 *
 * The Input Text field has no exposed canvas UI when the node is collapsed
 * (ChatInput defaults to `minimized = True`), so we set `input_value` by
 * intercepting the GET /api/v1/flows/{id} response and injecting the value
 * into the node template before the canvas renders. Same technique used by
 * `webhook-component-regression.spec.ts`.
 */

const PREFILL_VALUE = "prefill message";

async function injectChatInputValue(
  page: Page,
  flowId: string,
  value: string,
): Promise<void> {
  await page.route(`**/api/v1/flows/${flowId}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const chatInputNode = (json?.data?.nodes ?? []).find(
      (n: any) => n?.data?.type === "ChatInput",
    );
    if (chatInputNode) {
      chatInputNode.data.node.template.input_value.value = value;
    }
    await route.fulfill({ json });
  });
}

async function setupFlowWithPrefill(page: Page): Promise<string> {
  const flowId = await setupPlayground(page);
  // Wait for the autosave debounce to flush the ChatInput → ChatOutput
  // connection to the database before we reload with the injected template.
  await page.waitForTimeout(4000);
  await injectChatInputValue(page, flowId, PREFILL_VALUE);
  await page.reload();
  await page.waitForSelector('[data-testid="playground-btn-flow-io"]', {
    timeout: 30000,
  });
  return flowId;
}

test.describe.configure({ mode: "serial" });

test.describe("Playground – Input Text Pre-fill Behavior", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "playground opens with chat textarea pre-filled from ChatInput Input Text",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up flow with Input Text and open playground", async () => {
        createdFlowId = await setupFlowWithPrefill(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("textarea must hold the pre-filled value with no user input", async () => {
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toHaveValue(PREFILL_VALUE, { timeout: 10000 });
      });
    },
  );

  test(
    "creating a new session re-applies the Input Text pre-fill",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up flow with Input Text and open playground", async () => {
        createdFlowId = await setupFlowWithPrefill(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toHaveValue(PREFILL_VALUE, { timeout: 15000 });
      });

      await test.step("send the pre-filled message so chat history becomes non-empty", async () => {
        await page.getByTestId("button-send").last().click();
        await expect(
          page.getByTestId("chat-message-User-" + PREFILL_VALUE),
        ).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });

      await test.step("create a new session and verify the textarea is pre-filled again", async () => {
        await page.getByTestId("new-chat").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toHaveValue(PREFILL_VALUE, { timeout: 10000 });
      });
    },
  );

  test(
    "pre-filled value is sent as the first message of the session",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up flow with Input Text and open playground", async () => {
        createdFlowId = await setupFlowWithPrefill(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toHaveValue(PREFILL_VALUE, { timeout: 15000 });
      });

      await test.step("send without typing and verify the pre-filled value reaches the chat", async () => {
        await page.getByTestId("button-send").last().click();
        await expect(page.getByTestId("div-chat-message").first()).toBeVisible({
          timeout: 15000,
        });
        await expect(
          page.getByTestId("chat-message-User-" + PREFILL_VALUE),
        ).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });
    },
  );
});
