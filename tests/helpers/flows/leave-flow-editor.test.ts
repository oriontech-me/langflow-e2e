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
import {
  BLOCKER_GRACE_MS,
  HOME_TIMEOUT_MS,
  classifyEditorExit,
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
