// Unit tests for the node-configuration guard (issue #1302).
// Run with: npm run test:units
//
// What rides on these: whether a node that silently reverted reports itself as
// such, or as the thing #1302 was filed under — `expect(locator).toHaveCount`
// timing out after 180 s on `div-chat-message`, three layers downstream of the
// cause, which read as "the model was slow" and sent the issue after the wait
// budget. The budget was never the cause: the same step costs 5 408-6 503 ms on
// the four dailies measured, cold container or warm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  AUTOSAVE_INTERVAL_FALLBACK_MS,
  publishAutosaveInterval,
} from "./autosave-interval";
import {
  countDrainCalls,
  derivedWindowFailure,
  drainCallsWithoutDerivedWindow,
  intervalDependenceFailure,
  measureIntervalDependence,
} from "./derived-drain-window";
import {
  classifyConfigOutcome,
  nodeConfigDrainQuietMs,
  revertedConfigMessage,
} from "./node-config-guard";

const DETAIL = {
  field: "Model Name",
  expected: "llama3.2:1b",
  observed: "Select an option",
  valueTestId: "value-dropdown-dropdown_str_model_name",
};

test("a widget still showing the value HELD, even inside a larger label", () => {
  // These widgets render the selection among other text — the spec's own
  // assertion uses toContainText for the same reason. Equality here would call
  // a perfectly good selection a revert.
  assert.equal(classifyConfigOutcome("llama3.2:1b", "llama3.2:1b"), "held");
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "Model: llama3.2:1b (local)"),
    "held",
  );
});

test("the reverted states are the default label, empty, and a missing widget", () => {
  // "Select an option" is what the #1302 DOM actually showed; the other two are
  // the states the same revert can leave behind while the canvas re-renders.
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "Select an option"),
    "reverted",
  );
  assert.equal(classifyConfigOutcome("llama3.2:1b", ""), "reverted");
  assert.equal(classifyConfigOutcome("llama3.2:1b", null), "reverted");
});

test("a DIFFERENT model is reverted, not held — the run would use the wrong one", () => {
  // Not hypothetical: the drop-to-workspace-default class (#491/#596) replaces
  // the selection rather than clearing it, and that run executes green against
  // a model the test never chose.
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "qwen2.5:0.5b"),
    "reverted",
  );
});

test("the message names the field, both values, and the testid it read", () => {
  const msg = revertedConfigMessage(DETAIL);

  assert.match(msg, /Model Name/);
  assert.match(msg, /llama3\.2:1b/);
  assert.match(msg, /Select an option/);
  assert.match(msg, /value-dropdown-dropdown_str_model_name/);
});

test("an empty widget is reported as empty, not as a missing one", () => {
  // Same distinction the sidebar-add message draws: `""` is a real observation
  // (the field was reset) and must not read the same as "the widget is gone",
  // which points at a re-render instead.
  const empty = revertedConfigMessage({ ...DETAIL, observed: "" });
  const gone = revertedConfigMessage({ ...DETAIL, observed: null });

  assert.match(empty, /EMPTY/);
  assert.doesNotMatch(empty, /GONE/);
  assert.match(gone, /GONE/);
  assert.doesNotMatch(gone, /EMPTY/);
});

test("the companion field is what distinguishes one widget from a whole-node reset", () => {
  // In #1302 BOTH the model and the base URL were back at their defaults. A
  // message about the dropdown alone would understate it as a selection glitch.
  const msg = revertedConfigMessage({
    ...DETAIL,
    companion: {
      field: "Ollama API URL",
      expected: "http://ollama:11434",
      observed: "http://localhost:11434",
    },
  });

  assert.match(msg, /Ollama API URL/);
  assert.match(msg, /http:\/\/ollama:11434/);
  assert.match(msg, /http:\/\/localhost:11434/);
  assert.match(msg, /the whole node was reset/);
});

test("without a companion the message makes no claim about other fields", () => {
  assert.doesNotMatch(revertedConfigMessage(DETAIL), /whole node was reset/);
});

test("the message points at the cause and forbids the wrong reading", () => {
  // The two sentences that exist to stop #1302 being re-diagnosed as a budget:
  // it names the flow-save race, and it says outright that this is not slowness.
  const msg = revertedConfigMessage(DETAIL);

  assert.match(msg, /wait-for-flow-save-settled/);
  assert.match(msg, /no version check/);
  assert.match(msg, /in-memory graph/);
  assert.match(msg, /NOT read this as a slow model or a short timeout/);
});

