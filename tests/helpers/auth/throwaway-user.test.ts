// Unit tests for the throwaway user's erase wait (#2303).
// Run with: npm run test:units
//
// Since langflow#15470 a user delete answers 202 and one singleton worker erases
// users one at a time, so how long a user takes depends on how many were deleted
// before it. The wait therefore times the QUEUE, not the user: it fails when no
// erasure finished anywhere for `ERASE_STALL_MS`, or at a hard ceiling. These tests
// pin both halves — a long but moving queue must pass, a still one must fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  ERASE_CEILING_MS,
  ERASE_STALL_MS,
  type EraseClock,
  eraseWaitVerdict,
  queueMoved,
  waitForUserErased,
} from "./throwaway-user";

test("queueMoved: an id that left the queue is progress; a new arrival alone is not", () => {
  assert.equal(queueMoved(new Set(["a", "b"]), new Set(["b"])), true);
  assert.equal(queueMoved(new Set(["a"]), new Set(["a", "c"])), false);
  assert.equal(queueMoved(new Set(["a"]), new Set(["a"])), false);
});

test("queueMoved: an unreadable queue on either side is never progress", () => {
  assert.equal(queueMoved(null, new Set()), false);
  assert.equal(queueMoved(new Set(["a"]), null), false);
});

test("eraseWaitVerdict: waits while the last progress is recent, fails once the queue is still for the stall window", () => {
  assert.deepEqual(eraseWaitVerdict({ now: 59_999, startedAt: 0, lastProgressAt: 0 }), { wait: true });
  const stalled = eraseWaitVerdict({ now: ERASE_STALL_MS, startedAt: 0, lastProgressAt: 0 });
  assert.equal(stalled.wait, false);
  assert.match((stalled as { reason: string }).reason, /finished no erasure for 60s/);
});

test("eraseWaitVerdict: a long wait that keeps moving is fine until the ceiling", () => {
  assert.deepEqual(eraseWaitVerdict({ now: 300_000, startedAt: 0, lastProgressAt: 299_000 }), { wait: true });
  const capped = eraseWaitVerdict({ now: ERASE_CEILING_MS, startedAt: 0, lastProgressAt: ERASE_CEILING_MS - 1 });
  assert.equal(capped.wait, false);
  assert.match((capped as { reason: string }).reason, /hard ceiling/);
});

/** A clock that only moves when the wait sleeps. */
function fakeClock(): EraseClock & { t: number } {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

/**
 * A request whose user GET answers 200 until `erasedAt`, and whose queue read is
 * whatever `queueAt(t)` says (`null` = the read failed).
 */
function fakeInstance(clock: { t: number }, erasedAt: number, queueAt: (t: number) => string[] | null) {
  const get = async (url: string) => {
    if (url === "/api/v1/users/") {
      const ids = queueAt(clock.t);
      if (ids === null) return { status: () => 500, json: async () => ({}) };
      return { status: () => 200, json: async () => ({ users: ids.map((id) => ({ id })) }) };
    }
    return { status: () => (clock.t >= erasedAt ? 404 : 200), json: async () => ({}) };
  };
  return { get } as unknown as APIRequestContext;
}

test("waitForUserErased: the 5th of a serial queue, 75 s behind, is waited for — the old fixed 30 s failed this", async () => {
  // Measured shape: one erasure every ~15 s, ours last of five.
  const clock = fakeClock();
  const ids = ["u1", "u2", "u3", "u4", "me"];
  const request = fakeInstance(clock, 75_000, (t) => ids.slice(Math.floor(t / 15_000)));
  await waitForUserErased(request, {}, "me", clock);
  assert.ok(clock.t >= 75_000 && clock.t < 77_000, `resolved at ${clock.t}`);
});

test("waitForUserErased: a queue that stops moving fails at the stall window, naming the depth", async () => {
  const clock = fakeClock();
  const request = fakeInstance(clock, Number.POSITIVE_INFINITY, () => ["stuck", "me"]);
  await assert.rejects(waitForUserErased(request, {}, "me", clock), (error: Error) => {
    assert.match(error.message, /finished no erasure for 60s/);
    assert.match(error.message, /queue 2 queued/);
    return true;
  });
  assert.ok(clock.t >= ERASE_STALL_MS && clock.t < ERASE_STALL_MS + 2_000, `failed at ${clock.t}`);
});

test("waitForUserErased: with the queue unreadable it degrades to a fixed stall window, never unbounded", async () => {
  const clock = fakeClock();
  const request = fakeInstance(clock, Number.POSITIVE_INFINITY, () => null);
  await assert.rejects(waitForUserErased(request, {}, "me", clock), /queue unreadable/);
  assert.ok(clock.t >= ERASE_STALL_MS && clock.t < ERASE_STALL_MS + 2_000, `failed at ${clock.t}`);
});

test("waitForUserErased: a queue that moves forever without reaching us stops at the ceiling", async () => {
  // Someone else's deletions keep finishing while ours never does.
  const clock = fakeClock();
  const request = fakeInstance(clock, Number.POSITIVE_INFINITY, (t) => [`other-${Math.floor(t / 10_000)}`, "me"]);
  await assert.rejects(waitForUserErased(request, {}, "me", clock), /hard ceiling/);
  assert.ok(clock.t >= ERASE_CEILING_MS && clock.t < ERASE_CEILING_MS + 2_000, `failed at ${clock.t}`);
});
