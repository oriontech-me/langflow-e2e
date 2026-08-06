// Behavioural test for the fixture's declared-known-defect hatch (issue #1008).
//
// The pure classification lives next door in `http-error-policy.test.ts`, where
// `npm run test:units` covers it. What THIS pins is the half that only exists
// inside a real browser session and that no unit test or source grep can reach:
//
//   1. a declared defect is logged as `📌 Known backend defect` and NOT as
//      `🚨 Backend Error` — the second string is what the deterministic
//      pipeline's VALIDATE gate greps for (`runners.ts` → `backendErrors`), so
//      that spelling is load-bearing, not cosmetic;
//   2. the declaration narrows: a different status on the very same path, and any
//      other 4xx/5xx, are still reported. This is the entire reason the hatch
//      exists instead of `page.allowHttpErrors()`, which would silence both;
//   3. a declared defect that does NOT fire **fails the test**. That is the
//      self-retirement mechanism: the day Langflow fixes the bug, the suite says
//      so instead of carrying a justified-once exemption forever;
//   4. and a declared defect whose response is still IN FLIGHT when the test body
//      returns is not mistaken for one that never fired — the stale check runs in
//      teardown, `page.on("response")` is an event, and the two can race.
//
// (3) is the one that matters most and the one a print-only warning would have
// left unpinned. Its sibling `flow-error-gate.spec.ts` records the same
// limitation it could not get past — "a v1 error interrupts the RUNNING test
// cannot be asserted from inside the test it interrupts" — and calls a
// nested-run harness a follow-up. Here `test.fail()` reaches it without one, but
// only because the fixture branches on `testInfo.status === "passed"` rather than
// on `expectedStatus`; see the note at that branch.
//
// A tiny local server stands in for Langflow: no container, no provider key, no
// flow. The fixture only cares that the pathname contains `/api/` and the status
// is 4xx/5xx.
//
// MEASURED COVERAGE, and one accepted gap. Eleven mutations of the production
// code were applied one at a time and run against `npm run test:units` plus this
// file: ten are killed — matching on pathname alone, on status alone, by substring
// instead of equality, checking the declaration before `IGNORED`, keying the
// stale check on `expectedStatus`, removing the stale throw, printing the gate
// string in the `📌` line, never incrementing the hit counter, announcing on every
// occurrence instead of the first, and removing the stale-declaration grace
// period. The eleventh SURVIVES and is accepted: dropping the `else` so a declared
// defect is *also* tallied in `ignoredByPolicy`. That only double-counts it inside
// the `PW_HTTP_ERROR_DEBUG=1` breakdown — no verdict, no count and no gate string
// changes — so there is no behaviour to pin. Recorded rather than left unknown
// (#1012's rule); if that breakdown ever becomes load-bearing, this is the gap.
//
// WHY `@stable` — the same reasoning as `flow-error-gate.spec.ts`, and it is load
// bearing there too. `daily-stable.yml` selects with `--grep @stable` and is the
// only recurring lane; `pr-validation.yml` caps the impacted set at 20 with
// `@stable` first, and a `tests/fixtures/**` change resolves to every spec in the
// repo — so an untagged guard here would sort below the cap and never run, which
// is the defect it exists to prevent wearing the fix's clothes. It needs no
// QA-CHECKLIST bullet: `check-checklist-coverage.ts` and `stable-tests.ts` both
// scope to `tests/tests-automations/regression/`, outside this file's path.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type PageWithErrorHooks } from "./fixtures";
import type { KnownHttpDefect } from "./http-error-policy";

/** The shape of the real declaration in `folder-deletion-integrity.spec.ts`. */
const DECLARED_PATH = "/api/v1/projects/undefined";
const DECLARED: KnownHttpDefect = {
  pathname: DECLARED_PATH,
  status: 422,
  reason: "#1008 probe — the declaration under test",
};

/** A different project id, standing in for the #965/LE-2020 `DELETE` → 500. */
const OTHER_PATH = "/api/v1/projects/70af1547-0bd1-4799-be28-41f738b6e6dc";

