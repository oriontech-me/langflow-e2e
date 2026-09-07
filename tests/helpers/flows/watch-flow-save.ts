import type { Page, Request } from "@playwright/test";
import {
  describeAutosaveInterval,
  SAVE_COMPLETION_BUDGET_MS,
  saveScheduledDeadlineMs,
} from "./autosave-interval";

/** A flow autosave is a `PATCH` on this path prefix. */
const FLOWS_PATH_PREFIX = "/api/v1/flows/";

/** Poll spacing. Each turn is a traced Playwright call, so it is not free. */
const POLL_INTERVAL_MS = 50;

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
  settled(opts?: {
    /**
     * Budget for the save to be ISSUED. Defaults to one debounce plus slack,
     * derived from the instance.
     */
    issueTimeout?: number;
    /**
     * Budget for an issued save to COMPLETE, on top of `issueTimeout`. Two
     * budgets rather than one because they fail for different reasons and the
     * error has to say which.
     */
    completionTimeout?: number;
  }): Promise<void>;
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
 *
 * ## Precondition: arm it from a quiescent editor
 *
 * This watch resolves on the first save it OBSERVES, and it cannot know which
 * mutation produced it. A save already SCHEDULED when it was armed — an earlier
 * interaction's pending debounce — is issued after arming and therefore counts,
 * even though it carries pre-edit state. The identity `Set` closes the
 * in-flight case; nothing closes the scheduled one from inside, because a
 * pending debounce is invisible until it fires.
 *
 * It matters most where the watcher is most useful: when the edit did NOT mark
 * the node dirty (a `fill()` on a controlled input does not), a prior pending
 * save satisfies the watch and the test passes instead of naming the cause.
 *
 * So arm it when the editor is quiet. After an earlier mutation, drain first
 * with a window longer than the debounce — `waitForFlowSaveSettled(page,
 * { quietMs: pendingSaveQuietMs() })`, which is exactly the window that helper's
 * 700 ms default is too short to be (#1741).
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
  // Separate from `attached` on purpose: conflating them reports a DISPOSED
  // watch as a re-used one, which is the wrong diagnosis on the documented abort
  // path (dispose() in a catch, then settled() awaited). The sibling
  // `watchNodeRefresh` keeps the same two flags for the same reason.
  let spent = false;

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
    async settled({
      issueTimeout = saveScheduledDeadlineMs(),
      completionTimeout = SAVE_COMPLETION_BUDGET_MS,
    } = {}) {
      if (spent) {
        throw new Error(
          "watchFlowSave: settled() is single-use — arm a new watch per edit.",
        );
      }
      if (!attached) {
        throw new Error(
          "watchFlowSave: this watch was disposed before settled() was called.",
        );
      }
      spent = true;
      const issueDeadline = Date.now() + issueTimeout;
      const overallDeadline = issueDeadline + completionTimeout;
      try {
        // The condition is tested BEFORE either deadline, every turn, which is
        // what keeps a save that completed during the last sleep from being
        // discarded — the loop would otherwise exit on the clock and throw
        // `1 issued but 0 still in flight`, a message that disproves itself.
        // Same ordering as the sibling `watchNodeRefresh`.
        for (;;) {
          if (started > 0 && pending.size === 0) return;
          const now = Date.now();
          if (started === 0 && now >= issueDeadline) {
            throw new Error(
              `watchFlowSave: no flow-save PATCH was issued within ${issueTimeout} ms ` +
                `(${describeAutosaveInterval()}). The edit did not reach the server — ` +
                `it may not have marked the node dirty (a fill() on a controlled input ` +
                `does not), the flow is read-only, or autosave is disabled on this ` +
                `instance.`,
            );
          }
          if (now >= overallDeadline) {
            throw new Error(
              `watchFlowSave: ${started} flow-save PATCH(es) issued but ${pending.size} ` +
                `still in flight ${completionTimeout} ms after the last one started.`,
            );
          }
          await page.waitForTimeout(POLL_INTERVAL_MS);
        }
      } finally {
        dispose();
      }
    },
  };
}
