// Behavioural test for the fixture's flow-error gate (issue #1162).
//
// The pure policy is unit-tested next door. What THIS pins is the part that only
// exists inside a real browser session, and that a source grep cannot see:
//
//   1. a v1 run stream carrying an error FAILS THE RUNNING TEST, not just its
//      teardown — measured during review at 1.96 s (interrupting the test) vs
//      22.15 s (letting it run to completion) when the intentional throw is
//      swallowed. That regression shipped invisibly because nothing executed the
//      gate;
//   2. `page.allowFlowErrors()` still suppresses it;
//   3. the v2 run path FAILS too, since #1165 — it is no longer advisory, so the
//      hatch below is what keeps that test green. This file is itself the largest
//      emitter in the daily's advisory log (12 of 40 across five dailies),
//      precisely because it mocks a RUN_ERROR on purpose: flipping the surface
//      without flipping this spec would have reddened the gate's own guard;
//   4. a PROVIDER outage in a v2 run is NOT a flow error (#1165) — it is reported
//      as unevaluated, and it must leave a test green with no hatch at all;
//   5. `page.flowErrorReport()` answers what the gate cannot (#1452) — it is the
//      only way a spec can tell "no flow error" from "no verdict", and the four
//      cases at the end are the four states a caller has to distinguish.
//      Behavioural on purpose: the verdict rule is unit-tested next door, but
//      whether the accessor sees a stream that closed MID-TEST depends on the
//      capture's async continuation, and only a real session exercises that.
//
// A tiny local server stands in for Langflow: no container, no provider key, no
// LLM. The fixture only cares about the URL shape, the content type and the body.
//
// WHY `@stable` — it is load bearing, not decoration. `daily-stable.yml` selects
// with `--grep @stable` and is the only recurring lane (`nightly.yml` has been
// dormant since 03-2026), and `pr-validation.yml` caps the impacted set at 20
// with `@stable` first — a fixtures change resolves to every spec in the repo, so
// an untagged spec here sorts below the cap and never runs. Measured on PR #1164:
// 237 impacted, 20 run, 217 dropped, and this file was among the dropped. A guard
// against "a regression shipped because nothing executed the gate" that itself
// executes nowhere is the same defect wearing the fix's clothes. The tag is cheap
// here in a way it is not for a product spec: no backend, no provider, ~6 s.
//
// It needs no QA-CHECKLIST bullet: `check-checklist-coverage.ts` and
// `stable-tests.ts` both scope to `tests/tests-automations/regression/`, so this
// file is outside their glob and outside the generated counts.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures";
import { classifyFlowError } from "./flow-error-policy";
import {
  attachRunStreamCapture,
  type CapturedStream,
} from "./run-stream-capture";
import type { PageWithErrorHooks } from "./fixtures";

const V1_ERROR_BODY = JSON.stringify({
  data: { error: true, error_message: "boom in the graph" },
});

const V2_ERROR_BODY = [
  'data: {"type":"RUN_STARTED"}',
  `data: ${JSON.stringify({ type: "RUN_ERROR", message: "Error code: 400 - provider said no" })}`,
  "",
].join("\n");

/** A run that completed with no error — what a healthy v2 stream looks like. */
const V2_CLEAN_BODY = [
  'data: {"type":"RUN_STARTED"}',
  'data: {"type":"token","chunk":"all good"}',
  'data: {"type":"RUN_END"}',
  "",
].join("\n");

const V2_PROVIDER_OUTAGE_BODY = [
  'data: {"type":"RUN_STARTED"}',
  `data: ${JSON.stringify({
    type: "RUN_ERROR",
    message:
      "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API.'}}",
  })}`,
  "",
].join("\n");

