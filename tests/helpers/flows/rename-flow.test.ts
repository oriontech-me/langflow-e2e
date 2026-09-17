// Unit tests for `renameFlow`'s drain window (issue #1902).
// Run with: npm run test:units
//
// The helper itself drives a modal and cannot be unit-tested without a fake
// `Page`; what CAN be pinned here is the one number every barrier in it depends
// on, and whether the call sites actually pass it.
//
// What rides on that number: `renameFlow` is a workaround for an upstream defect
// (`PATCH /api/v1/flows/{id}` has no version check, last response wins — #995),
// and the workaround is "no autosave may be in flight, or on its way, while the
// modal is open or while the header is being judged". At the helper's 700 ms
// default that was unenforceable by arithmetic: the window arms immediately when
// nothing is in flight and the autosave an edit schedules is issued one full
// debounce later — 2000 ms on `1.13.0.dev15` (#1741). This file's own history
// shows the symptom: a SECOND barrier was added in #995 because the first kept
// returning with the clobbering PATCH still to come, observed 183 ms after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOSAVE_INTERVAL_FALLBACK_MS,
  publishAutosaveInterval,
} from "./autosave-interval";
import {
  countDrainCalls,
  derivedWindowFailure,
  drainCallsWithoutDerivedWindow,
} from "./derived-drain-window";
import { renameDrainQuietMs } from "./rename-flow";

test("the rename drain outlasts the autosave debounce it must wait out", () => {
  try {
    publishAutosaveInterval(2000);
    assert.ok(
      renameDrainQuietMs() > 2000,
      `drain window ${renameDrainQuietMs()}ms does not outlast a 2000ms debounce`,
    );
    // The default this replaces. Asserted explicitly so any window under the
    // debounce fails here instead of silently reopening #995's window.
    assert.ok(
      renameDrainQuietMs() > 700,
      `drain window ${renameDrainQuietMs()}ms is back at or below waitForFlowSaveSettled's 700ms default`,
    );
    // DERIVED, not merely above the values shipped so far: the two bounds above
    // are lower bounds that any large constant satisfies — measured on #1901, a
    // pasted `return 3500` passes both — so on its own this test would bless the
    // one shape `pendingSaveQuietMs` exists to prevent (#1741). A second
    // interval is what makes the dependence observable at all.
    publishAutosaveInterval(9000);
    assert.ok(
      renameDrainQuietMs() > 9000,
      `drain window ${renameDrainQuietMs()}ms does not track the resolved ` +
        `interval — a hardcoded window satisfies the bounds above and reopens #1902 ` +
        `the next time upstream raises auto_saving_interval`,
    );
  } finally {
    publishAutosaveInterval(null);
  }
});

test("an unknown autosave interval still gets a window above the fallback", () => {
  // Unknown is not a default (#1012): a run that could not read the interval
  // must over-wait. Under-waiting costs the retry — the loop reads a header the
  // clobbering PATCH has not reverted yet and skips the re-apply.
  publishAutosaveInterval(null);
  assert.ok(
    renameDrainQuietMs() > AUTOSAVE_INTERVAL_FALLBACK_MS,
    `drain window ${renameDrainQuietMs()}ms does not exceed the ` +
      `${AUTOSAVE_INTERVAL_FALLBACK_MS}ms unknown-interval fallback`,
  );
});

test("every rename drain call site passes the derived window, not the default", () => {
  // The assertions above never observe a call site: `renameDrainQuietMs` can
  // stay exported, typechecked and unit-tested while the helper drains with the
  // default (measured on #1901's equivalent). What this guard buys, and what it
  // does not, is argued in `derived-drain-window.ts`.
  //
  // ALL of them, deliberately: the four barriers answer the same question at
  // four moments (before the modal opens, before our own PATCH, before the loop
  // judges the header, and before the closing assertion), and a per-site window
  // would be an argument to re-derive on every edit of this file rather than a
  // property a test can state.
  const source = readFileSync(join(__dirname, "rename-flow.ts"), "utf8");
  const offenders = drainCallsWithoutDerivedWindow(source, "renameDrainQuietMs");
  assert.deepEqual(
    offenders,
    [],
    derivedWindowFailure("rename-flow.ts", "renameDrainQuietMs", offenders),
  );
  // The floor: with no call to find, the offender list is empty for the same
  // reason a missing file would be (#1012). Four is also the count #995's
  // mitigation is built on — the two modal barriers plus the two header ones —
  // so losing one silently is a regression in itself.
  assert.equal(
    countDrainCalls(source),
    4,
    "rename-flow.ts no longer holds exactly four drain calls — the guard above " +
      "is scoped to those and cannot vouch for a fifth, nor notice a lost one",
  );
});
