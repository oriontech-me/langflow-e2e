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
  /** Every `waitForTimeout` the helper asked for, in order. */
  const sleeps: number[] = [];
  const page = {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    async waitForTimeout(ms: number) {
      sleeps.push(ms);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
  const emit = (event: string, url: string) => {
    for (const handler of handlers.get(event) ?? []) handler({ url: () => url });
  };
  return {
    page: page as unknown as Page,
    /**
     * Every `page.waitForTimeout` the helper issued. In the E2E context each one
     * is a traced Playwright call, so the count is what makes the poll rate an
     * assertable property rather than a comment.
     */
    sleeps,
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

test("polls at a floor instead of spinning while a refresh is in flight", async () => {
  // The sleep is derived from the REMAINING quiet window, which goes negative
  // once `quietFor` passes `quietMs` with a request still in flight — the
  // `inFlight === 0` conjunct correctly blocks the return, so without a floor
  // the loop turns over every 1 ms. Measured at 5655 iterations for a request
  // in flight for 8 s, each one a traced Playwright call landing in the trace
  // someone opens to diagnose the throw.
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  fake.request(); // in flight for the whole window, never answered

  await assert.rejects(() =>
    watch.untilQuiet({ quietMs: 20, timeout: 400 }),
  );

  // 400 ms at the 50 ms floor is ~8 turns; at 1 ms it would be in the hundreds.
  assert.ok(
    fake.sleeps.length <= 40,
    `must not spin while in flight (issued ${fake.sleeps.length} sleeps, expected <= 40)`,
  );
  assert.ok(
    fake.sleeps.every((ms) => ms >= 20),
    `every sleep must respect the floor (got ${JSON.stringify(fake.sleeps)})`,
  );
});

test("a second untilQuiet() throws instead of reporting a quiet it cannot observe", async () => {
  // The listeners are detached once the first call settles, so a second one
  // would find `inFlight === 0` and a stale `lastActivityAt` and return on its
  // first iteration — indistinguishable from an observed quiet, and the exact
  // #1012 failure mode the timeout path refuses. The way in is a caller wrapping
  // interaction + settle in `expect(async () => {…}).toPass()`.
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  await watch.untilQuiet({ quietMs: 20, timeout: 1000 });

  const started = Date.now();
  await assert.rejects(
    () => watch.untilQuiet({ quietMs: 5000, timeout: 1000 }),
    (error: Error) => {
      assert.match(error.message, /single-use/);
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 500,
    "the refusal must be immediate, not a timeout",
  );
});

test("dispose() detaches the listeners on the abort path", async () => {
  // If the interaction between `watchNodeRefresh(page)` and `untilQuiet()`
  // throws, nothing else would ever remove these three listeners.
  const fake = fakePage();
  const watch = watchNodeRefresh(fake.page);
  assert.equal(fake.listeners, 3, "three listeners attach up front");

  watch.dispose();
  assert.equal(fake.listeners, 0, "dispose() must remove all of them");
  watch.dispose();
  assert.equal(fake.listeners, 0, "dispose() must be idempotent");
});
