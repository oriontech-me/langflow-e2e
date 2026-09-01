// Unit tests for the node-run outcome decision (issue #1667).
// Run with: npm run test:units
//
// What rides on this module: `node_duration_*` is an observable of a SUCCESSFUL
// build, never of a run having finished. The running image's own bundle renders
// it inside a ternary — success yields `node_duration_<node>`, and every other
// build status falls through to `node_status_icon_<node>_<status>`, which for an
// errored Knowledge ingest is `node_status_icon_knowledge_undefined` and is not
// even visible. So a wait gating on the badge alone cannot observe a failed run:
// it burns its whole budget and reports `element(s) not found`, naming the badge
// instead of the cause. That is exactly how `rag-pipeline.spec.ts` spent four
// dailies (2026-07-16, 2026-07-22, 2026-08-18, 2026-09-01) reporting an
// unattributable 90 s timeout while the real reason — a Google Vertex
// project-wide per-minute quota answering the embedding call with
// 429 RESOURCE_EXHAUSTED — was on screen within ~1 s.
//
// The decision lives here, in a pure function, rather than inside the polling
// loop, because #1226 established that a guard pinning a SPELLING does not pin a
// BEHAVIOUR — and because the loop body itself is unreachable from a test.
//
// Five distinctions these tests exist to protect:
//
//  1. **An unreadable reason is NOT transient.** "We could not read why it
//     failed" and "it failed for a reason we retry" are opposite verdicts.
//     Retrying an unknown burns the budget and then reports the same nothing;
//     #1012's rule is that an unevaluated observation is unknown, not clean.
//  2. **A hard build error is never retried.** Re-running a graph that cannot
//     build only delays the same verdict three times over — the stance
//     `api-component-regression.spec.ts` already takes for a rejected URL.
//  3. **The last attempt fails, it does not retry.** An off-by-one here turns a
//     bounded budget into a fourth run whose failure has nowhere to go.
//  4. **The thrown message carries the on-screen reason.** The entire point of
//     the change is attribution; a message that says "the ingest failed" and
//     drops the 429 rebuilds the defect with extra steps.
//  5. **Success outranks everything.** A stale failure banner still painted from
//     a prior attempt must never override a badge that is now visible, or a
//     healthy retry reports the failure it just recovered from.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NODE_RUN_MAX_ATTEMPTS,
  NODE_RUN_RETRY_DELAY_MS,
  NODE_RUN_TIMEOUT_MS,
  decideNodeRunOutcome,
  dedupeRepeatedReason,
  extractBuildFailureReason,
  isTransientRunFailure,
} from "./run-node-and-wait";

/** The verbatim message the daily and a local repro both recorded (#1667). */
const QUOTA_REASON =
  "Flow build failed Error embedding content (RESOURCE_EXHAUSTED): 429 " +
  "RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'Quota exceeded for " +
  "aiplatform.googleapis.com/global_embed_content_requests_per_minute_per_base_model " +
  "with base model: gemini-embedding.', 'status': 'RESOURCE_EXHAUSTED'}}";

// ---------------------------------------------------------------------------
// isTransientRunFailure — the class of reason that is worth another attempt
// ---------------------------------------------------------------------------

test("the measured 429 quota reason is transient", () => {
  assert.equal(isTransientRunFailure(QUOTA_REASON), true);
});

test("each provider rate-limit spelling is transient on its own", () => {
  for (const reason of [
    "429 Too Many Requests",
    "RESOURCE_EXHAUSTED",
    "resource_exhausted",
    "Quota exceeded for this model",
    "You exceeded your current quota",
    "Rate limit reached for gpt-4o-mini",
    "rate_limit_error",
    "429 RESOURCE_EXHAUSTED",
  ]) {
    assert.equal(isTransientRunFailure(reason), true, reason);
  }
});

test("a product build error is NOT transient — retrying only delays the verdict", () => {
  // Every one of these is a real failure this suite must report on the first
  // attempt. Classifying any of them as transient would spend the whole retry
  // budget and then report the same thing, 60 s later.
  for (const reason of [
    "Column 'text' not found in DataFrame",
    "ComponentBuildError: embedding model 'models/gemini-embedding-001' is no longer recognized",
    "SSRF Protection: DNS resolution failed for internal.invalid",
    "ValueError: raised on purpose",
    "ModuleNotFoundError: No module named 'lfx_groq'",
    "Error building Component Knowledge",
  ]) {
    assert.equal(isTransientRunFailure(reason), false, reason);
  }
});

