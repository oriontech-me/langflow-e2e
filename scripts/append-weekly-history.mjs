#!/usr/bin/env node
// Append one JSON line to reports/weekly-history.jsonl from a Playwright
// JSON report. Designed to run inside weekly-stable.yml after the test step.
//
// Inputs (env vars):
//   PLAYWRIGHT_JSON           Path to Playwright JSON output (default: results.json)
//   HISTORY_FILE              Path to JSONL file (default: reports/weekly-history.jsonl)
//   WORKFLOW                  Workflow id stored in the entry (default: weekly-stable)
//   GITHUB_RUN_ID             Run id (provided by Actions)
//   GITHUB_SERVER_URL         e.g. https://github.com (provided by Actions)
//   GITHUB_REPOSITORY         e.g. owner/repo (provided by Actions)
//   LANGFLOW_IMAGE            Full image ref including tag, e.g. langflowai/langflow-nightly:latest
//   LANGFLOW_VERSION          Optional. The RESOLVED version the run actually tested,
//                             e.g. 1.13.0.dev3. Recorded because LANGFLOW_IMAGE is a
//                             moving tag: two rows both saying ":latest" prove nothing
//                             about whether they tested the same product.
//   LIVENESS_DIR              Optional. Directory holding the per-shard
//                             backend-liveness.json summaries. When set AND at
//                             least one summary is found, the entry carries the
//                             `backend` block (#1077); otherwise it is omitted.
//   SHARD_TOTAL               Optional. The run's declared shard count, recorded
//                             so a shard that uploaded nothing cannot vanish.
//   COLLECTION_GATE_KEYS      Optional, and read as a PAIR with the one below:
//   COLLECTION_GATE_KEYS_ABSENT
//                             the collection-gating provider keys the run's listing
//                             resolved, and those it did not, space-separated names
//                             (never values) as `scripts/collection-gate-keys.ts`
//                             prints them. Together they produce the
//                             `collection_gate_keys` block; neither alone can, because
//                             a lane that resolved nothing and a lane that never
//                             measured both send an empty string (#1813).
//   LISTING_VERIFIED          Optional, and read as a PAIR with the one below:
//   LISTING_MISSING           whether the run's listing was shown to contain every spec
//                             file declaring an `@stable` test ("true"/"false"), and the
//                             paths of those it did not, as the JSON array both lanes
//                             publish (whitespace-separated is also accepted, for a
//                             hand-run) (#1812/#1818).
//                             Together they produce the `listing_completeness` block;
//                             `LISTING_VERIFIED` unset means the lane does not measure
//                             it, and the block is omitted.
//
// Schema (version 1):
// {
//   "version": 1,
//   "date": "YYYY-MM-DD",
//   "workflow": "weekly-stable",
//   "run_id": "...",
//   "run_url": "...",
//   "langflow_image": "...",
//   "langflow_version": "..." | null,           // optional, see below
//   "duration_ms": 0,
//   "totals": { "passed": 0, "failed": 0, "flaky": 0, "skipped": 0 },
//   "failures": [ { test, file, line, tags, attempts, error_signature, infra_signature, param? } ],
//   "flaky":    [ { test, file, line, tags, attempts, error_signature, infra_signature, param? } ],
//   "run_errors": [ "..." ]                     // optional, see below
//   "report_missing": true                      // optional, see below
//   `infra_signature_any_attempt` (additive to schema v1, #1589) is the same
//   classifier run over EVERY failed attempt, earliest match wins — a lead for a
//   triage recomputing recurrence, never a verdict, since it carries no
//   corroboration that the backend was actually down.
//   `infra_signature` (additive to schema v1, #1310) is the id of the
//   infra-signature the entry's error matched (`scripts/lib/infra-signatures.mjs`)
//   or null — i.e. "the harness could not reach the backend, so this failure is
//   not attributable to the spec that reported it". It is written HERE, rather
//   than derived by triage, because it must be classified from the FULL error
//   text: `error_signature` is line 1 only, and a wedge routinely surfaces as an
//   assertion whose *cause* line carries the transport error (the `#751`
//   credential guard being the usual wrapper). Rows written before #1310 lack
//   the field, and the triage dataset falls back to classifying
//   `error_signature` for those — a strictly weaker check.
//   `backend` (optional, additive to schema v1, #1077) is the in-run backend
//   liveness measurement for the run — outage count, unreachable seconds, and
//   the per-shard breakdown of the same, alongside each shard's observed span
//   and its passed/failed/flaky/skipped counts. It exists because the wedge is
//   measured into `liveness-N` artifacts that expire after 7 days, so #1077's
//   before/after had no durable series to compare against. Recording only; no
//   gate reads it. See scripts/lib/backend-history.mjs.
//   `listing_completeness` (optional, additive to schema v1, #1812/#1818) is
//   `{ verified: bool, missing: [...] }` — whether this run's `--grep @stable --list`
//   was shown to contain every spec file that DECLARES an `@stable` test, and which it
//   did not. It is the other half of `collection_gate_keys`: that field says which
//   suite the listing environment would produce, this says whether the listing then
//   produced it. A spec whose tests are generated at collection time leaves the
//   partition with no skip, no error and no row to be missing from, so the count is
//   simply smaller (#1764) — and where the gate can only hint at that by naming an
//   absent key, this names the FILE. `verified: false` means the check could not be
//   made, which is not the same as `missing: []`; the block's absence means the lane
//   does not measure it at all. The comparator reads all three states.
//   `collection_gate_keys` (optional, additive to schema v1, #1813) is
//   `{ present: [...], absent: [...] }` — which provider keys the run's LISTING
//   resolved. It is not a record of what the tests could reach: these keys gate
//   COLLECTION, so a spec file generated entirely from a missing one collects zero
//   tests, never enters the file-level partition, and is run by no shard. The row's
//   totals are then smaller for a reason no failure, skip or error records. Two lanes
//   whose rows carry different sets are not comparable by count, and this is the field
//   that says so instead of leaving it to be inferred (#1764 inferred it wrongly
//   twice). The BLOCK's absence means the run did not measure its gate; `present: []`
//   inside it means it measured and resolved nothing — a distinction the counts alone
//   cannot make. And it describes the LISTING's environment, not the run's: on Actions
//   that is the `prep` job, whose three collection-gating secrets (#1796) are a SUBSET
//   of the provider block its `test` shards carry, and on the VM it is the same shell
//   as the `--list`. So the field says which spec FILES a lane could collect, never
//   which providers its tests could reach. That is why the comparator explains a
//   TEST-COUNT difference with this field and refuses to explain a SKIP difference
//   with it.
//   `langflow_version` (optional, additive to schema v1) is the resolved version
//   string the run tested, as opposed to the tag it asked for. It exists for the
//   two-lane comparison of the VM migration: the Actions daily and the VM daily each
//   append here, and a comparison between rows that tested DIFFERENT Langflows
//   describes the product's changelog rather than the difference between the two
//   environments. Without this field the comparator can only declare version parity
//   UNVERIFIED, which is honest and useless. Rows written before it lack it.
//   `param` (optional, additive to schema v1) is the parameterization label a
//   model-parameterized spec carries on its describe title (e.g.
//   "google / gemini-2.5-flash" or "model:gpt-4o-mini"), used by the triage
//   dataset to group failures by provider variant (#899).
//   `report_missing` (optional, additive to schema v1, #1176) marks a line written
//   with NO merged Playwright report at all. Present only in that case; its absence
//   is the normal state. The line still carries zero totals and is selected by the
//   same "executed NO test at all" query as any other infra abort; this field is what
//   separates "there was no report" from "the report reported errors", which are
//   different diagnoses. It does NOT say which abort produced it — every shard dying
//   before its blob, and a merge failing on blobs that were written (#1726), both
//   land here, and only the first means no test ran. The blob count that tells them
//   apart lives in the merge job's `shardguard` step, which is where the umbrella
//   issue reads it. Its `run_errors[0]` is SYNTHESIZED by this script rather than
//   read from the report, which is the only place that happens.
//   `run_errors` (optional, additive to schema v1) carries the TOP-LEVEL report
//   errors — globalSetup / worker-level failures that stopped tests from running
//   at all. Omitted when there are none, so its presence is itself the signal
//   that something failed outside the tests (#1012).
// }

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { classifyInfraError } from "./lib/infra-signatures.mjs";

