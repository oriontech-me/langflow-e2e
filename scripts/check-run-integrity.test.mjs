// Unit tests for the report-integrity guard (issue #1012).
// Run with: node --test scripts/check-run-integrity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyze,
  displaySignature,
  errorSignature,
  errorSignatures,
  testsTotal,
} from "./check-run-integrity.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./check-run-integrity.mjs", import.meta.url));

// The real shape of the merged report from run 30351107916 (2026-07-28), where
// all four shards aborted in globalSetup: stats all zero, suites empty, and one
// top-level error per shard. Trimmed to the fields the guard reads.
const emptyRun = {
  config: {},
  suites: [],
  errors: [
    {
      message:
        "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms " +
        "(last: TimeoutError: apiRequestContext.get: Timeout 8000ms exceeded.\nCall log:\n" +
        "  - → GET http://localhost:7860/api/v1/version\n",
      stack: "...",
    },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
  ],
  stats: {
    startTime: "2026-07-28T10:42:53.805Z",
    duration: 456176.048,
    expected: 0,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
  },
};

const healthyRun = {
  suites: [{ file: "a.spec.ts", specs: [] }],
  errors: [],
  stats: { expected: 385, skipped: 9, unexpected: 8, flaky: 5, duration: 1086214 },
};

test("the 2026-07-28 zero-test run is detected as empty", () => {
  const r = analyze(emptyRun);
  assert.equal(r.empty, true);
  assert.equal(r.testsTotal, 0);
  assert.equal(r.reportErrors, 4);
  assert.equal(r.unreadable, false);
  assert.match(r.signatures[0], /^Error: \[preflight\] Langflow backend/);
});

test("a normal run is not empty and totals every status", () => {
  const r = analyze(healthyRun);
  assert.equal(r.empty, false);
  assert.equal(r.testsTotal, 385 + 9 + 8 + 5);
  assert.equal(r.reportErrors, 0);
  assert.deepEqual(r.signatures, []);
});

test("a missing or unparseable report counts as empty, never as green", () => {
  const r = analyze(null);
  assert.equal(r.empty, true);
  assert.equal(r.unreadable, true);
  assert.equal(r.testsTotal, 0);
  assert.deepEqual(r.signatures, []);
});

test("a run that only SKIPPED is not empty — that is coverage erosion, not an infra abort", () => {
  // The distinction matters: skipped specs were collected and evaluated, so the
  // shards did run. Silent-skip erosion is the #570 class, tracked separately —
  // this guard must not swallow it into the infra-abort bucket.
  const r = analyze({ suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 42 } });
  assert.equal(r.empty, false);
  assert.equal(r.testsTotal, 42);
});

test("a report with errors but tests that still ran is not empty, but IS partial", () => {
  // A worker-level error can coexist with a run that produced results; only the
  // absence of results makes a run empty. This test used to stop there — and that
  // was precisely the #1058 blind spot: `empty: false` was the only verdict, so a
  // run where half the shards aborted read as clean. `partial` is the missing one.
  const r = analyze({ stats: { expected: 10, unexpected: 1, flaky: 0, skipped: 0 }, errors: [{ message: "boom" }] });
  assert.equal(r.empty, false);
  assert.equal(r.aborted, true);
  assert.equal(r.partial, true);
  assert.equal(r.reportErrors, 1);
  assert.deepEqual(r.signatures, ["boom"]);
});

test("the 2026-07-29 PARTIAL run is detected — some shards aborted, others ran", () => {
  // Run 30444299314 (#1058), the case no guard caught. Shards 1 and 2 died in the
  // credentials preflight with ZERO tests because `Collect models` never imported
  // GOOGLE_API_KEY as a Langflow global variable; shards 3 and 4 executed 205
  // tests between them against a ~380 baseline. `stats` was therefore non-empty,
  // `empty` was false, shardguard saw 4/4 blobs, and ~184 tests silently never
  // ran behind a report that rendered as an ordinary 10-failure day.
  const partialRun = {
    suites: [{ file: "a.spec.ts", specs: [] }],
    errors: [
      {
        message:
          "Error: [preflight] provider key(s) set in the environment but NOT configured as a " +
          "Langflow global variable: GOOGLE_API_KEY. Specs resolve credentials from Langflow, " +
          "not the env var, so they would fail with a misleading error",
      },
      {
        message:
          "Error: [preflight] provider key(s) set in the environment but NOT configured as a " +
          "Langflow global variable: GOOGLE_API_KEY.",
      },
    ],
    stats: { expected: 183, skipped: 12, unexpected: 10, flaky: 12, duration: 2_486_000 },
  };

  const r = analyze(partialRun);
  assert.equal(r.empty, false, "tests DID run — this is not the #1012 empty case");
  assert.equal(r.aborted, true);
  assert.equal(r.partial, true, "the verdict that must gate the mutating steps");
  assert.equal(r.reportErrors, 2, "one per aborted shard");
  assert.match(r.signatures[0], /NOT configured as a\s+Langflow global variable: GOOGLE_API_KEY/);
});

