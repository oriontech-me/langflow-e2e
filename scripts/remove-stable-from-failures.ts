/**
 * Auto-remove the `@stable` tag from tests that hard-failed in a stable run.
 *
 * Leadership decision: on a hard failure (a test that failed ALL retries in a
 * scheduled daily/weekly run), the `@stable` tag is removed automatically, with
 * NO human review. Restoring the tag is the human-gated step (a later PR once
 * the test or Langflow is fixed). This script performs the removal.
 *
 * Run: `PLAYWRIGHT_JSON=results.json npx ts-node scripts/remove-stable-from-failures.ts`
 *
 * Safety:
 *  - Only `failures[]` (status "unexpected" = failed every retry) are targeted;
 *    flaky tests (passed on a retry) keep `@stable`, per the triage policy.
 *  - Mass-failure guard: if the number of hard failures exceeds MAX_AUTO_REMOVE
 *    (or the report is missing/empty — the suite never really ran), NOTHING is
 *    removed. A red day where everything fails is almost always infra (Langflow
 *    container didn't boot, network/model outage), not per-test rot, and must
 *    not quarantine the whole stable suite.
 *  - Infra-signature exemption (#1031): a hard failure whose last error is a
 *    transport-level error (see `scripts/lib/infra-signatures.ts`) is NOT
 *    attributable to the spec that reported it — it is collateral of a wedged
 *    backend (#1030/#1048). It is excluded from removal INDEPENDENTLY of the
 *    mass-failure guard, which only covers the wide wedge; the narrow one (a
 *    wedge costing ≤ MAX_AUTO_REMOVE tests) used to strip innocent tags.
 *  - Corroborated earlier-attempt exemption (#1589): the last-attempt rule was
 *    chosen against a SUSTAINED wedge, which burns the retries. An INTERMITTENT
 *    one cycles through them — run 32827671203 measured 156 of 894 probes down
 *    on shard 3 across windows as short as 6-8 s, and 4 of its 7 hard failures
 *    carried a transport-level signature on an earlier attempt and lost it on
 *    the last. An earlier attempt now exempts too, but only when the in-run
 *    liveness recorder measured an outage overlapping THAT attempt on ITS shard.
 *
 * ─── #1589's four branches, and why this one ─────────────────────────────────
 *
 *  1. Corroborate against the recorder rather than re-picking an attempt.
 *     TAKEN. It does not change which signatures qualify, only which attempt
 *     may be read, and the per-shard per-attempt overlap already existed in
 *     `report-backend-outages.mjs` for its `collateral_attempts` count — so the
 *     evidence is measured, not inferred.
 *  2. Read every attempt with a qualifier. NOT TAKEN as stated. Unqualified, it
 *     would exempt a real regression that hit one transient blip on a retry —
 *     the exemption would start protecting product breakage, which is worse
 *     than the failure it fixes. The issue's own qualifier ("≥ 2 attempts
 *     classifying") does not solve the motivating run either: all four of its
 *     cases had exactly one classifying attempt.
 *  3. Report the disagreement instead of resolving it. TAKEN, but as the
 *     FALLBACK rather than the answer: it is what an unmeasured run gets, and
 *     it is why a declined earlier-attempt signature is never silent again.
 *  4. Do nothing. NOT TAKEN. The mass-failure guard does not cover the
 *     sub-threshold day (≤ 5 hard failures: 2026-08-04, 08-13, 08-17, 08-24),
 *     where the exemption is the only thing between an intermittently wedged
 *     shard and an unreviewed tag removal.
 *
 * The invariant #1031 pins is unchanged in every branch: nothing here can add a
 * test to the removal set, only take one out, so the set stays a subset of what
 * the pre-#1031 script would have produced. Every corroboration failure mode —
 * absent file, unreadable file, malformed payload, unmeasured run — degrades to
 * exactly the last-attempt rule.
 *
 * Editing is AST-located + text-spliced: the TypeScript compiler API finds the
 * exact `"@stable"` element inside the `test(...)` `{ tag: [...] }` array, and
 * only that element (plus one adjacent comma) is removed from the raw source,
 * so all other formatting/comments are preserved.
 *
 * Output: a single JSON object on stdout describing what happened, for the
 * caller (workflow / composite action) to build the commit message + issue body.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { classifyInfraError, stripAnsi } from "./lib/infra-signatures";
// The join key against the corroboration file is a string compare across this
// script and `report-backend-outages.mjs`; both read the ONE normaliser (#1589).
import { normalizeSpecPath } from "./lib/spec-path.mjs";

const REPO_ROOT = path.resolve(__dirname, "..");
const STABLE_TAG = "@stable";

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
const MAX_AUTO_REMOVE = Number.parseInt(process.env.MAX_AUTO_REMOVE || "5", 10);
/**
 * Corroboration only, from `report-backend-outages.mjs`'s `wedged` output
 * (#1030): "true" | "false" | "" (unmeasured / step skipped). It changes the
 * WORDING of the exemption, never the decision — the exemption has to hold when
 * the liveness recorder produced nothing, which is exactly the run where the
 * backend state is least known.
 */