let server: http.Server;
let origin: string;
/** Responses left deliberately open by `?mode=hang`, ended in `afterAll`. */
const hanging = new Set<http.ServerResponse>();

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const [path, query = ""] = (req.url ?? "").split("?");
    if (path === "/api/v1/build/abc/flow") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(V1_ERROR_BODY);
      return;
    }
    if (path === "/api/v2/workflows") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      if (query.includes("mode=outage")) {
        // A drained provider key, verbatim from the 2026-09-02 daily. The SAME
        // wire shape as the error above — only the message differs, which is the
        // whole point: the downgrade is decided by the message, not the shape.
        res.end(V2_PROVIDER_OUTAGE_BODY);
        return;
      }
      if (query.includes("mode=ok")) {
        res.end(V2_CLEAN_BODY);
        return;
      }
      if (query.includes("mode=hang")) {
        // The case the capture exists for: the error is on the wire, and the
        // stream never closes. Asking for this body afterwards is what always
        // failed (#1168) — Chromium discards the partial buffer once the
        // request is cancelled.
        res.write(V2_ERROR_BODY);
        hanging.add(res);
        return;
      }
      res.end(V2_ERROR_BODY);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>gate probe</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  // `server.close()` waits for open connections, and `?mode=hang` leaves one on
  // purpose — so end them first or this hook is the hang.
  for (const res of hanging) res.end();
  hanging.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const runRequest = (path: string, method = "POST") =>
  `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)} }).then(r => r.text())`;

