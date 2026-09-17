// Unit tests for the editor-exit classifier (issue #1153).
// Run with: npm run test:units
//
// What rides on this module: when the upstream exit deadlock fires, the line
// this produces is the entire product of the failure in a daily's report. Before
// #1153 the same event surfaced as a bare `home-dropdown-menu` visibility
// timeout, which #1005's triage spent a full 24-run burst re-deriving into "the
// blocker dialog never cleared".
//
// Four distinctions these tests exist to protect:
//
//  1. **`stuck` is not `blocked-deadlocked`.** A swallowed chevron click and a
//     blocked navigation both end with the editor still on screen, and they send
//     a reader to opposite places (a click that never fired vs. the upstream
//     defect). Collapsing them re-creates the unattributed timeout.
//  2. **`pending` is a verdict, not an absence.** The polling loop terminates on
//     "anything but pending", so a classifier that returned `left` for "nothing
//     has happened yet" would make the loop exit on its first tick and assert
//     against a page that has not navigated.
//  3. **Home wins over a painted dialog.** The dialog animates out, so it is
//     routinely still in the DOM on the tick where home first renders. Reporting
//     that as a deadlock would warn — and force a page load — on healthy exits.
//  4. **The two deadlines are not one deadline.** An empty screen is an ordinary
//     in-flight navigation and gets the full home budget; only a dialog already
//     on screen is judged on the shorter blocker grace. Charging the grace window
//     to a slow-but-healthy exit reports a dead click that never happened — the
//     same mis-attribution as a bare timeout, only with a confident label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOSAVE_INTERVAL_FALLBACK_MS,
  publishAutosaveInterval,
} from "./autosave-interval";
import { stripComments } from "./strip-comments";
import {
  BLOCKER_GRACE_MS,
  HOME_TIMEOUT_MS,
  classifyEditorExit,
  editorExitDrainQuietMs,
  formatEditorExitStuckFailure,
  formatEditorExitWarning,
  type EditorExitVerdict,
} from "./leave-flow-editor";

/**
 * Named rather than positional, and every deadline defaults to NOT expired: a
 * test that forgets to expire one gets `pending` — which fails loudly — instead
 * of silently agreeing with whichever flag happened to be passed.
 */
const verdict = (observed: {
  home?: boolean;
  blocker?: boolean;
  /** `BLOCKER_GRACE_MS` elapsed. Only ever promotes a dialog already on screen. */
  grace?: boolean;
  /** `HOME_TIMEOUT_MS` elapsed. The only thing that may call an empty screen stuck. */
  homeBudget?: boolean;
}): EditorExitVerdict =>
  classifyEditorExit({
    homeVisible: observed.home ?? false,
    blockerVisible: observed.blocker ?? false,
    graceExpired: observed.grace ?? false,
    homeBudgetExpired: observed.homeBudget ?? false,
  });

test("home rendered with no dialog is a clean exit", () => {
  assert.equal(verdict({ home: true }), "left");
  assert.equal(verdict({ home: true, grace: true, homeBudget: true }), "left");
});

test("home rendered while the dialog is still painted is NOT a deadlock", () => {
  // The dialog animates out; it is routinely still in the DOM on the tick where
  // home first renders. Calling that a deadlock would warn and force a page load
  // on every healthy exit that happened to pass through the blocker.
  assert.equal(verdict({ home: true, blocker: true }), "blocked-settled");
  assert.equal(
    verdict({ home: true, blocker: true, grace: true, homeBudget: true }),
    "blocked-settled",
  );
});

test("the dialog inside the grace window is pending, not a verdict", () => {
  // `handleSave`'s own timeout is 1200ms, so a dialog that is up for a moment is
  // the normal save-then-proceed path. Returning a terminal verdict here would
  // make the caller give up before the exit had a chance to complete.
  assert.equal(verdict({ blocker: true }), "pending");
});

test("the dialog past the grace window is the #1153 deadlock", () => {
  assert.equal(verdict({ blocker: true, grace: true }), "blocked-deadlocked");
});

test("an empty screen past the grace window is NOT yet stuck", () => {
  // The regression this pins: `stuck` used to share the blocker's deadline, so a
  // navigation that was merely slow — a client-side route change plus the
  // listing's own GET, the thing that runs long on a saturated daily — failed at
  // 15s claiming the click never registered. The call sites this helper replaced
  // allowed 30s for exactly this window.
  assert.equal(verdict({ grace: true }), "pending");
});

test("an empty screen past the HOME budget is a swallowed click, not a deadlock", () => {
  // Distinct from `blocked-deadlocked` on purpose: this is the editor still on
  // screen with nothing blocking it, i.e. the chevron click never registered.
  assert.equal(verdict({ grace: true, homeBudget: true }), "stuck");
});

test("neither home nor dialog inside both windows is still pending", () => {
  assert.equal(verdict({}), "pending");
});

