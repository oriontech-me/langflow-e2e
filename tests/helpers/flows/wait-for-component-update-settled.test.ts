// Unit tests for the node-update settle barrier (extracted for #1855).
// Run with: npm run test:units
//
// What rides on it: two specs act on a node right after actions that round-trip it
// through `custom_component/update`, and an action landing during one is silently
// lost (#1519, #1855). A barrier that resolves early gives that race back without a
// single red line of its own, so the timing rules are pinned here with fake timers
// rather than trusted to a browser run that only fails under load.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_UPDATE_PATH,
  isComponentUpdate,
  waitForComponentUpdateSettled,
  type UpdateSettlePage,
  type UpdateSettleRequest,
} from "./wait-for-component-update-settled";

type Listener = (request: UpdateSettleRequest) => void;

/** A page whose request events the test fires by hand, recording attached listeners. */
function fakePage() {
  const listeners = new Map<string, Set<Listener>>();
  const page: UpdateSettlePage = {
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return page;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return page;
    },
  } as UpdateSettlePage;
  const fire = (event: string, request: UpdateSettleRequest) => {
    for (const l of [...(listeners.get(event) ?? [])]) l(request);
  };
  const attached = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { page, fire, attached };
}

const request = (method: string, url: string): UpdateSettleRequest => ({
  method: () => method,
  url: () => url,
});

const UPDATE = request("POST", `http://localhost:7860${COMPONENT_UPDATE_PATH}?flow_id=abc`);
const AUTOSAVE = request("PATCH", "http://localhost:7860/api/v1/flows/abc");

/** Resolution state of a promise, readable synchronously after the microtask queue drains. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

const flush = () => new Promise((r) => setImmediate(r));

test("matches the update endpoint by pathname, with or without a query string", () => {
  assert.equal(isComponentUpdate(UPDATE), true);
  assert.equal(isComponentUpdate(request("POST", `http://x${COMPONENT_UPDATE_PATH}`)), true);
  assert.equal(isComponentUpdate(request("GET", `http://x${COMPONENT_UPDATE_PATH}`)), false);
  assert.equal(isComponentUpdate(AUTOSAVE), false);
  assert.equal(isComponentUpdate(request("POST", "not a url")), false);
});

test("resolves true after the quiet window when nothing is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, attached } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 700, timeout: 15_000 }));

  t.mock.timers.tick(699);
  await flush();
  assert.equal(state.done, false, "must not resolve before the quiet window ends");

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(state, { done: true, value: true });
  assert.equal(attached(), 0, "listeners are detached once settled");
});

test("an update in flight holds the barrier until it finishes and the window passes again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 700, timeout: 15_000 }));

  t.mock.timers.tick(300);
  fire("request", UPDATE);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(state.done, false, "an open update must hold the barrier indefinitely below the cap");

  fire("requestfinished", UPDATE);
  t.mock.timers.tick(699);
  await flush();
  assert.equal(state.done, false, "the quiet window restarts from the finish, not from the attach");

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(state, { done: true, value: true });
});

test("a failed update counts as finished", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 100, timeout: 15_000 }));

  fire("request", UPDATE);
  fire("requestfailed", UPDATE);
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(state, { done: true, value: true });
});

test("two overlapping updates both have to finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 100, timeout: 15_000 }));

  fire("request", UPDATE);
  fire("request", UPDATE);
  fire("requestfinished", UPDATE);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(state.done, false, "one of two open updates is still in flight");

  fire("requestfinished", UPDATE);
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(state, { done: true, value: true });
});

test("other requests neither hold nor release the barrier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 100, timeout: 15_000 }));

  fire("request", UPDATE);
  fire("request", AUTOSAVE);
  fire("requestfinished", AUTOSAVE);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(state.done, false, "an autosave finishing must not release an open update");
});

test("an update already open at attach re-arms the window when it finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 700, timeout: 15_000 }));

  // Its `request` event happened before the attach; only the finish is seen.
  t.mock.timers.tick(500);
  fire("requestfinished", UPDATE);
  t.mock.timers.tick(699);
  await flush();
  assert.equal(state.done, false, "the finish must restart the quiet window");

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(state, { done: true, value: true });
});

test("resolves false at the cap when updates never settle, and detaches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, fire, attached } = fakePage();
  const state = track(waitForComponentUpdateSettled(page, { quietMs: 700, timeout: 2_000 }));

  fire("request", UPDATE);
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(state, { done: true, value: false });
  assert.equal(attached(), 0, "listeners are detached at the cap too");
});
