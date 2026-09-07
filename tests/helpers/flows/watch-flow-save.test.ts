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

type FakeRequest = { url(): string; method(): string };
type Handler = (req: FakeRequest) => void;
const SAVE_URL = "http://localhost:7860/api/v1/flows/abc-123";

/**
 * A Page stand-in exposing only what the helper touches.
 *
 * Requests are OBJECTS handed back to the caller, not re-created per event,
 * because Playwright emits the same `Request` instance on `request` and on
 * `requestfinished`/`requestfailed` and the helper keys on that identity. A fake
 * that minted a fresh object per event would let a watcher which cannot tell two
 * concurrent saves apart pass every test here (it did: the counter version this
 * replaced was green against that fake and released early on the interleaving
 * below).
 */
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
  const emit = (event: string, req: FakeRequest) => {
    for (const handler of handlers.get(event) ?? []) handler(req);
  };
  const make = (url = SAVE_URL, method = "PATCH"): FakeRequest => ({
    url: () => url,
    method: () => method,
  });
  return {
    page: page as unknown as Page,
    get listeners() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    /** Start a request and return it, so the same object can be settled later. */
    request: (url = SAVE_URL, method = "PATCH") => {
      const req = make(url, method);
      emit("request", req);
      return req;
    },
    finished: (req: FakeRequest) => emit("requestfinished", req),
    failed: (req: FakeRequest) => emit("requestfailed", req),
    /** A request the watch never saw start — in flight before it was armed. */
    settleUnobserved: (url = SAVE_URL) => emit("requestfinished", make(url)),
  };
}

test("resolves once a save issued after arming has completed", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  let req: ReturnType<typeof f.request>;
  setTimeout(() => (req = f.request()), 20);
  setTimeout(() => f.finished(req!), 60);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
});

test("does NOT resolve on silence — the whole point of the primitive", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  await assert.rejects(
    () => watch.settled({ issueTimeout: 200, completionTimeout: 200 }),
    /no flow-save PATCH was issued within 200 ms/,
  );
});

test("waits for the save to COMPLETE, not merely to be issued", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  const started = Date.now();
  setTimeout(() => f.finished(req), 150);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
  assert.ok(
    Date.now() - started >= 140,
    `must not return before the response settles (waited ${Date.now() - started} ms)`,
  );
});

test("a failed save settles it too — a rejected PATCH is not a pending one", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  setTimeout(() => f.failed(req), 20);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
});

test("reports the in-flight count when a save never completes", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request();
  await assert.rejects(() => watch.settled({ issueTimeout: 200, completionTimeout: 200 }), /still in flight/);
});

test("ignores traffic that is not a flow save", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  f.request("http://localhost:7860/api/v1/flows/abc", "GET");
  f.request("http://localhost:7860/api/v1/variables/", "PATCH");
  // The path is matched on the PATHNAME: a build asset quoting the prefix in its
  // query string must not count.
  f.request("http://localhost:7860/assets/index.js?x=/api/v1/flows/abc");
  await assert.rejects(() => watch.settled({ issueTimeout: 150, completionTimeout: 150 }), /no flow-save PATCH/);
});

test("detaches its listeners on every exit path", async () => {
  const ok = fakePage();
  const watch = watchFlowSave(ok.page);
  assert.equal(ok.listeners, 3);
  const okReq = ok.request();
  setTimeout(() => ok.finished(okReq), 10);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
  assert.equal(ok.listeners, 0, "resolved path must detach");

  const bad = fakePage();
  const failing = watchFlowSave(bad.page);
  await assert.rejects(() => failing.settled({ issueTimeout: 100, completionTimeout: 100 }));
  assert.equal(bad.listeners, 0, "timeout path must detach");

  const aborted = fakePage();
  watchFlowSave(aborted.page).dispose();
  assert.equal(aborted.listeners, 0, "dispose must detach");
});

test("is single-use: a second settled() throws instead of resolving blind", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  setTimeout(() => f.finished(req), 10);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
  await assert.rejects(() => watch.settled({ issueTimeout: 100, completionTimeout: 100 }), /single-use/);
});

test("dispose is idempotent and safe after settled()", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  setTimeout(() => f.finished(req), 10);
  await watch.settled({ issueTimeout: 2000, completionTimeout: 2000 });
  watch.dispose();
  watch.dispose();
  assert.equal(f.listeners, 0);
});

test("a save in flight BEFORE arming cannot release the watch (#1742 review)", async () => {
  // The interleaving that a counter cannot survive: the caller's edit starts a
  // save, then an OLDER save — in flight since before this watch existed —
  // finishes. A counting watcher drops to zero and returns while the save it was
  // asked about is still open, which is the early return this primitive exists
  // to prevent, reintroduced inside it.
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const mine = f.request();
  f.settleUnobserved();
  let released = false;
  const settled = watch.settled({ issueTimeout: 3000, completionTimeout: 3000 }).then(() => (released = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(released, false, "must not release while the observed save is open");
  f.finished(mine);
  await settled;
  assert.equal(released, true);
});

test("two concurrent saves: both must complete", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const first = f.request();
  const second = f.request();
  let released = false;
  const settled = watch.settled({ issueTimeout: 3000, completionTimeout: 3000 }).then(() => (released = true));
  f.finished(first);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(released, false, "one of two settling is not enough");
  f.finished(second);
  await settled;
  assert.equal(released, true);
});

test("a save that already completed is honoured even with the budget spent (#1742 review)", async () => {
  // The condition must be evaluated at least once, BEFORE the clock is
  // consulted. The `while (Date.now() < deadline)` version this replaces
  // discarded a save that completed during its final sleep and threw
  // "1 issued but 0 still in flight" — a message that disproves itself. Budgets
  // of 0 reproduce that ordering deterministically, with no clock race.
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  f.finished(req);
  await watch.settled({ issueTimeout: 0, completionTimeout: 0 });
});

test("the issuance and completion budgets are independent", async () => {
  // An issued-but-slow save must not be reported as "never issued": the two
  // failures have different causes (a follow-on mutation restarting the trailing
  // debounce vs a slow backend) and the error has to say which.
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  const req = f.request();
  const settled = watch.settled({ issueTimeout: 0, completionTimeout: 1000 });
  setTimeout(() => f.finished(req), 120);
  await settled;
});

test("a disposed watch says so, instead of blaming re-use (#1742 review)", async () => {
  const f = fakePage();
  const watch = watchFlowSave(f.page);
  watch.dispose();
  await assert.rejects(
    () => watch.settled({ issueTimeout: 100, completionTimeout: 100 }),
    /disposed before settled\(\) was called/,
  );
});
