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
import {
  AUTOSAVE_INTERVAL_ENV,
  publishAutosaveInterval,
} from "./autosave-interval";
import { stripComments } from "./strip-comments";

const CALLEE = "waitForFlowSaveSettled";

/**
 * Every `waitForFlowSaveSettled(...)` call in a source, as its argument text.
 *
 * Balanced-paren scanning rather than a regex, and the regex it replaced is why
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
  let depth = 0;
  let argStart = -1;

  // ONE walk, string-aware at every level. Two review rounds produced this
  // shape, and each defect it closes was a way for the guard to be WRONG rather
  // than loud:
  //
  //  - tracking quotes only inside the arguments let a quote in the TOP-LEVEL
  //    text count the callee's name where it is not a call. Every module scanned
  //    here carries multi-line error-message literals (`revertedConfigMessage`,
  //    `formatEditorExitWarning`, `renameFlow`'s `console.warn`); spelling the
  //    call inside one of them would have reddened the guard on a correct edit,
  //    which this module's own header names as the way a guard gets deleted;
  //  - a quote that never closes used to run to EOF, swallowing every call after
  //    it — the silence class the balanced scan was written to close. A `'` in a
  //    regex literal (`/it's/`) is the realistic carrier.
  //
  // An unterminated quote is NOT a string, and that decision is the one place
  // this differs from `strip-comments.ts`. A `'` in a regex literal (`/it's/`)
  // or an apostrophe in prose opens a span that never closes; treating it as a
  // string means everything after it — including the `)` that ends the call it
  // sits in — is invisible, which is the silence class this scanner exists to
  // close, arriving through the quote instead of through the paren. So a quote
  // that does not close before the newline is rewound and read as an ordinary
  // character (a template literal genuinely spans lines and is exempt).
  //
  // That is the loud direction, and it costs one thing the blanker used to
  // absorb: `stripComments` bails at the newline on the same unterminated
  // quote, so a `//` after one is left UNBLANKED, and reading it normally would
  // report a COMMENT as the offender. Hence the line-comment skip below — a
  // second net, over text that is supposed to have none left. Anything else the
  // blanker could not reach stays a false POSITIVE rather than a silence, which
  // is the trade #1012 asks for: a loud guard gets investigated, a quiet one
  // gets believed.
  const closingQuote = (from: number): number => {
    const quote = source[from];
    let k = from + 1;
    while (k < source.length) {
      const c = source[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === quote) return k + 1;
      if (quote !== "`" && c === "\n") return -1;
      k++;
    }
    return quote === "`" ? k : -1;
  };

  const endOfLine = (from: number): number => {
    const nl = source.indexOf("\n", from);
    return nl === -1 ? source.length : nl;
  };

  while (i < source.length) {
    const c = source[i];

    if (c === '"' || c === "'" || c === "`") {
      const close = closingQuote(i);
      if (close !== -1) {
        i = close;
        continue;
      }
      // Not a string. Fall through and read this character normally.
    }

    if (c === "/" && source[i + 1] === "/") {
      i = endOfLine(i);
      continue;
    }

    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(argStart, i));
          argStart = -1;
        }
      }
      i++;
      continue;
    }

    if (
      c === CALLEE[0] &&
      source.startsWith(CALLEE, i) &&
      !(i > 0 && /[\w$]/.test(source[i - 1]))
    ) {
      let j = i + CALLEE.length;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === "(") {
        depth = 1;
        argStart = j + 1;
        i = j + 1;
        continue;
      }
      i += CALLEE.length;
      continue;
    }

    i++;
  }

  // A call whose parentheses never closed is one this walker could not read.
  // Reported with what it did see, never dropped: silence is the one outcome
  // this module exists to rule out (#1012). A drain call NESTED inside another
  // call's arguments is the one shape still missed — contrived, and the count
  // floor every caller asserts is what stops it from reading as clean.
  if (argStart !== -1) calls.push(source.slice(argStart));

  return calls;
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
  // No interval is quoted, and neither is one resolved. A number pasted here
  // goes stale in exactly the way the mechanism it describes exists to prevent;
  // and resolving it is worse in this context — a unit run publishes none, so
  // `describeAutosaveInterval()` would print "UNKNOWN … fallback" on every
  // failure, which is a statement about the test process, not about the run the
  // reader is being warned about.
  return (
    `${file} drains with waitForFlowSaveSettled's 700 ms default, which arms ` +
    `immediately when nothing is in flight and therefore expires BEFORE a save ` +
    `an edit merely scheduled — one full autosave debounce later, read per run ` +
    `from GET /api/v1/config.auto_saving_interval (#1741/#1743/#1902). ` +
    `Pass { quietMs: ${accessor}() }. Offenders: ${offenders.join("; ")}`
  );
}

/**
 * Does a drain-window accessor actually TRACK the resolved autosave interval?
 *
 * The three consumers each assert their window is "derived" and, until the
 * second review round of #1902, none of them measured that: publishing a second
 * interval and asserting `accessor() > 9000` is a LOWER BOUND, and a pasted
 * `return 35000` satisfies every such bound. Measured — all three suites stayed
 * green under it, including the assertions whose own comments said a constant
 * could not pass. The property is a DIFFERENCE: move the interval by a known
 * amount and the window has to move by the same amount. A constant moves by 0.
 *
 * Shared rather than written three times, for the reason the scanner above is
 * shared: three copies of an assertion is how one of them drifts back into a
 * bound nobody notices.
 *
 * Restores whatever the environment held, so an accessor that throws cannot
 * leave a published interval behind for the next test file.
 */
export function measureIntervalDependence(
  accessor: () => number,
  { low = 2000, high = 9000 }: { low?: number; high?: number } = {},
): { low: number; high: number; observedDelta: number; expectedDelta: number } {
  const previous = process.env[AUTOSAVE_INTERVAL_ENV];
  try {
    publishAutosaveInterval(low);
    const atLow = accessor();
    publishAutosaveInterval(high);
    const atHigh = accessor();
    return {
      low: atLow,
      high: atHigh,
      observedDelta: atHigh - atLow,
      expectedDelta: high - low,
    };
  } finally {
    if (previous === undefined) publishAutosaveInterval(null);
    else process.env[AUTOSAVE_INTERVAL_ENV] = previous;
  }
}

/** The failure text for a window that does not move with the interval. */
export function intervalDependenceFailure(
  accessor: string,
  measured: ReturnType<typeof measureIntervalDependence>,
): string {
  return (
    `${accessor}() does not track the resolved autosave interval: moving it by ` +
    `${measured.expectedDelta}ms moved the window by ${measured.observedDelta}ms ` +
    `(${measured.low} -> ${measured.high}). A window that does not move is a ` +
    `number pasted into our source, which goes stale silently the next time ` +
    `upstream edits auto_saving_interval — the whole of #1741. Derive it from ` +
    `pendingSaveQuietMs().`
  );
}
