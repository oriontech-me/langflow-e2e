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

// ---------- the listing's provider gate rides on the row (#1813) ----------

// These keys gate COLLECTION: a spec file generated entirely from a missing one yields
// zero tests, leaves the file-level partition and is run by no shard. The row's totals
// shrink with nothing to point at — no failure, no skip, no error — so the two-lane
// comparison has to read the cause off the row or invent one, which it did twice.

const passing = () => report([{ title: "t", status: "expected", results: [result("passed")] }]);

test("the resolved and absent key sets are both recorded, as names", () => {
  const entry = append(passing(), {
    COLLECTION_GATE_KEYS: "OPENAI_API_KEY ANTHROPIC_API_KEY",
    COLLECTION_GATE_KEYS_ABSENT: "GOOGLE_API_KEY",
  });
  assert.deepEqual(entry.collection_gate_keys, {
    present: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    absent: ["GOOGLE_API_KEY"],
  });
});

test("a run that resolved NOTHING records an empty present, which is not the same as no block", () => {
  // The distinction the whole pair exists for. `present: []` is a measured lane that
  // will list no key-gated file at all; an absent block is a lane that never asked.
  const entry = append(passing(), {
    COLLECTION_GATE_KEYS: "",
    COLLECTION_GATE_KEYS_ABSENT: "OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY",
  });
  assert.deepEqual(entry.collection_gate_keys.present, []);
  assert.equal(entry.collection_gate_keys.absent.length, 3);
});

test("a run that did not measure its gate carries no block at all", () => {
  for (const envOver of [
    {},
    { COLLECTION_GATE_KEYS: "", COLLECTION_GATE_KEYS_ABSENT: "" },
    { COLLECTION_GATE_KEYS: "   ", COLLECTION_GATE_KEYS_ABSENT: "  " },
  ]) {
    const entry = append(passing(), envOver);
    assert.ok(!("collection_gate_keys" in entry), JSON.stringify(entry.collection_gate_keys));
  }
});

test("whitespace never becomes a key name", () => {
  // The lists arrive from a shell that produced them with `sed`, so a trailing space is
  // routine. `"".split(/\s+/)` is `[""]`, and a key named "" would compare unequal to
  // every real set — a permanent, unexplained mismatch on both lanes.
  const entry = append(passing(), {
    COLLECTION_GATE_KEYS: "  OPENAI_API_KEY   ANTHROPIC_API_KEY  ",
    COLLECTION_GATE_KEYS_ABSENT: " GOOGLE_API_KEY ",
  });
  assert.deepEqual(entry.collection_gate_keys.present, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(entry.collection_gate_keys.absent, ["GOOGLE_API_KEY"]);
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
  assert.match(entry.run_errors[0], /no merged report/i);
  assert.match(entry.run_errors[0], /infra abort/i);
});

test("#1176 the synthesized reason claims only what the appender measured", () => {
  // The reason is written by this script, not read from a report, so it is the one
  // string here that can assert something nobody checked. Two different aborts leave
  // no results.json — every shard dying before its blob, and `merge-reports` failing
  // on blobs the shards DID write (#1726) — and only the first means no test ran. The
  // appender cannot see blobs, so a reason phrased over shards would be a guess that
  // reads as a measurement: exactly the miscue #1726 had to fix in the umbrella
  // issue's own title. The blob count lives in the merge job's `shardguard` step.
  const entry = appendWithNoReport();
  assert.doesNotMatch(
    entry.run_errors[0],
    /shard/i,
    "the appender never counted shards, so the reason must not speak for them",
  );
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

// ─── infra_signature_any_attempt (#1589) ─────────────────────────────────────
//
// This writer had NO coverage at all: mutating `infraSignatureAnyAttempt` to
// `return null`, and deleting the field from the flaky entry, both left the
// whole lane green — on a committed, machine-owned JSONL that
// `reports/README.md` documents.

test("a hard failure records the earliest attempt that classified, not only the last", () => {
  // The intermittent-wedge shape: attempt 0 is transport-level, the last is not.
  // `infra_signature` stays last-attempt, so this file and
  // `remove-stable-from-failures.ts` still agree about the attempt they read.
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", TRANSPORT), result("failed", SPEC_ERROR)],
      },
    ]),
  );
  assert.equal(entry.failures[0].infra_signature, null);
  assert.equal(
    entry.failures[0].infra_signature_any_attempt,
    "api-request-timeout",
  );
});

