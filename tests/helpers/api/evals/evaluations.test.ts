// Unit tests for the evaluation-run poller (#2564).
// Run with: npm run test:units
//
// A run is asynchronous (202 queued → running → a terminal status), so every spec
// waits on it. The wait has two ways to be wrong, and both look like a product
// failure from the spec's side: returning before the run is where the caller asked
// (a count read mid-run), or giving up without saying where the run was stuck. These
// tests pin both, with a fake clock so the timeout is exact and instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalRunStatus, pollRun, type RunSnapshot } from "./evaluations";

function fakeRun(statuses: Array<Partial<RunSnapshot>>) {
  let calls = 0;
  let now = 0;
  return {
    get calls() {
      return calls;
    },
    read: async (): Promise<RunSnapshot> => {
      const next = statuses[Math.min(calls, statuses.length - 1)];
      calls += 1;
      return { id: "run-1", status: "queued", completed_items: 0, total_items: 6, ...next };
    },
    clock: { now: () => now, sleep: async (ms: number) => void (now += ms) },
  };
}

test("isTerminalRunStatus: completed, failed and cancelled end a run; queued and running do not", () => {
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(isTerminalRunStatus(status), true, status);
  for (const status of ["queued", "running"]) assert.equal(isTerminalRunStatus(status), false, status);
});

test("isTerminalRunStatus: an unknown status is not terminal, so a renamed one times out loudly", () => {
  assert.equal(isTerminalRunStatus("done"), false);
  assert.equal(isTerminalRunStatus(""), false);
});

test("pollRun: returns the first snapshot the predicate accepts, and reads no further", async () => {
  const run = fakeRun([{ status: "queued" }, { status: "running" }, { status: "completed", completed_items: 6 }]);
  const final = await pollRun(run.read, (r) => isTerminalRunStatus(r.status), {
    describe: "a terminal status",
    timeoutMs: 10_000,
    intervalMs: 500,
    clock: run.clock,
  });
  assert.equal(final.status, "completed");
  assert.equal(final.completed_items, 6);
  assert.equal(run.calls, 3);
});

test("pollRun: a run stuck mid-way throws naming the goal, the last status and the progress", async () => {
  const run = fakeRun([{ status: "running", completed_items: 2 }]);
  await assert.rejects(
    pollRun(run.read, (r) => isTerminalRunStatus(r.status), {
      describe: "a terminal status",
      timeoutMs: 3_000,
      intervalMs: 500,
      clock: run.clock,
    }),
    (error: Error) => {
      assert.match(error.message, /run-1 did not reach a terminal status within 3000 ms/);
      assert.match(error.message, /last status "running", 2\/6 rows/);
      return true;
    },
  );
});

test("pollRun: a predicate that is already true returns on the first read without sleeping", async () => {
  const run = fakeRun([{ status: "running", completed_items: 4 }]);
  const final = await pollRun(run.read, (r) => r.completed_items >= 3, {
    describe: "3 scored rows",
    timeoutMs: 1_000,
    intervalMs: 500,
    clock: run.clock,
  });
  assert.equal(final.completed_items, 4);
  assert.equal(run.calls, 1);
  assert.equal(run.clock.now(), 0);
});