test.describe("fixture flow-error gate", () => {
  // NOTE on what is NOT tested here: "a v1 error interrupts the RUNNING test"
  // cannot be asserted from inside the test it interrupts — the fixture's own
  // error fails it either way. It was measured instead, with a throwaway probe
  // (v1 error, then a 10 s wait): 238 ms and `Flow execution error detected
  // during test` with the fix, 10 249 ms and a teardown-only failure without it.
  // What keeps that from regressing invisibly again is the source invariant
  // pinned in `flow-error-policy.test.ts` — only the v2 read may be tracked,
  // because attaching a `.catch()` to the v1 read marks its rejection handled and
  // silently downgrades the gate to teardown-only. A nested-run harness would
  // assert it directly; that is a follow-up, not a blocker.

  test(
    "allowFlowErrors() suppresses the v1 gate",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      (page as any).allowFlowErrors();
      await page.goto(`${origin}/`);
      await page.evaluate(runRequest("/api/v1/build/abc/flow"));
      // Long enough that an unsuppressed gate would have interrupted this: the
      // measured interrupt lands in ~240 ms.
      await page.waitForTimeout(3000);
      expect(
        await page.evaluate(() => document.body.textContent),
        "the hatch did not suppress the v1 gate — the test never reached its end",
      ).toContain("gate probe");
    },
  );

  test(
    "a v2 run error is reported as a failure, and the hatch is what keeps this green",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // The hatch is load bearing HERE, and was not before #1165: this test mocks
      // a RUN_ERROR, so the moment v2 stopped being advisory the gate's own guard
      // became something the gate would fail.
      (page as any).allowFlowErrors();

      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
        originalLog(...args);
      };
      try {
        await page.goto(`${origin}/`);
        await page.evaluate(runRequest("/api/v2/workflows"));
        await page.waitForTimeout(3000);
      } finally {
        console.log = originalLog;
      }

      const verdict = logged.find((l) => l.includes("Flow Error Detected"));
      expect(
        verdict,
        "the v2 run stream carried a RUN_ERROR and the fixture logged nothing — the miss #1162 is about",
      ).toBeTruthy();
      // The flip, asserted on the one thing visible from inside the test: the
      // marker is gone. While v2 was staged this line read `(ADVISORY)` and the
      // teardown printed "these do NOT fail the test yet".
      expect(
        verdict,
        "the verdict is still marked ADVISORY — the v2 surface was not flipped (#1165)",
      ).not.toContain("ADVISORY");
      expect(logged.join("\n")).toContain("provider said no");
      expect(
        logged.join("\n"),
        "the advisory teardown block outlived the flip",
      ).not.toContain("do NOT fail the test yet");

      // What this CANNOT assert, said out loud so its silence is not read as
      // coverage: that removing `allowFlowErrors()` above would fail the test.
      // The fixture raises that in teardown, after this body and its `afterEach`
      // have run, so no assertion in here could observe it. Pinning it needs the
      // nested-run harness #1165 records as its own item.
    },
  );

  test(
    "a provider outage in a v2 run is NOT a flow error (#1165)",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // No `allowFlowErrors()` here, on purpose: a drained provider key must
      // leave this test green WITHOUT a hatch. If the downgrade regresses, the
      // fixture pushes a flow error and the teardown fails this test — so the
      // absence of the hatch IS half the assertion.
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
        originalLog(...args);
      };
      try {
        await page.goto(`${origin}/`);
        await page.evaluate(runRequest("/api/v2/workflows?mode=outage"));
        await page.waitForTimeout(3000);
      } finally {
        console.log = originalLog;
      }

      const joined = logged.join("\n");
      expect(
        joined,
        "the outage was not reported at all — unevaluated must never be silent (#1012)",
      ).toContain("Provider outage in run stream");
      expect(joined).toContain("credit-exhausted");
      expect(
        joined,
        "a drained provider key was reported as a flow error — it would strip @stable (#1165)",
      ).not.toContain("Flow Error Detected");
    },
  );

  test(
    "a run stream that never closes still yields its bytes (#1168)",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // Asserted against the capture DIRECTLY, not through the fixture, for the
      // same reason the mid-test interrupt is not asserted here: the fixture
      // renders this verdict during teardown, after both the test body and its
      // `afterEach` have run, so no assertion inside the test could ever see it.
      // Attaching a second capture measures the one property that matters and
      // can be checked in place.
      // Hatched since #1165, and it is the flip demonstrating itself: this test
      // puts a RUN_ERROR on the wire on purpose, so the moment a v2 verdict
      // started failing tests, the guard for #1168 failed on the very error it
      // exists to prove is readable. Measured, not anticipated — the run went
      // 3 passed / 1 failed before this line was added.
      (page as any).allowFlowErrors();

      const finished: CapturedStream[] = [];
      const capture = await attachRunStreamCapture(page, (s) =>
        finished.push(s),
      );

      await page.goto(`${origin}/`);
      // NOT awaited inside the page: this fetch never settles by design, and
      // `page.evaluate` would wait for its result.
      await page.evaluate(() => {
        void fetch("/api/v2/workflows?mode=hang", { method: "POST" });
      });
      await page.waitForTimeout(1500);

      const captured = [...finished, ...(await capture.drain())];
      expect(
        captured.length,
        "the hanging run stream was never captured at all",
      ).toBe(1);
      expect(
        captured[0].complete,
        "the stream never closed, so it must be reported as incomplete",
      ).toBe(false);

      // The point of the whole mechanism: a partial body is still a verdict.
      const verdict = classifyFlowError(captured[0].body);
      expect(
        verdict.failed,
        `no verdict from the captured bytes: ${JSON.stringify(captured[0].body).slice(0, 200)}`,
      ).toBe(true);
    },
  );

  // --- page.flowErrorReport() (#1452) -------------------------------------
  //
  // Four states, and the accessor's only job is that a caller can tell them
  // apart. Three of them leave the test GREEN today — which is the whole
  // problem: three spec docs read "any flow error fails the test via the
  // fixture" and used that to justify dropping their own asserts, and the
  // sentence is true only of the state the gate reaches a verdict in.

  test(
    "flowErrorReport(): a healthy v2 run reads clean",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      await page.goto(`${origin}/`);
      await page.evaluate(runRequest("/api/v2/workflows?mode=ok"));

      const report = await (page as PageWithErrorHooks).flowErrorReport();
      expect(report.clean, report.summary).toBe(true);
      expect(report.failures).toHaveLength(0);
      expect(report.unevaluatedTotal).toBe(0);
      expect(report.pending).toBe(0);
      // The half a unit test cannot reach: a real CDP session had to attach for
      // the v2 surface to be watched at all, and without it every other
      // assertion here would be vacuous.
      expect(
        report.v2Watched,
        "no CDP session, so this run was never watched — the clean verdict above would be meaningless",
      ).toBe(true);
      // `page.evaluate` resolved the fetch, so the stream had closed before the
      // call. That it is COUNTED by then is the accessor's `settle()` doing its
      // job — `judgeCapturedStream` runs from an async continuation, so without
      // it this same assertion would pass or fail on timing.
    },
  );

  test(
    "flowErrorReport(): a v2 run error is reported even under the hatch",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // The hatch is what keeps THIS test green (the gate would otherwise fail
      // it), and the assertion is that the hatch does not reach the report. A
      // report that a hatch could empty would let a spec assert `clean` while
      // declaring it tolerates failures — strongest-looking assertion, least
      // asserted.
      (page as PageWithErrorHooks).allowFlowErrors();
      await page.goto(`${origin}/`);
      await page.evaluate(runRequest("/api/v2/workflows"));

      const report = await (page as PageWithErrorHooks).flowErrorReport();
      expect(
        report.clean,
        "allowFlowErrors() emptied the report — it must suppress the gate, not the facts",
      ).toBe(false);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0].message).toContain("provider said no");
      expect(report.summary).toContain("flow error(s)");
    },
  );

  test(
    "flowErrorReport(): a provider outage reads NOT clean, and not as a failure",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // No hatch, deliberately: an outage must leave the test green (#1165). The
      // gate's silence is right and the accessor's is not — a spec whose contract
      // is "the run did not crash" learns nothing from a run the provider
      // refused, and today it cannot find that out at all.
      await page.goto(`${origin}/`);
      await page.evaluate(runRequest("/api/v2/workflows?mode=outage"));

      const report = await (page as PageWithErrorHooks).flowErrorReport();
      expect(
        report.clean,
        "a drained provider key read as a clean run — unknown is not clean (#1012)",
      ).toBe(false);
      expect(
        report.failures,
        "the outage was reported as a flow error — that is what strips @stable (#1165)",
      ).toHaveLength(0);
      expect(report.unevaluatedTotal).toBe(1);
      expect(report.summary).toContain("provider outage");
    },
  );

  test(
    "flowErrorReport(): a run still in flight is pending, not clean",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // `?mode=hang` puts the error on the wire and never closes the stream. The
      // gate reaches this verdict at teardown, from the captured bytes (#1168) —
      // so the hatch is needed here too — but DURING the test there is no
      // verdict, and the accessor has to say that rather than answer "clean".
      // This is the one not-clean state that is nobody's defect: the caller
      // simply asked too early.
      (page as PageWithErrorHooks).allowFlowErrors();
      await page.goto(`${origin}/`);
      await page.evaluate(() => {
        void fetch("/api/v2/workflows?mode=hang", { method: "POST" });
      });
      // Long enough for `responseReceived` to have registered the stream. Short
      // enough that it is still open — it never closes by design.
      await page.waitForTimeout(1000);

      const report = await (page as PageWithErrorHooks).flowErrorReport();
      expect(report.pending, report.summary).toBe(1);
      expect(
        report.clean,
        "a run still streaming read as clean — the verdict is not in yet",
      ).toBe(false);
      expect(report.summary).toContain("wait for the run to finish");
      // And it did NOT judge the open stream: doing so would spend the partial
      // body on a verdict while the rest of the run was still arriving, and the
      // teardown drain — the mechanism #1168 exists for — would find nothing.
      expect(
        report.failures,
        "the accessor judged a stream that was still open, taking the teardown's verdict with it",
      ).toHaveLength(0);
    },
  );
});
