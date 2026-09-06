// Unit tests for watchFlowSave (#1741).
// Run with: npm run test:units
//
// Why this helper is unit-tested: its guarantee is that a save was OBSERVED, and
// the bug it exists to prevent is a watcher that returns having observed nothing
// — indistinguishable from a correct one on a green E2E run, because the assert
// that follows usually passes anyway (the value is in the client store; only the
// server is behind). The boundary is a debounce that an E2E run cannot pin, so
// the timing is driven directly here.
//
// Timings are deliberately small; the helper reads the real clock, so assertions
// are on ORDER and on generous bounds, never on exact durations.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { watchFlowSave } from "./watch-flow-save";

type Handler = (req: { url(): string; method(): string }) => void;
const SAVE_URL = "http://localhost:7860/api/v1/flows/abc-123";

function fakePage() {
  const handlers = new Map<string, Set<Handler>>();
  const page = {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    async waitForTimeout(ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
  const emit = (event: string, url: string, method: string) => {
    for (const handler of handlers.get(event) ?? [])
      handler({ url: () => url, method: () => method });
  };
  return {
    page: page as unknown as Page,
    get listeners() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    request: (url = SAVE_URL, method = "PATCH") => emit("request", url, method),
    finished: (url = SAVE_URL, method = "PATCH") => emit("requestfinished", url, method),
    failed: (url = SAVE_URL, method = "PATCH") => emit("requestfailed", url, method),
  };
}

test("resolves once a save issued after arming has completed", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  setTimeout(() => f.request(), 20);
  setTimeout(() => f.finished(), 60);
  await watch.settled({ timeout: 2000 });
});

test("does NOT resolve on silence — the whole point of the primitive", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  await assert.rejects(
    () => watch.settled({ timeout: 200 }),
    /no flow-save PATCH was issued within 200 ms/,
  );
});

test("waits for the save to COMPLETE, not merely to be issued", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  const started = Date.now();
  setTimeout(() => f.finished(), 150);
  await watch.settled({ timeout: 2000 });
  assert.ok(
    Date.now() - started >= 140,
    `must not return before the response settles (waited ${Date.now() - started} ms)`,
  );
});

test("a failed save settles it too — a rejected PATCH is not a pending one", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  setTimeout(() => f.failed(), 20);
  await watch.settled({ timeout: 2000 });
});

test("reports the in-flight count when a save never completes", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  await assert.rejects(() => watch.settled({ timeout: 200 }), /still in flight/);
});

test("ignores traffic that is not a flow save", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request("http://localhost:7860/api/v1/flows/abc", "GET");
  f.request("http://localhost:7860/api/v1/variables/", "PATCH");
  // The path is matched on the PATHNAME: a build asset quoting the prefix in its
  // query string must not count.
  f.request("http://localhost:7860/assets/index.js?x=/api/v1/flows/abc");
  await assert.rejects(() => watch.settled({ timeout: 150 }), /no flow-save PATCH/);
});

test("detaches its listeners on every exit path", async () => {
  const ok = fakePage();
  const watch = watchFlowSave(ok.page);
  assert.equal(ok.listeners, 3);
  ok.request();
  setTimeout(() => ok.finished(), 10);
  await watch.settled({ timeout: 2000 });
  assert.equal(ok.listeners, 0, "resolved path must detach");

  const bad = fakePage();
  const failing = watchFlowSave(bad.page);
  await assert.rejects(() => failing.settled({ timeout: 100 }));
  assert.equal(bad.listeners, 0, "timeout path must detach");

  const aborted = fakePage();
  watchFlowSave(aborted.page).dispose();
  assert.equal(aborted.listeners, 0, "dispose must detach");
});

test("is single-use: a second settled() throws instead of resolving blind", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  setTimeout(() => f.finished(), 10);
  await watch.settled({ timeout: 2000 });
  await assert.rejects(() => watch.settled({ timeout: 100 }), /single-use/);
});

test("dispose is idempotent and safe after settled()", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  setTimeout(() => f.finished(), 10);
  await watch.settled({ timeout: 2000 });
  watch.dispose();
  watch.dispose();
  assert.equal(f.listeners, 0);
});