const BACKEND_WEDGED = process.env.BACKEND_WEDGED || "";
/**
 * Path to the collateral-attempt list `report-backend-outages.mjs` writes
 * (#1589). Optional: absent means the widened, corroborated half of the
 * exemption simply does not fire, and the rule is exactly what #1031 shipped.
 */
const OUTAGE_ATTEMPTS = process.env.OUTAGE_ATTEMPTS || "";

interface Failure {
  title: string;
  file: string; // absolute path
  /**
   * The spec path exactly as the report spelled it, normalised the way
   * `report-backend-outages.mjs` normalises it. This is the join key against
   * the corroboration file (#1589); re-deriving it from `file` would have to
   * guess which of `candidateBases()` won, and a near-miss there silently
   * corroborates nothing.
   */
  specPath: string;
  line: number; // 1-based test() line, as Playwright reports it
  /**
   * Last failed attempt's error, ANSI-stripped and UNtruncated; "" if none.
   * Full text on purpose — it is what the infra-signature classifier reads.
   */
  error: string;
  /**
   * Every failed attempt BEFORE the last one, oldest first (#1589). Empty on a
   * test that failed once.
   */
  earlierAttempts: AttemptError[];
}

/** One failed attempt of a test: which retry it was, and its full error text. */
export interface AttemptError {
  /** Playwright's `result.retry` — 0 is the first attempt. */
  retry: number;
  error: string;
}

interface Removed {
  file: string; // repo-relative
  title: string;
  line: number;
  soleTag: boolean; // true if @stable was the ONLY tag (array left empty)
}

interface Skipped {
  file: string; // repo-relative
  title: string;
  line: number;
  reason: string;
}

/** A hard failure the run cannot attribute to its spec (#1031). */
interface Exempt {
  file: string; // repo-relative
  title: string;
  line: number;
  /** `InfraSignature.id` that matched, e.g. `api-request-timeout`. */
  signature: string;
  /** Why that signature cannot be the spec's own fault. */
  why: string;
  /** The matched error text, truncated for the issue body. */
  error: string;
  /**
   * Which attempt carried the signature (#1589).
   *
   * `last-attempt` is the original #1031 rule and needs no corroboration — a
   * transport error is not a product assertion whatever else the run measured.
   * `earlier-attempt` is the widened case, and it is ONLY ever reached with
   * measured corroboration: the same attempt's span overlapped an outage window
   * the in-run recorder measured on that attempt's own shard.
   */
  via: "last-attempt" | "earlier-attempt";
  /** `result.retry` of the attempt that carried the signature. */
  attempt: number;
}

/**
 * A hard failure whose EARLIER attempt classified transport-level but which was
 * still counted as attributable, because nothing corroborated it (#1589).
 *
 * This is the branch that must never be silent. The rule is deliberately
 * narrow, so the cases it declines are exactly the ones a human should look at:
 * an intermittent wedge that cycled through the retries rather than burning
 * them leaves this shape behind, and on run 32827671203 four of seven hard
 * failures had it while the umbrella's collateral block rendered empty.
 */