const SCHEMA_VERSION = 1;

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
const historyPath = process.env.HISTORY_FILE || "reports/weekly-history.jsonl";
const workflow = process.env.WORKFLOW || "weekly-stable";

// An ABSENT report is an infra abort, not a reason to skip the day. Exiting 0 here
// reported absence as SUCCESS: on 2026-07-31 every shard aborted before its first
// test, so no blob existed, `Merge blob reports` failed, no results.json was ever
// written — and `Append daily history` / `Commit daily history` both went green
// while writing nothing. The day is simply missing from the series, and a `jq`
// query reads 2026-07-30 followed by 2026-08-03 as two consecutive weekdays. The
// day that most needs a record is the one that had none (#1176).
//
// The entry is built from what is knowable WITHOUT the report — date, run id, url,
// image — with every total at zero, which is exactly the shape the README's "runs
// that executed NO test at all" query already selects on, so this needs no new
// query and no schema version bump. `run_errors` carries the synthesized reason so
// that query prints a cause instead of its "no recorded reason" fallback, and
// `report_missing` marks the provenance so a consumer can tell a report-sourced
// error from this one.
//
// Only in a real CI run. Locally `GITHUB_RUN_ID` is unset and the old exit(0)
// stands: running this script by hand in a tree with no results.json must not
// append a junk line to a committed, machine-written file.
const reportMissing = !existsSync(reportPath);
if (reportMissing && !process.env.GITHUB_RUN_ID) {
  console.error(`[history] Playwright JSON not found at ${reportPath}; skipping append (not a CI run).`);
  process.exit(0);
}
if (reportMissing) {
  console.error(`[history] Playwright JSON not found at ${reportPath}; recording an infra abort.`);
}

