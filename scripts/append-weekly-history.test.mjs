// Unit tests for the history appender (#1310).
// Run with: node --test scripts/append-weekly-history.test.mjs
//
// WHY A SUBPROCESS AND NOT AN IMPORT. append-weekly-history.mjs is a top-level
// script: loading it reads env, reads PLAYWRIGHT_JSON and appends a line. Driving
// it as the workflow drives it — one process, one env, one report file — also
// tests the thing every longitudinal query actually depends on (the JSONL line).
//
// This file did not exist before #1310, which is how the `lastFailed` defect
// below survived: `reports/daily-history.jsonl` is machine-written and
// human-read, so a wrong field is invisible until someone questions a specific
// row. Two of the 24 hard failures on run 30997773754 had recorded
// `error_signature: "unknown"` while their real message sat on attempt 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./append-weekly-history.mjs", import.meta.url));

const TRANSPORT = "TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.";
const SPEC_ERROR = "Error: expect(locator).toBeVisible() failed";

// The shape run 30997773754 produced for `agent-context-id-continuity:405`: a
// transport failure on attempt 0, then the real (attributable) cause on the
// retries. Only the FULL text carries the transport error on the first attempt.
const GUARD_WRAPPED = [
  "Error: Agent credential never settled on the persisted flow (#751 guard, #1072).",
  "  observed       no successful read of the persisted flow",
  "  last read err  apiRequestContext.get: Timeout 20000ms exceeded.",
  "  verdict        read-failed",
].join("\n");

const result = (status, message) => ({
  status,
  duration: 10,
  ...(message ? { error: { message } } : {}),
});

/** One report containing exactly the tests described by `specs`. */
function report(specs) {
  return {
    config: {},
    suites: [
      {
        title: "a.spec.ts",
        specs: specs.map((s, i) => ({
          title: s.title,
          file: `tests/tests-automations/regression/smoke/a.spec.ts`,
          line: 10 + i,
          tags: s.tags ?? ["@stable"],
          tests: [{ status: s.status, results: s.results }],
        })),
      },
    ],
    stats: { duration: 1000 },
  };
}

/** Run the appender over `rep` and return the single JSONL entry it wrote. */
function append(rep, envOver = {}) {
  const dir = makeTempDir("history-");
  const reportPath = join(dir, "results.json");
  const historyPath = join(dir, "history.jsonl");
  writeFileSync(reportPath, JSON.stringify(rep));
  execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      PLAYWRIGHT_JSON: reportPath,
      HISTORY_FILE: historyPath,
      WORKFLOW: "unit",
      GITHUB_RUN_ID: "1",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      LANGFLOW_IMAGE: "img:tag",
      ...envOver,
    },
    encoding: "utf8",
  });
  const lines = readFileSync(historyPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one line must be appended");
  return JSON.parse(lines[0]);
}

test("a hard failure records infra_signature from its LAST failed attempt", () => {
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", SPEC_ERROR), result("failed", TRANSPORT)],
      },
    ]),
  );
  const f = entry.failures[0];
  assert.equal(f.error_signature, TRANSPORT, "signature comes from the last failed attempt");
  assert.equal(f.infra_signature, "api-request-timeout");
});

test("a hard failure whose last error is the spec's own records infra_signature null", () => {
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", TRANSPORT), result("failed", SPEC_ERROR)],
      },
    ]),
  );
  const f = entry.failures[0];
  assert.equal(f.error_signature, SPEC_ERROR);
  assert.equal(f.infra_signature, null, "the LAST error decides, matching the exemption's wording");
});

test("a flake records infra_signature from its FIRST failed attempt", () => {
  const entry = append(
    report([
      { title: "t", status: "flaky", results: [result("failed", TRANSPORT), result("passed")] },
    ]),
  );
  const f = entry.flaky[0];
  assert.equal(f.error_signature, TRANSPORT);
  assert.equal(
    f.infra_signature,
    "api-request-timeout",
    "this is what keeps a wedge-collateral flake out of a quarantine PR (#1310)",
  );
});

