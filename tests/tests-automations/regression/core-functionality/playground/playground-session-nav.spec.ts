import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Session creation (new-chat) and session switching (session-selector-trigger).
 *
 * Source files:
 *   chat-sidebar.tsx      — data-testid="new-chat", data-testid="session-selector"
 *   chat-sessions-dropdown.tsx — data-testid="session-selector-trigger"
 *
 * Overlap note: playground.spec.ts (line 127) also clicks new-chat and asserts
 * getByTitle("New Session 0"). That test is a monolithic integration spec without
 * @stable; this spec is the dedicated, isolated, @stable coverage for the same
 * behavior with different assertions (session-selector count). The header dropdown
 * (session-selector-trigger) is not covered anywhere else.
 */

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
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      const countBefore = await page.getByTestId("session-selector").count();

      await test.step("click new-chat and verify session count increases by one", async () => {
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
    "session selector dropdown must list sessions and switch to the selected one",
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

      await test.step("open the session selector dropdown and verify Default Session is listed", async () => {
        await page.getByTestId("session-selector-trigger").click();
        await expect(
          page.getByRole("menuitem", { name: "Default Session" }),
        ).toBeVisible({ timeout: 5000 });
      });

      await test.step("switch to Default Session and verify its messages are shown", async () => {
        await page.getByRole("menuitem", { name: "Default Session" }).click();
        await expect(page.getByText("default session message")).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByText("new session message")).toHaveCount(0);
      });
    },
  );
});
