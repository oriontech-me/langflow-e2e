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
//   OUTAGE_ATTEMPTS           Optional. Path to the `outage-attempts.json` that
//                             `report-backend-outages.mjs` writes earlier in the same
//                             job (its `OUTAGE_ATTEMPTS_OUT`). When set AND readable,
//                             every failure/flake entry carries `outage_overlap`
//                             (#1763). Unset means the lane does not measure it and the
//                             field is omitted — never recorded as a clean measurement.
//                             Unset while LIVENESS_DIR IS set is a broken wiring rather
//                             than such a lane, and says so on stderr: the row it writes
//                             is otherwise indistinguishable from weekly-stable.yml's.
//   COLLECTION_GATE_KEYS      Optional, and read as a PAIR with the one below:
//   COLLECTION_GATE_KEYS_ABSENT
//                             the collection-gating provider keys the run's listing
//                             resolved, and those it did not, space-separated names
//                             (never values) as `scripts/collection-gate-keys.ts`
//                             prints them. Together they produce the
//                             `collection_gate_keys` block; neither alone can, because
//                             a lane that resolved nothing and a lane that never
//                             measured both send an empty string (#1813).
//   LANGFLOW_VERSION_EXPECTED Optional, read together (#1964): how many shards the
//   LANGFLOW_VERSION_ANSWERED run expected, how many reported a served version, how
//   LANGFLOW_VERSION_SILENT   many EXPECTED shards reported none, and the distinct
//   LANGFLOW_VERSIONS         versions they served. All four come from
//                             `scripts/resolve-served-version.mjs`'s own outputs.
//                             `LANGFLOW_VERSION_ANSWERED` unset means the lane does not
//                             measure this, and no block is written.
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
//   `outage_overlap` (optional, additive to schema v1, #1763) is, PER ENTRY, how
//   much of each of its failed attempts sat inside measured backend downtime on
//   the shard that ran it: `{ state, failed_attempts, min_coverage, max_coverage,
//   attempts[], shard?, shard_down_pct?, why? }`. It exists because
//   `infra_signature` classifies the error TEXT, and a spec that wraps its wait in
//   an assertion reports the state that never arrived rather than the transport —
//   so a wedge-caused failure comes back `infra_signature: null` on every attempt
//   and a recurrence of it reads as attributable (measured twice in three weeks:
//   `agent-system-prompt.spec.ts:213` on 2026-09-08, `locale-resilience.spec.ts:116`
//   on 2026-09-10). The three states are not two: `overlapped` and `clear` are
//   measurements, `unmeasured` is the absence of one and carries `why` (#1012).
//   It is a MEASUREMENT, never a verdict — the coverage threshold that demotes a
//   flake lives in the triage dataset (`triage-core.mjs`), the same split
//   `infra_signature` keeps with `remove-stable-from-failures.ts`. Recorded here
//   because the `liveness-*` artifacts expire after 7 days while the flake
//   recurrence window is 30, so without it a later triage recomputing recurrence
//   sees the same `actionable: true` with no trace of the earlier refutation.
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
import { loadOutagePayload, overlapForEntry } from "./lib/outage-overlap.mjs";
import { paramFromSuitePath } from "./lib/spec-param.mjs";
import { UNEXPECTED_PASS_SIGNATURE, isUnexpectedPass } from "./lib/unexpected-pass.mjs";

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

// The parameterization label lives in `lib/spec-param.mjs` (#899, shared since
// #1763): `report-backend-outages.mjs` derives the same string for the join key,
// and a second copy here would only have to agree with it.

// The per-attempt outage corroboration (#1763), read ONCE for the whole run.
//
// Fail-closed and silent-never: an unset path, an unreadable file or a malformed
// payload all come back unavailable with a reason, which is PRINTED and makes
// every entry omit the field rather than record `clear`. The difference is the
// whole point of the block — a consumer that cannot tell "measured and clean"
// from "never measured" has no evidence at all (#1012).
const outagePayload = loadOutagePayload(process.env.OUTAGE_ATTEMPTS || "", readFileSync);
for (const line of outageOmissionNotice(process.env, outagePayload)) console.error(line);

/**
 * Why `outage_overlap` will be absent from every entry — or nothing, when the
 * lane legitimately does not measure.
 *
 * The distinction this exists for is the one an absent field cannot carry.
 * Absence is this schema's word for "this lane does not measure it"
 * (`collection_gate_keys`, `listing_completeness`), and `weekly-stable.yml`
 * really is such a lane — it has no liveness recorder at all. But a lane that
 * DOES record liveness and passes no `OUTAGE_ATTEMPTS` is not that: it is a
 * broken wiring, and the row it writes is indistinguishable from the weekly's.
 * Losing the daily's `OUTAGE_ATTEMPTS` — a rename, a reordered step, an edit to
 * the env block — would therefore have cost the measurement on every future run
 * and said nothing at all, in the file that invokes #1012 in five places.
 *
 * `LIVENESS_DIR` is the discriminator because it is already exactly that claim:
 * the appender reads it to build the row's `backend` block (#1077), and the two
 * lanes that set it (`daily-stable.yml`'s merge job, `run-e2e.sh`'s publish
 * phase) are precisely the two that produce `outage-attempts.json` a step
 * earlier. `weekly-stable.yml` sets neither, so it stays silent.
 *
 * Not exported: importing this module runs the whole script (it reads env and
 * appends a line), which is why every test here drives it as a subprocess. The
 * notice is asserted on the real stderr for the same reason.
 */
