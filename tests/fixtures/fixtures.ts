// tests/fixtures.ts
import { test as base, expect, type Page } from "@playwright/test";
import {
  classifyHttpError,
  type KnownHttpDefect,
} from "./http-error-policy";
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
 * How long to keep waiting for a declared known defect that has not fired yet,
 * before calling the declaration stale (#1008).
 *
 * The stale check runs in fixture teardown, and `page.on("response")` is an
 * event: a response the page issued in the last moments of the test body can
 * still be in flight when the synchronous tail of the teardown runs, leaving the
 * hit count at 0 for a defect that did occur. The failure that produces is
 * particularly bad — it says "the defect is gone, delete the declaration" about a
 * defect that is still there.
 *
 * Waiting is nearly free because the cost is only ever paid on a run that is
 * *about to fail anyway*: a declaration that already fired never enters the loop.
 * Same trade as the backend health gate's 420 s deadline — over-waiting only
 * spends time on a lane already headed for a red.
 */
const STALE_DECLARATION_GRACE_MS = 1_000;

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
  /**
   * Declare ONE backend error this test expects, from a known and filed defect.
   *
   * The narrow counterpart to `allowHttpErrors()`, added for #1008: the
   * destructive test in `folder-deletion-integrity.spec.ts` has to reach the
   * zero-project state, where the frontend fires `GET /api/v1/projects/undefined`
   * and the backend correctly answers `422`. Silencing the whole test would also
   * have silenced `DELETE /api/v1/projects/{id}` → 500 (#965/LE-2020), which its
   * own delete loop can produce and which is worth seeing.
   *
   * The declaration is **verified**: a declared defect that does not fire fails
   * the test, naming the declaration to delete. That is the point — an exemption
   * whose justification has expired is the thing #1084 was raised about, and a
   * printed warning would be one more line nobody reads.
   *
   * Call it **before** the test reaches the state that fires the defect —
   * declarations are not retroactive, so a late call gets the worst of both: the
   * response already reported as an error, and the declaration counted as stale.
   *
   * Declaring the same `(pathname, status)` twice is harmless: every matching
   * declaration is credited, so a shared helper and an inline call cannot leave
   * one of them looking stale.
   */
  expectKnownHttpError: (defect: KnownHttpDefect) => void;
};

// Extend test to log backend errors
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
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
     * Known, filed product defects this test declared it expects (#1008), and how
     * many times each was actually seen.
     *
     * Kept as a parallel count map rather than a mutable field on the declaration
     * so the objects a spec passes in are never written to — a spec is free to
     * hoist one to module scope and share it between tests, and a per-test count
     * must not leak across them.
     */
    const declaredDefects: KnownHttpDefect[] = [];
    const declaredDefectHits = new Map<KnownHttpDefect, number>();
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
    (page as any).expectKnownHttpError = (defect: KnownHttpDefect) => {
      declaredDefects.push(defect);
      declaredDefectHits.set(defect, 0);
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
      const verdict = classifyHttpError({ url, status }, declaredDefects);
      if (!verdict.monitored) {
        if ("knownDefect" in verdict) {
          // Printed on the FIRST occurrence only, and never with the `🚨 Backend
          // Error` prefix — that string is what the deterministic pipeline's
          // VALIDATE gate greps for (`runners.ts` → `backendErrors`), and this
          // response is precisely the one the gate must stop hard-stopping on.
          // The occurrence count goes in the teardown summary instead: a defect
          // that fires 40× is a different observation from one that fires once,
          // and 40 identical lines is the noise #1084 was raised about.
          //
          // Credited to EVERY declaration this response matches, not only the
          // one `classifyHttpError` returned. That function resolves with
          // `find()`, so two declarations of the same (pathname, status) — a
          // helper that declares plus an inline call, the same defect declared
          // in `beforeEach` and again in the body — are distinct objects and
          // only the first would ever be credited. The second would then be
          // reported stale and FAIL a test whose defect did fire, with a message
          // saying the opposite of what happened. Matching on the declaration's
          // own `pathname` rather than re-parsing the URL: the policy already
          // proved they are equal, and re-parsing is a second place to disagree.
          const matched = declaredDefects.filter(
            (candidate) =>
              candidate.status === status &&
              candidate.pathname === verdict.knownDefect.pathname,
          );
          const firstOccurrence = matched.every(
            (candidate) => (declaredDefectHits.get(candidate) ?? 0) === 0,
          );
          for (const candidate of matched) {
            declaredDefectHits.set(
              candidate,
              (declaredDefectHits.get(candidate) ?? 0) + 1,
            );
          }
          if (firstOccurrence) {
            console.log(
              `📌 Known backend defect (declared by this test): ${status} ${response.statusText()} - ${url}`,
            );
            console.log(`   ${verdict.knownDefect.reason}`);
          }
        } else if (status >= 400) {
          // Only 4xx/5xx are worth accounting for. Counting every 2xx would put
          // "32× not an error status" in the debug breakdown and bury the entries
          // that answer the question it exists to answer.
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

    // Account for every declared known defect (#1008). A declaration is a claim
    // about the product — "this filed bug still fires here" — so it is checked
    // like one, in both directions.
    for (const defect of declaredDefects) {
      const hits = declaredDefectHits.get(defect) ?? 0;
      if (hits > 0) {
        console.log(
          `\n📌 ${hits}× declared known backend defect: ${defect.status} ${defect.pathname} — NOT counted as a backend error.\n   ${defect.reason}`,
        );
      }
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

    // A declared known defect that did NOT fire (#1008). Last, so it can never
    // pre-empt the summary above or the flow-error throw, both of which say more
    // about the run than this does.
    //
    // Only when the test itself passed: a test that failed usually never reached
    // the state the defect fires in, so throwing here would replace the real
    // failure with a bookkeeping one — the same branch the spec-level teardown in
    // `folder-deletion-integrity.spec.ts` makes, for the same reason.
    //
    // `status === "passed"`, deliberately, and NOT `status === expectedStatus`.
    // The two differ under `test.fail()`, where `expectedStatus` is `"failed"`:
    // comparing against it would suppress this throw for exactly the body that
    // ran cleanly, which is the case it exists to catch — and it is how
    // `http-error-gate.spec.ts` pins this branch at all.
    const findStale = () =>
      declaredDefects.filter(
        (defect) => (declaredDefectHits.get(defect) ?? 0) === 0,
      );
    let staleDefects = findStale();
    // Give a response that is still in flight the chance to arrive before its
    // declaration is called stale — see `STALE_DECLARATION_GRACE_MS`. The `await`
    // is what makes this work at all: it yields to the event loop, so a queued
    // `response` event gets to run its listener. Entered only when something has
    // NOT fired, so a healthy run never pays for it.
    if (staleDefects.length > 0) {
      const deadline = Date.now() + STALE_DECLARATION_GRACE_MS;
      while (staleDefects.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        staleDefects = findStale();
      }
    }
    if (staleDefects.length > 0 && testInfo.status === "passed") {
      const details = staleDefects
        .map((d) => `\n  - ${d.status} ${d.pathname}\n    ${d.reason}`)
        .join("");
      throw new Error(
        `${staleDefects.length} declared known backend defect(s) did NOT occur:${details}\n\n` +
          `That is good news about Langflow and a stale exemption here. Confirm the\n` +
          `defect is really gone on the version under test, then delete the\n` +
          `page.expectKnownHttpError() call and close the issue it names — while it\n` +
          `stands, it hides whatever that endpoint does next.`,
      );
    }
  },
});

export { expect };