test("a flake whose failure is its own records infra_signature null", () => {
  const entry = append(
    report([
      { title: "t", status: "flaky", results: [result("failed", SPEC_ERROR), result("passed")] },
    ]),
  );
  assert.equal(entry.flaky[0].infra_signature, null);
});

test("the transport error is found even when an assertion wraps it", () => {
  // The whole reason classification happens HERE and not in triage: the stored
  // signature is line 1, and the cause line is three lines down.
  const entry = append(
    report([
      { title: "t", status: "flaky", results: [result("failed", GUARD_WRAPPED), result("passed")] },
    ]),
  );
  const f = entry.flaky[0];
  assert.equal(
    f.error_signature,
    "Error: Agent credential never settled on the persisted flow (#751 guard, #1072).",
    "the signature stays line 1 — unchanged behaviour",
  );
  assert.equal(
    f.infra_signature,
    "api-request-timeout",
    "but the classification sees the whole message, which line 1 alone cannot",
  );
});

// ── the `lastFailed` defect, fixed in #1310 ──────────────────────────────────
// A failing test inside a `test.describe.serial` block that aborts leaves
// SKIPPED retries. `lastFailed` selected the last non-passed result, which is a
// skipped attempt carrying no error at all — so the entry recorded
// `error_signature: "unknown"` and no classification, while the real message sat
// on attempt 0. `unknown` is not a signature but the absence of one, and
// triage's recurrence rule matches on it, clustering unrelated message-less
// failures. `build-run-payload.mjs` had always excluded `skipped` here; its
// header claims to mirror this script's parsing, and the two had drifted.
test("#1310 a failure whose retries were SKIPPED keeps its real signature", () => {
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", SPEC_ERROR), result("skipped"), result("skipped")],
      },
    ]),
  );
  const f = entry.failures[0];
  assert.equal(f.error_signature, SPEC_ERROR, 'must not degrade to "unknown" — a skipped retry carries no error');
  assert.notEqual(f.error_signature, "unknown");
  assert.equal(f.attempts, 3, "attempts still counts every result entry");
});

test("#1310 a skipped-retry failure is still classified as wedge collateral", () => {
  // Exactly `agent-context-id-isolation.spec.ts:557` on run 30997773754, which
  // the umbrella listed as collateral while the history row said `unknown`.
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", GUARD_WRAPPED), result("skipped"), result("skipped")],
      },
    ]),
  );
  assert.equal(entry.failures[0].infra_signature, "api-request-timeout");
});

test('a failure with no error at all still records "unknown" and no classification', () => {
  // The genuine no-message case must stay distinguishable from the bug above:
  // here there IS no error anywhere, so "unknown" is the honest answer.
  const entry = append(
    report([{ title: "t", status: "unexpected", results: [result("failed")] }]),
  );
  const f = entry.failures[0];
  assert.equal(f.error_signature, "unknown");
  assert.equal(f.infra_signature, null);
});

test("totals and the entry shape are unchanged by the added field", () => {
  const entry = append(
    report([
      { title: "pass", status: "expected", results: [result("passed")] },
      { title: "fail", status: "unexpected", results: [result("failed", SPEC_ERROR)] },
      { title: "flake", status: "flaky", results: [result("failed", SPEC_ERROR), result("passed")] },
    ]),
  );
  assert.deepEqual(entry.totals, { passed: 1, failed: 1, flaky: 1, skipped: 0 });
  assert.equal(entry.version, 1, "an additive optional field does not bump the schema version");
  for (const e of [...entry.failures, ...entry.flaky]) {
    assert.ok("infra_signature" in e, "every failure and flake carries the field, so absent means pre-#1310");
  }
});