interface Disagreement {
  file: string; // repo-relative
  title: string;
  line: number;
  /** `InfraSignature.id` that matched on the earlier attempt. */
  signature: string;
  why: string;
  /** `result.retry` of the attempt that carried it. */
  attempt: number;
  /** Why the exemption was NOT extended to it. */
  declined: string;
  error: string;
}

// ─── Parse hard failures out of the Playwright JSON report ───────────────────
// Mirrors scripts/build-run-payload.mjs: only status "unexpected" counts as a
// hard failure; "flaky"/"skipped"/"expected" are ignored.

/**
 * Base directories to try, in order, when resolving a non-absolute spec path
 * from the report. The Playwright JSON reporter emits `spec.file` relative to
 * the Playwright `rootDir` (`<repo>/tests`, from `testDir: "./tests"`), NOT the
 * repo root — so `REPO_ROOT` alone never matches and every failure was silently
 * skipped as "spec file not found" (issue #476). We prefer the report's own
 * `config.rootDir` (absolute, correct in the run that produced it), then the
 * conventional `<repo>/tests`, then `REPO_ROOT` as a last resort, and pick the
 * first base under which the file actually exists on disk.
 */
function candidateBases(report: any): string[] {
  const bases: string[] = [];
  const rootDir = report?.config?.rootDir;
  if (typeof rootDir === "string" && rootDir) bases.push(rootDir);
  bases.push(path.join(REPO_ROOT, "tests"));
  bases.push(REPO_ROOT);
  return bases;
}

/** Max error characters carried into the result JSON / issue body. */
const ERROR_MAX = 240;

/**
 * Shorten an error for the result JSON / issue body.
 *
 * DISPLAY ONLY. Classification always runs on the untruncated text: a wedge
 * frequently surfaces as an assertion header whose `Cause:` line — the transport
 * error — sits hundreds of characters in, under a Playwright call log. Truncating
 * before `classifyInfraError` would silently un-exempt exactly those, which is
 * the harm #1031 exists to prevent.
 */
export function truncateError(error: string): string {
  return error.length > ERROR_MAX ? `${error.slice(0, ERROR_MAX)}…` : error;
}

/** One error object flattened to text: message (or thrown value) plus its stack. */
function errorText(e: any): string {
  const message = stripAnsi(e?.message || e?.value || "");
  const stack = stripAnsi(e?.stack || "");
  if (stack && !message.includes(stack)) return message ? `${message}\n${stack}` : stack;
  return message || stack;
}

/**
 * The error of the LAST failed attempt — the same result `build-run-payload.mjs`
 * picks for `error_signature`, so the exemption and the history file talk about
 * the same attempt. Last, not first: retries are what a wedge burns, and the
 * final attempt is the one that decided the verdict.
 *
 * Unlike `firstErr` there, this keeps the whole message (plus the stack) rather
 * than its first line — a transport error is often the *cause* line under an
 * assertion header, and truncating to line one would hide it.
 *
 * It also keeps EVERY error of that attempt, not just the first. A `timedOut`
 * result carries the `Test timeout of Xms exceeded` wrapper in `error` and the
 * pending call — the transport error itself — in a later `errors[]` entry, which
 * is precisely the shape "the test timed out while an API call hung".
 */
/** Every error of ONE attempt, deduped and joined — the classifier's input. */
function attemptErrorText(result: any): string {
  if (!result) return "";
  const candidates = [
    result.error,
    ...(Array.isArray(result.errors) ? result.errors : []),
  ];
  // Playwright usually sets `error` to `errors[0]`, so dedup by text.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = errorText(candidate);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join("\n");
}

function failedResults(test: any): any[] {
  const results: any[] = Array.isArray(test?.results) ? test.results : [];
  return results.filter((r) => r?.status !== "passed" && r?.status !== "skipped");
}

