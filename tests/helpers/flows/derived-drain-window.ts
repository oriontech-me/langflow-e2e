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
import { stripComments } from "./strip-comments";

/**
 * Every `waitForFlowSaveSettled(...)` call in a source, as written.
 *
 * Non-greedy up to the first `)` followed by `;`, which is what every call in
 * the tree looks like; a call whose arguments contain a `);` would be missed,
 * and the count floor below is what stops that from reading as "no offenders".
 */
const DRAIN_CALL = /waitForFlowSaveSettled\(([\s\S]*?)\)\s*;/g;

/** Identifiers only — a regex-special character here would match by accident. */
const ACCESSOR = /^[A-Za-z_$][\w$]*$/;

/** How many drain calls a source holds, comments excluded. */
export function countDrainCalls(source: string): number {
  return [...stripComments(source).matchAll(DRAIN_CALL)].length;
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
  for (const match of stripComments(source).matchAll(DRAIN_CALL)) {
    const args = match[1];
    if (!derived.test(args)) {
      offenders.push(
        `waitForFlowSaveSettled(${args.replace(/\s+/g, " ").trim()})`,
      );
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
  return (
    `${file} drains with waitForFlowSaveSettled's 700 ms default, which arms ` +
    `immediately when nothing is in flight and therefore expires BEFORE a save ` +
    `an edit merely scheduled — one full autosave debounce later, 2000 ms on ` +
    `1.13.0.dev15 (#1741/#1743/#1902). Pass { quietMs: ${accessor}() }. ` +
    `Offenders: ${offenders.join("; ")}`
  );
}
