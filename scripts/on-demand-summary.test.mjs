// The on-demand suite summary (phase 7): counted as the daily's payload counts,
// shaped and fitted as the platform's contract takes it.
// Run with: node --test scripts/on-demand-summary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import {
  buildSummary, cut, fit, httpStatusOf, summaryFromFile, SUMMARY_MAX_BYTES,
} from "./lib/on-demand-summary.mjs";
import { UNEXPECTED_PASS_SIGNATURE } from "./lib/unexpected-pass.mjs";

const PAYLOAD = fileURLToPath(new URL("./build-run-payload.mjs", import.meta.url));
const ESC = "\u001b";

/** One spec, as a merged Playwright JSON report writes it. */
const spec = (file, line, title, status, results) => ({ title, file, line, tags: ["@stable"], tests: [{ status, results }] });
const ok = [{ status: "passed", duration: 900, steps: [] }];
const err = (message) => ({ status: "failed", duration: 900, steps: [], error: { message } });

/** Every outcome the daily's reader distinguishes, across two specs. */
const REPORT = {
  config: {},
  stats: { duration: 1_318_000 },
  suites: [
    {
      title: "memory-base-panel.spec.ts",
      specs: [
        spec("tests-automations/regression/core-functionality/memory/memory-base-panel.spec.ts", 12,
          "opens the memory base panel from the sidebar", "unexpected",
          [err(`${ESC}[31mError: expect(received).toBe(expected)${ESC}[39m\n\nExpected: 200\nReceived: 404 (HTTP 404)`)]),
        spec("tests-automations/regression/core-functionality/memory/memory-base-panel.spec.ts", 40,
          "lists the ingested documents", "expected", ok),
      ],
      suites: [{
        title: "nested describe",
        specs: [spec("tests-automations/regression/core-functionality/memory/memory-base-panel.spec.ts", 77,
          "deletes a document", "flaky", [err("TimeoutError: locator.click: Timeout 30000ms exceeded."), ok[0]])],
      }],
    },
    {
      title: "rag-pipeline.spec.ts",
      specs: [
        spec("tests-automations/regression/core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts", 8,
          "ingests a PDF and answers from it", "skipped", [{ status: "skipped", duration: 0, steps: [] }]),
        spec("tests-automations/regression/core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts", 31,
          "a declared bug, fixed today", "unexpected", [ok[0], ok[0], ok[0]]),
        spec("tests-automations/regression/core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts", 55,
          "cites the source chunk", "unexpected", [err("Error: status code: 500 from /api/v1/run")]),
      ],
    },
  ],
};

function dailyPayload(report) {
  const dir = makeTempDir("od-summary-");
  const path = join(dir, "results.json");
  writeFileSync(path, JSON.stringify(report));
  return JSON.parse(execFileSync(process.execPath, [PAYLOAD], {
    encoding: "utf-8", stdio: "pipe",
    env: { PATH: process.env.PATH, PLAYWRIGHT_JSON: path, GITHUB_RUN_ID: "1" },
  }));
}

// --- the same reading as the daily ------------------------------------------------------

test("the counts are the daily payload's, outcome for outcome", () => {
  const s = buildSummary(REPORT);
  assert.deepEqual(s.totals, dailyPayload(REPORT).totals);
  assert.deepEqual(s.totals, { passed: 1, failed: 3, flaky: 1, skipped: 1 });
  assert.equal(s.duration_ms, 1_318_000);
});

test("every test is the daily payload's test: same file, line, title and status", () => {
  const ours = buildSummary(REPORT).tests_by_spec.flatMap((g) => g.tests.map((t) => `${g.spec}:${t.line} ${t.title} = ${t.status}`));
  const daily = dailyPayload(REPORT).tests.map((t) => `${t.file}:${t.line} ${t.test} = ${t.status}`);
  assert.deepEqual(ours, daily);
});

