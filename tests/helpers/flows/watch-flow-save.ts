import type { Page, Request } from "@playwright/test";
import {
  describeAutosaveInterval,
  saveScheduledDeadlineMs,
} from "./autosave-interval";

/** A flow autosave is a `PATCH` on this path prefix. */
const FLOWS_PATH_PREFIX = "/api/v1/flows/";

/**
 * Anchored on the PATHNAME, never on a substring of the whole URL — the repo has
 * been bitten by `url.includes("/build/")` matching `/assets/build/index.js`
 * (see `tests/fixtures/flow-error-policy.ts`).
 */
function isFlowSave(req: Request): boolean {
  if (req.method() !== "PATCH") return false;
  try {
    return new URL(req.url()).pathname.startsWith(FLOWS_PATH_PREFIX);
  } catch {
    return false;
  }
}

export interface FlowSaveWatch {
  /**
   * Resolve once a save that started AFTER this watch was armed has completed.
   *
   * Throws if none was ever issued by `timeout`. That is the whole point of the
   * primitive: "no save appeared" is the state `waitForFlowSaveSettled` reports
   * as success, and it is indistinguishable from a persisted edit on a green
   * run (#1741).
   *
   * **Single-use**, for the reason its sibling `watchNodeRefresh` is: the
   * listeners are detached on the way out, so a second call could never observe
   * a request and would resolve on a save it did not see.
   */
  settled(opts?: { timeout?: number }): Promise<void>;
  /**
   * Detach without waiting. Only needed on the abort path — if the edit between
   * `watchFlowSave(page)` and `settled()` throws, the listeners would otherwise
   * outlive the step. Idempotent, and safe after `settled()`.
   */
  dispose(): void;
}

/**
 * Watch for the autosave an edit is about to schedule.
 *
 * Arm it BEFORE the edit, await it after:
 *
 * ```ts
 * const save = watchFlowSave(page);
 * await field.fill("8");
 * await save.settled();
 * ```
 *
 * ## Why this exists next to `waitForFlowSaveSettled`
 *
 * They answer different questions, and only one of them is the question most
 * callers have. `waitForFlowSaveSettled` DRAINS what is already in flight: it
 * arms a quiet window immediately, so when nothing has been issued yet it
 * returns after that window with no request ever tracked. Since the autosave is
 * scheduled one full debounce after the edit — 2000 ms on `1.13.0.dev4` against
 * that helper's 700 ms window — a barrier called right after an edit routinely
 * returns BEFORE the save exists (measured 3/3, with the database still holding
 * the pre-edit value at the moment it returned; #1741).
 *
 * That is correct behaviour for "let the editor go quiet" and wrong for "my edit
 * is persisted". This watcher answers the second: it observes the save being
 * issued and waits for it to complete, and it FAILS when none appears rather
 * than reporting a silence it cannot interpret (#1012).
 *
 * Use `waitForFlowSaveSettled` when you are draining traffic you did not cause;
 * use this when the next assertion depends on the edit having reached the
 * server — a reload, a navigation away, or an API read of the flow.
 */
export function watchFlowSave(page: Page): FlowSaveWatch {
  /**
   * The saves this watch actually OBSERVED start, by request identity.
   *
   * Identity, not a counter, and that is the whole correctness argument. A PATCH
   * already in flight when the watch was armed settles here too, and a counter
   * cannot tell it apart from the one the caller's edit triggered: an older save
   * finishing while the new one is still open would decrement the count to zero
   * and release the watch on a save that had not completed — the exact early
   * return this primitive exists to prevent, reintroduced inside it. Playwright
   * emits the same `Request` object on `request` and on
   * `requestfinished`/`requestfailed`, so membership answers it exactly:
   * unobserved settles are not in the set and are ignored.
   */
  const pending = new Set<Request>();
  let started = 0;
  let attached = true;

  const onRequest = (req: Request) => {
    if (!isFlowSave(req)) return;
    started++;
    pending.add(req);
  };
  const onSettled = (req: Request) => {
    // No `isFlowSave` test needed: only saves were ever added, and `delete`
    // reports whether this request was one of them.
    pending.delete(req);
  };

  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);

  const dispose = () => {
    if (!attached) return;
    attached = false;
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  };

  return {
    dispose,
    async settled({ timeout = saveScheduledDeadlineMs() } = {}) {
      if (!attached) {
        throw new Error(
          "watchFlowSave: settled() is single-use — arm a new watch per edit.",
        );
      }
      const deadline = Date.now() + timeout;
      try {
        while (Date.now() < deadline) {
          if (started > 0 && pending.size === 0) return;
          await page.waitForTimeout(50);
        }
        throw new Error(
          started === 0
            ? `watchFlowSave: no flow-save PATCH was issued within ${timeout} ms ` +
              `(${describeAutosaveInterval()}). The edit did not reach the server — ` +
              `it may not have marked the node dirty (a fill() on a controlled input ` +
              `does not), or the flow is read-only.`
            : `watchFlowSave: ${started} flow-save PATCH(es) issued but ${pending.size} ` +
              `still in flight after ${timeout} ms.`,
        );
      } finally {
        dispose();
      }
    },
  };
}