/**
 * How long `?mode=slow` withholds its response.
 *
 * Long enough that the test body has certainly returned — so the `response` event
 * is delivered while the fixture is tearing down — and comfortably inside the
 * fixture's 1 s stale-declaration grace period.
 */
const SLOW_RESPONSE_MS = 300;

let server: http.Server;
let origin: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const [path, query = ""] = (req.url ?? "").split("?");
    if (path === DECLARED_PATH || path === OTHER_PATH) {
      // `mode=500` answers the DECLARED path with an undeclared status, which is
      // the narrowing case: a new defect wearing the known one's URL.
      const status = query.includes("mode=500")
        ? 500
        : path === OTHER_PATH
          ? 500
          : 422;
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `probe ${status}` }));
      };
      // `mode=slow` answers only after the test body has certainly returned, so
      // the `response` event lands during fixture teardown — the race the
      // stale-declaration grace period exists for.
      if (query.includes("mode=slow")) setTimeout(send, SLOW_RESPONSE_MS);
      else send();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>http gate probe</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Runs `fn` with `console.log` tapped, and returns everything it printed.
 *
 * The fixture reports through `console.log`, so that is where the assertions have
 * to look — the same tap `flow-error-gate.spec.ts` uses for the v2 advisory line.
 * Output is still forwarded, so a failing run is readable in the report.
 */
async function withCapturedLog(fn: () => Promise<void>): Promise<string> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    originalLog(...args);
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logged.join("\n");
}

/** Issues the request from inside the page, so `page.on("response")` sees it. */
const fetchFromPage = (page: PageWithErrorHooks, path: string) =>
  page.evaluate(
    (p) => fetch(p).then((r) => r.status),
    path,
  );