test("an unreadable reason is NOT transient — unknown is not retryable", () => {
  // The distinction that costs the most if collapsed: a signal that had already
  // gone by the time the page text was read tells us nothing about WHY. Treating
  // that as a quota would retry three times and then report the same silence.
  for (const reason of ["", "   ", "\n\t "]) {
    assert.equal(isTransientRunFailure(reason), false, JSON.stringify(reason));
  }
});

// ---------------------------------------------------------------------------
// extractBuildFailureReason — the reason renders NEXT TO the signal
// ---------------------------------------------------------------------------

test("the reason is sliced from the signal onward, whitespace collapsed", () => {
  const pageText =
    "Starter Project   RAG Pipeline\n\n  Flow build failed\n   Error embedding " +
    "content (RESOURCE_EXHAUSTED): 429   RESOURCE_EXHAUSTED.\n Retry Dismiss";
  const reason = extractBuildFailureReason(pageText);
  assert.match(reason, /^Flow build failed Error embedding content/);
  assert.doesNotMatch(reason, /\n/);
  assert.doesNotMatch(reason, /  /);
  // Leading page chrome is not part of the reason.
  assert.doesNotMatch(reason, /Starter Project/);
});

test("an absent signal yields the empty string, never a slice of unrelated chrome", () => {
  // `indexOf` returning -1 and being passed straight to `slice` would return the
  // LAST character of the page — a reason invented out of page chrome, which
  // would then be classified and possibly retried.
  assert.equal(extractBuildFailureReason("Starter Project   Flows   MCP"), "");
  assert.equal(extractBuildFailureReason(""), "");
});

test("the slice is bounded — a page dump is not an error message", () => {
  const reason = extractBuildFailureReason(
    `Flow build failed ${"x".repeat(5000)}`,
  );
  assert.ok(
    reason.length <= 600,
    `expected a bounded slice, got ${reason.length} chars`,
  );
});

// ---------------------------------------------------------------------------
// dedupeRepeatedReason — the node status tooltip repeats its own body
// ---------------------------------------------------------------------------

test("the doubled tooltip body is collapsed to one copy", () => {
  // Verbatim from the running image (1.12.0.dev44): hovering
  // `node_status_icon_knowledge_error` yields the same sentence twice. Left
  // alone it would put a doubled message into the failure, which reads like the
  // helper malfunctioning rather than like the node's own reason.
  const raw =
    "The requested model provider is not available Duration: 3.8 seconds " +
    "The requested model provider is not available Duration: 3.8 seconds";
  assert.equal(
    dedupeRepeatedReason(raw),
    "The requested model provider is not available Duration: 3.8 seconds",
  );
});

test("a message that does not repeat is returned whole", () => {
  // The cut must be driven by an actual repeat, never by a fixed length — a
  // one-copy tooltip truncated at the probe would drop the half that names the
  // cause.
  const once = "Error embedding content (RESOURCE_EXHAUSTED): 429 quota exceeded";
  assert.equal(dedupeRepeatedReason(once), once);
});

test("a short message is not mistaken for a repeat", () => {
  assert.equal(dedupeRepeatedReason("  Timed out \n "), "Timed out");
  assert.equal(dedupeRepeatedReason(""), "");
});

test("the deduped reason is still classified — the two compose", () => {
  // The tooltip path is the one that feeds a `node status=error` run into the
  // classifier; if dedupe mangled the text, a real quota would stop being
  // recognised as transient.
  const raw = `${QUOTA_REASON} ${QUOTA_REASON}`;
  assert.equal(isTransientRunFailure(dedupeRepeatedReason(raw)), true);
});

// ---------------------------------------------------------------------------
// decideNodeRunOutcome — the whole decision, in one pure place
// ---------------------------------------------------------------------------

