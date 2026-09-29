// Unit tests for the run-scoped autosave interval (#1741).
// Run with: npm run test:units
//
// Why these are unit-tested: every consumer's guarantee is a DEADLINE derived
// from this value, and a deadline that is too short fails silently — the barrier
// returns on a save that was never issued, and the run is green. The cases below
// pin the two directions that matter: an unreadable value must degrade to the
// conservative fallback, never to zero, and a readable one must be used as-is.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOSAVE_INTERVAL_ENV,
  AUTOSAVE_INTERVAL_FALLBACK_MS,
  describeAutosaveInterval,
  fallbackStalenessWarning,
  pendingSaveQuietMs,
  preflightWarningLine,
  publishAutosaveInterval,
  readAutosaveIntervalMs,
  SAVE_COMPLETION_BUDGET_MS,
  saveScheduledDeadlineMs,
  SHIPPED_AUTOSAVE_INTERVALS_MS,
} from "./autosave-interval";

const env = (value?: string): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [AUTOSAVE_INTERVAL_ENV]: value };

test("reads a published interval back", () => {
  assert.equal(readAutosaveIntervalMs(env("2000")), 2000);
});

test("an absent or blank value is UNKNOWN, not a default", () => {
  assert.equal(readAutosaveIntervalMs(env()), null);
  assert.equal(readAutosaveIntervalMs(env("   ")), null);
});

test("a non-positive or non-integer value reads as unknown", () => {
  // A 0 would collapse every derived deadline to 'already due' — the one state
  // no caller can recover from, so it must not survive as a value.
  for (const bad of ["0", "-1", "abc", "2000.5", "NaN", "Infinity"]) {
    assert.equal(
      readAutosaveIntervalMs(env(bad)),
      null,
      `${bad} must be unknown`,
    );
  }
});

test("publish round-trips through the real environment, and null clears it", () => {
  const before = process.env[AUTOSAVE_INTERVAL_ENV];
  try {
    publishAutosaveInterval(1234);
    assert.equal(readAutosaveIntervalMs(), 1234);
    publishAutosaveInterval(null);
    assert.equal(readAutosaveIntervalMs(), null);
  } finally {
    if (before === undefined) delete process.env[AUTOSAVE_INTERVAL_ENV];
    else process.env[AUTOSAVE_INTERVAL_ENV] = before;
  }
});

test("the deadline allows a full debounce plus slack", () => {
  assert.equal(saveScheduledDeadlineMs(2000, { slackMs: 1500 }), 3500);
});

test("an unknown interval falls back ABOVE every value upstream has shipped", () => {
  const deadline = saveScheduledDeadlineMs(null, { slackMs: 0 });
  assert.equal(deadline, AUTOSAVE_INTERVAL_FALLBACK_MS);
  // Read from the list, never a literal: the literal `2000` this used to compare
  // against is how the fallback sat at 3000 below a shipped 5000 with the unit
  // lane green (#2107).
  const largest = Math.max(...SHIPPED_AUTOSAVE_INTERVALS_MS);
  assert.ok(
    AUTOSAVE_INTERVAL_FALLBACK_MS >= 2 * largest,
    `fallback ${AUTOSAVE_INTERVAL_FALLBACK_MS}ms is not at least 2x the largest ` +
      `shipped interval (${largest}ms)`,
  );
});

test("the shipped-interval record includes the 1.13.0.dev27 value (#2107)", () => {
  // Measured on 1.13.0.dev27 (`GET /api/v1/config.auto_saving_interval`).
  // Dropping it from the list would let the 2x assertion above pass against a
  // stale maximum.
  assert.ok(SHIPPED_AUTOSAVE_INTERVALS_MS.includes(5000));
});

test("an unknown interval never waits less than any shipped one", () => {
  // The property #2107 is about, stated on the derived windows the callers use
  // rather than on the constant: with the read failed, both the watcher's
  // deadline and the drain's window must still cover every real debounce.
  for (const shipped of SHIPPED_AUTOSAVE_INTERVALS_MS) {
    assert.ok(
      saveScheduledDeadlineMs(null) > saveScheduledDeadlineMs(shipped),
      `unknown-interval deadline does not cover a ${shipped}ms debounce`,
    );
    assert.ok(
      pendingSaveQuietMs(null) > pendingSaveQuietMs(shipped),
      `unknown-interval drain window does not cover a ${shipped}ms debounce`,
    );
  }
});

test("a read interval larger than every shipped one is named, not silent", () => {
  const largest = Math.max(...SHIPPED_AUTOSAVE_INTERVALS_MS);
  for (const shipped of SHIPPED_AUTOSAVE_INTERVALS_MS) {
    assert.equal(
      fallbackStalenessWarning(shipped),
      null,
      `${shipped}ms is known`,
    );
  }
  // A new maximum warns on first sight — before it reaches the fallback, which
  // is the point: warning only at the fallback would warn on the day it is
  // already too short.
  const margin = fallbackStalenessWarning(largest + 1);
  assert.ok(margin, "a new maximum below the fallback must still warn");
  assert.match(margin, /SHIPPED_AUTOSAVE_INTERVALS_MS/);
  assert.match(margin, /lost its 2x margin/);
  assert.match(margin, new RegExp(String(largest + 1)));
  const urgent = fallbackStalenessWarning(AUTOSAVE_INTERVAL_FALLBACK_MS);
  assert.ok(urgent, "a value at the fallback must warn");
  assert.match(urgent, /fail healthy saves/);
  assert.match(urgent, new RegExp(String(2 * AUTOSAVE_INTERVAL_FALLBACK_MS)));
});