test("`pending` is never terminal, so the poll loop cannot exit early", () => {
  // The loop's only exit condition is `verdict !== "pending"`. Every combination
  // that has not resolved yet must therefore classify as pending, or the caller
  // asserts against a page that has not navigated.
  //
  // Includes the deadline states, because they expire at different times: with
  // the blocker grace elapsed but the home budget still open, an empty screen is
  // the one state where a shared deadline used to produce a wrong verdict.
  const unresolved = [
    { blocker: false, grace: false },
    { blocker: true, grace: false },
    { blocker: false, grace: true },
  ];
  for (const { blocker, grace } of unresolved) {
    assert.equal(
      verdict({ blocker, grace }),
      "pending",
      `blocker=${blocker} grace=${grace} must stay pending while the home budget is open`,
    );
  }
});

test("the deadlock message names the upstream defect, not just the symptom", () => {
  // Called with NO argument, so this pins the pairing the helper actually ships
  // — not just the formatting. Feeding the constant in would have passed a
  // regression that quoted a budget this verdict is not gated on.
  const message = formatEditorExitWarning();
  // A triager reading only this line has to reach the issue and the mechanism
  // without opening the screenshot.
  assert.match(message, /#1153/);
  assert.match(message, /SaveChangesModal/);
  assert.match(message, /no \.catch\(\)/);
  assert.match(message, new RegExp(`${BLOCKER_GRACE_MS}ms`));
  // Must not quote the home budget: this verdict is gated on the grace window,
  // and swapping the two is precisely how the deadlines get collapsed again.
  assert.doesNotMatch(message, new RegExp(`${HOME_TIMEOUT_MS}ms`));
});

test("the stuck message rules the deadlock OUT rather than staying vague", () => {
  // The two failures send a reader to opposite places, so the message for one
  // must not read as the other. A triager who sees this line must not go
  // looking at SaveChangesModal.
  // Also called with no argument — see the deadlock message test above.
  const message = formatEditorExitStuckFailure();
  assert.match(message, /did not navigate/);
  assert.match(message, /NOT the #1153/);
  assert.match(message, /LE-2019/);
  assert.doesNotMatch(
    message,
    /deadlocked/,
    "the swallowed-click message must not describe itself as the deadlock",
  );
  // It must quote the window it actually waited out. Quoting the blocker's
  // shorter grace would understate the evidence behind "the click never
  // registered" — and would be the visible symptom of the two deadlines having
  // been collapsed back into one.
  assert.match(message, new RegExp(`${HOME_TIMEOUT_MS}ms`));
  assert.doesNotMatch(message, new RegExp(`${BLOCKER_GRACE_MS}ms`));
});

test("the grace budget is not below the repo's save budgets", () => {
  // `renameFlow` allows 15s per modal step and a single save click has needed
  // longer than that under CI saturation (#790). A budget below that would
  // classify a slow-but-working save as a deadlock — and, where recovery is
  // enabled, discard editor state over it.
  assert.ok(
    BLOCKER_GRACE_MS >= 15000,
    `grace window ${BLOCKER_GRACE_MS}ms is below renameFlow's 15000ms per-step budget`,
  );
});

test("the home budget stays above the blocker grace, and above what the call sites had", () => {
  // Ordering is the whole point of splitting the deadlines: if the home budget
  // ever fell to or below the grace window, `stuck` would start firing on slow
  // navigations again and this helper would be back to mis-attributing them.
  assert.ok(
    HOME_TIMEOUT_MS > BLOCKER_GRACE_MS,
    `home budget ${HOME_TIMEOUT_MS}ms must exceed the blocker grace ${BLOCKER_GRACE_MS}ms`,
  );
  // 30s is inherited, not invented: it is what `duplicate-flow` (`toBeVisible`)
  // and `export-import-flow` (`waitForSelector`) allowed this assertion before
  // the helper existed. The helper must not silently shorten it.
  assert.ok(
    HOME_TIMEOUT_MS >= 30000,
    `home budget ${HOME_TIMEOUT_MS}ms is below the 30000ms the call sites already allowed`,
  );
});

// The prevention half (#1743). `waitForFlowSaveSettled`'s 700 ms default arms
// immediately when nothing is in flight, so it expires BEFORE the save an edit
// schedules one debounce later — the exit then happens with the store still
// diverged, which is the state `useBlocker` fires on and the one this helper's
// prevention step exists to avoid. These pin the window against the interval
// actually resolved for the run rather than against a number pasted here.
test("the exit drain outlasts the autosave debounce it must wait out", () => {
  try {
    publishAutosaveInterval(2000);
    assert.ok(
      editorExitDrainQuietMs() > 2000,
      `drain window ${editorExitDrainQuietMs()}ms does not outlast a 2000ms debounce`,
    );
    // The default this replaces. Asserted explicitly so any window under the
    // debounce fails here instead of silently reopening #1743.
    assert.ok(
      editorExitDrainQuietMs() > 700,
      `drain window ${editorExitDrainQuietMs()}ms is back at or below the 700ms default`,
    );
    // DERIVED from the interval, not merely above the values shipped so far.
    // The two bounds above are lower bounds that any large constant satisfies —
    // measured, `return 3500` passes both — so on its own this test would bless
    // the one shape `pendingSaveQuietMs` exists to prevent: a number pasted into
    // our source, which goes stale silently the next time upstream edits its
    // default (`autosave-interval.ts`, #1741). A second interval is what makes
    // the dependence observable at all.
    publishAutosaveInterval(9000);
    assert.ok(
      editorExitDrainQuietMs() > 9000,
      `drain window ${editorExitDrainQuietMs()}ms does not track the resolved ` +
        `interval — a hardcoded window satisfies the bounds above and reopens #1743 ` +
        `the next time upstream raises auto_saving_interval`,
    );
  } finally {
    publishAutosaveInterval(null);
  }
});

test("an unknown autosave interval still gets a window above the fallback", () => {
  // Unknown is not a default (#1012): a run that could not read the interval
  // must over-wait, never under-wait, because under-waiting returns on a save
  // that was never issued and the exit proceeds with a diverged store.
  publishAutosaveInterval(null);
  assert.ok(
    editorExitDrainQuietMs() > AUTOSAVE_INTERVAL_FALLBACK_MS,
    `drain window ${editorExitDrainQuietMs()}ms does not exceed the ` +
      `${AUTOSAVE_INTERVAL_FALLBACK_MS}ms unknown-interval fallback`,
  );
});

// The window is only worth deriving if the helper actually PASSES it, and the
// three assertions above never observe the call site: reverting the drain to
// `waitForFlowSaveSettled(page)` — the exact regression #1743 is about, and the
// bare spelling every other caller in the suite still uses — left all of them
// green (measured). `editorExitDrainQuietMs` would stay exported, typechecked
// and unit-tested while nothing used it.
//
// So this is a STRUCTURAL guard, and it is worth being plain about what that
// buys: it pins a spelling, not a behaviour (#1226). That is adequate here and
// nowhere near generally — the mutation this has to catch IS the spelling, one
// argument present or absent at a single call site, so there is no gap between
// "the source says it" and "the helper does it". A behavioural version would
// need a fake `Page` covering `getByTestId`, `expect` and the polling loop, to
// assert one argument.
//
// Comments are blanked first: this module's own JSDoc names the 700 ms default
// it replaced, and matching prose would report the explanation as the offender.
const DRAIN_CALL = /waitForFlowSaveSettled\(([\s\S]*?)\)\s*;/g;

/** Drain calls that do not pass the derived window. Returns the call text. */
function drainCallsWithoutDerivedWindow(source: string): string[] {
  const offenders: string[] = [];
  for (const match of stripComments(source).matchAll(DRAIN_CALL)) {
    const args = match[1];
    // The constant, not just any `quietMs`: `quietMs: 700` is the state this
    // exists to reject, and it satisfies a presence-only test.
    if (!/quietMs\s*:\s*editorExitDrainQuietMs\(\s*\)/.test(args)) {
      offenders.push(`waitForFlowSaveSettled(${args.replace(/\s+/g, " ").trim()})`);
    }
  }
  return offenders;
}

test("the exit drain call site passes the derived window, not the default", () => {
  const source = readFileSync(join(__dirname, "leave-flow-editor.ts"), "utf8");
  const offenders = drainCallsWithoutDerivedWindow(source);
  assert.deepEqual(
    offenders,
    [],
    `leave-flow-editor.ts drains with the helper's 700 ms default, which arms ` +
      `immediately and expires before the autosave an edit schedules one debounce ` +
      `later — the exit then happens with the store diverged (#1743/#1153). Pass ` +
      `{ quietMs: editorExitDrainQuietMs() }. Offenders: ${offenders.join("; ")}`,
  );
  // The guard is only meaningful if the file has a call to find: a rename or a
  // refactor that moved the drain out would otherwise report "no offenders" for
  // the same reason a missing file would (#1012).
  assert.equal(
    [...stripComments(source).matchAll(DRAIN_CALL)].length,
    1,
    "leave-flow-editor.ts no longer holds exactly one drain call — the guard " +
      "above is scoped to that call and cannot vouch for a second one",
  );
});

test("the drain guard catches the reversion it claims to catch", () => {
  // Each of these is a real reversion path, and the middle one is why the
  // pattern asserts the CONSTANT rather than the presence of `quietMs`.
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(`await waitForFlowSaveSettled(page);`),
    ["waitForFlowSaveSettled(page)"],
  );
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: 700 });`,
    ),
    ["waitForFlowSaveSettled(page, { quietMs: 700 })"],
  );
  // And it must not fire on the correct form, nor on prose describing the
  // default: a guard that fails a correct edit gets deleted, not fixed.
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: editorExitDrainQuietMs() });`,
    ),
    [],
  );
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `// reverting to waitForFlowSaveSettled(page); would reopen #1743\n`,
    ),
    [],
  );
});