test("the failures are the daily payload's failures, with the same error line", () => {
  const ours = buildSummary(REPORT).failures_by_spec.flatMap((g) => g.failures.map((f) => `${g.spec} ${f.title}: ${f.first_error_line}`));
  const daily = dailyPayload(REPORT).failures.map((f) => `${f.file} ${f.test}: ${f.error_signature}`);
  assert.deepEqual(ours, daily);
});

test("an unexpected pass is a failure under its own signature, as the daily records it", () => {
  const f = buildSummary(REPORT).failures_by_spec[1].failures.find((x) => x.title === "a declared bug, fixed today");
  assert.equal(f.first_error_line, UNEXPECTED_PASS_SIGNATURE);
  assert.equal(f.http_status, null);
});

// --- the contract's shape ---------------------------------------------------------------

test("failures are grouped by spec, and every test by spec, in report order", () => {
  const s = buildSummary(REPORT);
  assert.deepEqual(s.failures_by_spec.map((g) => g.failures.length), [1, 2]);
  assert.deepEqual(s.tests_by_spec.map((g) => g.tests.length), [3, 3]);
  assert.ok(s.failures_by_spec.every((g) => g.failures.length > 0), "a spec with no failures is not listed");
});

test("an error line is one line, ANSI stripped, as the contract takes it", () => {
  const line = buildSummary(REPORT).failures_by_spec[0].failures[0].first_error_line;
  assert.equal(line, "Error: expect(received).toBe(expected)");
  const wild = buildSummary({ suites: [{ specs: [spec("a.spec.ts", 1, "t", "unexpected", [err(`a${ESC}]0;title\u0007b\tc`)])] }] });
  assert.match(wild.failures_by_spec[0].failures[0].first_error_line, /^[^\x00-\x08\x0a-\x1f\x7f]*$/);
});

test("an HTTP status is taken only when the error names one", () => {
  assert.equal(httpStatusOf("Received: 404 (HTTP 404)"), 404);
  assert.equal(httpStatusOf("Error: status code: 500 from /api/v1/run"), 500);
  assert.equal(httpStatusOf("Request failed with status 405"), 405);
  assert.equal(httpStatusOf("TimeoutError: locator.click: Timeout 30000ms exceeded."), null);
  assert.equal(httpStatusOf("expected 404 items, got 3"), null);
  assert.equal(httpStatusOf("status 999"), null);
  // Lines from the 2026-10-04 run of release-1.13.0 (od-20261004-9bf58919).
  assert.equal(httpStatusOf('Error: POST /api/v1/knowledge_bases failed: 422 — {"detail":[{"type":"value_error"}]}'), 422);
  assert.equal(httpStatusOf("🚨 Backend Error: 404 Not Found - http://localhost:7910/api/v1/flows/x"), 404);
  assert.equal(httpStatusOf("Error: expect(locator).toHaveText(expected) failed"), null);
  assert.equal(httpStatusOf("Error: the IPv6 loopback leg must be reported too"), null);
  assert.equal(httpStatusOf("returns 404 for non-existent flow ID"), null);
});

test("an empty report is a summary of nothing, not an error", () => {
  assert.deepEqual(buildSummary({}), {
    totals: { passed: 0, failed: 0, flaky: 0, skipped: 0 }, duration_ms: 0, failures_by_spec: [], tests_by_spec: [],
  });
});

// --- text the platform can store ---------------------------------------------------------
// A lone surrogate is valid to zod and refused by Postgres in a jsonb, which fails
// the platform's whole terminal update: the result would never land.
const EMOJI = "\u{1F600}";
const lone = (s) => /\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(s));

test("a cut never leaves half a character", () => {
  assert.equal(cut("a".repeat(239) + EMOJI, 240), "a".repeat(239));
  assert.equal(cut("ab" + EMOJI, 4), "ab" + EMOJI);
  assert.equal(cut("x\ud800y", 10), "x\ufffdy", "a lone surrogate already in the text is replaced");
});

