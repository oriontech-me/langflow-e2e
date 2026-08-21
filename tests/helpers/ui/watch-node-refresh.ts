import type { Page, Request, Response } from "@playwright/test";

/** Pathname of the component-refresh endpoint a `real_time_refresh` edit posts to. */
export const COMPONENT_REFRESH_PATH = "/api/v1/custom_component/update";

/**
 * Anchored on the PATHNAME, never on a substring of the whole URL — the repo has
 * been bitten by `url.includes("/build/")` matching `/assets/build/index.js`
 * (see `tests/fixtures/flow-error-policy.ts`).
 */
function isComponentRefresh(url: string): boolean {
  try {
    return new URL(url).pathname === COMPONENT_REFRESH_PATH;
  } catch {
    return false;
  }
}

export interface NodeRefreshWatch {
  /**
   * Resolve once no component refresh is in flight AND none has been seen for
   * `quietMs`. Throws if the traffic is still going at `timeout`. Detaches its
   * listeners either way.
   *
   * **Single-use.** Detaching is what makes a second call unsafe: with no
   * listeners attached, `inFlight` can never rise and `lastActivityAt` is
   * already stale, so the second call would return on its first iteration and
   * report a quiet it never observed — the #1012 failure mode the timeout path
   * below refuses. It therefore throws instead. Wrap the interaction in a
   * `toPass()` retry and you need a fresh `watchNodeRefresh(page)` per attempt.
   */
  untilQuiet(opts?: { quietMs?: number; timeout?: number }): Promise<void>;
  /**
   * Detach the listeners without waiting. Only needed on the abort path: if the
   * interaction between `watchNodeRefresh(page)` and `untilQuiet()` throws, the
   * listeners would otherwise stay attached for the rest of the test. Idempotent,
   * and safe to call after `untilQuiet()` (which detaches on its own).
   */
  dispose(): void;
}

/**
 * Start watching the node's component-refresh traffic. Call this BEFORE the
 * interaction that triggers it, then `await watch.untilQuiet()` after.
 *
 * Touching a field the component declares `real_time_refresh` on — the API
 * Request `method` dropdown, or the inspector toggle that adds an advanced field
 * to the node body — posts `/api/v1/custom_component/update`. Two measured
 * properties of that traffic make "wait for the response" the wrong wait, and
 * each of them alone is enough to reopen the race:
 *
 *  - **One interaction produces more than one round-trip.** Timed on
 *    `1.12.0.dev32`, switching `method` to POST: request at +228 ms after the
 *    click, answered at +286 ms — then a SECOND request at +565 ms, answered at
 *    +610 ms, with no further interaction in between. A test awaiting the first
 *    response resumes at +286 ms and has ~280 ms before the node re-renders
 *    again.
 *  - **The round-trip is deferred, and its duration is not bounded.** The
 *    refresh for the `inspector-add-<field>` click starts ~336 ms AFTER the
 *    click, and an update answered in ~100 ms on an idle box says nothing about
 *    a shared CI container.
 *
 * Either way, a refresh landing while a `TableInput` modal is open makes
 * `TableNodeComponent`'s `[value]` effect re-sync `tempValue` from the node and
 * DROP the row the test had just added. That is the mechanism behind
 * `api-request-component-regression`'s oldest table flake (#868) and behind
 * `parameters-panel-field-types`' table test flaking in the daily on 2026-07-20
 * / 07-21 / 07-27 / 08-04 — reproduced locally at 2 runs in 5 and root-caused on
 * #1488. In the api-request persistence test the same accident used to pass
 * GREEN: both cell edits then land on the default header row, which its
 * assertion cannot tell apart from the added one.
 *
 * Quiet therefore means BOTH: nothing in flight, and `quietMs` since the last
 * refresh activity of any kind. Counting responses would move the race to the
 * next build that emits one more; ignoring in-flight requests would let the
 * window elapse over a refresh already issued and not yet answered.
 *
 * **Why a watcher and not a plain wait:** a helper that attaches its listeners
 * only when it is called cannot see a request issued before that moment, so a
 * slow refresh already in flight is invisible to it and the window elapses right
 * over the thing it is waiting for. Attaching first is what makes the guarantee
 * true rather than likely.
 */
export function watchNodeRefresh(page: Page): NodeRefreshWatch {
  let inFlight = 0;
  let lastActivityAt = Date.now();

  const onRequest = (request: Request) => {
    if (!isComponentRefresh(request.url())) return;
    inFlight += 1;
    lastActivityAt = Date.now();
  };
  // `requestfailed` counts too: an aborted refresh (navigation, teardown) would
  // otherwise leave `inFlight` stuck above zero and turn the wait into a throw.
  const onSettled = (event: Request | Response) => {
    if (!isComponentRefresh(event.url())) return;
    inFlight = Math.max(0, inFlight - 1);
    lastActivityAt = Date.now();
  };

  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);

  let spent = false;
  const detach = () => {
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  };

  return {
    dispose: detach,
    async untilQuiet({ quietMs = 1500, timeout = 20000 } = {}) {
      // Refuse the second call rather than answering it wrongly: the listeners
      // are gone, so this one would see `inFlight === 0` and a stale
      // `lastActivityAt` and return at once, claiming a quiet it cannot have
      // observed (#1012).
      if (spent) {
        throw new Error(
          "watchNodeRefresh: untilQuiet() is single-use — its listeners are " +
            "detached once it settles, so a second call would report quiet it " +
            "never observed. Call watchNodeRefresh(page) again before the next " +
            "interaction.",
        );
      }
      spent = true;
      try {
        const deadline = Date.now() + timeout;
        for (;;) {
          const quietFor = Date.now() - lastActivityAt;
          if (inFlight === 0 && quietFor >= quietMs) return;
          if (Date.now() >= deadline) {
            // Never report quiet it did not observe (#1012): a caller that opens
            // the table modal anyway hits exactly the race this closes, and the
            // failure would surface as a dropped row somewhere else entirely.
            throw new Error(
              `watchNodeRefresh: ${COMPONENT_REFRESH_PATH} was still busy after ` +
                `${timeout} ms (${inFlight} request(s) in flight, last activity ` +
                `${quietFor} ms ago, needed ${quietMs} ms of quiet) — the node ` +
                `never stopped re-rendering.`,
            );
          }
          // The sleep is derived from the quiet window, so with a request in
          // flight past `quietMs` the remaining-window figure goes negative and
          // a bare `Math.max(1, …)` collapses the loop to 1 ms per turn — a
          // request in flight for 8 s measured 5655 iterations, and each one is
          // a traced Playwright call, so the very trace someone opens to
          // diagnose the throw is the one buried in them. Poll at a fixed 50 ms
          // whenever there is nothing to wait out but the in-flight request.
          const sleepMs =
            inFlight > 0 ? 50 : Math.min(100, Math.max(1, quietMs - quietFor));
          await page.waitForTimeout(sleepMs);
        }
      } finally {
        detach();
      }
    },
  };
}
