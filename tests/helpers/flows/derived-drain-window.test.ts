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

// The silence path the first version of this module had, and documented as
// impossible (found in review). The old regex required a terminating `;`, so a
// call in ARGUMENT position did not match on its own — its body ran on to the
// next call's `);` and merged the two into one match carrying the derived
// accessor. Both halves of the guard went quiet: `offenders` empty AND the count
// unchanged, because the merge subtracts one match and adds one.
test("a drain call with no trailing semicolon is found, not merged into the next", () => {
  const source = [
    `await Promise.all([waitForFlowSaveSettled(page)]);`,
    `await waitForFlowSaveSettled(page, { quietMs: ${ACCESSOR}() });`,
  ].join("\n");

  assert.equal(countDrainCalls(source), 2);
  assert.deepEqual(drainCallsWithoutDerivedWindow(source, ACCESSOR), [
    "waitForFlowSaveSettled(page)",
  ]);
});

test("nested parentheses in the arguments do not end the call early", () => {
  // A second argument is not hypothetical — the drain also takes `timeout`. The
  // old regex stopped at the first `)` followed by `;`, so a call ending in a
  // nested call reported a TRUNCATED offender: a false positive on a correct
  // call, which is how a guard gets deleted rather than fixed.
  const source =
    `await waitForFlowSaveSettled(page, { quietMs: ${ACCESSOR}(), timeout: capMs(2) });`;
  assert.equal(countDrainCalls(source), 1);
  assert.deepEqual(drainCallsWithoutDerivedWindow(source, ACCESSOR), []);
});

test("a parenthesis inside a STRING argument does not unbalance the scan", () => {
  const source = `await waitForFlowSaveSettled(page, { label: ")(", quietMs: ${ACCESSOR}() });`;
  assert.equal(countDrainCalls(source), 1);
  assert.deepEqual(drainCallsWithoutDerivedWindow(source, ACCESSOR), []);
});

test("a call whose parentheses never close is an offender, not a silence", () => {
  // Unreadable is not clean (#1012). A truncated file, or a scan this walker
  // cannot follow, must surface as something a reader can act on.
  const offenders = drainCallsWithoutDerivedWindow(
    `await waitForFlowSaveSettled(page, { quietMs: ${ACCESSOR}(`,
    ACCESSOR,
  );
  assert.equal(offenders.length, 1);
});

test("a longer identifier ENDING in the callee name is not a drain call", () => {
  // `myWaitForFlowSaveSettled(page)` is someone else's function; counting it
  // would fail the count floor of a file that is perfectly correct.
  const source = `await myWaitForFlowSaveSettled(page);`;
  assert.equal(countDrainCalls(source), 0);
  assert.deepEqual(drainCallsWithoutDerivedWindow(source, ACCESSOR), []);
});
