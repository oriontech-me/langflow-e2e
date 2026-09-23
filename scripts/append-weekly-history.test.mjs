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
import { execFileSync, spawnSync } from "node:child_process";
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

// ---------- how many products the run actually served (#1964) ----------

// `langflow_version` is ONE version: the lowest-index shard that answered. A sharded
// run can have served more, because the shards pull `:latest` into their own
// containers independently — and until this block nothing recorded that, so
// `compare-lane-verdicts.mjs` compared two single values for equality and its version
// gate PASSED while up to three shards of a lane had tested another build.

test("the sweep's facts ride on the row beside the one version it picked", () => {
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION: "1.13.0.dev3",
    LANGFLOW_VERSION_EXPECTED: "4",
    LANGFLOW_VERSION_ANSWERED: "4",
    LANGFLOW_VERSION_SILENT: "0",
    LANGFLOW_VERSIONS: "1.13.0.dev3,1.13.0.dev4",
  });
  assert.deepEqual(entry.langflow_version_sweep, {
    expected: 4,
    answered: 4,
    silent: 0,
    versions: ["1.13.0.dev3", "1.13.0.dev4"],
  });
  // All of them, because two agreeing answers prove nothing if two shards never spoke.
  assert.equal(entry.langflow_version, "1.13.0.dev3", "the picked version still rides alone");
});

test("no block at all when the lane does not measure it", () => {
  // Keyed on ANSWERED alone, the one value the reader always emits as a number when it
  // ran — so every row before #1964, and any lane not wired to it, simply has no block.
  // Absent is "this lane cannot say", which the comparator reports as UNVERIFIED rather
  // than as agreement (#1012).
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION: "1.13.0.dev3",
    LANGFLOW_VERSION_EXPECTED: "4",
    LANGFLOW_VERSIONS: "1.13.0.dev3",
  });
  assert.ok(!("langflow_version_sweep" in entry));
});

test("an EMPTY answered count means no block, not an unreadable one", () => {
  // Actions sets these from `steps.lfver.outputs.*`, which are empty strings when that
  // step never ran — a state that must read as "this lane did not measure", not as a
  // half-written block the comparator then reports as UNREADABLE.
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION_EXPECTED: "",
    LANGFLOW_VERSION_ANSWERED: "",
    LANGFLOW_VERSIONS: "",
  });
  assert.ok(!("langflow_version_sweep" in entry));
});

test("a sweep that resolved nothing is recorded as that, not as no sweep", () => {
  // Every shard silent is a measurement — and it is the state a wedged run produces.
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION: "",
    LANGFLOW_VERSION_EXPECTED: "4",
    LANGFLOW_VERSION_ANSWERED: "0",
    LANGFLOW_VERSION_SILENT: "4",
    LANGFLOW_VERSIONS: "",
  });
  assert.deepEqual(entry.langflow_version_sweep, { expected: 4, answered: 0, silent: 4, versions: [] });
  assert.equal(entry.langflow_version, null);
});

test("an unknown expected count is null, and does not take the block down with it", () => {
  // `--expect-shards` is optional and can be refused, so the reader emits `expected=`
  // empty. Reading that as 0 would make every answered shard look unaccounted for.
  // `0x10` and `1e3` are the load-bearing entries: `Number` reads them as 16 and 1000,
  // an input nobody meant, honoured without a word. `"abc"` pins nothing here — NaN
  // serialises to `null` through the row's JSON round trip, which is the same answer
  // the digit test gives — and it stays only as documentation of the shape.
  for (const expected of ["", "abc", "-1", "4.5", "0x10", "1e3"]) {
    const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
      LANGFLOW_VERSION_EXPECTED: expected,
      LANGFLOW_VERSION_ANSWERED: "2",
      LANGFLOW_VERSION_SILENT: "1",
      LANGFLOW_VERSIONS: "1.13.0.dev3",
    });
    // `silent` goes with it: a count of expected shards means nothing without one.
    assert.deepEqual(
      entry.langflow_version_sweep,
      { expected: null, answered: 2, silent: null, versions: ["1.13.0.dev3"] },
      `expected=${JSON.stringify(expected)} was not read as unknown`,
    );
  }
});

test("a stray shard's answer is not allowed to cancel a silent one out", () => {
  // #1964 review: 3 of 4 expected shards answered plus a leftover shard 5, so
  // `answered` is 4. The reader's `silent=1` is carried verbatim — the row must not be
  // left for the comparator to recompute as `expected - answered`, which is 0.
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION_EXPECTED: "4",
    LANGFLOW_VERSION_ANSWERED: "4",
    LANGFLOW_VERSION_SILENT: "1",
    LANGFLOW_VERSIONS: "1.13.0.dev3",
  });
  assert.equal(entry.langflow_version_sweep.silent, 1);
});

