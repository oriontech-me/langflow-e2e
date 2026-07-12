import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Rename availability is controlled server-side by:
 *   canRenameSession = !isDefaultSession && hasMessages
 *
 * When false, the rename-session-option element is not rendered in the DOM.
 * However, SelectContent (Radix) only renders its children when the menu is
 * open — there is no forceMount. The more-menu must be opened before asserting
 * the item's absence, otherwise the assertion is a false positive.
 *
 * The more-menu button uses a dynamic testid: session-{id}-more-menu.
 * We target it with the partial-match pattern ^session- + $-more-menu.
 */

test.describe("Playground – Session Rename (B2)", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "rename option must not be available for the Default Session",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          createdFlowId = await setupPlayground(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("input-chat-playground")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Open the more-menu and verify rename-session-option is absent for the Default Session",
        async () => {
          // canRenameSession = !isDefaultSession && hasMessages
          // isDefaultSession = true → showRename = false → item not rendered in DOM.
          // Menu must be open first: SelectContent only renders when open.
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .first()
            .click();
          await expect(page.getByTestId("rename-session-option")).toHaveCount(
            0,
          );
          await page.keyboard.press("Escape");
        },
      );
    },
  );

  test(
    "rename option must not be available for a session with no messages",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          createdFlowId = await setupPlayground(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("input-chat-playground")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step("Create a new session without sending any message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step(
        "Open the more-menu and verify rename-session-option is absent for a session with no messages",
        async () => {
          // canRenameSession = !isDefaultSession && hasMessages
          // hasMessages = false → showRename = false → item not rendered in DOM.
          // Menu must be open first: SelectContent only renders when open.
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .last()
            .click();
          await expect(page.getByTestId("rename-session-option")).toHaveCount(
            0,
          );
          await page.keyboard.press("Escape");
        },
      );
    },
  );

  test(
    "rename option must be available and functional for a session with messages",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          createdFlowId = await setupPlayground(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("input-chat-playground")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Create a new session and send a message to enable rename",
        async () => {
          await page.getByTestId("new-chat").click();
          await expect(page.getByTestId("input-chat-playground")).toBeVisible({
            timeout: 10000,
          });
          await page.getByTestId("input-chat-playground").fill("hello rename test");
          await page.getByTestId("button-send").click();
          await expect(page.getByTestId("input-chat-playground")).toHaveValue(
            "",
            { timeout: 15000 },
          );
        },
      );

      await test.step(
        "Wait until the new session's message is durably persisted server-side",
        async () => {
          // The rename option is enabled from the client-side React Query
          // message cache, which the build stream fills BEFORE the messages are
          // committed to the DB. The rename endpoint
          // (PATCH /api/v1/monitor/messages/session/{old}) reads the DB and
          // 404s when no rows exist for {old} yet — on 404 the frontend keeps
          // the old name (toast only), so the renamed label never appears and
          // the assertion below times out. This is the #637 flake. Poll the
          // SAME table the PATCH reads (GET /api/v1/monitor/messages) until the
          // new session's message is queryable, sequencing the rename against
          // real persistence instead of widening a timeout. The new session's
          // rows carry a session_id other than the flow id (the Default
          // Session).
          await expect
            .poll(
              async () => {
                const resp = await page.request.get(
                  `/api/v1/monitor/messages?flow_id=${createdFlowId}`,
                );
                if (!resp.ok()) return 0;
                const messages = (await resp.json()) as Array<{
                  session_id: string;
                }>;
                return messages.filter(
                  (m) => m.session_id !== createdFlowId,
                ).length;
              },
              { timeout: 15000, intervals: [250, 500, 1000] },
            )
            .toBeGreaterThan(0);
        },
      );

      await test.step(
        "Open the session more-menu and verify rename option is available",
        async () => {
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .last()
            .click();
          await expect(
            page.getByTestId("rename-session-option"),
          ).toBeVisible({ timeout: 5000 });
        },
      );

      await test.step(
        "Rename the session and confirm with Enter",
        async () => {
          await page.getByTestId("rename-session-option").click();
          await page.getByTestId("session-rename-input").fill("my renamed session");
          await page.keyboard.press("Enter");
          await expect(
            page.getByTestId("session-selector").getByText("my renamed session"),
          ).toBeVisible({ timeout: 5000 });
        },
      );

      await test.step(
        "Open rename again and cancel with Escape — name must be preserved",
        async () => {
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .last()
            .click();
          await page.getByTestId("rename-session-option").click();
          await page.getByTestId("session-rename-input").fill("discarded name");
          await page.keyboard.press("Escape");
          await expect(
            page.getByTestId("session-selector").getByText("my renamed session"),
          ).toBeVisible({ timeout: 5000 });
        },
      );
    },
  );
});
