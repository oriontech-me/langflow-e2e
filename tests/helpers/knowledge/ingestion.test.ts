// Unit tests for waitForRunToFinish's `requireFinishedAt` option (#2417).
// Run with: npm run test:units
//
// The default is the strict one, and it is what caught #2417: a terminal run whose
// `finished_at` never appears fails by name. The option exists for the one test that
// must read a run whose `finished_at` is KNOWN to stay null on some builds (a
// cancelled run on 1.14.0.dev23+), so it can assert everything else first — it must
// return on the terminal status alone, and must still wait while the run is in flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { waitForRunToFinish } from "./ingestion";

/** A fake whose GET /runs/{id} answers the given runs in order, then repeats the last. */
function fakeRequest(runs: Array<Record<string, unknown>>) {
  let calls = 0;
  const request = {
    get: async () => {
      const run = runs[Math.min(calls, runs.length - 1)];
      calls += 1;
      return { status: () => 200, ok: () => true, json: async () => run, text: async () => "" };
    },
  } as unknown as APIRequestContext;
  return { request, calls: () => calls };
}

const cancelledNoTimestamp = { id: "r1", status: "cancelled", finished_at: null };

test("by default a terminal run with no finished_at fails, naming the timestamp", async () => {
  const { request } = fakeRequest([cancelledNoTimestamp]);
  await assert.rejects(
    waitForRunToFinish(request, "kb", "r1", { timeoutMs: 30_000, finishedAtGraceMs: 300 }),
    /reports 'cancelled' but its finished_at stayed null for 300 ms/,
  );
});

test("requireFinishedAt: false returns on the terminal status alone", async () => {
  const { request, calls } = fakeRequest([cancelledNoTimestamp]);
  const run = await waitForRunToFinish(request, "kb", "r1", { requireFinishedAt: false });
  assert.equal(run.status, "cancelled");
  assert.equal(run.finished_at, null);
  assert.equal(calls(), 1, "no grace wait once the status is terminal");
});

test("requireFinishedAt: false still waits while the run is in flight", async () => {
  const { request, calls } = fakeRequest([
    { id: "r1", status: "running", finished_at: null },
    cancelledNoTimestamp,
  ]);
  const run = await waitForRunToFinish(request, "kb", "r1", { requireFinishedAt: false });
  assert.equal(run.status, "cancelled");
  assert.equal(calls(), 2);
});

test("a settled run is returned at once either way", async () => {
  const settled = { id: "r1", status: "succeeded", finished_at: "2026-11-12T00:00:00Z" };
  for (const requireFinishedAt of [true, false]) {
    const { request, calls } = fakeRequest([settled]);
    const run = await waitForRunToFinish(request, "kb", "r1", { requireFinishedAt });
    assert.equal(run.finished_at, settled.finished_at);
    assert.equal(calls(), 1);
  }
});