test("a missing silent count beside a known expected one is null, for the comparator to refuse", () => {
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION_EXPECTED: "4",
    LANGFLOW_VERSION_ANSWERED: "4",
    LANGFLOW_VERSIONS: "1.13.0.dev3",
  });
  assert.equal(entry.langflow_version_sweep.silent, null);
});

test("the version list is tolerated the way the listing's is, never thrown on", () => {
  const entry = append(report([{ title: "t", status: "expected", results: [result("passed")] }]), {
    LANGFLOW_VERSION_ANSWERED: "3",
    LANGFLOW_VERSIONS: " 1.13.0.dev3 , ,1.13.0.dev4, ",
  });
  assert.deepEqual(entry.langflow_version_sweep.versions, ["1.13.0.dev3", "1.13.0.dev4"]);
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

// ─── outage_overlap: the per-attempt backend measurement on the row (#1763) ──
//
// `infra_signature` classifies the error TEXT, so it is blind by construction to
// a spec that wraps its wait in an assertion: the message is about the state
// that never arrived, not about the transport. This block is the other evidence,
// and it has to be on the ROW because the `liveness-*` artifacts expire after 7
// days while the flake-recurrence window is 30.

const SPEC_FILE = "tests-automations/regression/smoke/a.spec.ts";

/** A results.json whose single flaky test failed `retries` times, then passed. */
function flakyReport(title, retries) {
  return report([
    {
      title,
      status: "flaky",
      results: [
        ...retries.map((retry) => ({ ...result("failed", SPEC_ERROR), retry })),
        { ...result("passed"), retry: retries.length },
      ],
    },
  ]);
}

function withOutageFile(payload, rep, envOver = {}) {
  const dir = makeTempDir("outage-");
  const file = join(dir, "outage-attempts.json");
  writeFileSync(file, JSON.stringify(payload));
  return append(rep, { OUTAGE_ATTEMPTS: file, ...envOver });
}

const outagePayload = (attempts, over = {}) => ({
  measured: true,
  reportRead: true,
  specMeasured: { [SPEC_FILE]: true },
  attempts,
  ...over,
});

test("#1763 a flake measured inside an outage carries the fraction, per attempt", () => {
  const entry = withOutageFile(
    outagePayload([
      { file: SPEC_FILE, title: "boots", retry: 0, shard: "2", coverage: 0.82, downSeconds: 108, shardDownPct: 41.2 },
      { file: SPEC_FILE, title: "boots", retry: 1, shard: "2", coverage: 0.87, downSeconds: 112, shardDownPct: 41.2 },
    ]),
    flakyReport("boots", [0, 1]),
  );
  const o = entry.flaky[0].outage_overlap;
  assert.equal(o.state, "overlapped");
  assert.equal(o.failed_attempts, 2);
  assert.equal(o.min_coverage, 0.82);
  assert.equal(o.shard, "2");
  assert.equal(o.shard_down_pct, 41.2);
  // The signature half is untouched and still says nothing — which is the whole
  // reason this block exists.
  assert.equal(entry.flaky[0].infra_signature, null);
  assert.equal(entry.flaky[0].infra_signature_any_attempt, null);
});

test("#1763 a hard failure carries it too, since the blindness is not flake-specific", () => {
  const entry = withOutageFile(
    outagePayload([
      { file: SPEC_FILE, title: "boots", retry: 0, shard: "2", coverage: 0.9, downSeconds: 90, shardDownPct: 30 },
    ]),
    report([
      {
        title: "boots",
        status: "unexpected",
        results: [{ ...result("failed", SPEC_ERROR), retry: 0 }],
      },
    ]),
  );
  assert.equal(entry.failures[0].outage_overlap.state, "overlapped");
  assert.equal(entry.failures[0].outage_overlap.min_coverage, 0.9);
});

test("#1763 a measured run with no overlap says `clear`, which is a measurement", () => {
  const entry = withOutageFile(outagePayload([]), flakyReport("boots", [0]));
  assert.equal(entry.flaky[0].outage_overlap.state, "clear");
  assert.equal(entry.flaky[0].outage_overlap.min_coverage, 0);
});

test("#1763 an unmeasured shard says so, and never reads as clear", () => {
  const entry = withOutageFile(
    outagePayload([], { specMeasured: { [SPEC_FILE]: false } }),
    flakyReport("boots", [0]),
  );
  assert.equal(entry.flaky[0].outage_overlap.state, "unmeasured");
  assert.match(entry.flaky[0].outage_overlap.why, /no liveness probes/);
});

test("#1763 a lane that does not measure omits the field entirely", () => {
  // Absence is this schema's word for "this lane does not measure it"; a null
  // would read as a measured nothing. weekly-stable.yml has no recorder at all.
  const entry = append(flakyReport("boots", [0]));
  assert.equal("outage_overlap" in entry.flaky[0], false);
});

test("#1763 an unreadable outage file degrades to absent and says why on stderr", () => {
  const dir = makeTempDir("outage-");
  const reportPath = join(dir, "results.json");
  const historyPath = join(dir, "history.jsonl");
  writeFileSync(reportPath, JSON.stringify(flakyReport("boots", [0])));
  const stderr = execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      PLAYWRIGHT_JSON: reportPath,
      HISTORY_FILE: historyPath,
      WORKFLOW: "unit",
      GITHUB_RUN_ID: "1",
      LANGFLOW_IMAGE: "img:tag",
      OUTAGE_ATTEMPTS: join(dir, "absent.json"),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = JSON.parse(readFileSync(historyPath, "utf8").trim());
  assert.equal("outage_overlap" in entry.flaky[0], false);
  assert.ok(stderr !== undefined);
});

test("#1763 a SKIPPED retry is not counted as a failed attempt", () => {
  // A describe.serial abort turns the retries into skipped results that carry no
  // error and never ran. Counting one would put a phantom attempt in
  // failed_attempts with coverage 0 and drag min_coverage down — silently
  // turning a fully corroborated collateral failure into an uncorroborated one.
  const entry = withOutageFile(
    outagePayload([
      { file: SPEC_FILE, title: "boots", retry: 0, shard: "2", coverage: 0.8, downSeconds: 80, shardDownPct: 40 },
    ]),
    report([
      {
        title: "boots",
        status: "unexpected",
        results: [
          { ...result("failed", SPEC_ERROR), retry: 0 },
          { ...result("skipped"), retry: 1 },
        ],
      },
    ]),
  );
  assert.equal(entry.failures[0].outage_overlap.failed_attempts, 1);
  assert.equal(entry.failures[0].outage_overlap.min_coverage, 0.8);
});

test("#1763 a timedOut or interrupted attempt counts as a failed attempt", () => {
  // The filter is the COMPLEMENT of {passed, skipped}, not `status === "failed"`.
  // Playwright's failing statuses are failed / timedOut / interrupted, and a
  // timeout is the single most likely shape for a wedge-adjacent failure —
  // narrowing to "failed" would drop a non-overlapping attempt from
  // failed_attempts and stop it dragging min_coverage below the threshold, i.e.
  // it would WIDEN the exemption.
  for (const status of ["timedOut", "interrupted"]) {
    const entry = withOutageFile(
      outagePayload([
        { file: SPEC_FILE, title: "boots", retry: 1, shard: "2", coverage: 0.9, downSeconds: 90, shardDownPct: 30 },
      ]),
      report([
        {
          title: "boots",
          status: "unexpected",
          results: [
            { ...result(status, SPEC_ERROR), retry: 0 },
            { ...result("failed", SPEC_ERROR), retry: 1 },
          ],
        },
      ]),
    );
    const o = entry.failures[0].outage_overlap;
    assert.equal(o.failed_attempts, 2, `${status} must count as a failed attempt`);
    assert.equal(o.min_coverage, 0, `${status} attempt 0 overlapped nothing and must drag min_coverage down`);
  }
});

test("#1763 the parameterization variant reaches the join, per provider", () => {
  const parameterized = {
    config: {},
    stats: { duration: 1000 },
    suites: [
      {
        title: "a.spec.ts",
        suites: ["openai / gpt-4o-mini", "google / gemini-3.5-flash"].map((label) => ({
          title: `Agent max iterations [${label}]`,
          specs: [
            {
              title: "boots",
              file: `tests/${SPEC_FILE}`,
              line: 10,
              tags: ["@stable"],
              tests: [
                {
                  status: "flaky",
                  results: [
                    { ...result("failed", SPEC_ERROR), retry: 0 },
                    { ...result("passed"), retry: 1 },
                  ],
                },
              ],
            },
          ],
        })),
      },
    ],
  };
  const entry = withOutageFile(
    outagePayload([
      { file: SPEC_FILE, title: "boots", retry: 0, param: "openai / gpt-4o-mini", shard: "2", coverage: 1, downSeconds: 60, shardDownPct: 3.3 },
    ]),
    parameterized,
  );
  const byParam = Object.fromEntries(entry.flaky.map((f) => [f.param, f.outage_overlap]));
  assert.equal(byParam["openai / gpt-4o-mini"].state, "overlapped");
  assert.equal(byParam["google / gemini-3.5-flash"].state, "clear",
    "google failed while the backend was answering — openai's outage must not answer for it");
});

// ─── A lost wiring must not read as "this lane does not measure" (#1763) ─────

/** Run the appender and return its stderr alongside the entry it wrote. */
function appendCapturingStderr(rep, envOver = {}) {
  const dir = makeTempDir("history-stderr-");
  const reportPath = join(dir, "results.json");
  const historyPath = join(dir, "history.jsonl");
  writeFileSync(reportPath, JSON.stringify(rep));
  const proc = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      PLAYWRIGHT_JSON: reportPath,
      HISTORY_FILE: historyPath,
      WORKFLOW: "unit",
      GITHUB_RUN_ID: "1",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      LANGFLOW_IMAGE: "img:tag",
      OUTAGE_ATTEMPTS: "",
      LIVENESS_DIR: "",
      ...envOver,
    },
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `the appender must still write the row: ${proc.stderr}`);
  const entry = JSON.parse(readFileSync(historyPath, "utf8").trim());
  return { entry, stderr: proc.stderr };
}