function outageOmissionNotice(env, payload) {
  if (payload?.available === true) return [];
  if (env.OUTAGE_ATTEMPTS) return [`[history] outage_overlap omitted: ${payload.reason}`];
  if (!env.LIVENESS_DIR) return []; // a lane with no recorder — absence is the honest record
  return [
    "[history] outage_overlap omitted: this run records backend liveness (LIVENESS_DIR is set) " +
      "but passed no OUTAGE_ATTEMPTS path, so no failing attempt could be placed inside a measured " +
      "outage. Point it at the `OUTAGE_ATTEMPTS_OUT` file `report-backend-outages.mjs` writes " +
      "earlier in the same job (#1763) — the row is otherwise indistinguishable from a lane that " +
      "does not measure at all.",
  ];
}

// `result.retry` of every attempt that did not pass, oldest first.
//
// `skipped` is excluded for the same reason the hard-failure path below excludes
// it: a `describe.serial` abort turns the retries into skipped results that
// carry no error and never ran, so counting them would put a phantom attempt in
// `failed_attempts` and drag `min_coverage` to 0 — i.e. it would silently
// convert a fully-corroborated collateral failure into an uncorroborated one.
function failedRetries(test) {
  return (test?.results || [])
    .filter((r) => r.status !== "passed" && r.status !== "skipped")
    .map((r) => Number(r.retry) || 0);
}

// The spread-ready `outage_overlap` field for one entry: `{}` when the lane does
// not measure, so the field is ABSENT rather than null. Absence is already this
// schema's word for "this lane does not measure it" (`collection_gate_keys`,
// `listing_completeness`), and a null would read as a measured nothing.
function outageOverlapField(file, title, param, test) {
  const block = overlapForEntry(
    { specPath: file, title, param, failedRetries: failedRetries(test) },
    outagePayload,
  );
  return block ? { outage_overlap: block } : {};
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
          ...outageOverlapField(file, title, param, test),
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
        // An unexpected pass (#2009) has no failed attempt, so `lastFailed` is
        // undefined and this used to be "unknown" — pooling the fix-day signal of a
        // declared bug with every failure whose error was lost. `build-run-payload.mjs`
        // records the same signature from the same predicate.
        error_signature: isUnexpectedPass(test)
          ? UNEXPECTED_PASS_SIGNATURE
          : firstErrorMessage(lastFailed) || "unknown",
        // Classified from the LAST failed attempt, matching the exemption's own
        // wording ("a hard failure whose LAST error is transport-level") and
        // `remove-stable-from-failures.ts`, so the history and the umbrella's
        // collateral block cannot disagree about the same failure.
        infra_signature: infraSignatureId(lastFailed),
        infra_signature_any_attempt: infraSignatureAnyAttempt(test),
        ...outageOverlapField(file, title, param, test),
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
// `langflow_version_sweep` (optional, additive to schema v1, #1964).
//
// `langflow_version` is ONE version — the lowest-index shard that answered
// (`scripts/lib/served-version.mjs`) — and a sharded run can have served more than
// one: the four shards pull `:latest` into their own containers independently, so a
// nightly published mid-run really can split them. The sweep sees that and, until
// this field, nothing recorded it: the row carried shard 1's answer and
// `compare-lane-verdicts.mjs` compared two single values for equality, passing its
// own version gate while up to three shards of a lane tested another build.
//
// Three facts, because the question "did this lane test one product?" needs all
// three: how many shards were EXPECTED, how many ANSWERED, and the DISTINCT
// versions they served. Two answers agreeing proves nothing if two shards never
// spoke, so the counts are not decoration.
//
// Keyed on `LANGFLOW_VERSION_ANSWERED` alone — the one variable the reader always
// emits as a number when it ran at all — so an absent block means the lane does not
// measure this (every row before #1964, and any lane not wired to the reader).
const versionSweep = (() => {
  const answeredRaw = process.env.LANGFLOW_VERSION_ANSWERED;
  if (answeredRaw === undefined || answeredRaw.trim() === "") return null;
  // DECIMAL DIGITS ONLY, and blank is `null`, not zero. `Number("")` is 0, which read
  // an unknown expected count — what the reader emits when `--expect-shards` was absent
  // or refused — as "the run expected no shards", and then every shard that answered
  // looked unaccounted for. Garbage in `answered` leaves `null` too, so the block reads
  // as UNREADABLE downstream rather than as a measurement of nothing.
  const count = (raw) => {
    const text = String(raw ?? "").trim();
    return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  };
  const expected = count(process.env.LANGFLOW_VERSION_EXPECTED);
  return {
    expected,
    answered: count(answeredRaw),
    // The expected shards that reported nothing, as the reader counted them. Not
    // `expected - answered`: `answered` includes a shard outside the expected range,
    // so a stray answer would cancel a silent shard out (#1964 review). Meaningless
    // without an expected count, so `null` whenever `expected` is.
    silent: expected === null ? null : count(process.env.LANGFLOW_VERSION_SILENT),
    // A comma list, which is what the reader emits. Tolerant in the same direction
    // as `listingMissing`: anything unparseable becomes an empty list rather than a
    // throw, and the consumer reads a block whose `answered` disagrees with its
    // `versions` as UNREADABLE rather than as a measurement.
    versions: String(process.env.LANGFLOW_VERSIONS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
})();

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
  ...(versionSweep ? { langflow_version_sweep: versionSweep } : {}),
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