export function lastFailureError(test: any): string {
  const results: any[] = Array.isArray(test?.results) ? test.results : [];
  const failed = failedResults(test);
  const lastFailed = failed[failed.length - 1] ?? results[results.length - 1];
  return attemptErrorText(lastFailed);
}

/**
 * Every failed attempt BEFORE the one `lastFailureError` reads, oldest first
 * (#1589).
 *
 * The last-attempt rule was chosen against a SUSTAINED wedge, where retries are
 * burnt and the final attempt really is the informative one. It does not hold
 * against an INTERMITTENT one: on run 32827671203 shard 3 measured 156 of 894
 * probes down across 15 windows as short as 6-8 s, and the wedge cycled through
 * the 30 s retry budget rather than consuming it — four of seven hard failures
 * carried a transport-level signature on an earlier attempt and lost it on the
 * last, one of them the barrier's own `[backend-unreachable]` marker.
 */
export function earlierFailedAttempts(test: any): AttemptError[] {
  return failedResults(test)
    .slice(0, -1)
    .map((r) => ({ retry: Number(r?.retry) || 0, error: attemptErrorText(r) }));
}

export function collectHardFailures(reportFile: string): Failure[] {
  if (!fs.existsSync(reportFile)) return [];
  let report: any;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch {
    return [];
  }
  const failures: Failure[] = [];
  const bases = candidateBases(report);
  const resolveFile = (spec: any): string => {
    const f = spec?.file || spec?.location?.file || "";
    if (!f) return "";
    if (path.isAbsolute(f)) return f;
    for (const base of bases) {
      const candidate = path.resolve(base, f);
      if (fs.existsSync(candidate)) return candidate;
    }
    // Nothing matched: return the tests/-rebased path (the correct base per
    // testDir) so the downstream "spec file not found" skip is meaningful.
    return path.resolve(path.join(REPO_ROOT, "tests"), f);
  };
  const visit = (node: any): void => {
    for (const spec of node.specs || []) {
      const file = resolveFile(spec);
      const line = spec?.line || spec?.location?.line || 0;
      for (const t of spec.tests || []) {
        if (t.status === "unexpected") {
          failures.push({
            title: spec.title,
            file,
            specPath: normalizeSpecPath(spec?.file || spec?.location?.file || ""),
            line,
            error: lastFailureError(t),
            earlierAttempts: earlierFailedAttempts(t),
          });
        }
      }
    }
    for (const child of node.suites || []) visit(child);
  };
  for (const s of report.suites || []) visit(s);
  return failures;
}

// ─── Corroboration from the in-run liveness recorder (#1589) ────────────────

export { normalizeSpecPath };

export interface Corroboration {
  /**
   * Whether any shard produced liveness probes at all. FALSE is the absence of
   * evidence, not evidence of absence, and the two must not read alike (#1012)
   * — so an unmeasured run keeps the pre-#1589 last-attempt behaviour and says
   * so, rather than declining the widened exemption as if it had checked.
   */
  measured: boolean;
  /** `${specPath}\u0000${title}\u0000${retry}` for every corroborated attempt. */
  keys: Set<string>;
  /** Set when the file could not be read at all; the reason, for the report. */
  unavailable?: string;
}

export function attemptKey(specPath: string, title: string, retry: number): string {
  return `${specPath}\u0000${title}\u0000${retry}`;
}

/**
 * Load the collateral-attempt list `report-backend-outages.mjs` writes.
 *
 * FAIL-CLOSED on every failure mode: an absent path, an unreadable file and a
 * malformed payload all yield "no corroboration", which reduces the exemption
 * to exactly the rule it had before #1589. The widened branch may only ever
 * SHRINK the removal set relative to the pre-#1031 script, so degrading it can
 * never remove a tag that today's rule would keep — the invariant #1031 pins.
 */
