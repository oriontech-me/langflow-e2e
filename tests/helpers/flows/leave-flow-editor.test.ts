// Unit tests for the editor-exit classifier (issue #1153).
// Run with: npm run test:units
//
// What rides on this module: when the upstream exit deadlock fires, the line
// this produces is the entire product of the failure in a daily's report. Before
// #1153 the same event surfaced as a bare `home-dropdown-menu` visibility
// timeout, which #1005's triage spent a full 24-run burst re-deriving into "the
// blocker dialog never cleared".
//
// Three distinctions these tests exist to protect:
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
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKER_GRACE_MS,
  classifyEditorExit,
  formatEditorExitStuckFailure,
  formatEditorExitWarning,
  type EditorExitVerdict,
} from "./leave-flow-editor";

const verdict = (
  homeVisible: boolean,
  blockerVisible: boolean,
  graceExpired: boolean,
): EditorExitVerdict =>
  classifyEditorExit({ homeVisible, blockerVisible, graceExpired });

test("home rendered with no dialog is a clean exit", () => {
  assert.equal(verdict(true, false, false), "left");
  assert.equal(verdict(true, false, true), "left");
});

test("home rendered while the dialog is still painted is NOT a deadlock", () => {
  // The dialog animates out; it is routinely still in the DOM on the tick where
  // home first renders. Calling that a deadlock would warn and force a page load
  // on every healthy exit that happened to pass through the blocker.
  assert.equal(verdict(true, true, false), "blocked-settled");
  assert.equal(verdict(true, true, true), "blocked-settled");
});

test("the dialog inside the grace window is pending, not a verdict", () => {
  // `handleSave`'s own timeout is 1200ms, so a dialog that is up for a moment is
  // the normal save-then-proceed path. Returning a terminal verdict here would
  // make the caller give up before the exit had a chance to complete.
  assert.equal(verdict(false, true, false), "pending");
});

test("the dialog past the grace window is the #1153 deadlock", () => {
  assert.equal(verdict(false, true, true), "blocked-deadlocked");
});

test("neither home nor dialog past the window is a swallowed click, not a deadlock", () => {
  // Distinct from `blocked-deadlocked` on purpose: this is the editor still on
  // screen with nothing blocking it, i.e. the chevron click never registered.
  assert.equal(verdict(false, false, true), "stuck");
});

test("neither home nor dialog inside the window is still pending", () => {
  assert.equal(verdict(false, false, false), "pending");
});

test("`pending` is never terminal, so the poll loop cannot exit early", () => {
  // The loop's only exit condition is `verdict !== "pending"`. Every combination
  // that has not resolved yet must therefore classify as pending, or the caller
  // asserts against a page that has not navigated.
  const unresolvedInsideWindow: Array<[boolean, boolean]> = [
    [false, false],
    [false, true],
  ];
  for (const [home, blocker] of unresolvedInsideWindow) {
    assert.equal(
      verdict(home, blocker, false),
      "pending",
      `home=${home} blocker=${blocker} must stay pending inside the grace window`,
    );
  }
});

test("the deadlock message names the upstream defect, not just the symptom", () => {
  // Fed the real constant, not a literal: asserting against a hand-written
  // number would pass a regression that logged a budget the helper never used.
  const message = formatEditorExitWarning(BLOCKER_GRACE_MS);
  // A triager reading only this line has to reach the issue and the mechanism
  // without opening the screenshot.
  assert.match(message, /#1153/);
  assert.match(message, /SaveChangesModal/);
  assert.match(message, /no \.catch\(\)/);
  assert.match(message, new RegExp(`${BLOCKER_GRACE_MS}ms`));
});

test("the stuck message rules the deadlock OUT rather than staying vague", () => {
  // The two failures send a reader to opposite places, so the message for one
  // must not read as the other. A triager who sees this line must not go
  // looking at SaveChangesModal.
  const message = formatEditorExitStuckFailure(BLOCKER_GRACE_MS);
  assert.match(message, /did not navigate/);
  assert.match(message, /NOT the #1153/);
  assert.match(message, /LE-2019/);
  assert.doesNotMatch(
    message,
    /deadlocked/,
    "the swallowed-click message must not describe itself as the deadlock",
  );
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
