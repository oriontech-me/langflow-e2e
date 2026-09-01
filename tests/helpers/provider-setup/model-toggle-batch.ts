import type { Page } from "@playwright/test";

/**
 * Enabling a provider's models is a TRANSACTION, and the panel must not be closed
 * on top of it (#1649).
 *
 * The three provider-setup helpers used to carry the same loop — click every
 * unchecked `:visible` toggle, then immediately click Close. That is not a slow
 * test being impatient; it selects a different code path in the product. Every
 * toggle feeds `useModelToggleQueue`, which applies an optimistic cache update and
 * batches the write behind a **1000 ms debounce**, and the batch can leave through
 * either of two paths:
 *
 *   debounced flush (`flushModelToggles`)   1000 ms after the last toggle
 *       -> onSettled: invalidateQueries AND refreshAllModelInputs  -> picker updates
 *   close-path flush (`flushPendingChanges`)  on the modal's Close
 *       -> invalidateQueries only; handleClose's own refreshAllModelInputs runs
 *          AFTER onClose already unmounted the modal                -> picker does NOT
 *
 * So closing inside the debounce window leaves the picker rendering the PRE-toggle
 * enabled set — on a freshly configured provider that is the `MIN_DEFAULT_MODELS`
 * default of five — and the picker read that follows correctly reports the
 * disagreement as `MODEL_PICKER_DEFECT`. Measured on 1.12.0.dev44, one clean
 * container, three runs differing ONLY in the pause before Close, with the server
 * reporting `enabled=41` in all three:
 *
 *   pause before Close   model_model visible after   picker offers
 *   0 ms                 4 327 ms                    5    <- the daily's failure
 *   1 200 ms             30 020 ms                   35
 *   2 000 ms             29 640 ms                   35
 *
 * A person cannot close a dialog under a second after their last click, which is
 * why this never reproduced by hand and reproduced every time from the suite.
 *
 * ## Why quiescence and not a simpler wait
 *
 * Two narrower conditions were measured and rejected:
 *
 *   - `waitForResponse` on the toggle POST **races**. A slow loop lets the debounce
 *     fire mid-loop, so the write is often already sent before the wait is armed:
 *     measured returning `landed=false` while the write had in fact landed. It also
 *     cannot tell the FIRST batch from the LAST one.
 *   - polling `GET /models/enabled_models` **stalls the backend** that is busy with
 *     the very write being waited on: measured `apiRequestContext.get: Timeout
 *     20000ms exceeded` against a single-worker instance.
 *
 * What is left is quiescence over the product's own writes, observed passively:
 * at least one write answered, and quiet on BOTH clocks — no click and no new
 * write for longer than the debounce.
 */

/** What the listeners saw while the toggles were being clicked. */
export type ToggleBatchObservation = {
  /** Toggles this loop actually clicked. Zero means there is no batch. */
  clicked: number;
  /** `Date.now()` of the last click, or null when nothing was clicked. */
  lastClickAt: number | null;
  /** `POST /models/enabled_models` requests observed starting. */
  postsStarted: number;
  /** …and answering (success or failure — either settles the mutation). */
  postsFinished: number;
  /** `Date.now()` of the most recent POST start, or null. */
  lastPostStartedAt: number | null;
};

export type FlushVerdict =
  | { kind: "nothing-to-flush" }
  | { kind: "settled" }
  | { kind: "waiting"; reason: string }
  | { kind: "gave-up"; message: string };

export type FlushOptions = {
  /** Quiet period required on both clocks. Must exceed the product's 1000 ms. */
  quietMs: number;
  /** `Date.now()` past which the wait reports `gave-up`. */
  deadlineAt: number;
};

/**
 * Decides whether the toggle batch has left through the debounced path.
 *
 * PURE — no page, no clock — so every branch is reachable from a unit test, the
 * same reason `resolveModelOption` and `censusForTarget` are pure. The ordering is
 * load-bearing: `nothing-to-flush` is checked FIRST and outranks the deadline,
 * because an unchanged panel is not a timeout and must not print one on every
 * healthy run.
 */