const report = reportMissing ? null : JSON.parse(readFileSync(reportPath, "utf8"));

const totals = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
const failures = [];
const flaky = [];

function firstErrorMessage(result) {
  return errorSignature(result?.error || result?.errors?.[0]);
}

// The COMPLETE message of the same error object `firstErrorMessage` summarises —
// uncapped and unsplit. Only used for `infra_signature` (#1310): the exemption's
// classifier matches anywhere in the message, and truncating to line 1 first is
// what makes it miss the guard-wrapped shape. Never stored; the full text of a
// failure belongs in the artifact, not in the history file.
function fullErrorText(result) {
  const err = result?.error || result?.errors?.[0];
  if (!err) return null;
  return err.message || err.value || null;
}

// The id of the infra signature this error carries, or null. `null` means "could
// be the spec's own", never "definitely the spec's own" — the list is narrow by
// design (scripts/lib/infra-signatures.ts).
function infraSignatureId(result) {
  return classifyInfraError(fullErrorText(result))?.id ?? null;
}

// The signature carried by the EARLIEST failed attempt that has one, across
// every attempt of the test (#1589). Additive to schema v1; `infra_signature`
// keeps its meaning untouched, so this file and
// `remove-stable-from-failures.ts` still agree about the attempt they read.
//
// It exists because an INTERMITTENT wedge cycles through the retry budget
// rather than burning it, so a transport-level signature can sit on attempt 0
// and be gone by the last one — on run 32827671203 that was 4 of 7 hard
// failures, every one of them recorded here as `infra_signature: null`, which
// left a later triage recomputing recurrence from the history unable to see
// them as collateral at all.
//
// It is a SIGNATURE, never a verdict: it carries no corroboration, so a row
// with it is a lead. The exemption decision lives in the run's auto-remove
// result, which is the only place that has the liveness overlap.
function infraSignatureAnyAttempt(test) {
  for (const result of test?.results || []) {
    if (result?.status === "passed" || result?.status === "skipped") continue;
    const id = infraSignatureId(result);
    if (id) return id;
  }
  return null;
}