test("a shard left empty by --pass-with-no-tests is NOT an abort", () => {
  // The discriminator, measured against Playwright 1.58 blob reports rather than
  // assumed. The workflow shards N ways over fewer files on purpose and passes
  // `--pass-with-no-tests`, so a shard with nothing to run is routine. Such a
  // shard emits NO top-level error (4 jsonl lines: metadata, configure, begin,
  // end), while a shard that aborts in globalSetup emits one. Were `partial`
  // inferred from a zero test count instead, every normal run with more shards
  // than files would fail here.
  const r = analyze({
    suites: [{ file: "a.spec.ts", specs: [] }],
    errors: [],
    stats: { expected: 205, skipped: 0, unexpected: 0, flaky: 0 },
  });
  assert.equal(r.aborted, false);
  assert.equal(r.partial, false);
});

test("a fully empty run is aborted but NOT partial — it stays the #1012 case", () => {
  // Keeps the two verdicts from colliding: `partial` must mean "some ran, some
  // did not", so the workflow can keep naming the two conditions separately
  // (an infra abort of the whole run vs. an under-counted report).
  const r = analyze(emptyRun);
  assert.equal(r.empty, true);
  assert.equal(r.aborted, true);
  assert.equal(r.partial, false);
});

test("an unreadable report is not reported as an abort — that would name the wrong cause", () => {
  const r = analyze(null);
  assert.equal(r.unreadable, true);
  assert.equal(r.empty, true);
  assert.equal(r.aborted, false);
  assert.equal(r.partial, false);
});

test("testsTotal tolerates a missing or partial stats block", () => {
  assert.equal(testsTotal({}), 0);
  assert.equal(testsTotal({ stats: {} }), 0);
  assert.equal(testsTotal({ stats: { expected: 3 } }), 3);
});

test("errorSignature takes the first non-empty line, capped at 240 chars", () => {
  assert.equal(errorSignature({ message: "\n\n  real cause  \nstack frame\n" }), "real cause");
  assert.equal(errorSignature({ value: "from value" }), "from value");
  assert.equal(errorSignature({ message: "x".repeat(300) }).length, 240);
  assert.equal(errorSignature({}), null);
  assert.equal(errorSignature({ message: "\n \n" }), null);
});

test("errorSignatures drops entries that carry no message", () => {
  assert.deepEqual(errorSignatures({ errors: [{ message: "a" }, {}, { message: "b" }] }), ["a", "b"]);
  assert.deepEqual(errorSignatures({}), []);
});

test("displaySignature strips the ANSI codes Playwright puts in error messages", () => {
  // Not cosmetic: this value is rendered in a fenced block in the umbrella issue
  // and in a ::error:: annotation. The committed history shows real signatures
  // carry these codes (`Error: [2mexpect([22m…`).
  const esc = String.fromCharCode(27);
  const raw = `Error: ${esc}[2mexpect(${esc}[22m${esc}[31mlocator${esc}[39m${esc}[2m).${esc}[22mtoBeVisible failed`;
  assert.equal(displaySignature(raw), "Error: expect(locator).toBeVisible failed");
});

test("displaySignature neutralises a CR so first_error cannot forge a second output line", () => {
  const cr = String.fromCharCode(13);
  const signature = errorSignature({ message: `boom${cr}empty=false${cr}x` });
  // errorSignature keeps it — it splits on "\n" and only trims the ends. That is
  // deliberate (it is the clustering key shared with the history appender), so the
  // sanitising has to happen on the display path.
  assert.ok(signature.includes(cr));
  const display = displaySignature(signature);
  assert.equal(display, "boom empty=false x");
  assert.ok(!/[\r\n]/.test(display));
});