test("#1763 a lane that records liveness but passes no OUTAGE_ATTEMPTS says so", () => {
  // The failure this pins is the one an absent field cannot report. Absence is
  // this schema's word for "this lane does not measure it", so a daily that lost
  // its OUTAGE_ATTEMPTS env — a rename, a reordered step — would write rows
  // indistinguishable from weekly-stable.yml's, on every run, in silence.
  const dir = makeTempDir("liveness-");
  const { entry, stderr } = appendCapturingStderr(flakyReport("boots", [0]), { LIVENESS_DIR: dir });
  assert.equal(entry.flaky[0].outage_overlap, undefined, "the field is still absent — this is a report, not a gate");
  assert.match(stderr, /outage_overlap omitted/);
  assert.match(stderr, /LIVENESS_DIR is set/);
  assert.match(stderr, /OUTAGE_ATTEMPTS_OUT/, "and names the file to point it at");
});

test("#1763 a lane with no liveness recorder at all stays silent", () => {
  // weekly-stable.yml sets neither, and its rows are honestly unmeasured — a
  // warning there would be noise on every run and would train the reader to
  // ignore the one case above.
  const { entry, stderr } = appendCapturingStderr(flakyReport("boots", [0]));
  assert.equal(entry.flaky[0].outage_overlap, undefined);
  assert.equal(stderr.includes("outage_overlap omitted"), false, stderr);
});