// Normalise ONE error object (not a result) to its signature: first *non-empty*
// line (some messages lead with a blank line), trimmed and capped so equal
// causes cluster to an equal signature. Shared by the per-test path above and
// the top-level `report.errors` path below, whose entries are already error
// objects rather than results.
function errorSignature(err) {
  if (!err) return null;
  const raw = err.message || err.value || "";
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 240) : null;
}

function specRelFile(spec) {
  const file = spec?.file || spec?.location?.file || "";
  try {
    return relative(process.cwd(), resolve(file));
  } catch {
    return file;
  }
}

// Extract the parameterization label a model-parameterized spec carries on its
// `describe` title — e.g. `Agent max_tokens [google / gemini-2.5-flash]` →
// `google / gemini-2.5-flash`, or `[model:gpt-4o-mini]` → `model:gpt-4o-mini`.
// Scan the suite path innermost-first and return the first bracketed content;
// null when nothing is parameterized. Recorded as `param` so the triage dataset
// can group failures by provider variant (#899).
function paramFromSuitePath(suitePath) {
  for (let i = suitePath.length - 1; i >= 0; i--) {
    const m = /\[([^\]]+)\]/.exec(suitePath[i] || "");
    if (m) return m[1].trim();
  }
  return null;
}

function visit(node, suitePath = []) {
  const path = node.title ? [...suitePath, node.title] : suitePath;
  const param = paramFromSuitePath(path);
  for (const spec of node.specs || []) {
    const file = specRelFile(spec);
    const line = spec?.line || spec?.location?.line || 0;

    for (const test of spec.tests || []) {
      const tags = test.tags || spec.tags || [];
      const status = test.status; // "expected" | "unexpected" | "flaky" | "skipped"
      const attempts = (test.results || []).length;
      const title = spec.title;

      if (status === "skipped") {
        totals.skipped++;
        continue;
      }
      if (status === "expected") {
        totals.passed++;
        continue;
      }
      if (status === "flaky") {
        totals.flaky++;
        // A flaky test failed on an earlier attempt and passed on a retry.
        // Surface that first failed attempt's message through the same
        // normaliser used for hard failures, so the flake-recurrence criterion
        // in CONTRIBUTING.md (same signature within 30 days) can be applied
        // mechanically to `.flaky[]` rows too. Pick the first result that
        // actually carries a message — skipping any interrupted/no-message
        // attempt that may precede the real failure.
        // Hold on to the RESULT, not just its signature: `infra_signature` has to
        // be classified from that same attempt's full error text (#1310).
        const firstFailedResult = (test.results || []).find((r) => firstErrorMessage(r));
        const firstFailedSignature = firstErrorMessage(firstFailedResult);
        flaky.push({
          test: title,
          file,
          line,
          tags,
          attempts,
          error_signature: firstFailedSignature || "unknown",
          infra_signature: infraSignatureId(firstFailedResult),
          infra_signature_any_attempt: infraSignatureAnyAttempt(test),
          ...(param ? { param } : {}),
        });
        continue;
      }
      // unexpected (or anything else) → failure
      totals.failed++;
      // `skipped` is excluded, not just `passed` (#1310). When a test fails and
      // its retries are then SKIPPED — what a `test.describe.serial` block does
      // when it aborts — the last non-passed result is a skipped attempt that
      // carries no error at all, so this used to select it and record
      // `error_signature: "unknown"` while the real message sat on attempt 0.
      // Two of the 24 hard failures on run 30997773754 landed that way
      // (`webhook-component-regression:191`, `agent-context-id-isolation:557`),
      // and `unknown` is not a signature but the absence of one: triage's
      // recurrence rule matches on it, so message-less failures clustered
      // together across unrelated specs.
      //
      // `build-run-payload.mjs` has always excluded `skipped` here, and its
      // header claims to mirror this file's parsing — the two had drifted, which
      // is why the umbrella's collateral block named these two failures while
      // the history row for the same failure said `unknown`.
      const lastFailed = [...(test.results || [])]
        .reverse()
        .find((r) => r.status !== "passed" && r.status !== "skipped");
      failures.push({
        test: title,
        file,
        line,
        tags,
        attempts,
        error_signature: firstErrorMessage(lastFailed) || "unknown",
        // Classified from the LAST failed attempt, matching the exemption's own
        // wording ("a hard failure whose LAST error is transport-level") and
        // `remove-stable-from-failures.ts`, so the history and the umbrella's
        // collateral block cannot disagree about the same failure.
        infra_signature: infraSignatureId(lastFailed),
        infra_signature_any_attempt: infraSignatureAnyAttempt(test),
        ...(param ? { param } : {}),
      });
    }
  }
  for (const child of node.suites || []) visit(child, path);
}