test("a failure with no transport-level attempt at all records null", () => {
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("failed", SPEC_ERROR), result("failed", SPEC_ERROR)],
      },
    ]),
  );
  assert.equal(entry.failures[0].infra_signature_any_attempt, null);
});

test("a flaky entry carries the field too", () => {
  // A separate call site: deleting it there left the lane green while half the
  // rows silently lost the field.
  const entry = append(
    report([
      {
        title: "t",
        status: "flaky",
        results: [result("failed", TRANSPORT), result("passed")],
      },
    ]),
  );
  assert.equal(entry.flaky.length, 1);
  assert.equal(
    entry.flaky[0].infra_signature_any_attempt,
    "api-request-timeout",
  );
});

test("a passing attempt is never classified", () => {
  // A `passed` result carries no failure to read; counting it would let a stray
  // error field on a green attempt decide the row.
  const entry = append(
    report([
      {
        title: "t",
        status: "unexpected",
        results: [result("passed", TRANSPORT), result("failed", SPEC_ERROR)],
      },
    ]),
  );
  assert.equal(entry.failures[0].infra_signature_any_attempt, null);
});

// --- listing completeness (#1812/#1818) --------------------------------------

test("the listing verdict is recorded when the lane measured it, in either outcome", () => {
  // Keyed on LISTING_VERIFIED alone and NOT on "either field has content": the
  // informative row here is the clean one — `verified: true, missing: []` — which an
  // "either is non-empty" rule (the one `collection_gate_keys` correctly uses) would
  // drop every day.
  const clean = append(report([]), { LISTING_VERIFIED: "true", LISTING_MISSING: "[]" });
  assert.deepEqual(clean.listing_completeness, { verified: true, missing: [] });

  const lost = append(report([]), {
    LISTING_VERIFIED: "true",
    LISTING_MISSING: '["llm-agents/provider-invalid-auth-error.spec.ts"]',
  });
  assert.deepEqual(lost.listing_completeness, {
    verified: true,
    missing: ["llm-agents/provider-invalid-auth-error.spec.ts"],
  });
});

test("a lane that did not measure gets no block at all — absent, never clean", () => {
  assert.equal(append(report([])).listing_completeness, undefined);
  assert.equal(append(report([]), { LISTING_VERIFIED: "" }).listing_completeness, undefined);
});

test("`verified` is true only for the exact string, so an unknown never reads as checked", () => {
  for (const raw of ["false", "TRUE", "yes", "1"]) {
    assert.equal(append(report([]), { LISTING_VERIFIED: raw }).listing_completeness.verified, false, raw);
  }
});

test("the missing list is read as the JSON both lanes publish, and never throws", () => {
  // The Actions lane publishes a JSON array as a step output; the VM publishes the
  // same string. Whitespace is the fallback for a hand-run. This appender runs at the
  // END of a day whose verdict is already decided, so a throw costs the row for
  // everything else it carries.
  const cases = [
    ['["a.spec.ts","b.spec.ts"]', ["a.spec.ts", "b.spec.ts"]],
    ["a.spec.ts b.spec.ts", ["a.spec.ts", "b.spec.ts"]],
    ["not json", ["not", "json"]],
    ['["a.spec.ts",null,2,""]', ["a.spec.ts"]],
    // Parses as JSON but is not an array — a wiring break. The whitespace fallback
    // records it verbatim rather than as `[]`: visible nonsense in the row beats an
    // empty list that reads as "nothing was missing" (#1012).
    ["{}", ["{}"]],
    ["", []],
  ];
  for (const [raw, expected] of cases) {
    const entry = append(report([]), { LISTING_VERIFIED: "true", LISTING_MISSING: raw });
    assert.deepEqual(entry.listing_completeness.missing, expected, raw);
  }
});
