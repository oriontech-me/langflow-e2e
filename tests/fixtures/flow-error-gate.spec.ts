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
//   3. the v2 run path is ADVISORY for now — it logs the cause and does NOT fail,
//      because 75 of the 88 run-driving specs have no hatch and some provoke an
//      execution error on purpose (see `flow-error-policy.ts`, step 2).
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

const V1_ERROR_BODY = JSON.stringify({
  data: { error: true, error_message: "boom in the graph" },
});

const V2_ERROR_BODY = [
  'data: {"type":"RUN_STARTED"}',
  `data: ${JSON.stringify({ type: "RUN_ERROR", message: "Error code: 400 - provider said no" })}`,
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
    "a v2 run error is advisory: logged, and it does not fail the test",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
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
      expect(verdict).toContain("ADVISORY");
      expect(logged.join("\n")).toContain("provider said no");
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
});
