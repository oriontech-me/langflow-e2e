// Unit tests for the flow-save drain (issues #995, #1902).
// Run with: npm run test:units
//
// The helper had no unit coverage at all; what it needs is small and specific.
//
//  1. **The safety cap is a DERIVED window, not a round number.** It bounds the
//     same thing `quietMs` bounds — a save still to be issued — plus the time to
//     complete it, so raising `quietMs` without raising the cap silently shortens
//     the interval in which a late PATCH can still be drained (#1902).
//  2. **The cap exit is not the quiet exit.** They resolve the same way, and
//     until #1902 they were indistinguishable: a drain that gave up while a PATCH
//     was in flight looked exactly like one that ended with a settled store —
//     the #995 state the helper exists to rule out, reported as success.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Request } from "@playwright/test";
import { SAVE_COMPLETION_BUDGET_MS } from "./autosave-interval";
import {
  DEFAULT_DRAIN_CAP_MS,
  drainCapMs,
  waitForFlowSaveSettled,
} from "./wait-for-flow-save-settled";

test("the cap leaves room for a save to be issued AND to complete", () => {
  for (const quietMs of [700, 2500, 3500, 9500]) {
    assert.ok(
      drainCapMs(quietMs) >= quietMs + SAVE_COMPLETION_BUDGET_MS,
      `cap ${drainCapMs(quietMs)}ms for a ${quietMs}ms window does not leave the ` +
        `${SAVE_COMPLETION_BUDGET_MS}ms completion budget`,
    );
  }
});

test("the cap tracks the window rather than staying a constant", () => {
  // The regression: a fixed 10 000 ms cap against a window raised 700 -> 2500
  // shrinks the drainable interval from ~9.3 s to ~7.5 s, and past it the helper
  // returns with a PATCH possibly still in flight.
  assert.ok(
    drainCapMs(3500) > drainCapMs(2500),
    "the cap does not grow with the window it caps",
  );
});

test("a caller that passes no window keeps at least the cap it always had", () => {
  assert.ok(drainCapMs(700) >= DEFAULT_DRAIN_CAP_MS);
});

/** The only two members of `Page` this helper touches. */
function fakePage(): Page & { emit: (event: string, req: Request) => void } {
  const handlers = new Map<string, Set<(req: Request) => void>>();
  return {
    on(event: string, fn: (req: Request) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off(event: string, fn: (req: Request) => void) {
      handlers.get(event)?.delete(fn);
    },
    emit(event: string, req: Request) {
      for (const fn of handlers.get(event) ?? []) fn(req);
    },
  } as unknown as Page & { emit: (event: string, req: Request) => void };
}

const patch = (): Request =>
  ({
    url: () => "http://x/api/v1/flows/abc",
    method: () => "PATCH",
  }) as unknown as Request;

test("an idle editor resolves after the quiet window, not after the cap", async () => {
  const started = Date.now();
  await waitForFlowSaveSettled(fakePage(), { quietMs: 40, timeout: 5000 });
  assert.ok(
    Date.now() - started < 2000,
    "the drain waited far past its quiet window on an idle page",
  );
});

test("a PATCH still in flight at the cap is reported, not resolved in silence", async () => {
  const page = fakePage();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    const settled = waitForFlowSaveSettled(page, { quietMs: 40, timeout: 250 });
    // Issued and never finished — the #995 state: the caller's next action would
    // race a save that is still on the wire.
    page.emit("request", patch());
    await settled;
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 1, "the cap exit said nothing");
  // A reader has to be able to tell this apart from a settled drain WITHOUT
  // opening the helper: what it gave up on, and what that means for the next
  // assertion.
  assert.match(warnings[0], /safety cap/);
  assert.match(warnings[0], /1 flow-save PATCH\(es\) still in flight/);
  assert.match(warnings[0], /NOT starting from a settled store/);
});

test("a drain that really went quiet says nothing", async () => {
  // The other half: a warning on every healthy drain is a warning nobody reads.
  const page = fakePage();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    const settled = waitForFlowSaveSettled(page, { quietMs: 40, timeout: 5000 });
    page.emit("request", patch());
    page.emit("requestfinished", patch());
    await settled;
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(warnings, []);
});
