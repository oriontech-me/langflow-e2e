// Which tests a run skipped, and why (#2125).
//
// `reports/daily-history.jsonl` recorded skips only as `totals.skipped`, so a test
// could sit out the daily for weeks, counted and unnamed. #1480 could not establish
// its own recurrence for exactly that reason: its two Azure tests skipped on every
// daily from 2026-08-04 and the only per-skip record, `results.json`, expires.
//
// ## Why the annotation alone is not the reason
//
// The obvious source is the `skip` annotation Playwright records for
// `test.skip(condition, reason)` — the substrate #1456 already reads for provider-
// health skips. Measured on the two dailies before this shipped (runs 36730351768
// and 36583902805), it covers a MINORITY: of 4 and 3 skips, 1 each carried an
// annotation. The rest were serial-mode cascades — a sibling earlier in a
// `mode: "serial"` group failed, so Playwright skipped the remainder on every
// attempt, with no annotation and a 0 ms duration. Recording only the annotation
// would have written "no reason" on the most informative rows: one of them
// (`anthropic-provider.spec.ts:301`) skipped on Actions because `:267` failed,
// and the VM lane removed its `@stable` the next morning for a hard failure.
// So a cascade is attributed to the failure that caused it.
//
// ## Kinds
//
//   provider-health  the skip reason is a provider-health record (`inactive`, or
//                    `active` but stale, #1904), read through the one shared parser
//   annotated        `test.skip(cond, "<reason>")` with any other reason
//   fixme            `test.fixme(...)`
//   serial-cascade   no annotation, and an earlier test of the same serial group
//                    (same file, same describe chain) failed; `caused_by` names it
//   unannotated      none of the above — a bare `test.skip()`, or a skip whose cause
//                    the report does not carry. Kept distinct from an empty reason.

import { parseProviderInactiveReason } from "./provider-health-reason.mjs";
import { paramFromSuitePath } from "./spec-param.mjs";

/** Reasons are recorded verbatim up to this many characters. */
export const SKIP_REASON_MAX = 300;

function capReason(text) {
  const s = String(text).trim();
  return s.length > SKIP_REASON_MAX ? `${s.slice(0, SKIP_REASON_MAX - 1)}…` : s;
}

/**
 * The kind and reason a skipped test's own annotations give, or `null` when it
 * carries none (the cascade candidate).
 *
 * A provider-health reason wins over any other annotation, as in
 * `lane-coverage-verdict.mjs`: a test can gate on provider health AND on a model
 * being resolvable, and the health record is the fact a reader triages from.
 *
 * @param {any} test one entry of `spec.tests`
 */
export function classifySkipAnnotations(test) {
  const annotations = (Array.isArray(test?.annotations) ? test.annotations : [])
    .filter((a) => a?.type === "skip" || a?.type === "fixme");
  if (annotations.length === 0) return null;
  for (const a of annotations) {
    if (a.type !== "skip") continue;
    const health = parseProviderInactiveReason(a.description);
    if (health) {
      return {
        kind: "provider-health",
        reason: capReason(a.description),
        provider: health.provider,
        stale: health.stale === true,
      };
    }
  }
  const first = annotations[0];
  const described = typeof first.description === "string" && first.description.trim() !== "";
  if (first.type === "fixme") {
    return { kind: "fixme", reason: described ? capReason(first.description) : null };
  }
  return described
    ? { kind: "annotated", reason: capReason(first.description) }
    : { kind: "unannotated", reason: null };
}

/**
 * Every skipped test in a Playwright JSON report, classified.
 *
 * @param {unknown} report parsed Playwright JSON report
 * @param {{ relFile?: (spec: any) => string }} [opts] how to spell a spec's path;
 *   the appender passes the same `specRelFile` it uses for `failures[]`, so the two
 *   lists name a file identically
 * @returns {Array<object>}
 */
export function collectSkips(report, opts = {}) {
  const relFile = opts.relFile ?? ((spec) => spec?.file ?? "");
  const rows = [];
  const walk = (node, suitePath) => {
    if (!node || typeof node !== "object") return;
    const path = node.title ? [...suitePath, node.title] : suitePath;
    for (const spec of Array.isArray(node.specs) ? node.specs : []) {
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        rows.push({
          file: relFile(spec),
          line: spec?.line || spec?.location?.line || 0,
          test: spec.title,
          group: path.join("\u0000"),
          param: paramFromSuitePath(path),
          status: test?.status,
          annotated: test?.status === "skipped" ? classifySkipAnnotations(test) : null,
        });
      }
    }
    for (const child of Array.isArray(node.suites) ? node.suites : []) walk(child, path);
  };
  for (const suite of Array.isArray(report?.suites) ? report.suites : []) walk(suite, []);

  const skips = [];
  for (const row of rows) {
    if (row.status !== "skipped") continue;
    const base = {
      file: row.file,
      line: row.line,
      test: row.test,
      ...(row.param ? { param: row.param } : {}),
    };
    if (row.annotated) {
      skips.push({ ...base, ...row.annotated });
      continue;
    }
    // The NEAREST earlier failure of the same group: in serial mode the first
    // failure skips everything after it, so a later failure cannot be the cause.
    const cause = rows
      .filter((r) => r.status === "unexpected" && r.file === row.file && r.group === row.group && r.line < row.line)
      .sort((a, b) => b.line - a.line)[0];
    skips.push(cause
      ? { ...base, kind: "serial-cascade", caused_by: { line: cause.line, test: cause.test } }
      : { ...base, kind: "unannotated", reason: null });
  }
  return skips;
}
