// tests/fixtures.ts
import { test as base, expect, type Page } from "@playwright/test";
import { classifyHttpError } from "./http-error-policy";
import {
  classifyFlowError,
  isUnreadableStream,
  runStreamSurface,
} from "./flow-error-policy";

/**
 * How long a run stream's body may take to arrive.
 *
 * An SSE run stream closes when the run does, so the old 2 s bound guaranteed a
 * miss on the endpoint that matters most (#1162). This is the per-test timeout
 * from `playwright.config.ts` minus a margin for teardown: a read that outlives
 * the test cannot produce a verdict anyway.
 */
const RUN_STREAM_READ_TIMEOUT_MS = 240_000;

/**
 * How long teardown waits for in-flight run-stream reads before rendering its
 * verdict. Bounded tightly on purpose: measured, the wait only pays off when a
 * stream closes on its own shortly after the test ends. When the app aborts it —
 * the common case — the read settles in under a second and this costs nothing;
 * when the backend is wedged, every extra second is paid by every such test and
 * buys no verdict. 15 s was measured at exactly 15 s of pure waste on a
 * never-closing stream.
 */
const PENDING_READ_DRAIN_MS = 3_000;

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
     * Run-stream body reads still in flight. Awaited (bounded) before the
     * teardown verdict: an SSE stream resolves late by construction, and the
     * previous code's only gate for such a read was a race it usually lost —
     * the same undercount hazard already documented for HTTP errors below.
     */
    const pendingBodyReads = new Set<Promise<void>>();
    /**
     * Run streams whose body never produced a verdict, by reason. A stream the
     * fixture could not read is UNKNOWN, not clean — and the most common reason
     * (the page aborting the stream on Stop / closing the playground) used to
     * return silently, so whether a run was evaluated at all came down to who won
     * a race nobody could see.
     */
    const unevaluatedStreams = new Map<string, number>();

    // Add helper method to page context
    (page as any).allowFlowErrors = () => {
      allowFlowErrors = true;
    };
    (page as any).allowHttpErrors = () => {
      allowHttpErrors = true;
    };

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

      // Monitor the run-stream endpoints for execution errors. Which URLs those
      // are, and which shapes count as a failure, live in `flow-error-policy.ts`
      // where `npm run test:units` covers them — this used to be an inline URL
      // list plus an inline shape check, and on 1.12.x neither could see a
      // playground run: it is `POST /api/v2/workflows` (in no list) served as
      // `text/event-stream` (skipped wholesale). An Anthropic 400 therefore
      // produced NO verdict at all, which is how #1059's failure ended up
      // attributed to a count assertion (#1162).
      const surface =
        status === 200 ? runStreamSurface(url, response.request().method()) : null;
      if (surface) {
        const bodyRead = (async () => {
        try {
          const headers = response.headers();
          const contentType = (headers["content-type"] || "").toLowerCase();
          if (isUnreadableStream(contentType)) {
            unevaluatedStreams.set(
              "unreadable content type",
              (unevaluatedStreams.get("unreadable content type") ?? 0) + 1,
            );
            return;
          }

          // An SSE run stream only closes when the run does, so 2 s is a
          // guaranteed miss for the endpoint that matters most. The read is
          // bounded by the spec's own patience instead, and the fixture waits for
          // in-flight reads before it renders a verdict (see below).
          const READ_BODY_TIMEOUT_MS = contentType.includes("text/event-stream")
            ? RUN_STREAM_READ_TIMEOUT_MS
            : 2000;
          const bodyTimeoutToken = Symbol("response-body-timeout");
          let responseBody: string | undefined;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;

          try {
            const bodyResult = await Promise.race([
              response.text(),
              new Promise<symbol>((resolve) => {
                timeoutId = setTimeout(
                  () => resolve(bodyTimeoutToken),
                  READ_BODY_TIMEOUT_MS,
                );
              }),
            ]);

            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }

            if (bodyResult === bodyTimeoutToken) {
              unevaluatedStreams.set(
                "read timed out",
                (unevaluatedStreams.get("read timed out") ?? 0) + 1,
              );
              return;
            }

            responseBody = bodyResult as string;
          } catch (bodyReadErr) {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }
            // The usual cause is the page aborting the stream (Stop, closing the
            // playground, navigating away) — Playwright then reports "No resource
            // with given identifier found". Counted, not silent: whether the read
            // won that race decided the verdict, which is not something a suite
            // should learn by accident.
            unevaluatedStreams.set(
              "read failed (stream aborted?)",
              (unevaluatedStreams.get("read failed (stream aborted?)") ?? 0) + 1,
            );
            return;
          }

          if (!responseBody) {
            unevaluatedStreams.set(
              "empty body",
              (unevaluatedStreams.get("empty body") ?? 0) + 1,
            );
            return;
          }

          const verdict = classifyFlowError(responseBody);
          if (!verdict.failed) return;

          // How strong the verdict may be depends on the surface — see
          // `runStreamSurface`. v1 keeps failing tests exactly as before; v2 is
          // new coverage and logs only, until the hatch audit in step 2.
          const advisory = surface === "v2";
          console.log(
            `🚨 Flow Error Detected in Event Stream - ${url}${advisory ? " (ADVISORY)" : ""}`,
          );
          console.log(`   Shape: ${verdict.shape}`);
          console.log(`   Error: ${verdict.message}`);
          if (advisory) {
            console.log(
              `   ADVISORY: this does NOT fail the test yet — the v2 run path is newly covered and 75 of the 88 run-driving specs have no page.allowFlowErrors() (#1162, step 2).`,
            );
          }

          errors.push({
            url,
            status: 200,
            statusText: "Flow Error",
            responseBody: verdict.message,
            type: advisory ? "flow_error_advisory" : "flow_error",
          });

          // Fail the running test, not just its teardown. The throw escapes this
          // async listener as an unhandled rejection, which Playwright attributes
          // to the test in flight — measured: 1.96 s to fail mid-test versus
          // 22.15 s when the rejection is swallowed and only teardown reports it.
          // Swallowing it re-created the very problem #1059 describes: the real
          // cause buried under a downstream timeout.
          if (!advisory && !allowFlowErrors) {
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
          if (
            e instanceof Error &&
            e.message.includes("Flow execution error")
          ) {
            throw e;
          }
          // Ignore parsing errors for event streams
        }
        })();
        // Only the v2 read is tracked for the teardown drain, and this is load
        // bearing rather than an optimisation: attaching ANY `.catch()` to
        // `bodyRead` marks its rejection as handled, and the intentional throw
        // above stops reaching the test. Measured — with the read tracked, a v1
        // error let the test run its full 10 s and failed only in teardown;
        // untracked, it interrupts in ~2 s, which is the behaviour specs have
        // always had. v2 never throws (it is advisory), so tracking it is safe,
        // and it is the only surface that needs draining: its SSE body resolves
        // late by construction, while a v1 JSON body lands in milliseconds.
        if (surface === "v2") {
          const tracked = bodyRead.catch(() => {});
          pendingBodyReads.add(tracked);
          void tracked.finally(() => pendingBodyReads.delete(tracked));
        }
      }
    });

    await use(page);

    // Let in-flight run-stream reads land before judging the test. Without this
    // the flow_error gate is decided by whether a body happened to resolve in
    // time, which for an SSE stream it usually did not (#1162).
    if (pendingBodyReads.size > 0) {
      const drained = await Promise.race([
        Promise.allSettled([...pendingBodyReads]).then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), PENDING_READ_DRAIN_MS),
        ),
      ]);
      if (!drained) {
        unevaluatedStreams.set(
          "read still in flight at teardown",
          (unevaluatedStreams.get("read still in flight at teardown") ?? 0) +
            pendingBodyReads.size,
        );
      }
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
      const advisoryFlowErrors = errors.filter(
        (e) => e.type === "flow_error_advisory",
      );
      if (advisoryFlowErrors.length > 0) {
        // New coverage on the v2 run path (#1162). Logged, not failing, until the
        // hatch audit — step 2 in `flow-error-policy.ts`.
        console.log(
          `   ⚠️  ${advisoryFlowErrors.length} flow execution error(s) on the v2 run path — ADVISORY: these do NOT fail the test yet. Review them before trusting this run.`,
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