export function loadCorroboration(file: string | undefined): Corroboration {
  if (!file) {
    return { measured: false, keys: new Set(), unavailable: "no corroboration file was provided" };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return {
      measured: false,
      keys: new Set(),
      unavailable: `${file} could not be read (${(e as Error).message.split("\n")[0]})`,
    };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.attempts)) {
    return { measured: false, keys: new Set(), unavailable: `${file} has no \`attempts\` array` };
  }
  const keys = new Set<string>();
  for (const a of parsed.attempts) {
    if (!a || typeof a.file !== "string" || typeof a.title !== "string") continue;
    keys.add(attemptKey(normalizeSpecPath(a.file), a.title, Number(a.retry) || 0));
  }
  return { measured: parsed.measured === true, keys };
}

export interface Classification {
  exempt: Exempt[];
  attributable: Failure[];
  disagreements: Disagreement[];
}

/**
 * Decide, per hard failure, whether the run can attribute it to its spec.
 *
 * Two rules, and the second is strictly narrower than the first:
 *
 *   1. LAST attempt classifies transport-level -> exempt. #1031's rule,
 *      unchanged, and it never depends on the liveness recorder: a caller with
 *      no liveness step still gets it.
 *   2. An EARLIER attempt classifies AND the recorder measured an outage
 *      overlapping THAT attempt on ITS OWN shard -> exempt. This is #1589's
 *      widening, and the corroboration is what keeps it from laundering a real
 *      regression that hit one transient blip on a retry.
 *
 * An earlier attempt that classifies with no corroboration is NOT exempted and
 * NOT silent: it becomes a `Disagreement`, which the umbrella renders. That is
 * the cheap branch of #1589, kept as the fallback rather than as the answer,
 * because it is the only honest outcome on a run the recorder never measured.
 */
export function classifyFailures(
  allFailures: Failure[],
  corroboration: Corroboration,
): Classification {
  const out: Classification = { exempt: [], attributable: [], disagreements: [] };
  for (const f of allFailures) {
    const rel = path.relative(REPO_ROOT, f.file);
    const last = classifyInfraError(f.error);
    if (last) {
      out.exempt.push({
        file: rel,
        title: f.title,
        line: f.line,
        signature: last.id,
        why: last.why,
        error: truncateError(f.error),
        via: "last-attempt",
        attempt: f.earlierAttempts.length,
      });
      continue;
    }

    const classified = f.earlierAttempts
      .map((a) => ({ attempt: a, signature: classifyInfraError(a.error) }))
      .filter((c) => c.signature !== null) as Array<{
      attempt: AttemptError;
      signature: NonNullable<ReturnType<typeof classifyInfraError>>;
    }>;

    if (classified.length === 0) {
      out.attributable.push(f);
      continue;
    }

    const corroborated = classified.find((c) =>
      corroboration.keys.has(attemptKey(f.specPath, f.title, c.attempt.retry)),
    );
    if (corroborated) {
      out.exempt.push({
        file: rel,
        title: f.title,
        line: f.line,
        signature: corroborated.signature.id,
        why: corroborated.signature.why,
        error: truncateError(corroborated.attempt.error),
        via: "earlier-attempt",
        attempt: corroborated.attempt.retry,
      });
      continue;
    }

    // Declined, and named. The reason distinguishes "we measured and this
    // attempt did not overlap an outage" from "nothing was measured" — the
    // first is evidence against the widening, the second is its absence.
    const declined = corroboration.unavailable
      ? `no corroboration was available (${corroboration.unavailable})`
      : corroboration.measured
        ? "the in-run recorder measured this shard and this attempt did not overlap any outage window"
        : "no shard produced liveness probes, so nothing could corroborate it";
    const first = classified[0];
    out.attributable.push(f);
    out.disagreements.push({
      file: rel,
      title: f.title,
      line: f.line,
      signature: first.signature.id,
      why: first.signature.why,
      attempt: first.attempt.retry,
      declined,
      error: truncateError(first.attempt.error),
    });
  }
  return out;
}

// ─── AST: find the `"@stable"` element inside a matching test()'s tag array ──

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      s += "${" + span.expression.getText() + "}" + span.literal.text;
    }
    return s;
  }
  return null;
}

function isPlainTestCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === "test";
}

