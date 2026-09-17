// The structural guard three helpers use to prove their `waitForFlowSaveSettled`
// drains pass a DERIVED quiet window instead of the helper's 700 ms default.
//
// WHY A GUARD AT ALL, AND WHAT IT IS WORTH
//
// `pendingSaveQuietMs()` is only worth deriving if the call site actually passes
// it, and a unit test of the accessor never observes the call site: measured on
// #1901, reverting `leaveFlowEditor`'s drain to the bare
// `waitForFlowSaveSettled(page)` — the exact regression #1743 is about — left
// all three of its window assertions green, with `editorExitDrainQuietMs`
// exported, typechecked and unit-tested while nothing used it.
//
// Being plain about what that buys: it pins a SPELLING, not a behaviour (#1226).
// That is adequate here and nowhere near generally — the mutation it has to
// catch IS the spelling, one argument present or absent at a call site, so there
// is no gap between "the source says it" and "the helper does it". A behavioural
// version would need a fake `Page` covering the request/response events and the
// timers, to assert one argument.
//
// ONE COPY, FOR THE REASON `strip-comments.ts` RECORDS
//
// This was one copy in `leave-flow-editor.test.ts` (#1743) and #1902 needed the
// same guard in two more helpers. `strip-comments.ts` exists because the same
// scanner was cloned once and the clone inherited the original's defect; a
// pattern with three call sites is where that happens again. The accessor name
// is a parameter precisely so the copies cannot drift on the interesting part.
//
// Comments are blanked first (`stripComments`): every one of these modules has
// JSDoc naming the 700 ms default it replaced, and matching prose would report
// the explanation as the offender.
import { describeAutosaveInterval } from "./autosave-interval";
import { stripComments } from "./strip-comments";

const CALLEE = "waitForFlowSaveSettled";

/**
 * Every `waitForFlowSaveSettled(...)` call in a source, as its argument text.
 *
 * Balanced-paren scanning rather than a regex, and the regex it replaces is why
 * (found in review of this module's first version). That one was
 * `/waitForFlowSaveSettled\(([\s\S]*?)\)\s*;/g` — it required a terminating
 * SEMICOLON, which an `await`ed statement happens to have and an expression does
 * not. A call in argument position (`Promise.all([waitForFlowSaveSettled(page)])`,
 * a `.then` chain) therefore did not match on its own: the non-greedy body ran on
 * to the NEXT call's `);` and merged the two into one match whose text contains
 * the derived accessor. Measured on the real file, adding such a call gave
 * `count = 4` (unchanged) and `offenders = []` — the merge subtracts one match
 * and adds one, so the count floor could not see it either, and a fifth drain on
 * the 700 ms default was invisible to BOTH halves of the guard. A guard that goes
 * quiet is worse than no guard, because it reports the regression it exists to
 * catch as clean (#1012).
 *
 * Quoted spans are skipped while walking, so a parenthesis inside a string
 * argument cannot unbalance the scan. Comments are blanked by the caller before
 * this ever runs.
 */
function scanDrainCalls(source: string): string[] {
  const calls: string[] = [];
  let i = 0;
  while (true) {
    const at = source.indexOf(CALLEE, i);
    if (at === -1) return calls;
    i = at + CALLEE.length;
    // An identifier boundary on the left, so `myWaitForFlowSaveSettled` is not
    // this function — and on the right only whitespace before the `(`.
    const before = at === 0 ? "" : source[at - 1];
    if (/[\w$]/.test(before)) continue;
    let j = i;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== "(") continue;

    const start = j + 1;
    let depth = 1;
    let k = start;
    let quote = "";
    while (k < source.length && depth > 0) {
      const c = source[k];
      if (quote) {
        if (c === "\\") k++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      k++;
    }
    // An unbalanced tail is a call this scanner could not read. Reported as an
    // offender with what it did see, never dropped: silence is the one outcome
    // this module exists to rule out.
    calls.push(source.slice(start, Math.min(k, source.length)));
    i = k + 1;
  }
}

/** Identifiers only — a regex-special character here would match by accident. */
const ACCESSOR = /^[A-Za-z_$][\w$]*$/;

/** How many drain calls a source holds, comments excluded. */
export function countDrainCalls(source: string): number {
  return scanDrainCalls(stripComments(source)).length;
}

/**
 * The drain calls that do NOT pass `{ quietMs: <accessor>() }`, as call text.
 *
 * Matches the accessor itself rather than the presence of a `quietMs` key:
 * `quietMs: 700` is a state this exists to reject and it satisfies a
 * presence-only test.
 *
 * Throws on an accessor that is not an identifier. A guard that cannot express
 * what it is looking for must say so — silently matching nothing is how it
 * reports a reverted call site as clean (#1012).
 */
export function drainCallsWithoutDerivedWindow(
  source: string,
  accessor: string,
): string[] {
  if (!ACCESSOR.test(accessor)) {
    throw new Error(
      `drainCallsWithoutDerivedWindow: "${accessor}" is not an identifier, so ` +
        `the guard cannot be built from it`,
    );
  }
  const derived = new RegExp(`quietMs\\s*:\\s*${accessor}\\(\\s*\\)`);
  const offenders: string[] = [];
  for (const args of scanDrainCalls(stripComments(source))) {
    if (!derived.test(args)) {
      offenders.push(`${CALLEE}(${args.replace(/\s+/g, " ").trim()})`);
    }
  }
  return offenders;
}

/**
 * The failure text for a helper whose drain reverted to the default window.
 *
 * One wording for all three call sites: the cause and the fix are the same, and
 * a reader hitting it in one file should not get a thinner explanation than in
 * another.
 */
export function derivedWindowFailure(
  file: string,
  accessor: string,
  offenders: string[],
): string {
  // The interval is RESOLVED, not quoted: a number pasted into a failure message
  // goes stale in exactly the way the mechanism it describes exists to prevent.
  return (
    `${file} drains with waitForFlowSaveSettled's 700 ms default, which arms ` +
    `immediately when nothing is in flight and therefore expires BEFORE a save ` +
    `an edit merely scheduled — one full autosave debounce later ` +
    `(${describeAutosaveInterval()}) — #1741/#1743/#1902. ` +
    `Pass { quietMs: ${accessor}() }. Offenders: ${offenders.join("; ")}`
  );
}