test("the reverted-config message is NOT classifiable as an infra failure", () => {
  // #1262's rule: claiming infra would exempt this from @stable auto-removal
  // and hide a node that silently drops its configuration.
  assert.equal(classifyInfraError(revertedConfigMessage(DETAIL)), null);
});

// The drain window (#1902). `waitForFlowSaveSettled`'s 700 ms default — what
// this module passed until #1902 — arms immediately when nothing is in flight,
// so it expired before a revert an edit had merely SCHEDULED one debounce later
// (2000 ms on `1.13.0.dev15`). The drain then returned with the widget still
// showing the selection, `classifyConfigOutcome` said `held`, and
// `waitForNodeConfigSettled` returned without ever exercising `reapply` — so a
// RECOVERABLE revert was reported as a hard failure by `assertNodeConfigHeld`
// one step later, on a spec that is `@stable` in the daily.
test("the config drain outlasts the autosave debounce it must wait out", () => {
  try {
    publishAutosaveInterval(2000);
    assert.ok(
      nodeConfigDrainQuietMs() > 2000,
      `drain window ${nodeConfigDrainQuietMs()}ms does not outlast a 2000ms debounce`,
    );
    // The constant this replaces. Asserted explicitly so any window under the
    // debounce fails here instead of silently costing the repair path again.
    assert.ok(
      nodeConfigDrainQuietMs() > 700,
      `drain window ${nodeConfigDrainQuietMs()}ms is back at or below the 700ms NODE_CONFIG_QUIET_MS`,
    );
    // DERIVED, and that is a DIFFERENCE rather than a bound. The two assertions
    // above are lower bounds that any large constant satisfies, and publishing a
    // second interval plus a third bound was one too: measured in the second
    // review round of #1902, a pasted `return 35000` passed every "derived"
    // assertion in all three of these suites. Moving the interval by a known
    // amount must move the window by the same amount; a constant moves by 0.
    // That is what keeps the window from being a number in our source, which
    // goes stale silently the next time upstream edits `auto_saving_interval`
    // (#1741).
    const measured = measureIntervalDependence(nodeConfigDrainQuietMs);
    assert.equal(
      measured.observedDelta,
      measured.expectedDelta,
      intervalDependenceFailure("nodeConfigDrainQuietMs", measured),
    );
  } finally {
    publishAutosaveInterval(null);
  }
});

test("an unknown autosave interval still gets a window above the fallback", () => {
  // Unknown is not a default (#1012): a run that could not read the interval
  // must over-wait. Under-waiting here does not fail loudly — it silently skips
  // the re-apply, which is the whole cost this window buys back.
  publishAutosaveInterval(null);
  assert.ok(
    nodeConfigDrainQuietMs() > AUTOSAVE_INTERVAL_FALLBACK_MS,
    `drain window ${nodeConfigDrainQuietMs()}ms does not exceed the ` +
      `${AUTOSAVE_INTERVAL_FALLBACK_MS}ms unknown-interval fallback`,
  );
});

test("both config drain call sites pass the derived window, not the default", () => {
  // The assertions above never observe the call site: `nodeConfigDrainQuietMs`
  // can stay exported, typechecked and unit-tested while the helper drains with
  // the default (measured on #1901's equivalent). What this guard buys, and what
  // it does not, is argued in `derived-drain-window.ts`.
  const source = readFileSync(join(__dirname, "node-config-guard.ts"), "utf8");
  const offenders = drainCallsWithoutDerivedWindow(
    source,
    "nodeConfigDrainQuietMs",
  );
  assert.deepEqual(
    offenders,
    [],
    derivedWindowFailure(
      "node-config-guard.ts",
      "nodeConfigDrainQuietMs",
      offenders,
    ),
  );
  // TWO, and the count matters beyond the empty-file case: the second drain is
  // the one after `reapply`, i.e. the repair path. A refactor that dropped it
  // would leave the re-applied value judged with a save still scheduled — the
  // same defect this issue closed, on the branch that exists to fix it (#1012).
  assert.equal(
    countDrainCalls(source),
    2,
    "node-config-guard.ts no longer holds exactly two drain calls — the guard " +
      "above is scoped to the converge and repair paths and cannot vouch for a third",
  );
});
