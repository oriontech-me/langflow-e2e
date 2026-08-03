import { expect } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";

// Spec doc: docs/core-functionality/a2a/a2a-server-agent-tab-try-it.md
//
// #1242 already proves JSON-RPC `message/send` end-to-end over `request.post()`.
// What HTTP-level coverage structurally cannot see is whether the UI wires itself
// to that endpoint at all: a panel that posts to the wrong URL, drops the reply, or
// never leaves "working" would leave all nine API assertions green.
//
// The flow is a Chat Input -> Chat Output passthrough, so the reply is deterministic
// — the sentinel comes back verbatim, with no LLM and no provider key in the path.

test.describe("A2A Server — Agent tab Try it panel @workspace @ui-ux @a2a", () => {
  test("the Try it panel round-trips a sentinel over the published endpoint @workspace @ui-ux @a2a", async ({
    page,
  }) => {
    const headers = { Authorization: await getAuthToken(page.request) };
    await requireA2aEnabled(page.request, headers);

    const flow = await createRunnableChatFlowViaApi(page.request, headers);
    const sentinel = `a2a-try-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      await openFlowById(page, flow.flowId);

      await test.step("publish through the UI to reach the panel", async () => {
        // Deliberately the UI path: the panel is only reachable from the state a user
        // actually reaches, and on a Draft flow `agent-transcript` renders a
        // publish-first placeholder instead of a conversation. The publish MECHANICS
        // are asserted in a2a-server-agent-tab-publish.spec.ts; here `Live` is a
        // precondition check, not the subject.
        await page.getByTestId("sidebar-nav-agent").click();
        await page.getByTestId("agent-publish-switch").click();

        // The status chip flips optimistically, so it is not proof the write landed;
        // the save fires PATCH /api/v1/flows/{id} and a send issued before that
        // response would hit an endpoint that is not published yet.
        const saved = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" &&
            new URL(res.url()).pathname === `/api/v1/flows/${flow.flowId}` &&
            res.status() === 200,
        );
        await page.getByTestId("agent-save").click();
        await saved;

        await expect(page.getByTestId("agent-status")).toHaveText("Live");
      });

      await test.step("send the sentinel from the panel", async () => {
        await page.getByTestId("agent-test-input").fill(sentinel);
        await page.getByTestId("agent-test-send").click();
      });

      await test.step("the transcript shows the turn reaching a terminal state", async () => {
        await expect(page.getByTestId("agent-transcript")).toContainText("completed");
      });

      await test.step("and the agent echoed the sentinel back", async () => {
        const transcript = await page.getByTestId("agent-transcript").innerText();

        // TWO occurrences is the load-bearing part: one is what a panel that renders
        // the user's own message and never receives a reply would produce. Counted
        // over the transcript text rather than asserted twice, since `toContainText`
        // is satisfied by a single occurrence.
        const occurrences = transcript.split(sentinel).length - 1;
        expect(occurrences, `transcript was:\n${transcript}`).toBe(2);

        // The reply must belong to the agent, not be a second echo of the user turn.
        expect(transcript.indexOf("Agent")).toBeLessThan(transcript.lastIndexOf(sentinel));
      });

      await test.step("the panel counts the turn and offers a reset", async () => {
        // Neither control carries a testid — both resolve by text.
        await expect(page.getByText("1 turn", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
      });
    } finally {
      await flow.deleteFlow();
    }
  });
});