test("#1763 an OUTAGE_ATTEMPTS that cannot be read still names the reason, not the wiring", () => {
  const dir = makeTempDir("liveness-");
  const { stderr } = appendCapturingStderr(flakyReport("boots", [0]), {
    LIVENESS_DIR: dir,
    OUTAGE_ATTEMPTS: join(dir, "does-not-exist.json"),
  });
  assert.match(stderr, /outage_overlap omitted/);
  assert.match(stderr, /could not be read/);
  assert.equal(stderr.includes("LIVENESS_DIR is set"), false, "the path was provided — this is a different failure");
});

test("#2009 an unexpected pass records its own signature, not \"unknown\"", () => {
  // The measured shape of a `test.fail()` whose body passed (Playwright 1.58.2):
  // status `unexpected`, every attempt `passed`, no error anywhere. There is no
  // failed attempt, which is why `lastFailed` found nothing and the row said
  // "unknown" — the same string as a failure whose error was lost.
  const entry = append(
    report([
      {
        title: "declared failing",
        status: "unexpected",
        results: [result("passed"), result("passed"), result("passed")],
      },
      { title: "lost error", status: "unexpected", results: [result("failed")] },
    ]),
  );
  assert.deepEqual(entry.totals, { passed: 0, failed: 2, flaky: 0, skipped: 0 });
  const [pass, lost] = entry.failures;
  assert.equal(pass.error_signature, "expected to fail but passed");
  assert.equal(pass.infra_signature, null, "a passing attempt is never transport-level");
  assert.equal(pass.attempts, 3);
  assert.equal(lost.error_signature, "unknown", "the genuine no-message failure is unchanged");
});

test("#2009 the pass is read off the LAST attempt: an earlier timeout does not mask it", () => {
  const entry = append(
    report([
      {
        title: "declared failing",
        status: "unexpected",
        results: [result("timedOut", "Test timeout of 30000ms exceeded."), result("passed")],
      },
    ]),
  );
  assert.equal(entry.failures[0].error_signature, "expected to fail but passed");
});
