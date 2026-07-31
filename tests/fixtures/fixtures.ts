// tests/fixtures.ts
import { test as base, expect, type Page } from "@playwright/test";
import { classifyHttpError } from "./http-error-policy";
import {
  classifyFlowError,
  isUnreadableStream,
  runStreamSurface,
  type FlowErrorVerdict,
} from "./flow-error-policy";
import {
  attachRunStreamCapture,
  type CapturedStream,
} from "./run-stream-capture";

/**
 * How long a **v1** run-stream body may take to arrive.
 *
 * The pre-#1162 bound, kept. v1 bodies land in milliseconds; the two v1 surfaces
 * that stream (`text/event-stream`, `application/x-ndjson`) are read on a best
 * effort and counted as unevaluated when they do not close in time.
 *
 * There is deliberately no long budget here any more. Waiting longer for a body
 * is what #1168 proved cannot work: `response.text()` does not read a stream, it
 * asks Chromium for a buffer it may already have discarded. v2 does not use this
 * path at all — see `run-stream-capture.ts`.
 */
const V1_BODY_READ_TIMEOUT_MS = 2_000;

/**
 * The escape hatches this fixture bolts onto `page`.
 *
 * Specs reach them through `(page as any)` today; this type exists so the two
 * names are discoverable and spelled consistently.
 */
export type PageWithErrorHooks = Page & {
  /** Flow-execution errors are expected in this test — do not fail on them. */
  allowFlowErrors: () => void;
  /**
   * Backend HTTP errors are expected in this test — do not report them.
   *
   * For specs that drive an endpoint into a 4xx/5xx **on purpose**, including
   * the ones that mock one with `page.route` (`execution-error-notification`
   * fulfils a 503, `llm-invalid-api-key-ui` a 500). Since HTTP errors are
   * advisory (below), this suppresses log noise rather than a failure — which is
   * the point: the fixture's only real gate is a human reading that log, so a
   * deliberately-provoked error sitting in it makes the log less trustworthy,
   * not more (#1084).
   */
  allowHttpErrors: () => void;
};

