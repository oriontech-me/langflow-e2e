// The suite summary an on-demand run sends the platform (phase 7): counts, the
// failures grouped by spec, and every test with its outcome.
//
// The shape is the platform's SuiteSummary (oriontech-me/quality-platform,
// apps/api/src/functions/on-demand/contract.ts, NORMATIVE). What this file
// repeats from it -- the limits and the byte budget -- it repeats because the
// worker must fit the summary BEFORE sending: the platform drops a summary that
// does not fit, and a dropped summary is a summary lost.
//
// THE SAME READING AS THE DAILY'S PAYLOAD. A test is counted, normalised and
// identified exactly as build-run-payload.mjs does it for e2e_automation_runs:
// Playwright's expected/unexpected become passed/failed, a test.fail() whose body
// passed is a failure under UNEXPECTED_PASS_SIGNATURE, and a test is its spec file,
// line and title. That is what lets the platform compare an on-demand run with the
// daily test by test (phase 8). on-demand-summary.test.mjs runs both readers over
// one report and fails on any difference, so the two cannot drift apart unseen.
//
// It only counts. A verdict on what the counts mean stays the executor's, in
// results/<id>.env, and the interpretation stays outside the VM.
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { UNEXPECTED_PASS_SIGNATURE, isUnexpectedPass } from "./unexpected-pass.mjs";

export const SUMMARY_MAX_BYTES = 256 * 1024;
export const MAX_SUITE_TESTS = 5000;
const LIMITS = { specs: 500, failuresPerSpec: 200, spec: 300, title: 500, line: 500 };

const stripAnsi = (s) => (s || "").replace(/\u001b\[[0-9;]*m/g, "");
/**
 * At most `max` UTF-16 units, never half a character. A cut through an emoji
 * leaves a lone surrogate, which JSON writes as \ud83d and Postgres refuses in a
 * jsonb: the platform's whole terminal update would fail, and the result with it.
 * The trailing half goes; a lone surrogate already in the text becomes U+FFFD.
 */
export const cut = (s, max) => s.slice(0, max).replace(/[\ud800-\udbff]$/, "").toWellFormed();
/** One line the contract accepts: no control characters but tabs. */
const oneLine = (s, max) => cut(s.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, " "), max);
/** The daily's firstErr: the first line of the error, ANSI stripped, 240 units
 *  (cut whole, where the daily's slice can split a character). */
const firstErr = (r) => {
  const e = r?.error || r?.errors?.[0];
  return e ? cut(stripAnsi(e.message || e.value || "").split("\n")[0], 240) : null;
};
const OUTCOMES = new Set(["passed", "failed", "flaky", "skipped"]);
/** Playwright's per-test outcome, normalised as the daily does. Anything else, which
 *  only a damaged report holds, is a failure: one status outside the contract's four
 *  would cost the whole summary. */
const normStatus = (s) => {
  const n = s === "expected" ? "passed" : s === "unexpected" ? "failed" : s;
  return OUTCOMES.has(n) ? n : "failed";
};

/**
 * An HTTP status the error line names. null when it names none: a guess here would
 * put a 404 on a failure that never saw one, and a family of 404s is what phase 8
 * reads as a feature the branch does not have. The forms are the suite's own:
 *   "HTTP 404", "status 405", "status code: 500";
 *   "POST /api/v1/knowledge_bases failed: 422 — {...}", the API helpers' wording;
 *   "Backend Error: 404 Not Found - http://...", a code with its reason phrase.
 */
const STATUS_FORMS = [
  /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*([1-5]\d\d)\b/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+(?:failed|returned|answered)\s*:?\s*([1-5]\d\d)\b/,
  /\b([1-5]\d\d)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Unprocessable (?:Entity|Content)|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];
export function httpStatusOf(line) {
  for (const re of STATUS_FORMS) {
    const m = re.exec(line || "");
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * The summary of a merged Playwright JSON report.
 * @param report  the parsed results.json
 * @param root    where the suite ran, for a spec path the report wrote absolute
 *                (build-run-payload.mjs makes it relative to its cwd, which is
 *                there); a relative path, which is what Playwright writes, is
 *                kept as written.
 */
export function buildSummary(report, { root = process.cwd() } = {}) {
  const totals = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const failures = new Map();
  const tests = new Map();
  const relFile = (s) => {
    const f = s?.file || s?.location?.file || "";
    return isAbsolute(f) ? relative(root, f) : f;
  };

  function visit(node) {
    for (const spec of node.specs || []) {
      const file = relFile(spec);
      const line = spec?.line || spec?.location?.line || 0;
      for (const t of spec.tests || []) {
        const status = normStatus(t.status);
        if (!tests.has(file)) tests.set(file, []);
        tests.get(file).push({ line, title: spec.title, status });

        if (t.status === "skipped") { totals.skipped++; continue; }
        if (t.status === "expected") { totals.passed++; continue; }
        if (t.status === "flaky") { totals.flaky++; continue; }
        totals.failed++;
        const results = t.results || [];
        const lastFailed = [...results].reverse().find((r) => r.status !== "passed" && r.status !== "skipped");
        const errLine = isUnexpectedPass(t) ? UNEXPECTED_PASS_SIGNATURE : firstErr(lastFailed) || "unknown";
        if (!failures.has(file)) failures.set(file, []);
        failures.get(file).push({ title: spec.title, http_status: httpStatusOf(errLine), first_error_line: errLine });
      }
    }
    for (const c of node.suites || []) visit(c);
  }
  for (const s of report?.suites || []) visit(s);

  const specName = (f) => cut(f || "(no file)", LIMITS.spec) || "(no file)";
  const title = (t) => oneLine(t || "(untitled)", LIMITS.title) || "(untitled)";
  const summary = {
    totals,
    duration_ms: Number.isFinite(report?.stats?.duration) ? Math.max(0, Math.round(report.stats.duration)) : 0,
    failures_by_spec: [...failures].slice(0, LIMITS.specs).map(([spec, fs]) => ({
      spec: specName(spec),
      failures: fs.slice(0, LIMITS.failuresPerSpec).map((f) => ({
        title: title(f.title), http_status: f.http_status, first_error_line: oneLine(f.first_error_line, LIMITS.line),
      })),
    })),
    tests_by_spec: [...tests].slice(0, MAX_SUITE_TESTS).map(([spec, ts]) => ({
      spec: specName(spec),
      tests: ts.slice(0, MAX_SUITE_TESTS).map((t) => ({ line: Math.max(0, t.line | 0), title: title(t.title), status: t.status })),
    })),
  };
  return fit(summary);
}

/** Under SUMMARY_MAX_BYTES: tests_by_spec goes first, then failures from the end. */
export function fit(summary) {
  const size = (s) => Buffer.byteLength(JSON.stringify(s));
  if (size(summary) <= SUMMARY_MAX_BYTES) return summary;
  const { tests_by_spec, ...rest } = summary;
  const out = { ...rest, failures_by_spec: rest.failures_by_spec.map((f) => ({ ...f, failures: [...f.failures] })) };
  while (size(out) > SUMMARY_MAX_BYTES && out.failures_by_spec.length > 0) {
    const last = out.failures_by_spec[out.failures_by_spec.length - 1];
    last.failures.pop();
    if (last.failures.length === 0) out.failures_by_spec.pop();
  }
  return out;
}

/**
 * The summary of a run, or null: no results.json (the run was killed, refused,
 * or never reached the suite), or one that does not parse. Never throws, because
 * a summary that cannot be built must not cost the result it travels with.
 */
export function summaryFromFile(path, opts) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  try {
    return buildSummary(report, opts);
  } catch {
    return null;
  }
}