test("a visible badge is done, whatever else is on screen", () => {
  // Success outranks a stale banner: the failure signal from attempt 1 animates
  // out, so it is routinely still painted on the tick where attempt 2's badge
  // first renders. Reporting that as a failure would red a run that recovered.
  const outcome = decideNodeRunOutcome({
    badgeVisible: true,
    reason: QUOTA_REASON,
    attempt: 2,
    maxAttempts: NODE_RUN_MAX_ATTEMPTS,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "done");
});

test("a transient reason with attempts left retries", () => {
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: QUOTA_REASON,
    attempt: 1,
    maxAttempts: 3,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "retry");
});

test("a transient reason on the LAST attempt fails — the budget is bounded", () => {
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: QUOTA_REASON,
    attempt: 3,
    maxAttempts: 3,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "fail");
  assert.match(outcome.message, /3 attempt/);
  // A sustained provider outage is still a red, and it says which provider
  // condition it was: never a silent skip, never a pass.
  assert.match(outcome.message, /RESOURCE_EXHAUSTED/);
});

test("a non-transient reason fails on the FIRST attempt", () => {
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: "Column 'text' not found in DataFrame",
    attempt: 1,
    maxAttempts: 3,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "fail");
  assert.match(outcome.message, /Column 'text' not found/);
});

test("the failure message names the node and quotes the on-screen reason", () => {
  // The entire product of this change is attribution. A message that says the
  // run failed but drops the reason rebuilds #1667 with extra steps.
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: QUOTA_REASON,
    attempt: 1,
    maxAttempts: 1,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "fail");
  assert.match(outcome.message, /Knowledge-ingest/);
  assert.match(outcome.message, /gemini-embedding/);
});

test("an unreadable reason fails immediately and SAYS it could not be read", () => {
  // Not retried (unknown is not transient), and the message must not pretend to
  // a cause it never observed — it points at the trace instead.
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: "",
    attempt: 1,
    maxAttempts: 3,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "fail");
  assert.match(outcome.message, /could not be read|see the trace/i);
});

test("no failure signal and no badge is a TIMEOUT verdict, distinct from a build failure", () => {
  // The pre-#1667 world: nothing on the node, nothing on the page. It is still a
  // failure, but it must not claim a build error it never saw — that would be
  // the same invented attribution the old message had, only more confident.
  const outcome = decideNodeRunOutcome({
    badgeVisible: false,
    reason: null,
    attempt: 1,
    maxAttempts: 3,
    nodeId: "Knowledge-ingest",
  });
  assert.equal(outcome.action, "fail");
  assert.match(outcome.message, /neither .* nor/i);
  assert.match(outcome.message, new RegExp(String(NODE_RUN_TIMEOUT_MS / 1000)));
});

// ---------------------------------------------------------------------------
// The budget arithmetic, pinned against the 5-minute per-test timeout
// ---------------------------------------------------------------------------

test("the worst-case retry cost fits two node runs inside the test timeout", () => {
  // `playwright.config.ts` allows 5 minutes per test. `vector-store-index-query`
  // runs TWO nodes in one test, so the budget has to survive being paid twice.
  // Pinned as arithmetic rather than as prose: raising either constant without
  // re-doing this sum is how a fix for a timeout becomes a timeout.
  const worstCasePerRun =
    NODE_RUN_TIMEOUT_MS * NODE_RUN_MAX_ATTEMPTS +
    NODE_RUN_RETRY_DELAY_MS * (NODE_RUN_MAX_ATTEMPTS - 1);
  // Two runs must still leave room for setup and assertions. The realistic cost
  // is far lower — a failure is signalled in ~1 s, not at the 45 s ceiling — but
  // the ceiling is what a pathological hang would actually spend.
  assert.ok(
    worstCasePerRun <= 195_000,
    `worst case per node run is ${worstCasePerRun} ms`,
  );
});

test("the timeout is calibrated against the measured ingest, not inherited", () => {
  // Measured on 1.12.0.dev44: the ingest badge appears in 2-4 s across 26 clean
  // runs. 45 s is >10x that, with headroom for a slower CI runner; the prior
  // 90 s was ~30x and, more to the point, was what DETECTED the failure. The
  // signal detects it now, so the ceiling only bounds a pathological hang.
  assert.equal(NODE_RUN_TIMEOUT_MS, 45_000);
  assert.ok(NODE_RUN_TIMEOUT_MS >= 10 * 4_000);
});