test.describe("fixture declared-known-defect hatch", () => {
  test(
    "a declared defect is not reported as a backend error",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      const hooked = page as PageWithErrorHooks;
      hooked.expectKnownHttpError(DECLARED);

      const log = await withCapturedLog(async () => {
        await page.goto(`${origin}/`);
        // Fired THREE times on purpose. The fixture announces a declared defect
        // on its first occurrence only and puts the count in the teardown
        // summary, so that the log of a defect firing on every render stays
        // readable — re-noising the log is what #1084 was raised about. Firing it
        // once could not tell the two designs apart.
        for (let i = 0; i < 3; i++) {
          expect(await fetchFromPage(hooked, DECLARED_PATH)).toBe(422);
        }
        await page.waitForTimeout(1000);
      });

      expect(
        log,
        "the declared 422 was not announced — a silenced error and an announced one must not look alike",
      ).toContain("📌 Known backend defect");
      expect(log).toContain(DECLARED.reason);
      expect(
        log.match(/📌 Known backend defect/g) ?? [],
        "the declared defect was announced once per occurrence — three identical lines is the log noise the summary count exists to avoid",
      ).toHaveLength(1);
      // The load-bearing spelling, and — because `errors.push(entry)` sits in the
      // same branch as that log line — also proof the response was never counted
      // in the `📋 Found N backend error(s)` total. That total itself is printed
      // during fixture teardown, after this body has returned, so no assertion
      // here could ever read it.
      expect(
        log,
        "the declared defect still printed `🚨 Backend Error` — the VALIDATE gate would still hard-stop on it",
      ).not.toContain("🚨 Backend Error");
    },
  );

  test(
    "the declaration narrows: another status on the same path, and other paths, still report",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      const hooked = page as PageWithErrorHooks;
      hooked.expectKnownHttpError(DECLARED);

      const log = await withCapturedLog(async () => {
        await page.goto(`${origin}/`);
        // Fire the declared one too, so this test's declaration is not stale —
        // the point here is what happens to everything ELSE.
        expect(await fetchFromPage(hooked, DECLARED_PATH)).toBe(422);
        expect(await fetchFromPage(hooked, `${DECLARED_PATH}?mode=500`)).toBe(500);
        expect(await fetchFromPage(hooked, OTHER_PATH)).toBe(500);
        await page.waitForTimeout(1000);
      });

      expect(log).toContain("📌 Known backend defect");
      // Both 500s must be reported. `allowHttpErrors()` would have hidden them,
      // and one of them is the shape of #965/LE-2020, which the destructive test's
      // own delete loop can produce.
      expect(
        log,
        "a 500 on the declared path was swallowed — the declaration widened past the status it names",
      ).toContain(`🚨 Backend Error: 500 Internal Server Error - ${origin}${DECLARED_PATH}?mode=500`);
      expect(
        log,
        "a 500 on a different project id was swallowed — the declaration widened past the path it names",
      ).toContain(`🚨 Backend Error: 500 Internal Server Error - ${origin}${OTHER_PATH}`);
      // And the declared 422 is still the only thing NOT reported: exactly one
      // `📌` line, two `🚨` lines.
      expect(log.match(/🚨 Backend Error/g) ?? []).toHaveLength(2);
      expect(log.match(/📌 Known backend defect/g) ?? []).toHaveLength(1);
    },
  );

  test(
    "a declared defect still in flight when the test ends is not called stale",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // The race a review of #1008 surfaced. The stale check runs in fixture
      // teardown, and `page.on("response")` is an event — so a response the page
      // issued in the last moments of the body can still be in flight when the
      // teardown's synchronous tail runs, leaving the hit count at 0 for a defect
      // that DID occur. Without the grace period this test fails, and it fails
      // with the worst possible message: "the defect is gone, delete the
      // declaration", about a defect that is still there.
      const hooked = page as PageWithErrorHooks;
      hooked.expectKnownHttpError(DECLARED);

      await page.goto(`${origin}/`);
      // Fire-and-forget INSIDE the page, and do not await the result: the body
      // returns while the server is still withholding the response.
      await page.evaluate(() => {
        void fetch("/api/v1/projects/undefined?mode=slow");
      });
      // No wait of any kind here — that is the whole point.
    },
  );

  test(
    "two declarations of the same defect are both credited",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // `classifyHttpError` resolves a response to ONE declaration with `find()`,
      // so a defect declared twice — a shared helper plus an inline call, or a
      // `beforeEach` plus a body — produces two distinct objects competing for
      // the same response. Crediting only the one `find()` returned leaves the
      // other at zero hits, and the teardown then fails this test with "did NOT
      // occur" about a defect that fired. The passing of this test IS the
      // assertion: reverting the fixture to credit a single declaration turns it
      // red in teardown.
      const hooked = page as PageWithErrorHooks;
      const viaHelper: KnownHttpDefect = { ...DECLARED };
      const viaBody: KnownHttpDefect = { ...DECLARED };
      expect(
        viaHelper,
        "the two declarations must be distinct objects — identical ones would pass on the bug",
      ).not.toBe(viaBody);

      hooked.expectKnownHttpError(viaHelper);
      hooked.expectKnownHttpError(viaBody);

      await page.goto(`${origin}/`);
      expect(await fetchFromPage(hooked, DECLARED_PATH)).toBe(422);
      await page.waitForTimeout(1000);
    },
  );

  test(
    "a declared defect that never fires fails the test",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // The fixture's teardown MUST fail this test. If the self-retirement check
      // ever stops throwing, this body passes and Playwright reports
      // "expected to fail but passed" — which is the alarm.
      test.fail();

      (page as PageWithErrorHooks).expectKnownHttpError({
        pathname: "/api/v1/a-path-this-test-never-requests",
        status: 418,
        reason: "#1008 probe — a declaration that cannot possibly match",
      });

      await page.goto(`${origin}/`);
      expect(
        await page.evaluate(() => document.body.textContent),
        "the probe page did not load, so the test would have failed for the wrong reason",
      ).toContain("http gate probe");
    },
  );
});
