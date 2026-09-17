// Unit tests for the shared derived-window guard (#1902).
// Run with: npm run test:units
//
// These were `leave-flow-editor.test.ts`'s (#1743) and moved here with the
// scanner. What rides on them: the guard is the only thing that observes the
// CALL SITE, so a guard that fires on a correct edit gets deleted rather than
// fixed, and one that stays quiet on a reverted one is worse than absent — it
// reports the regression it exists to catch as clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countDrainCalls,
  derivedWindowFailure,
  drainCallsWithoutDerivedWindow,
} from "./derived-drain-window";

const ACCESSOR = "editorExitDrainQuietMs";

test("the guard catches the reversions it claims to catch", () => {
  // Each of these is a real reversion path, and the middle one is why the
  // pattern asserts the ACCESSOR rather than the presence of `quietMs`.
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page);`,
      ACCESSOR,
    ),
    ["waitForFlowSaveSettled(page)"],
  );
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: 700 });`,
      ACCESSOR,
    ),
    ["waitForFlowSaveSettled(page, { quietMs: 700 })"],
  );
  // The shape `pendingSaveQuietMs` exists to prevent: a number pasted into our
  // source, which goes stale silently the next time upstream raises
  // `auto_saving_interval` (#1741).
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: 3500 });`,
      ACCESSOR,
    ),
    ["waitForFlowSaveSettled(page, { quietMs: 3500 })"],
  );
});

test("the guard does not fire on the correct form, nor on prose about it", () => {
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: ${ACCESSOR}() });`,
      ACCESSOR,
    ),
    [],
  );
  // Every one of these modules explains the default it replaced. A guard that
  // reported the explanation as the offender would be turned off.
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `// reverting to waitForFlowSaveSettled(page); would reopen #1743\n`,
      ACCESSOR,
    ),
    [],
  );
});

test("a DIFFERENT accessor is an offender, not a pass", () => {
  // The three consumers each derive through their own named accessor, so the
  // guard must be scoped to the one its file actually exports — otherwise a
  // copy-pasted call site would vouch for a window the module never defines.
  assert.deepEqual(
    drainCallsWithoutDerivedWindow(
      `await waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() });`,
      ACCESSOR,
    ),
    ["waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() })"],
  );
});

test("an accessor that is not an identifier throws instead of matching nothing", () => {
  // A regex-special character would build a pattern that quietly matches
  // something else — and a guard that finds no offenders because it could not
  // look is indistinguishable from a clean file (#1012).
  assert.throws(
    () => drainCallsWithoutDerivedWindow(`waitForFlowSaveSettled(page);`, "a("),
    /not an identifier/,
  );
});

test("the call count is what stops a moved drain from reading as clean", () => {
  // The offender list is empty for a file with no calls at all, so every caller
  // floors on the count. Comments do not count toward it.
  assert.equal(countDrainCalls(`await waitForFlowSaveSettled(page);`), 1);
  assert.equal(
    countDrainCalls(`// await waitForFlowSaveSettled(page);\nconst x = 1;`),
    0,
  );
  assert.equal(
    countDrainCalls(
      `await waitForFlowSaveSettled(page);\nawait waitForFlowSaveSettled(page, { quietMs: 1 });`,
    ),
    2,
  );
});

test("the failure text names the cause, the fix and the offenders", () => {
  const message = derivedWindowFailure("x.ts", ACCESSOR, [
    "waitForFlowSaveSettled(page)",
  ]);
  assert.match(message, /x\.ts/);
  assert.match(message, /700 ms default/);
  // The mechanism, not just the number: a reader who only learns "use the other
  // window" re-derives why the next time a window is chosen.
  assert.match(message, /arms\s+immediately/);
  assert.match(message, /scheduled/);
  assert.match(message, new RegExp(`quietMs: ${ACCESSOR}\\(\\)`));
  assert.match(message, /waitForFlowSaveSettled\(page\)/);
});