test("an emoji at any limit leaves the summary storable", () => {
  const longLine = "Expected text: " + "a".repeat(224) + EMOJI + " more";
  const longTitle = "t".repeat(499) + EMOJI;
  const longSpec = "tests/" + "s".repeat(293) + EMOJI + ".spec.ts";
  const s = buildSummary({ suites: [{ specs: [spec(longSpec, 1, longTitle, "unexpected", [err(longLine)])] }] });
  assert.equal(lone(s), false, JSON.stringify(s).slice(0, 200));
  const f = s.failures_by_spec[0];
  assert.ok(f.spec.length <= 300 && f.failures[0].title.length <= 500 && f.failures[0].first_error_line.length <= 500);
});

// --- a damaged report still gives a summary the contract takes --------------------------

test("a duration that is not a number is 0, not a null the contract refuses", () => {
  for (const duration of ["n/a", Infinity, NaN, null]) {
    assert.equal(buildSummary({ stats: { duration } }).duration_ms, 0, String(duration));
  }
});

test("a test with no status, or one outside the four, is a failure in the list as in the counts", () => {
  const s = buildSummary({ suites: [{ specs: [
    { title: "no status", file: "a.spec.ts", line: 1, tests: [{ results: [] }] },
    { title: "odd status", file: "a.spec.ts", line: 2, tests: [{ status: "timedOut", results: [] }] },
  ] }] });
  assert.deepEqual(s.tests_by_spec[0].tests.map((t) => t.status), ["failed", "failed"]);
  assert.equal(s.totals.failed, 2);
});

test("an absolute spec path is made relative to the suite checkout, as the daily makes it", () => {
  const abs = { suites: [{ specs: [spec("/root/e2e-qa/tests/a.spec.ts", 3, "t", "expected", ok)] }] };
  assert.equal(buildSummary(abs, { root: "/root/e2e-qa" }).tests_by_spec[0].spec, "tests/a.spec.ts");
});

// --- the byte budget --------------------------------------------------------------------

/** A suite of n tests in specs of four, with long paths and titles. */
function suite(n, failEvery = 0) {
  const specs = Array.from({ length: n }, (_, i) => spec(
    `tests-automations/regression/core-functionality/area-${Math.floor(i / 4) % 40}/some-feature-${Math.floor(i / 4)}.spec.ts`, 10 + i,
    `does the ${i}th thing a user would do with this feature`,
    failEvery && i % failEvery === 0 ? "unexpected" : "expected",
    failEvery && i % failEvery === 0 ? [err("E".repeat(600))] : ok));
  return { stats: { duration: 1 }, suites: [{ specs }] };
}

test("today's suite and twice it fit with every test", () => {
  for (const n of [800, 1600]) {
    const s = buildSummary(suite(n));
    assert.ok(s.tests_by_spec, `${n} tests kept tests_by_spec`);
    assert.ok(Buffer.byteLength(JSON.stringify(s)) <= SUMMARY_MAX_BYTES);
  }
});

test("over the budget, tests_by_spec goes first and the counts and failures stay", () => {
  const s = buildSummary(suite(3000));
  assert.equal(s.tests_by_spec, undefined);
  assert.equal(s.totals.passed, 3000);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= SUMMARY_MAX_BYTES);
});

test("then failures are trimmed from the end until it fits, and the counts still say how many", () => {
  const s = buildSummary(suite(4000, 2));
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= SUMMARY_MAX_BYTES);
  assert.equal(s.totals.failed, 2000);
  const kept = s.failures_by_spec.reduce((n, g) => n + g.failures.length, 0);
  assert.ok(kept > 0 && kept < 2000, `${kept} failures kept`);
  assert.ok(s.failures_by_spec.every((g) => g.failures.length > 0));
});

test("fit leaves a summary inside the budget untouched", () => {
  const s = buildSummary(REPORT);
  assert.equal(fit(s), s);
});

// --- from a file, and in the worker -----------------------------------------------------

test("no results.json, or one that does not parse, is null and never a throw", () => {
  const dir = makeTempDir("od-summary-");
  assert.equal(summaryFromFile(join(dir, "missing.json")), null);
  writeFileSync(join(dir, "bad.json"), "{ not json");
  assert.equal(summaryFromFile(join(dir, "bad.json")), null);
});