// Extend test to log backend errors
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: Array<{
      url: string;
      status: number;
      statusText: string;
      responseBody?: string;
      type?: string;
    }> = [];
    /**
     * v2 flow errors, kept OUT of `errors` on purpose (#1162).
     *
     * `errors.length` feeds the `📋 Found N backend error(s)` line, and that line
     * is the human gate — checklist step 4, `CONTRIBUTING.md` step 5. Counting
     * advisories there would inflate the one number a reviewer scans with entries
     * that are explicitly not the thing it asks about, which works against the
     * same log trustworthiness #1084 was written to restore. They get their own
     * line instead.
     */
    const advisoryFlowErrors: Array<{ url: string; message: string }> = [];

    // Flag to allow flow errors (for tests that expect errors)
    let allowFlowErrors = false;
    // Same, for backend HTTP errors the test provokes deliberately.
    let allowHttpErrors = false;
    /**
     * Responses the policy chose not to report, by reason. Not printed unless
     * asked for: the Store 500s alone would put a line in every test's log, and
     * re-noising the log is exactly what #1084 was about. Set
     * `PW_HTTP_ERROR_DEBUG=1` to see them — useful when deciding whether the
     * ignore list is still right, or whether HTTP errors could start failing
     * tests (the open half of #1084).
     */
    const ignoredByPolicy = new Map<string, number>();
    /**
     * Run streams whose body never produced a verdict, by reason. A stream the
     * fixture could not read is UNKNOWN, not clean — and the most common reason
     * (the page aborting the stream on Stop / closing the playground) used to
     * return silently, so whether a run was evaluated at all came down to who won
     * a race nobody could see.
     */
    const unevaluatedStreams = new Map<string, number>();
    const countUnevaluated = (reason: string) =>
      unevaluatedStreams.set(reason, (unevaluatedStreams.get(reason) ?? 0) + 1);

    /**
     * Render a flow-error verdict. Shared, because the two surfaces reach it by
     * different routes: v1 through `response.text()` in the listener below, v2
     * through the CDP capture (#1168).
     */
    const reportFlowError = (
      url: string,
      verdict: Extract<FlowErrorVerdict, { failed: true }>,
      advisory: boolean,
    ) => {
      console.log(
        `🚨 Flow Error Detected in Event Stream - ${url}${advisory ? " (ADVISORY)" : ""}`,
      );
      console.log(`   Shape: ${verdict.shape}`);
      console.log(`   Error: ${verdict.message}`);
      if (advisory) {
        console.log(
          `   ADVISORY: this does NOT fail the test yet — the v2 run path is newly covered and 80 of the 89 run-driving specs have no page.allowFlowErrors() (#1165).`,
        );
        advisoryFlowErrors.push({ url, message: verdict.message });
        return;
      }
      errors.push({
        url,
        status: 200,
        statusText: "Flow Error",
        responseBody: verdict.message,
        type: "flow_error",
      });
    };

    /** A v2 stream the capture handed over — complete or cut short. */
    const judgeCapturedStream = (stream: CapturedStream) => {
      if (!stream.body) {
        countUnevaluated(
          stream.complete ? "empty body" : "stream cancelled before any data",
        );
        return;
      }
      const verdict = classifyFlowError(stream.body);
      if (verdict.failed) reportFlowError(stream.url, verdict, true);
    };

    // Add helper method to page context
    (page as any).allowFlowErrors = () => {
      allowFlowErrors = true;
    };
    (page as any).allowHttpErrors = () => {
      allowHttpErrors = true;
    };

    // Capture v2 run-stream bodies as they arrive. This is what makes the v2
    // verdict deterministic: the old `response.text()` path lost every run whose
    // stream outlived its test, which on the node-run path was all of them
    // (#1168).
    const runStreamCapture = await attachRunStreamCapture(
      page,
      judgeCapturedStream,
    );

    // Monitor API responses for errors
    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      // Report any backend 4xx/5xx the policy considers meaningful. The rules —
      // and the reason for each exemption — live in `http-error-policy.ts`,
      // where they are unit-tested; this used to be an inline list of four
      // status codes that silently missed 401/403/405/409/502/503 (#1084).
      const verdict = classifyHttpError({ url, status });
      if (!verdict.monitored) {
        // Only 4xx/5xx are worth accounting for. Counting every 2xx would put
        // "32× not an error status" in the debug breakdown and bury the entries
        // that answer the question it exists to answer.
        if (status >= 400) {
          ignoredByPolicy.set(
            verdict.ignoreReason,
            (ignoredByPolicy.get(verdict.ignoreReason) ?? 0) + 1,
          );
        }
      } else if (!allowHttpErrors) {
        console.log(
          `🚨 Backend Error: ${status} ${response.statusText()} - ${url}`,
        );
        // Recorded BEFORE the body is read, because reading it is an `await`
        // inside an async event handler and the fixture's teardown does not wait
        // for it. An error observed late in a test therefore raced the summary
        // below and could be dropped from the count — measured: a 405 fired at
        // the end of a test printed `🚨` with no `📋 Found N backend error(s)`
        // line at all. Since that summary is the whole gate for HTTP errors, an
        // undercount is the one failure this mechanism cannot afford (#1084).
        const entry: {
          url: string;
          status: number;
          statusText: string;
          responseBody?: string;
          type: string;
        } = {
          url,
          status,
          statusText: response.statusText(),
          type: "http_error",
        };
        errors.push(entry);
        try {
          entry.responseBody = await response.text();
          console.log(`   Response: ${entry.responseBody}`);
        } catch (e) {
          entry.responseBody = "Could not read response";
        }
      }

      // Monitor the v1 run-stream endpoints for execution errors. Which URLs
      // those are, and which shapes count as a failure, live in
      // `flow-error-policy.ts` where `npm run test:units` covers them — this used
      // to be an inline URL list plus an inline shape check (#1162).
      //
      // v2 does NOT come through here: its body is captured as it arrives, by
      // `run-stream-capture.ts`. Asking for a v2 body after the fact is the
      // failure #1168 is about — a run stream routinely outlives its test, and
      // Chromium has dropped the buffer by the time anyone asks.
      //
      // The read below is deliberately NOT awaited and NOT tracked anywhere.
      // Attaching any `.catch()` to it marks its rejection as handled, and the
      // intentional throw stops reaching the running test — measured, that turns
      // "interrupts in 238 ms" into "fails its teardown 10 249 ms later", which
      // re-creates the exact problem #1059 describes. A unit assertion pins it,
      // because it regressed once already.
      const surface =
        status === 200 ? runStreamSurface(url, response.request().method()) : null;
      if (surface === "v1") {
        void (async () => {
          try {
            const contentType = (
              response.headers()["content-type"] || ""
            ).toLowerCase();
            if (isUnreadableStream(contentType)) {
              countUnevaluated("unreadable content type");
              return;
            }

            const bodyTimeoutToken = Symbol("response-body-timeout");
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            let bodyResult: string | symbol;

            try {
              bodyResult = await Promise.race([
                response.text(),
                new Promise<symbol>((resolve) => {
                  timeoutId = setTimeout(
                    () => resolve(bodyTimeoutToken),
                    V1_BODY_READ_TIMEOUT_MS,
                  );
                  (timeoutId as unknown as { unref?: () => void }).unref?.();
                }),
              ]);
            } catch {
              // Usually the page aborting the stream (Stop, closing the
              // playground, navigating away). Counted, not silent: whether the
              // read won that race decided the verdict, which is not something a
              // suite should learn by accident.
              countUnevaluated("read failed (stream aborted?)");
              return;
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }

            if (bodyResult === bodyTimeoutToken) {
              countUnevaluated("read timed out");
              return;
            }
            if (!bodyResult) {
              countUnevaluated("empty body");
              return;
            }

            const verdict = classifyFlowError(bodyResult as string);
            if (!verdict.failed) return;
            reportFlowError(url, verdict, false);

            // Fail the running test, not just its teardown. The throw escapes
            // this async listener as an unhandled rejection, which Playwright
            // attributes to the test in flight.
            if (!allowFlowErrors) {
              const errorMessage =
                `Flow execution error detected during test:\n\n` +
                `URL: ${url}\n` +
                `Error: ${verdict.message}\n\n` +
                `If this error is expected, call page.allowFlowErrors() at the start of your test.`;

              (page as any).emit("pageerror", new Error(errorMessage));
              throw new Error(errorMessage);
            }
          } catch (e) {
            // Only ignore parsing errors, not our intentional throws
            if (e instanceof Error && e.message.includes("Flow execution error")) {
              throw e;
            }
          }
        })();
      }
    });

    await use(page);

    // Judge every v2 stream that was still open when the test ended. These are
    // exactly the ones the old path always lost — and they are judged on the
    // bytes that DID arrive, which is enough: an SSE error event lands long
    // before the stream closes, and `parseStreamEvents()` tolerates a truncated
    // tail. No waiting, because there is nothing left to wait for (#1168).
    for (const stream of await runStreamCapture.drain()) {
      judgeCapturedStream(stream);
    }
    if (!runStreamCapture.available) {
      // No CDP session, so the whole v2 surface went unwatched for this test.
      // Said out loud rather than left to read as a clean run (#1012).
      countUnevaluated("v2 capture unavailable (no CDP session)");
    }

    // Say it out loud: a run stream the fixture could not read means the
    // flow-error verdict for this test is UNKNOWN, not clean. Same rule as the
    // daily's runguard (#1012) — a verdict that cannot be produced must not read
    // as a pass. All four give-up paths funnel here; three of them used to be
    // silent, and one printed nothing at all.
    if (unevaluatedStreams.size > 0) {
      const breakdown = [...unevaluatedStreams.entries()]
        .map(([reason, count]) => `      ${count}× ${reason}`)
        .join("\n");
      console.log(
        `\n⚠️  run stream(s) NOT evaluated for flow-execution errors — this test's flow-error verdict is unknown, not clean:\n${breakdown}`,
      );
    }

    if (process.env.PW_HTTP_ERROR_DEBUG === "1" && ignoredByPolicy.size > 0) {
      const breakdown = [...ignoredByPolicy.entries()]
        .map(([reason, count]) => `      ${count}× ${reason}`)
        .join("\n");
      console.log(
        `\n🔎 HTTP responses ignored by policy (tests/fixtures/http-error-policy.ts):\n${breakdown}`,
      );
    }

    // New coverage on the v2 run path (#1162). Logged, never failing, until the
    // hatch audit — step 2 in `flow-error-policy.ts`. Printed on its own rather
    // than folded into the count below, which is the human gate for HTTP errors.
    if (advisoryFlowErrors.length > 0) {
      console.log(
        `\n   ⚠️  ${advisoryFlowErrors.length} flow execution error(s) on the v2 run path — ADVISORY: these do NOT fail the test yet. Review them before trusting this run.`,
      );
    }

    // Check for errors and fail test if not allowed
    if (errors.length > 0) {
      const flowErrors = errors.filter((e) => e.type === "flow_error");
      const httpErrors = errors.filter((e) => e.type === "http_error");

      console.log(`\n📋 Found ${errors.length} backend error(s) during test`);

      if (flowErrors.length > 0) {
        console.log(
          `   ⚠️  ${flowErrors.length} flow execution error(s) detected`,
        );
      }
      if (httpErrors.length > 0) {
        // Say what happens next, because nothing does. An HTTP error is logged
        // and never fails the test — on any path, for any endpoint — so the only
        // thing between a real backend 500 and a green run is someone reading
        // this line. Leaving that implicit is how the suite ended up with docs
        // claiming a gate it does not have (#1084).
        console.log(
          `   ⚠️  ${httpErrors.length} HTTP error(s) detected — ADVISORY: these do NOT fail the test. Review them before trusting this run.`,
        );
      }

      // Fail the test if flow errors occurred and weren't allowed
      if (flowErrors.length > 0 && !allowFlowErrors) {
        const errorDetails = flowErrors
          .map((e) => {
            const bodyPreview = e.responseBody
              ? e.responseBody.substring(0, 300)
              : "No response body";
            return `\n  - ${e.url}\n    ${bodyPreview}`;
          })
          .join("\n");

        throw new Error(
          `Test failed due to ${flowErrors.length} flow execution error(s):${errorDetails}\n\n` +
            `If this error is expected, call page.allowFlowErrors() at the start of your test.`,
        );
      }
    }
  },
});

export { expect };
