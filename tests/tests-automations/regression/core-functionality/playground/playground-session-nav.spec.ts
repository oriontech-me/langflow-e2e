import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

// Overlap: playground.spec.ts also clicks new-chat but is a monolithic, non-@stable spec; this is the dedicated @stable coverage with independent assertions.
// Session switching is tested via sidebar click (session-selector); the header dropdown (session-selector-trigger) only exists in the fullscreen playground, not in the IOModal.

test.describe.configure({ mode: "serial" });

test.describe("Playground – Session Creation and Navigation", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "new-chat button must add a new session entry to the sidebar",
    { tag: ["@regression", "@playground"] },
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
        await page.getByTestId("input-chat-playground").last().fill("default session message");
        await page.getByTestId("button-send").last().click();
        await expect(page.getByText("default session message").last()).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });

      await test.step("create a new session and send a distinct message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await page.getByTestId("input-chat-playground").last().fill("new session message");
        await page.getByTestId("button-send").last().click();
        await expect(page.getByText("new session message").last()).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
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
