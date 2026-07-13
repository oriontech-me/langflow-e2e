import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Transport-level proof that a Playground run is delivered over Server-Sent
 * Events (SSE): the browser consumes a `text/event-stream` response from the
 * workflow-execution endpoint, the user message renders, and the run completes.
 *
 * Streaming was previously exercised only implicitly by `playground-ux.spec.ts`,
 * which asserts UX behaviors (instant user echo, auto-scroll, input readiness)
 * but never the SSE transport itself. This spec is the dedicated transport proof
 * for QA-CHECKLIST §9.1 "Response streaming (SSE)".
 *
 * Deterministic by design: a ChatInput → ChatOutput echo flow (no LLM) exercises
 * the streaming transport without any provider key. On 1.11 the Playground run
 * hits `POST /api/v2/workflows`, which streams the result as `text/event-stream`
 * (legacy fallback: `/api/v1/build/{job_id}/events`). The transport is matched by
 * content-type, not a fixed URL, so an upstream path move does not silently
 * defeat the assertion. Progressive token-by-token LLM rendering is out of scope.
 */
test.describe("Playground — Response Streaming (SSE)", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("Playground run is delivered over an SSE (text/event-stream) response",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      // The Playground run is streamed over SSE from the workflow-execution
      // endpoint (POST /api/v2/workflows on 1.11; legacy /build/{job}/events on
      // v1). Match the run endpoint transport-level, not URL-exact — the editor's
      // own /api/v1/flows/{id}/events polling (JSON) must not match here.
      const runSseEndpoint = /\/api\/v2\/workflows\b|\/build\/.*\/events/;
      const runContentTypes: string[] = [];

      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);

        // Install the SSE collector before triggering the run.
        page.on("response", (response) => {
          if (runSseEndpoint.test(response.url())) {
            runContentTypes.push(response.headers()["content-type"] ?? "");
          }
        });

        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send message and confirm it renders in chat", async () => {
        const userMessage = "Streaming SSE transport check";
        await page.getByTestId("input-chat-playground").last().fill(userMessage);
        await page.getByTestId("button-send").last().click();

        await expect(page.getByText(userMessage).last()).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("Wait for the run to complete", async () => {
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeEnabled({ timeout: 15000 });
      });

      await test.step("Assert the run was delivered over an SSE (text/event-stream) response", async () => {
        await expect
          .poll(
            () =>
              runContentTypes.some((ct) => ct.includes("text/event-stream")),
            { timeout: 10000 },
          )
          .toBe(true);
      });
    },
  );
});
