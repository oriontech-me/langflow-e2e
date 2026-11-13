import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Overlap: playground.spec.ts also clicks new-chat but is a monolithic, non-@stable spec; this is the dedicated @stable coverage with independent assertions.
// Session switching is tested via sidebar click (session-selector); the header dropdown (session-selector-trigger) only exists in the fullscreen playground, not in the IOModal.

test.describe.configure({ mode: "serial" });

// The run behind a send is `POST /api/v2/workflows`, and it can leave the page
// well after the click: `button-stop` is hidden before the run starts too, so
// it is not a completion signal on its own. Clicking `new-chat` while the
// previous run is still in flight drops the next send or sends it empty (#2418),
// so each send waits for its own run's stream to end.
async function sendAndAwaitRun(page: Page, text: string): Promise<string> {
  const run = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v2/workflows",
    { timeout: 30000 },
  );
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  const response = await run;
  const body = response.request().postDataJSON() as { input_value?: string; session_id?: string };
  expect(body.input_value, "the run must carry the text that was typed").toBe(text);
  await response.finished();
  await expect(page.getByTestId(`chat-message-User-${text}`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("button-stop").last()).toBeHidden({ timeout: 30000 });
  return body.session_id ?? "";
}

test.describe("Playground – Session Creation and Navigation", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "new-chat button must add a new session entry to the sidebar",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("click new-chat and verify session count increases by one", async () => {
        const countBefore = await page.getByTestId("session-selector").count();
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("session-selector")).toHaveCount(
          countBefore + 1,
          { timeout: 5000 },
        );
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
      });
    },
  );

  test(
    "session selector sidebar must switch to the selected session",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("send a message in the Default session", async () => {
        const sessionId = await sendAndAwaitRun(page, "default session message");
        expect(sessionId, "the Default session is the flow id").toBe(createdFlowId);
      });

      await test.step("create a new session and send a distinct message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        const sessionId = await sendAndAwaitRun(page, "new session message");
        expect(sessionId, "the new chat must not reuse the Default session").not.toBe(createdFlowId);
      });

      await test.step("click the Default Session sidebar entry and verify its messages are shown", async () => {
        await page
          .getByTestId("session-selector")
          .filter({ hasText: "Default Session" })
          .click();
        // Use the user-bubble test ID (chat-message-User-{text}) to avoid matching the echoed AI reply.
        await expect(page.getByTestId("chat-message-User-default session message")).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("chat-message-User-new session message")).toHaveCount(0);
      });
    },
  );
});
