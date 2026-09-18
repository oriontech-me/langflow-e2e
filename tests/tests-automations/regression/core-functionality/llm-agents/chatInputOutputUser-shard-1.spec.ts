import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { clearCanvasBottomOverlay } from "../../../../helpers/ui/clear-canvas-bottom-overlay";

// The Output Inspection shortcut (`o`), against its contract in
// `NodeOutputfield` (see docs/core-functionality/llm-agents/chatInputOutputUser-shard-1.md).
//
// Rewritten for #1907 (Wave 9 T2 triage). The two inherited tests this file
// carried were green without asserting their subject: the first discarded three
// `isVisible()` booleans after a real OpenAI completion, and the second followed
// every `o` press with an un-awaited `getByText(...)` and ended on
// `expect(count).toBeGreaterThanOrEqual(0)`. The first is consolidated into the
// `@stable` `playground/output-modal-copy-button.spec.ts`; this one keeps its title
// and subject on a flow that needs no model and no network.
//
// Why a seeded flow now, when the previous header argued against one (#1675):
// `createRunnableChatFlowViaApi` hands back Chat Input -> Chat Output already
// expanded and connected, which is what makes the node ids and both branches of
// the shortcut deterministic. Its nodes carry an old `lf_version`, so the nightly
// can raise the "Flow needs review" banner in the canvas' bottom slot — cleared
// once at flow open, the shape `clearCanvasBottomOverlay` documents for seeded
// flows.

/** Every open output-inspection dialog: `${nodeId}-${outputName}-output-modal`. */
const OUTPUT_MODALS = '[data-testid$="-output-modal"]';

let removeFlow: ((request?: APIRequestContext) => Promise<void>) | undefined;

test.afterEach(async ({ page, request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit this binding.
  const remove = removeFlow;
  removeFlow = undefined;
  if (!remove) return;
  // Leave the editor first: an editor mounted over a deleted flow keeps polling
  // `GET /flows/{id}/events` and 404s into the backend-error log (#1288).
  await unmountEditorForCleanup(page);
  await remove(request).catch((error: unknown) => {
    console.warn(
      `chatInputOutputUser-shard-1: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

/** The canvas node carrying this title — never a text filter, which matches notes. */
function nodeByTitle(page: Page, title: string): Locator {
  return page
    .locator(".react-flow__node")
    .filter({ has: page.getByTestId(`title-${title}`) });
}

async function nodeIdByTitle(page: Page, title: string): Promise<string> {
  const node = nodeByTitle(page, title);
  await expect(node).toHaveCount(1);
  await expect(node).toHaveAttribute("data-id", /\S/);
  return (await node.getAttribute("data-id")) as string;
}

/**
 * The autosave write that carries `value`, armed before the edit that causes it.
 *
 * The node's run button executes the PERSISTED flow (measured on #1791), and the
 * autosave is debounced ~2 s behind the canvas, so a run clicked right after the
 * fill can execute the fixture's old input. Matching the payload, not just the
 * URL, keeps an unrelated write in flight from satisfying the wait.
 */
function flowWriteCarrying(page: Page, flowId: string, value: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/v1/flows/${flowId}` &&
      response.ok() &&
      (response.request().postData() ?? "").includes(value),
    { timeout: 60000 },
  );
}

/**
 * Selects the node, presses `o`, and asserts the ONE dialog that opens is this
 * node's `message` output, showing `value`; then closes it.
 */
async function expectShortcutOpensOutputOf(
  page: Page,
  title: string,
  nodeId: string,
  value: string,
): Promise<void> {
  await page.getByTestId(`title-${title}`).click();
  const selected = page.locator(".react-flow__node.selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("data-id", nodeId);

  await page.keyboard.press("o");

  const modalId = `${nodeId}-message-output-modal`;
  await expect(page.getByTestId(modalId)).toBeVisible({ timeout: 10000 });
  await expect(page.locator(OUTPUT_MODALS)).toHaveCount(1);

  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByTestId(modalId) });
  await expect(dialog.getByTestId("textarea")).toHaveValue(value);

  await dialog.getByTestId("btn-close-modal").click();
  await expect(page.locator(OUTPUT_MODALS)).toHaveCount(0, { timeout: 10000 });
}

test(
  "user must be able to see output inspection using 'o' shortcut",
  { tag: ["@stable", "@release", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const sentinel = `O-SHORTCUT-SENTINEL-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    let flowId = "";
    let chatInputId = "";
    let chatOutputId = "";

    await test.step("Create a Chat Input -> Chat Output flow over the API and open it", async () => {
      const bearer = await getAuthToken(request);
      const flow = await createRunnableChatFlowViaApi(request, {
        Authorization: bearer,
      });
      flowId = flow.flowId;
      removeFlow = flow.deleteFlow;

      await openFlowById(page, flowId);
      await expect(page.getByTestId("title-Chat Input")).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId("title-Chat Output")).toBeVisible({
        timeout: 30000,
      });
      await clearCanvasBottomOverlay(page, { allowAlreadyClear: true });

      chatInputId = await nodeIdByTitle(page, "Chat Input");
      chatOutputId = await nodeIdByTitle(page, "Chat Output");
    });

    await test.step("Type a sentinel into Chat Input and wait until the flow persisted it", async () => {
      const persisted = flowWriteCarrying(page, flowId, sentinel);
      await nodeByTitle(page, "Chat Input")
        .getByTestId("textarea_str_input_value")
        .fill(sentinel);
      await persisted;
    });

    await test.step("Run the flow and wait for both nodes to build", async () => {
      await page.getByTestId("button_run_chat output").click();
      // The duration badge renders only on a node's successful build.
      await expect(page.getByTestId("node_duration_chat input")).toBeVisible({
        timeout: 45000,
      });
      await expect(page.getByTestId("node_duration_chat output")).toBeVisible({
        timeout: 45000,
      });
    });

    await test.step("With no node selected, 'o' opens no output dialog", async () => {
      await page
        .locator(".react-flow__pane")
        .click({ position: { x: 10, y: 10 } });
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
      await page.keyboard.press("o");
      // Decided again in the next step: output dialogs close only on Close, so
      // one opened here would still be open there and break "exactly one".
      await expect(page.locator(OUTPUT_MODALS)).toHaveCount(0);
    });

    await test.step("Chat Input selected: 'o' opens the output that feeds its edge", async () => {
      await expectShortcutOpensOutputOf(page, "Chat Input", chatInputId, sentinel);
    });

    await test.step("Chat Output selected: 'o' opens the output of a node with no outgoing edge", async () => {
      await expectShortcutOpensOutputOf(
        page,
        "Chat Output",
        chatOutputId,
        sentinel,
      );
    });
  },
);