// The resolved version, and why it is worth a test of its own. LANGFLOW_IMAGE is a
// moving tag: two rows both saying ":latest" are two different products on two
// different days. The VM migration's step 14 compares an Actions row against a VM row,
// and a comparison across different Langflows describes the product's changelog rather
// than the difference between the environments -- so the comparator BLOCKS on a
// mismatch, and it can only do that if the version is on the row.
test("the resolved Langflow version is recorded next to the image tag", () => {
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION: "1.13.0.dev3",
  });
  assert.equal(entry.langflow_version, "1.13.0.dev3");
  assert.equal(entry.langflow_image, "img:tag", "the tag stays, because it records what was ASKED for");
});

test("an absent version is null, never omitted, so a reader can tell 'unknown' from 'not recorded'", () => {
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION: "",
  });
  assert.equal(entry.langflow_version, null);
  assert.ok("langflow_version" in entry);
});

// ---------- an ABSENT report is an infra abort, not a skipped day (#1176) ----------

// On 2026-07-31 every shard aborted before its first test, so no blob existed and the
// merge step failed: results.json was never written. The appender exited 0, its step
// went green, and the day is simply missing from the series — a `jq` query reads
// 2026-07-30 followed by 2026-08-03 as consecutive weekdays. Absence reported as
// success is the pattern #1012 exists to refuse.

/** Run the appender with NO report at all, and return what it wrote (or null). */
function appendWithNoReport({ ci = true } = {}) {
  const dir = makeTempDir("history-");
  const historyPath = join(dir, "history.jsonl");
  const env = {
    ...process.env,
    PLAYWRIGHT_JSON: join(dir, "results.json"), // deliberately never created
    HISTORY_FILE: historyPath,
    WORKFLOW: "unit",
    GITHUB_SERVER_URL: "https://example.invalid",
    GITHUB_REPOSITORY: "o/r",
    LANGFLOW_IMAGE: "img:tag",
  };
  if (ci) env.GITHUB_RUN_ID = "1";
  else delete env.GITHUB_RUN_ID;
  execFileSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
  let raw;
  try {
    raw = readFileSync(historyPath, "utf8").trim();
  } catch {
    return null; // no file written at all
  }
  return raw ? JSON.parse(raw) : null;
}

test("#1176 a CI run with no report writes an entry instead of vanishing", () => {
  const entry = appendWithNoReport();
  assert.ok(entry, "the day must be recorded, not skipped");
  assert.equal(entry.report_missing, true);
  assert.deepEqual(entry.totals, { passed: 0, failed: 0, flaky: 0, skipped: 0 });
  assert.equal(entry.run_id, "1");
  assert.equal(entry.langflow_image, "img:tag");
  assert.equal(entry.version, 1, "an additive optional field does not bump the schema version");
});

test("#1176 the entry carries its own reason, so the abort is not silent", () => {
  const entry = appendWithNoReport();
  assert.ok(Array.isArray(entry.run_errors) && entry.run_errors.length === 1);
  assert.match(entry.run_errors[0], /absent/i);
  assert.match(entry.run_errors[0], /infra abort/i);
});

test("#1176 the entry is selected by the README's existing zero-test query", () => {
  // That query is `select([.totals[]] | add == 0)` printing
  // `.run_errors[0] // "no recorded reason"`. Pinning both halves is the point: the
  // fix is worthless if the line lands in the file but the published query walks past
  // it, or selects it and prints the fallback.
  const entry = appendWithNoReport();
  const executed = Object.values(entry.totals).reduce((a, b) => a + b, 0);
  assert.equal(executed, 0, "must be selected by the zero-test query");
  assert.notEqual(
    entry.run_errors?.[0] ?? null,
    null,
    "must print a cause, not the query's 'no recorded reason' fallback",
  );
});

test("#1176 running locally still writes nothing — the file is CI-owned", () => {
  // With no run id this is a developer's tree, and appending a junk line to a
  // committed, machine-written file would be a worse bug than the one being fixed.
  assert.equal(appendWithNoReport({ ci: false }), null);
});

test("#1176 an ordinary run carries no report_missing marker", () => {
  const entry = append(report([{ title: "pass", status: "expected", results: [result("passed")] }]));
  assert.equal(entry.report_missing, undefined, "present only on a missing report");
});
