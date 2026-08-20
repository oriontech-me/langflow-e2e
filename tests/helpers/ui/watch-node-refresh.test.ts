// Unit tests for watchNodeRefresh (#1488).
// Run with: npm run test:units
//
// Why this helper is unit-tested: what it guarantees is a NEGATIVE — that no
// component refresh is in flight and none has landed for `quietMs` — and a
// watcher that releases too early is indistinguishable from a correct one on a
// green E2E run. The flake it removes only reproduces when a late refresh
// happens to land inside the table modal's edit window, so an E2E run cannot pin
// the boundary. These tests drive the timing directly instead.
//
// Timings are deliberately small (tens of ms) so the suite stays fast; the
// helper reads the real clock, so assertions are on ORDER and on generous lower
// bounds, never on exact durations.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import {
  COMPONENT_REFRESH_PATH,
  watchNodeRefresh,
} from "./watch-node-refresh";

type Handler = (event: { url(): string }) => void;
const REFRESH_URL = `http://localhost:7860${COMPONENT_REFRESH_PATH}`;

/** A Page stand-in exposing only what the helper touches. */
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
  const emit = (event: string, url: string) => {
    for (const handler of handlers.get(event) ?? []) handler({ url: () => url });
  };
  return {
    page: page as unknown as Page,
    /** Total listeners still attached, across every event. */
    get listeners() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    request: (url = REFRESH_URL) => emit("request", url),
    finished: (url = REFRESH_URL) => emit("requestfinished", url),
    failed: (url = REFRESH_URL) => emit("requestfailed", url),
  };
}

test("releases once the refresh traffic has been quiet for quietMs", async () => {
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  const started = Date.now();

  await watch.untilQuiet({ quietMs: 120, timeout: 2000 });

  assert.ok(
    Date.now() - started >= 100,
    "must observe the quiet window rather than releasing immediately",
  );
  assert.equal(fake.listeners, 0, "every listener must be removed");
});

test("a refresh landing inside the window restarts it — the second round-trip of #1488", async () => {
  // Measured on 1.12.0.dev32: one method switch produces a request at +228 ms
  // (answered at +286 ms) and a SECOND at +565 ms, with no interaction between.
  // Waiting for the first response only is what let the second land inside the
  // open table modal.
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  const started = Date.now();
  setTimeout(() => {
    fake.request();
    fake.finished();
  }, 100);

  await watch.untilQuiet({ quietMs: 150, timeout: 4000 });

  const waited = Date.now() - started;
  assert.ok(
    waited >= 240,
    `must wait quietMs AFTER the late refresh (waited ${waited} ms, expected >= 240)`,
  );
});

test("does not report quiet while a refresh is still IN FLIGHT", async () => {
  // This is why the helper is a watcher attached BEFORE the interaction rather
  // than a wait called after it: the refresh is deferred (~336 ms after the
  // inspector-add click) and its duration is not bounded on a shared CI
  // container, so a response-only wait would let the window elapse over a
  // request that was issued and never answered — straight into the race.
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  fake.request(); // issued, never answered within the window

  await assert.rejects(
    () => watch.untilQuiet({ quietMs: 50, timeout: 250 }),
    (error: Error) => {
      assert.match(error.message, /1 request\(s\) in flight/);
      return true;
    },
  );
  assert.equal(fake.listeners, 0, "listeners must be removed on the throwing path");
});

test("an in-flight refresh that lands is waited out, then quiet is reported", async () => {
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  const started = Date.now();
  fake.request();
  setTimeout(() => fake.finished(), 120);

  await watch.untilQuiet({ quietMs: 100, timeout: 4000 });

  assert.ok(
    Date.now() - started >= 210,
    "the quiet window must start when the in-flight request settles",
  );
});

test("a FAILED refresh releases the wait — an aborted request must not wedge it", async () => {
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  fake.request();
  setTimeout(() => fake.failed(), 60);

  await watch.untilQuiet({ quietMs: 60, timeout: 3000 });
});

test("ignores traffic from any other endpoint", async () => {
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  const started = Date.now();
  // Flow autosaves and event polls fire constantly during these specs; if they
  // counted, the wait would block until its timeout on every call. The asset
  // path is the `url.includes("/build/")` trap, one directory over.
  const noise = setInterval(() => {
    fake.request("http://localhost:7860/api/v1/flows/abc");
    fake.request("http://localhost:7860/assets/api/v1/custom_component/update.js");
    fake.finished("http://localhost:7860/api/v1/flows/abc");
    fake.finished("http://localhost:7860/assets/api/v1/custom_component/update.js");
  }, 20);

  try {
    await watch.untilQuiet({ quietMs: 120, timeout: 2000 });
  } finally {
    clearInterval(noise);
  }

  assert.ok(
    Date.now() - started < 1000,
    "unrelated traffic must not extend the wait",
  );
});

test("throws naming the endpoint when the traffic never goes quiet", async () => {
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  const noise = setInterval(() => {
    fake.request();
    fake.finished();
  }, 20);

  try {
    await assert.rejects(
      () => watch.untilQuiet({ quietMs: 200, timeout: 300 }),
      (error: Error) => {
        assert.match(error.message, /custom_component\/update/);
        assert.match(error.message, /never stopped re-rendering/);
        return true;
      },
    );
  } finally {
    clearInterval(noise);
  }

  assert.equal(fake.listeners, 0, "every listener must be removed");
});
