// An UNEXPECTED PASS: a test declared failing with `test.fail()` whose body passed
// (#2009). Playwright reports it as `status: "unexpected"` — the same status as a hard
// failure — so every consumer that split the report on status alone recorded it as
// one, and with `error_signature: "unknown"`, because a passing attempt carries no
// error to take a signature from. Measured on 1.58.2: a `test.fail()` whose body
// passes yields `status: "unexpected"`, `expectedStatus: "failed"` and three attempts
// of `status: "passed"` with no `error` and an empty `errors[]`.
//
// It is the opposite reading of a hard failure: the fix-day signal for the declared
// upstream bug. `unknown` made it indistinguishable from a failure whose error was
// lost, and pooled it with every such failure under one recurrence key.
//
// ONE copy of the predicate and of the signature, shared by the payload builder, the
// history appender and the umbrella: a consumer carrying its own spelling of the
// string is a consumer that stops matching the day the other one is reworded.

/** The `error_signature` recorded for an unexpected pass. Stable on purpose — it is a
 *  recurrence key, so it must not carry anything that varies between runs. */
export const UNEXPECTED_PASS_SIGNATURE = "expected to fail but passed";

// A PARTIAL unexpected pass (#2217): the same declaration, whose body passed on SOME
// attempts and failed as declared on a later one. A passing attempt is the one that
// is not ok under `test.fail()`, and the last attempt decides, so Playwright reports
// `status: "flaky"` — measured on the VM dailies of 2026-09-18 and 2026-10-07,
// `workflows-v2-job-lifecycle.spec.ts:304`: `expectedStatus: "failed"`, attempts
// `[passed, failed]`. Every flake consumer took its signature from the first attempt
// carrying a message, which here is the EXPECTED failure: the row read "this assertion
// fails intermittently" when the declared bug had in fact not reproduced once, and the
// triage filed it as a recurrent flake for quarantine.
//
// It is neither a fix day (the retry reproduced the bug) nor a flake of the
// assertion: the declared bug reproduces intermittently, or is starting to go away.
// A sibling of the full signature rather than the same string, because the two lead
// to different actions and the triage must not count one as the other.

/** The `error_signature` recorded for a partial unexpected pass. Fixed for the same
 *  reason as UNEXPECTED_PASS_SIGNATURE. */
export const PARTIAL_UNEXPECTED_PASS_SIGNATURE = "expected to fail but passed on some attempts";

/**
 * Whether a Playwright JSON `test` entry is an unexpected pass: its status is
 * `unexpected` and its LAST attempt passed. The last attempt, as the issue frames it,
 * because it is the attempt that decided the verdict; an earlier attempt that timed
 * out (a `timedOut` is not the `failed` a `test.fail()` expects) does not make a
 * passing final attempt any less of a pass.
 */
export function isUnexpectedPass(test) {
  if (test?.status !== "unexpected") return false;
  const results = Array.isArray(test.results) ? test.results : [];
  return results.length > 0 && results[results.length - 1]?.status === "passed";
}

/**
 * Whether a Playwright JSON `test` entry is a partial unexpected pass: declared
 * failing (`expectedStatus: "failed"`), reported `flaky`, and at least one attempt
 * `passed`. The passed attempt is what separates it from a genuine flake of a
 * declared test — `[timedOut, failed]` is also `flaky` under `test.fail()` (a
 * `timedOut` is not the `failed` it expects), and that one stays an ordinary flake
 * with the timeout as its signature.
 */
export function isPartialUnexpectedPass(test) {
  if (test?.status !== "flaky" || test?.expectedStatus !== "failed") return false;
  const results = Array.isArray(test.results) ? test.results : [];
  return results.some((r) => r?.status === "passed");
}

/** Every test of a report that `predicate` accepts, as the collectors below return them. */
function collect(report, predicate) {
  const out = [];
  const visit = (node, inheritedFile) => {
    if (!node || typeof node !== "object") return;
    const nodeFile = node.file || inheritedFile || "";
    for (const spec of Array.isArray(node.specs) ? node.specs : []) {
      for (const t of Array.isArray(spec?.tests) ? spec.tests : []) {
        if (!predicate(t)) continue;
        const results = t.results;
        out.push({
          file: spec.file || spec.location?.file || nodeFile,
          line: spec.line || spec.location?.line || 0,
          title: String(spec.title ?? ""),
          attempts: results.length,
          passedAttempts: results.filter((r) => r?.status === "passed").length,
        });
      }
    }
    for (const child of Array.isArray(node.suites) ? node.suites : []) visit(child, nodeFile);
  };
  for (const s of Array.isArray(report?.suites) ? report.suites : []) visit(s, s?.file || "");
  return out;
}

/**
 * Every unexpected pass in a merged Playwright JSON report, in report order, as
 * `{ file, line, title, attempts, passedAttempts }`. `file` is the report's own
 * spelling (relative to the config's rootDir). Tolerant of a partial or malformed
 * report: a node it cannot read contributes nothing rather than throwing, because the
 * umbrella that calls this must still open on a day the report is damaged.
 */
export function collectUnexpectedPasses(report) {
  return collect(report, isUnexpectedPass);
}

/** Every partial unexpected pass (#2217), in the same shape and with the same tolerance. */
export function collectPartialUnexpectedPasses(report) {
  return collect(report, isPartialUnexpectedPass);
}

/**
 * Whether a HISTORY ROW entry (`reports/daily-history.jsonl`, `failures[]`) records an
 * unexpected pass. The row keeps no attempts, so the signature the appender wrote is
 * the only evidence — read here, beside the constant, so the triage never carries its
 * own spelling of the string (#2027). Rows written before #2009 said `"unknown"` for
 * the same case and are indistinguishable from a lost error; they answer false.
 */
export function isUnexpectedPassEntry(entry) {
  return String(entry?.error_signature ?? "").trim() === UNEXPECTED_PASS_SIGNATURE;
}

/**
 * Whether a HISTORY ROW entry (`flaky[]`) records a partial unexpected pass (#2217).
 * Rows written before #2217 carry the expected failure's message for the same case
 * and answer false: the row kept no attempts, so nothing can tell them apart.
 */
export function isPartialUnexpectedPassEntry(entry) {
  return String(entry?.error_signature ?? "").trim() === PARTIAL_UNEXPECTED_PASS_SIGNATURE;
}
