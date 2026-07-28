// Unit tests for the report-integrity guard (issue #1012).
// Run with: node --test scripts/check-run-integrity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyze,
  displaySignature,
  errorSignature,
  errorSignatures,
  testsTotal,
} from "./check-run-integrity.mjs";

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

test("a report with errors but tests that still ran is not empty", () => {
  // A worker-level error can coexist with a run that produced results; only the
  // absence of results makes a run empty.
  const r = analyze({ stats: { expected: 10, unexpected: 1, flaky: 0, skipped: 0 }, errors: [{ message: "boom" }] });
  assert.equal(r.empty, false);
  assert.equal(r.reportErrors, 1);
  assert.deepEqual(r.signatures, ["boom"]);
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
  const dir = mkdtempSync(join(tmpdir(), "run integrity "));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(emptyRun));

  const { outputs } = runCli({ reportPath, dir });
  assert.equal(outputs.empty, "true");
  assert.equal(outputs.unreadable, "false");
  assert.equal(outputs.tests_total, "0");
  assert.equal(outputs.report_errors, "4");
  assert.match(outputs.first_error, /^Error: \[preflight\] Langflow backend/);
  // Exactly the documented keys — nothing injected by the report's error text.
  assert.deepEqual(Object.keys(outputs).sort(), [
    "empty",
    "first_error",
    "report_errors",
    "tests_total",
    "unreadable",
  ]);
});

test("a missing report is reported as unreadable, not merely empty", () => {
  // The two need different triage: "the merge produced nothing" points at the
  // merge step and the blob artifacts, "zero tests" points at the shard aborts.
  const dir = mkdtempSync(join(tmpdir(), "run integrity "));
  const { outputs } = runCli({ reportPath: join(dir, "does-not-exist.json"), dir });
  assert.equal(outputs.empty, "true");
  assert.equal(outputs.unreadable, "true");
  assert.equal(outputs.first_error, "");
});

test("a healthy report yields empty=false, which is what un-gates the mutating steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "run integrity "));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(healthyRun));

  const { outputs } = runCli({ reportPath, dir });
  assert.equal(outputs.empty, "false");
  assert.equal(outputs.unreadable, "false");
  assert.equal(outputs.tests_total, String(385 + 9 + 8 + 5));
});
