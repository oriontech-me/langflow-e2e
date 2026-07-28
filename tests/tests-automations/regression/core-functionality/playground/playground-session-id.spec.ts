import { randomUUID } from "node:crypto";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The Playground has no free-text session_id input, and has not had one since the
// modal playground was replaced by the sliding sidebar (upstream 126c037aa0,
// pre-1.8): the `popover-anchor-input-session_id` this spec used to fill is the
// generic node-parameter renderer for ChatInput's `session_id`, an advanced field
// reachable only through `inspector-add-session_id`. The surface a user has for
// naming a session today is the session list — New chat plus Rename — so that is
// what this spec covers, asserting what the rename does to the stored data rather
// than what it does to a label (#994).
test.describe("Playground — Session ID", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate to home before deleting to stop background browser requests
      // for the current flow; without this, pending polling GETs complete
      // after the DELETE and trigger spurious 404 fixture errors.
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "a session renamed in the playground is the session its messages are stored under",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      const customSessionId = `e2e-session-${randomUUID().slice(0, 8)}`;
      let autoSessionId = "";

      type StoredMessage = { session_id: string; text: string };

      /**
       * Every message the flow has produced, straight from the database, or
       * `null` when the read itself did not answer 200.
       *
       * The null is what makes this callable from inside `expect.poll`:
       * Playwright runs the poll generator OUTSIDE its retry try/catch
       * (`matchers/expect.js` → `pollMatcher`), so a generator that throws
       * aborts the poll instead of retrying it. A single transient 500 from a
       * container running the whole suite in parallel would then fail this test
       * outright — the saturation signature behind #549/#553. Same shape as
       * `playground-session-rename`'s persistence gate.
       */
      const readMessages = async (): Promise<StoredMessage[] | null> => {
        const response = await page.request.get(
          `/api/v1/monitor/messages?flow_id=${createdFlowId}`,
        );
        if (!response.ok()) return null;
        return (await response.json()) as StoredMessage[];
      };

      /** Same read, for the assertions that must not tolerate a failed GET. */
      const readMessagesOrFail = async (): Promise<StoredMessage[]> => {
        const messages = await readMessages();
        if (messages === null) {
          throw new Error(
            `GET /api/v1/monitor/messages?flow_id=${createdFlowId} did not answer 200.`,
          );
        }
        return messages;
      };

      const sendMessage = async (text: string) => {
        const botBubblesBefore = await page
          .getByTestId("div-chat-message")
          .count();
        await page.getByTestId("input-chat-playground").fill(text);
        await page.getByTestId("button-send").click();
        await expect(page.getByTestId("input-chat-playground")).toHaveValue("", {
          timeout: 15000,
        });
        await expect(page.getByTestId("button-stop")).toBeHidden({
          timeout: 30000,
        });
        // The two gates above do not prove the run produced anything: the input
        // is cleared optimistically on send, and `toBeHidden` passes trivially
        // when the stop button never rendered. Without this the session
        // assertions downstream report "0 messages persisted" for a flow that
        // simply never executed, which names the wrong culprit.
        // `div-chat-message` is rendered by `bot-message.tsx` only (the user
        // bubble does not carry it), so one more of them IS the flow's answer.
        await expect(page.getByTestId("div-chat-message")).toHaveCount(
          botBubblesBefore + 1,
          { timeout: 30000 },
        );
      };

      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("create a session and send the first message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 10000,
        });
        await sendMessage("first message");
      });

      await test.step(
        "wait until that message is durably persisted, and record its session ID",
        async () => {
          // The rename endpoint (PATCH /api/v1/monitor/messages/session/{old})
          // reads the DB and 404s when no row exists for {old} yet, while the
          // rename affordance is enabled from the client-side message cache the
          // build stream fills first. On 404 the frontend keeps the old name and
          // only toasts, so the rename silently does nothing. Sequence against
          // real persistence instead of a timeout — this is the #637 flake.
          // The new session's rows carry a session_id other than the flow id
          // (which is the Default Session).
          await expect
            .poll(
              async () =>
                (await readMessages())?.filter(
                  (message) => message.session_id !== createdFlowId,
                ).length ?? 0,
              { timeout: 20000, intervals: [250, 500, 1000] },
            )
            .toBeGreaterThan(0);

          const persisted = (await readMessagesOrFail()).find(
            (message) => message.session_id !== createdFlowId,
          );
          autoSessionId = persisted?.session_id ?? "";
          expect(autoSessionId).not.toBe("");
          expect(autoSessionId).not.toBe(customSessionId);
        },
      );

      await test.step("rename the session to a custom ID", async () => {
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .last()
          .click();
        await page.getByTestId("rename-session-option").click();
        await page.getByTestId("session-rename-input").fill(customSessionId);
        await page.keyboard.press("Enter");
        await expect(
          page.getByTestId("session-selector").getByText(customSessionId),
        ).toBeVisible({ timeout: 10000 });
      });

      await test.step(
        "the already-sent message is re-keyed under the custom session ID",
        async () => {
          // The rename is a backend write, so assert on the database rather than
          // on the label the previous step already waited for: a rename that only
          // repainted the sidebar would pass there and fail here.
          await expect
            .poll(
              async () =>
                (await readMessages())?.filter(
                  (message) => message.session_id === customSessionId,
                ).length ?? 0,
              { timeout: 15000, intervals: [250, 500, 1000] },
            )
            .toBeGreaterThan(0);

          const messages = await readMessagesOrFail();
          expect(
            messages.filter((message) => message.session_id === autoSessionId),
          ).toHaveLength(0);
          expect(
            messages.filter(
              (message) => message.session_id !== customSessionId,
            ),
          ).toHaveLength(0);
        },
      );

      await test.step(
        "a message sent afterwards is stored under the custom session ID too",
        async () => {
          await sendMessage("second message");

          await expect
            .poll(
              async () =>
                (await readMessages())?.find(
                  (message) => message.text === "second message",
                )?.session_id ?? "not persisted yet",
              { timeout: 20000, intervals: [250, 500, 1000] },
            )
            .toBe(customSessionId);
        },
      );

      await test.step(
        "the flow reports exactly one session, the one the user named",
        async () => {
          const response = await page.request.get(
            `/api/v1/monitor/messages/sessions?flow_id=${createdFlowId}`,
          );
          expect(response.ok()).toBe(true);
          expect(await response.json()).toEqual([customSessionId]);
        },
      );
    },
  );
});