test("preflight warnings become annotations on GitHub Actions only", () => {
  assert.equal(
    preflightWarningLine("x", { GITHUB_ACTIONS: "true" }),
    "::warning::x",
  );
  assert.equal(preflightWarningLine("x", {}), "[preflight] WARNING: x");
  assert.equal(
    preflightWarningLine("x", { GITHUB_ACTIONS: "false" }),
    "[preflight] WARNING: x",
  );
});

test("an annotation keeps a multi-line error on ONE workflow-command line", () => {
  // The shape a failed read really produces: Playwright's request error is
  // multi-line and carries ANSI colour codes in its call log (measured against a
  // closed port in the review of #2108). An unescaped newline ends the
  // annotation, and the fallback sentence would never reach the run page.
  const message =
    `${describeAutosaveInterval(null)} — could not read the flow autosave debounce: ` +
    "Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:7899\r\n" +
    "Call log:\n\u001b[2m  - → GET http://127.0.0.1:7899/api/v1/config\u001b[22m\n100%";
  const line = preflightWarningLine(message, { GITHUB_ACTIONS: "true" });
  assert.ok(line.startsWith("::warning::"));
  assert.doesNotMatch(line, /[\r\n]/, "a raw newline ends the annotation");
  assert.doesNotMatch(line, /\u001b/, "ANSI codes would render as garbage");
  assert.match(line, /using the 10000 ms fallback/);
  assert.match(line, /%0D%0ACall log:%0A/);
  assert.match(line, /100%25$/, "a literal % must be escaped, not read as one");
  // Locally the message is printed as is, colours and newlines included.
  assert.equal(
    preflightWarningLine(message, {}),
    `[preflight] WARNING: ${message}`,
  );
});

test("the description names which of the two states produced the number", () => {
  assert.match(describeAutosaveInterval(2000), /2000 ms/);
  assert.match(describeAutosaveInterval(2000), /auto_saving_interval/);
  assert.match(describeAutosaveInterval(null), /UNKNOWN/);
  assert.match(
    describeAutosaveInterval(null),
    new RegExp(String(AUTOSAVE_INTERVAL_FALLBACK_MS)),
  );
});

test("the pending-save quiet window is longer than the debounce itself", () => {
  // The gap waitForFlowSaveSettled leaves open is a save that is SCHEDULED and
  // not yet issued; only a window longer than the debounce closes it.
  assert.ok(pendingSaveQuietMs(2000) > 2000);
  assert.equal(pendingSaveQuietMs(2000, { slackMs: 500 }), 2500);
  assert.ok(
    pendingSaveQuietMs(null) > AUTOSAVE_INTERVAL_FALLBACK_MS - 1,
    "an unknown interval must not shrink the window",
  );
});

test("the quiet window clears the post-debounce latency by more than a hair", () => {
  // #1902 measured the latency the slack exists to cover: on 1.13.0.dev15 the
  // PATCH was issued 2433 ms after the drain armed against a 2000 ms interval —
  // 433 ms of render and request setup, on an IDLE local box. At the 500 ms slack
  // this shipped with, the window backing the whole mechanism cleared its own
  // measurement by 67 ms, and under-waiting is the silent failure (#1741).
  const MEASURED_LATENCY_MS = 433;
  for (const interval of SHIPPED_AUTOSAVE_INTERVALS_MS) {
    assert.ok(
      pendingSaveQuietMs(interval) - interval >= MEASURED_LATENCY_MS * 2,
      `slack ${pendingSaveQuietMs(interval) - interval}ms leaves less than 2x the ` +
        `${MEASURED_LATENCY_MS}ms of post-debounce latency measured on an idle box`,
    );
  }
  // And the two sibling budgets for that same latency must not diverge again:
  // one of them was 500 and the other 1500, which is how the optimistic half
  // went unnoticed.
  assert.equal(
    pendingSaveQuietMs(2000) - 2000,
    saveScheduledDeadlineMs(2000) - 2000,
    "the drain window and the watcher deadline budget the same latency differently",
  );
});

test("the completion budget is separate from, and larger than, the issuance slack", () => {
  // Folding them into one makes a healthy-but-slow round trip indistinguishable
  // from an edit that never marked the node dirty.
  assert.ok(SAVE_COMPLETION_BUDGET_MS > 0);
  assert.ok(
    SAVE_COMPLETION_BUDGET_MS > saveScheduledDeadlineMs(2000) - 2000,
    "the completion budget must exceed the issuance slack it was split from",
  );
});