export function flushVerdict(
  observation: ToggleBatchObservation,
  now: number,
  options: FlushOptions,
): FlushVerdict {
  const { clicked, lastClickAt, postsStarted, postsFinished, lastPostStartedAt } = observation;

  if (clicked === 0) return { kind: "nothing-to-flush" };

  const expired = now > options.deadlineAt;
  const giveUp = (): FlushVerdict => ({
    kind: "gave-up",
    message:
      `provider panel: the model-toggle batch did not settle in time — ` +
      `${clicked} toggle(s) clicked, ${postsStarted} write(s) started, ` +
      `${postsFinished} finished. Closing the panel now takes the flush path that ` +
      `does NOT refresh the model picker, so the picker may still show the ` +
      `pre-toggle set. Not failing here: the picker read that follows is the real ` +
      `gate and names the disagreement itself (#1649).`,
  });

  if (lastClickAt !== null && now - lastClickAt < options.quietMs) {
    return expired
      ? giveUp()
      : { kind: "waiting", reason: "the 1000 ms toggle debounce window is still open" };
  }

  if (postsStarted === 0) {
    return expired
      ? giveUp()
      : { kind: "waiting", reason: "no write has been issued yet — the queue has not fired" };
  }

  if (postsFinished < postsStarted) {
    return expired ? giveUp() : { kind: "waiting", reason: "a write is still in flight" };
  }

  if (lastPostStartedAt !== null && now - lastPostStartedAt < options.quietMs) {
    return expired
      ? giveUp()
      : { kind: "waiting", reason: "not quiet yet — a follow-up batch may still be queued" };
  }

  return { kind: "settled" };
}

/** What one pass over the open provider panel's model toggles did. */
export type ToggleBatchResult = {
  /** `:visible` toggles found (the collapsed deprecated section is excluded). */
  visible: number;
  /** How many were clicked because `aria-checked` was not "true". */
  clicked: number;
  /** How many report `aria-checked="true"` after the pass. */
  checked: number;
  /** How the flush ended — `gave-up` is logged, never thrown. */
  verdict: FlushVerdict["kind"];
};

/**
 * Enables every visible model toggle in the OPEN provider panel, then waits for
 * the product's own write to settle so the caller can close the panel safely.
 *
 * The `:visible` filter excludes the toggles inside the collapsed "deprecated
 * models" disclosure: they are in the DOM but not displayed, and `.click()` on one
 * retry-loops to a timeout.
 *
 * The wait runs ONLY when something was clicked, so the common path — a provider
 * `Collect models` already enabled, where the loop clicks nothing — pays nothing.
 */
export async function enableAndSettleModelToggles(
  page: Page,
  options: { quietMs?: number; timeoutMs?: number } = {},
): Promise<ToggleBatchResult> {
  const quietMs = options.quietMs ?? 1500;
  // 90 s, because the write itself is slow on the single-worker instances the
  // lanes run: measured 36 toggles producing one POST that had not answered 30 s
  // later on a local `LANGFLOW_WORKERS=1` container. The budget is NOT additive
  // with the caller's `model_model` wait — it is the same wall clock, paid here
  // where the give-up message can name what it saw instead of there where a
  // visibility timeout cannot. Waiting for the write to ANSWER (not merely to be
  // issued) is what proves the mutation settled while the modal was still
  // mounted, which is where `onSettled` -> `refreshAllModelInputs` runs (#1649).
  const timeoutMs = options.timeoutMs ?? 90000;

  const observation: ToggleBatchObservation = {
    clicked: 0,
    lastClickAt: null,
    postsStarted: 0,
    postsFinished: 0,
    lastPostStartedAt: null,
  };

  const isToggleWrite = (url: string, method: string): boolean =>
    method === "POST" && url.includes("/models/enabled_models");
  const onRequest = (r: { url(): string; method(): string }) => {
    if (isToggleWrite(r.url(), r.method())) {
      observation.postsStarted += 1;
      observation.lastPostStartedAt = Date.now();
    }
  };
  const onFinished = (r: { url(): string; method(): string }) => {
    if (isToggleWrite(r.url(), r.method())) observation.postsFinished += 1;
  };
  // `requestfailed` counts too: an aborted write settles the mutation just as a
  // 200 does, and not counting it would hold the wait open to its deadline.
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFinished);

  try {
    const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
    await toggles.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const visible = await toggles.count();

    for (let i = 0; i < visible; i++) {
      const toggle = toggles.nth(i);
      if ((await toggle.getAttribute("aria-checked")) !== "true") {
        await toggle.click();
        observation.clicked += 1;
        observation.lastClickAt = Date.now();
      }
    }

    const deadlineAt = Date.now() + timeoutMs;
    let verdict = flushVerdict(observation, Date.now(), { quietMs, deadlineAt });
    while (verdict.kind === "waiting") {
      await page.waitForTimeout(250);
      verdict = flushVerdict(observation, Date.now(), { quietMs, deadlineAt });
    }
    if (verdict.kind === "gave-up") console.warn(`⚠️  ${verdict.message}`);

    const checked = await page
      .locator('[data-testid^="llm-toggle"]:visible[aria-checked="true"]')
      .count();
    return { visible, clicked: observation.clicked, checked, verdict: verdict.kind };
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFinished);
  }
}