/** The `@stable` string element node within `test()`'s tag array, if present. */
function findStableElement(
  call: ts.CallExpression,
): ts.ArrayLiteralExpression["elements"][number] | null {
  if (call.arguments.length < 2) return null;
  const opts = call.arguments[1];
  if (!ts.isObjectLiteralExpression(opts)) return null;
  for (const prop of opts.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !ts.isIdentifier(prop.name) ||
      prop.name.text !== "tag"
    ) {
      continue;
    }
    if (!ts.isArrayLiteralExpression(prop.initializer)) return null;
    for (const el of prop.initializer.elements) {
      if (literalText(el) === STABLE_TAG) return el;
    }
  }
  return null;
}

interface Match {
  element: ts.ArrayLiteralExpression["elements"][number];
  array: ts.ArrayLiteralExpression;
  line: number; // 1-based line of the test() call
}

/** All test() calls in `source` that carry `@stable`, with their line + element. */
function stableTestMatches(source: ts.SourceFile): Map<string, Match[]> {
  // keyed by title so we can match a failure by title (+ line as tiebreaker)
  const byTitle = new Map<string, Match[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isPlainTestCall(node)) {
      const title = node.arguments.length >= 1 ? literalText(node.arguments[0]) : null;
      const element = findStableElement(node);
      if (title !== null && element) {
        const array = element.parent as ts.ArrayLiteralExpression;
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const list = byTitle.get(title) || [];
        list.push({ element, array, line });
        byTitle.set(title, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return byTitle;
}

/** Character range [start, end) to delete to drop one array element cleanly. */
function spliceRange(
  match: Match,
  source: ts.SourceFile,
): { start: number; end: number; soleTag: boolean } {
  const elements = match.array.elements;
  const idx = elements.indexOf(match.element);
  const el = match.element;
  if (elements.length === 1) {
    // Only tag: leave `[]`. Rare — @stable is normally paired with @release etc.
    return { start: el.getStart(source), end: el.getEnd(), soleTag: true };
  }
  if (idx < elements.length - 1) {
    // Not last: eat element + trailing comma + whitespace up to the next element.
    return {
      start: el.getStart(source),
      end: elements[idx + 1].getStart(source),
      soleTag: false,
    };
  }
  // Last element: eat leading comma + whitespace + element.
  return {
    start: elements[idx - 1].getEnd(),
    end: el.getEnd(),
    soleTag: false,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const allFailures = collectHardFailures(reportPath);

  // Partition BEFORE the guard, and report both sides in every branch (#1031).
  // Doing it after would lose the collateral labelling on precisely the run that
  // motivated this — the wide wedge, where the guard returns early.
  const corroboration = loadCorroboration(OUTAGE_ATTEMPTS || undefined);
  const { exempt, attributable: failures, disagreements } = classifyFailures(
    allFailures,
    corroboration,
  );

  const result: {
    status: "removed" | "none" | "guard_tripped";
    threshold: number;
    /** Every hard failure in the report, exempt ones included. */
    hardFailures: number;
    /** Hard failures the run CAN attribute to their spec — the removal candidates. */
    attributableFailures: number;
    removed: Removed[];
    skipped: Skipped[];
    exempt: Exempt[];
    /**
     * Hard failures counted as attributable although an EARLIER attempt
     * classified transport-level (#1589). Not a removal decision — a pointer
     * for the analyst, so the case the widened rule declines is never silent.
     */
    disagreements: Disagreement[];
    /**
     * Whether the in-run liveness recorder produced probes this run (#1589).
     * `false` means the widened exemption could not be evaluated at all, which
     * is not the same as evaluating it and declining.
     */
    corroborationMeasured: boolean;
    /** Present when the corroboration file was absent or unreadable. */
    corroborationUnavailable?: string;
    /** "true" | "false" | "" — the #1030 liveness verdict, for wording only. */
    backendWedged: string;
  } = {
    status: "none",
    threshold: MAX_AUTO_REMOVE,
    hardFailures: allFailures.length,
    attributableFailures: failures.length,
    removed: [],
    skipped: [],
    exempt,
    disagreements,
    corroborationMeasured: corroboration.measured,
    ...(corroboration.unavailable
      ? { corroborationUnavailable: corroboration.unavailable }
      : {}),
    backendWedged: BACKEND_WEDGED,
  };

  // Mass-failure guard: too many hard failures => treat as infra, remove nothing.
  //
  // Counts EVERY hard failure, not just the attributable ones. Netting the
  // exempt ones out would make the mechanism strictly more aggressive than it
  // is today: on run 30374528125 (19 failures, 14 with an infra signature) the
  // guard trips and removes nothing, while an attributable-only count would
  // remove 5 tags with no review. #1031 asks to protect innocent specs, not to
  // widen auto-removal's reach — so the removal set here is always a subset of
  // what the pre-#1031 script would have produced.
  //
  // Evaluated BEFORE the "nothing attributable" exit so `status` keeps meaning
  // "would the guard have tripped": a wide wedge whose every failure is
  // collateral is still a mass-failure day, and the triage skill's own
  // `detectGuard` (which recomputes from `totals.failed`) would otherwise
  // disagree with this field.
  if (allFailures.length > MAX_AUTO_REMOVE) {
    result.status = "guard_tripped";
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (failures.length === 0) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Group failures by file so each file is parsed + written once.
  const byFile = new Map<string, Failure[]>();
  for (const f of failures) {
    const list = byFile.get(f.file) || [];
    list.push(f);
    byFile.set(f.file, list);
  }

  for (const [file, fileFailures] of byFile) {
    const rel = path.relative(REPO_ROOT, file);
    if (!fs.existsSync(file)) {
      for (const f of fileFailures)
        result.skipped.push({ file: rel, title: f.title, line: f.line, reason: "spec file not found" });
      continue;
    }
    let text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const matches = stableTestMatches(source);

    // Resolve each failure to a single @stable test() element, then splice from
    // the END of the file backwards so earlier offsets stay valid.
    const ranges: Array<{ start: number; end: number; removed: Removed }> = [];
    for (const f of fileFailures) {
      const candidates = matches.get(f.title) || [];
      let match: Match | undefined;
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        // Duplicate titles in one file: disambiguate by the reported line.
        match = candidates.find((c) => c.line === f.line);
      }
      if (!match) {
        // No @stable in the test()'s own tag array. Either it's inherited from a
        // describe block (not per-test removable) or the title didn't resolve.
        result.skipped.push({
          file: rel,
          title: f.title,
          line: f.line,
          reason: candidates.length
            ? "ambiguous title, no line match"
            : "no per-test @stable (describe-level tag or title mismatch)",
        });
        continue;
      }
      const { start, end, soleTag } = spliceRange(match, source);
      ranges.push({
        start,
        end,
        removed: { file: rel, title: f.title, line: match.line, soleTag },
      });
    }

    if (ranges.length === 0) continue;
    ranges.sort((a, b) => b.start - a.start); // splice back-to-front
    for (const r of ranges) {
      text = text.slice(0, r.start) + text.slice(r.end);
      result.removed.push(r.removed);
    }
    fs.writeFileSync(file, text);
  }

  result.status = result.removed.length > 0 ? "removed" : "none";

  // Fail louder: a "spec file not found" skip means path resolution is broken
  // (the exact failure mode of #476) — the report has real hard failures we
  // couldn't act on. Surface a GitHub Actions warning annotation on stderr so
  // it's visible in the log instead of exiting quietly as `none`.
  const notFound = result.skipped.filter((s) => s.reason === "spec file not found");
  if (notFound.length > 0) {
    process.stderr.write(
      `::warning title=Auto-remove @stable::${notFound.length} hard failure(s) skipped because their spec file could not be resolved on disk — path resolution may be broken (see #476). Files: ${notFound
        .map((s) => s.file)
        .join(", ")}\n`,
    );
  }

  process.stdout.write(JSON.stringify(result));
}

// Only run when invoked as a script — keeps the module importable from tests.
if (require.main === module) {
  main();
}