for (const suite of report?.suites || []) visit(suite);

const runId = process.env.GITHUB_RUN_ID || "local";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const repo = process.env.GITHUB_REPOSITORY || "";
const runUrl = repo ? `${serverUrl}/${repo}/actions/runs/${runId}` : null;

// Top-level report errors — globalSetup / worker-level failures that stopped
// tests from running at all, as opposed to a test failing. Recorded so a line
// whose `totals` are ALL ZERO carries its own explanation instead of being
// indistinguishable from "nothing failed" (#1012: on 2026-07-28 every shard
// aborted in the globalSetup preflight and the history line said 0/0/0/0 with
// no reason attached). Additive and optional — omitted when there are none, so
// schema v1 readers are unaffected.
// The synthesized reason says only what this script MEASURED: that no merged report
// exists at `reportPath`. It deliberately does NOT claim the shards produced nothing —
// two different aborts land here and the wording used to assert the first: every shard
// dying before its blob, and every shard finishing while `merge-reports` fails on the
// blobs they wrote (#1726). Naming the wrong one is the exact miscue #1726 had to fix
// in the umbrella issue's own title. The distinction IS available upstream — the
// `shardguard` step counts the blobs and `create-failure-issue.mjs` renders the two
// shapes apart — so it is read there, not guessed here.
const runErrors = reportMissing
  ? [`Playwright JSON absent at ${reportPath} — no merged report was produced (infra abort)`]
  : (report?.errors || []).map((e) => errorSignature(e)).filter(Boolean);

// In-run backend liveness (#1077). Built from the same per-shard summaries the
// merge job's outage reporter renders into the umbrella issue, through that
// script's own readers — a row here and that section describe the same run with
// the same numbers by construction, not by two parsers agreeing.
//
// Wrapped, and imported DYNAMICALLY inside the wrap. This line is written on a
// red day, and a diagnostic must never be the reason the run history goes
// unrecorded — but a static import runs the module body before any of this file
// executes, so a top-level throw in `backend-history.mjs` (or in
// `report-backend-outages.mjs`, which it pulls in) would abort the appender
// before a line existed, on EVERY lane including `weekly-stable.yml` and local
// runs that set no LIVENESS_DIR at all. The imported reporter's own "a
// diagnostic must never redden a step" guarantee lives in its entry point, not
// in its module body. Here the blast radius is the block: a throw is reported
// and the entry is written without it, which reads as "not measured" — never as
// a healthy backend.
let backend = null;
if (process.env.LIVENESS_DIR) {
  try {
    const { backendBlockFromDir } = await import("./lib/backend-history.mjs");
    backend = backendBlockFromDir(
      process.env.LIVENESS_DIR,
      report,
      Number(process.env.SHARD_TOTAL) || null,
    );
  } catch (err) {
    console.error(`[history] backend liveness block skipped: ${err?.message || err}`);
  }
}