test("displaySignature is empty for a missing signature", () => {
  assert.equal(displaySignature(null), "");
  assert.equal(displaySignature(""), "");
});

// ── CLI-level tests: the outputs the workflow actually gates on ──

function runCli({ reportPath, dir }) {
  const outPath = join(dir, "outputs.txt");
  const script = join(dir, "check-run-integrity.mjs");
  // Run a COPY inside `dir` (whose name contains spaces) rather than the original:
  // the script's only imports are node builtins, so a copy behaves identically,
  // and this is what exercises the percent-encoded path case.
  writeFileSync(script, readFileSync(SCRIPT));
  execFileSync(process.execPath, [script], {
    env: { ...process.env, PLAYWRIGHT_JSON: reportPath, GITHUB_OUTPUT: outPath },
  });
  const text = readFileSync(outPath, "utf8");
  const outputs = Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  return { text, outputs };
}

test("the CLI writes its outputs even when its own path needs URL escaping", () => {
  // Regression test for the entrypoint check. A `file://${process.argv[1]}`
  // template does not match import.meta.url once the path is percent-encoded (a
  // single space is enough): main() never ran, the step exited 0 with NO outputs,
  // and the workflow's gate then saw `empty=""` — so the run went green on an
  // empty report, the exact failure this guard exists to remove.
  const dir = makeTempDir("run integrity ");
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(emptyRun));

  const { outputs } = runCli({ reportPath, dir });
  assert.equal(outputs.empty, "true");
  assert.equal(outputs.unreadable, "false");
  assert.equal(outputs.tests_total, "0");
  assert.equal(outputs.report_errors, "4");
  assert.match(outputs.first_error, /^Error: \[preflight\] Langflow backend/);
  // Exactly the documented keys — nothing injected by the report's error text.
  // Every key here is read by a `steps.runguard.outputs.*` expression in
  // daily-stable.yml, so this list is the guard's published contract: adding one
  // without wiring it is dead weight, and removing one silently un-gates a
  // mutating step (the `empty != 'false'` fail-closed idiom depends on the key
  // existing at all).
  assert.deepEqual(Object.keys(outputs).sort(), [
    "aborted",
    "empty",
    "first_error",
    "partial",
    "report_errors",
    "tests_total",
    "unreadable",
  ]);
});

test("the CLI reports partial=true for a run where only some shards aborted", () => {
  // End-to-end through the real entrypoint, not just analyze(): the workflow
  // reads these as step outputs, so a verdict that never reaches $GITHUB_OUTPUT
  // is a verdict the run cannot gate on.
  const dir = makeTempDir("run integrity partial ");
  const reportPath = join(dir, "results.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      suites: [{ file: "a.spec.ts", specs: [] }],
      errors: [{ message: "Error: [preflight] provider key(s) ... GOOGLE_API_KEY" }],
      stats: { expected: 205, skipped: 0, unexpected: 10, flaky: 0 },
    }),
  );

  const { outputs } = runCli({ reportPath, dir });
  assert.equal(outputs.empty, "false", "tests ran — must not read as the #1012 empty case");
  assert.equal(outputs.aborted, "true");
  assert.equal(outputs.partial, "true");
  assert.equal(outputs.tests_total, "215");
});

test("a missing report is reported as unreadable, not merely empty", () => {
  // The two need different triage: "the merge produced nothing" points at the
  // merge step and the blob artifacts, "zero tests" points at the shard aborts.
  const dir = makeTempDir("run integrity ");
  const { outputs } = runCli({ reportPath: join(dir, "does-not-exist.json"), dir });
  assert.equal(outputs.empty, "true");
  assert.equal(outputs.unreadable, "true");
  assert.equal(outputs.first_error, "");
});

test("a healthy report yields empty=false, which is what un-gates the mutating steps", () => {
  const dir = makeTempDir("run integrity ");
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(healthyRun));

  const { outputs } = runCli({ reportPath, dir });
  assert.equal(outputs.empty, "false");
  assert.equal(outputs.unreadable, "false");
  assert.equal(outputs.tests_total, String(385 + 9 + 8 + 5));
});