// The listing's provider gate (#1813). Names only — the resolver never reads a value —
// and split on whitespace so the empty string yields `[]` rather than `[""]`.
//
// The block is written when EITHER list has a name in it, which is exactly "the run
// measured its gate": the resolver refuses to report an empty derivation at all, so a
// measured run always names at least one key on one side. A run that did not measure
// sends two empty strings and gets no block — absent, never an empty measurement.
const gateNames = (value) => (value ?? "").trim().split(/\s+/).filter(Boolean);
const gatePresent = gateNames(process.env.COLLECTION_GATE_KEYS);
const gateAbsent = gateNames(process.env.COLLECTION_GATE_KEYS_ABSENT);
const collectionGateKeys =
  gatePresent.length || gateAbsent.length ? { present: gatePresent, absent: gateAbsent } : null;

// Whether the listing CONTAINED the suite the gate above says it would list
// (#1812/#1818). The two answer different halves and only the pair is a claim: the
// gate records the listing's environment, this records what that environment actually
// produced, and a spec generated at COLLECTION time can vanish between them with no
// failure, skip or error to show for it (#1764).
//
// Keyed on `LISTING_VERIFIED` ALONE, not on "either field has content", because the
// informative state here is the opposite of the gate's: `missing: []` with
// `verified: true` is the answer worth recording every day, and an "either is
// non-empty" rule would drop exactly that row. A lane that does not measure sends
// nothing and gets no block — absent, never a clean measurement it did not make.
const listingVerifiedRaw = process.env.LISTING_VERIFIED;
/**
 * The missing list as both lanes publish it: a JSON array of spec paths.
 *
 * Whitespace splitting is kept as the fallback rather than as the format, so a
 * hand-run passing bare paths still records them — and so does anything else that is
 * not a JSON array, verbatim. That is deliberate: both producers emit
 * `JSON.stringify(array)`, so a value of another shape is a wiring break, and
 * recording it as garbage keeps it visible where an empty list would read as "nothing
 * was missing" (#1012). Parsed defensively for the reason every optional input here
 * is: this appender runs at the END of a day whose verdict is already decided, so a
 * throw costs the row for everything else it carries.
 */
const listingMissing = (raw) => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((f) => typeof f === "string" && f);
  } catch {
    /* not JSON — fall through to the whitespace form */
  }
  return gateNames(raw);
};
const listingCompleteness =
  listingVerifiedRaw === undefined || listingVerifiedRaw === ""
    ? null
    : {
        verified: listingVerifiedRaw === "true",
        missing: listingMissing(process.env.LISTING_MISSING),
      };

const entry = {
  version: SCHEMA_VERSION,
  date: new Date().toISOString().split("T")[0],
  workflow,
  run_id: runId,
  run_url: runUrl,
  langflow_image: process.env.LANGFLOW_IMAGE || null,
  langflow_version: process.env.LANGFLOW_VERSION || null,
  duration_ms: Math.round(report?.stats?.duration ?? 0),
  totals,
  failures,
  flaky,
  ...(runErrors.length ? { run_errors: runErrors } : {}),
  ...(reportMissing ? { report_missing: true } : {}),
  ...(backend ? { backend } : {}),
  ...(collectionGateKeys ? { collection_gate_keys: collectionGateKeys } : {}),
  ...(listingCompleteness ? { listing_completeness: listingCompleteness } : {}),
};

mkdirSync(dirname(historyPath), { recursive: true });
appendFileSync(historyPath, JSON.stringify(entry) + "\n");

const executed = totals.passed + totals.failed + totals.flaky + totals.skipped;
const summary = `[history] ${entry.date} ${workflow} run=${runId} ` +
  `passed=${totals.passed} failed=${totals.failed} flaky=${totals.flaky} skipped=${totals.skipped}` +
  (runErrors.length ? ` run_errors=${runErrors.length}` : "") +
  (backend
    ? ` outages=${backend.outages_total} down=${backend.down_seconds_total}s` +
      ` shards_measured=${backend.shards_measured}/${backend.shard_total ?? "?"}`
    : "") +
  (executed === 0 ? " (ZERO tests executed — infra abort)" : "");
console.log(summary);
