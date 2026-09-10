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
 *
 * ## Why the batch enables ONE model and not the whole panel (#1679)
 *
 * The loop used to click every unchecked `:visible` toggle — 29 to 31 of them for
 * Google, more for OpenAI — and that write is not merely slow: it takes the
 * instance down and then persists nothing. `POST /api/v1/models/enabled_models` is
 * an `async def` handler that calls `validate_model_provider_key` once PER enabled
 * update, synchronously, and that function ends in `llm.invoke("test")` — a
 * blocking provider round trip on the event loop of the single uvicorn worker the
 * lanes pin (`LANGFLOW_WORKERS=1`). Nothing else on that instance runs while it
 * does, including uvicorn's `callback_notify`, which is gunicorn's heartbeat.
 *
 * Measured on 1.13.0.dev8, one idle container, `LANGFLOW_WORKERS=1`,
 * `LANGFLOW_WORKER_TIMEOUT=120`, `/health_check` probed at 1 Hz with a 3 s client
 * timeout, the batch issued exactly as the panel's debounced queue issues it (one
 * request carrying every toggle):
 *
 *   enable batch   result                                    /health_check
 *   1 model        HTTP 200 in 0.86 s                        never down (the one
 *                                                            overlapping probe
 *                                                            answered in 0.796 s
 *                                                            against 0.018 s idle)
 *   29 models      NEVER ANSWERED — the connection closed    26 consecutive probes
 *                  at 93.2 s (3.21 s/model)                  DOWN over 97 s, from
 *                                                            the first probe after
 *                                                            the write to +99.3 s
 *
 * The container log names the last link: `WORKER TIMEOUT (pid:12)` →
 * `Worker (pid:12) was sent SIGKILL! Perhaps out of memory?` (gunicorn's stock
 * guess — the worker was not out of memory, its loop was blocked) → a new worker,
 * with `/health_check` back at +100.7 s. So the direction of causation is measured,
 * not inferred: the outage starts with the write and ends with the worker restart,
 * and `1 write(s) started, 0 finished` is the write being killed mid-flight.
 *
 * Two further measurements decide the shape of the fix rather than its size:
 *
 *   - after the kill, `GET /models/enabled_models` still reported exactly the
 *     `MIN_DEFAULT_MODELS` five. `_update_model_sets` runs AFTER the validation
 *     loop, so a killed batch persists NOTHING — the sweep is not a slow success
 *     that later specs ride for free, it is a guaranteed failure every spec on that
 *     instance re-pays in full;
 *   - `gemini-flash-latest`, which `resolveGeminiModel` prefers FIRST, is one of
 *     Google's five `default: true` models and is therefore enabled server-side the
 *     moment the credential exists. Not one of the 29 clicks was the model the
 *     failing specs went on to select.
 *
 * So the panel does not need every model enabled; it needs the ONE model this
 * setup is about to pick, and usually not even that. {@link planToggleTargets}
 * decides which, and the quiescence wait above survives the narrower write
 * unchanged — one click still batches behind the same 1000 ms debounce and still
 * has to leave through the flush path that refreshes the picker.
 *
 * This is the spec-side half of the decision #1666 carried into `collect-models`
 * (`ensureTargetModelsEnabled`: "the one model per active provider that the key
 * axis settled on, which is all any spec picks").
 */

/**
 * Which toggles a setup actually needs to click, and why.
 *
 * `reason` is not decoration: with the sweep gone, an EMPTY plan is the common
 * outcome, and "clicked nothing" has four causes that a run has to be able to tell
 * apart — the model was already on, the panel does not list it, no model was
 * pinned and an acceptable one is already on, or nothing acceptable is listed at
 * all. Only the first two are healthy, and a count cannot distinguish them (#1012).
 */
export type TogglePlan = {
  /**
   * Model ids whose toggle must be clicked. At most one by construction — a
   * provider setup picks exactly one model — but kept a list so the click loop and
   * the give-up accounting stay indifferent to that.
   */
  toClick: string[];
  /** One line for the log and for the give-up message: what was decided, and why. */
  reason: string;
};

export type TogglePlanInput = {
  /**
   * Every `llm-toggle-<model>` id the panel RENDERED, whatever its state — what
   * `enumerateEnabledModels` returns. Deliberately not `:visible`-filtered, for the
   * reason that helper documents; the click step is where a collapsed toggle is
   * handled, because "not rendered" and "rendered inside the deprecated disclosure"
   * are different facts and only the first one is an absence.
   */
  listed: string[];
  /** The subset whose toggle already reads ON — `enumerateCheckedModels`. */
  checked: string[];
  /** The model the caller pinned, when it pinned one. */
  requested?: string;
  /**
   * Ordered acceptance predicates for the case where no pinned model resolves —
   * the caller's own model preference, applied to the LOWERCASED model id.
   *
   * It exists because "enable nothing and let the picker's defaults do" is wrong
   * for OpenAI: measured on 1.13.0.dev8, its five `default: true` models are
   * `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6`, `gpt-5.6-terra` —
   * none of which `setup-openai`'s ranking accepts, so its first-available
   * fallback would hand a vision spec a frontier model where it used to get
   * `gpt-4o-mini`. Google's and Anthropic's defaults are all `gemini`/`claude`, so
   * for those two the ladder is satisfied by the defaults and clicks nothing.
   */
  acceptable?: Array<(model: string) => boolean>;
};

/**
 * Decides which toggles to click so the caller's model ends up enabled.
 *
 * PURE — the same reason {@link flushVerdict} is: the interesting branches are
 * decided by panel state a spec cannot produce on demand (a model listed but
 * absent from the defaults, a pin the catalog retired), and every one of them is
 * reachable from a unit test here.
 *
 * The ladder runs whenever the pin does not resolve, `requested` absent or listed
 * or not: `setup-openai`'s `fallbackToRanking` consumers (#606) pass a pin from
 * `models.json` that can be stale, and a stale pin must degrade to the caller's
 * preference — which is what the whole-panel sweep did by accident, and what
 * enabling nothing would quietly stop doing.
 */
export function planToggleTargets(input: TogglePlanInput): TogglePlan {
  const { listed, checked, requested, acceptable } = input;
  const onCount = `${checked.length} of ${listed.length} listed model(s) already enabled`;

  if (requested !== undefined && requested !== "") {
    if (checked.includes(requested)) {
      return {
        toClick: [],
        reason: `"${requested}" is already enabled — no write needed (${onCount})`,
      };
    }
    if (listed.includes(requested)) {
      return {
        toClick: [requested],
        reason: `enabling ONLY "${requested}", the model this setup targets (${onCount})`,
      };
    }
  }

  const pin =
    requested === undefined || requested === ""
      ? "no model was pinned"
      : `the panel does not list the pinned "${requested}"`;

  if (acceptable === undefined || acceptable.length === 0) {
    return {
      toClick: [],
      reason: `${pin} and no preference was given — the panel is left as it is (${onCount})`,
    };
  }

  for (const [index, accepts] of acceptable.entries()) {
    const rank = `preference ${index + 1} of ${acceptable.length}`;
    const already = checked.find((model) => accepts(model.toLowerCase()));
    if (already !== undefined) {
      return {
        toClick: [],
        reason: `${pin}; "${already}" is already enabled and matches ${rank} — no write needed`,
      };
    }
    const candidate = listed.find((model) => accepts(model.toLowerCase()));
    if (candidate !== undefined) {
      return {
        toClick: [candidate],
        reason: `${pin}; enabling ONLY "${candidate}", the first listed model matching ${rank}`,
      };
    }
  }

  return {
    toClick: [],
    reason:
      `${pin} and none of the ${listed.length} listed model(s) matches any of the ` +
      `${acceptable.length} preference(s) — the panel is left as it is, and the caller's ` +
      `own picker ranking decides`,
  };
}

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
      `pre-toggle set. Not failing here: the read that follows is the real gate, and ` +
      `it attributes the failure to THIS write — MODEL_TOGGLE_WRITE_STALLED — rather ` +
      `than to the picker (#1649).`,
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
  /** What {@link planToggleTargets} asked this pass to enable. */
  planned: string[];
  /**
   * Planned models whose toggle is in the DOM but not displayed — the collapsed
   * "deprecated models" disclosure. Not clicked (`.click()` on one retry-loops to a
   * timeout) and never silent: the picker read that follows reports the model as
   * not enabled, and this is the only place that says why.
   */
  hidden: string[];
  /** How many were clicked because `aria-checked` was not "true". */
  clicked: number;
  /** How many report `aria-checked="true"` after the pass. */
  checked: number;
  /** How the flush ended — `gave-up` is logged, never thrown. */
  verdict: FlushVerdict["kind"];
  /** `POST /models/enabled_models` requests seen starting during the pass. */
  writesStarted: number;
  /** …and answering. `started > finished` on a give-up is THE stall signature. */
  writesFinished: number;
};

/**
 * The subset a caller must carry forward so a later failure can name this batch.
 *
 * Deliberately narrow: `visible`/`checked` describe the panel, and the panel is
 * the source that LIES under a stall (`aria-checked` is the optimistic cache).
 */
export type ToggleBatchOutcome = Pick<
  ToggleBatchResult,
  "clicked" | "verdict" | "writesStarted" | "writesFinished"
>;

/**
 * Prefixed `MODEL_` like its four siblings in `model-option.ts`, and deliberately
 * NOT `MODEL_NOT_AVAILABLE`: every caller turns that prefix into a `test.skip`,
 * and an instance that cannot accept a write must never be reported as a model
 * the product does not have.
 */
export const MODEL_TOGGLE_WRITE_STALLED = "MODEL_TOGGLE_WRITE_STALLED";

/**
 * Why a later failure is this batch's fault rather than the picker's — or `null`
 * when this batch cannot explain anything.
 *
 * PURE, for the same reason `flushVerdict` is. It exists because #1651's gate
 * already OBSERVED the cause and printed it, and then dropped it: 90 s later the
 * picker read failed naming two hypotheses nobody had measured ("the picker did
 * not refresh, or the option list is filtered"), while the measured cause — the
 * write was issued and never answered — sat in a log line no failure message, no
 * `error_signature` and no triage dataset correlates. That is why #1649 was
 * verdicted twice and reopened.
 *
 * Three properties are load-bearing, each pinned by a unit test:
 *
 *   - an UNOBSERVED batch (`undefined`) yields `null` — a source nobody read must
 *     never be reported as a negative one (#1012);
 *   - a SETTLED batch yields `null`, which is what keeps `MODEL_PICKER_DEFECT`
 *     alive for the genuine, unexplained disagreement #1461 wrote it for;
 *   - a panel nobody changed yields `null`, so a healthy run can never print an
 *     instance-stall verdict.
 */
export function writeStallReason(batch?: ToggleBatchOutcome): string | null {
  if (!batch) return null;
  if (batch.verdict !== "gave-up") return null;
  if (batch.clicked === 0) return null;
  return (
    `the enable write never answered — ${batch.clicked} toggle(s) clicked, ` +
    `${batch.writesStarted} write(s) started, ${batch.writesFinished} finished before the ` +
    `flush budget expired, so POST /api/v1/models/enabled_models did not land`
  );
}

/**
 * The message for a `model_model` trigger that never became usable after the
 * panel closed on a stalled batch — or `null` when the batch cannot explain it.
 *
 * Two of #1649's six occurrences were exactly this, 60 s each
 * (`locator.waitFor: Timeout 60000ms exceeded ... getByTestId('model_model')`),
 * with nothing in the message naming a cause. The post-close refresh runs in the
 * batch's own `onSettled`, which never fired — so a trigger that never returns is
 * the same instance stall, not a trigger or testid defect. `original` is kept
 * verbatim: a re-labelled failure that discards Playwright's own call log is
 * harder to triage, not easier.
 */
export function modelTriggerStallMessage(
  batch: ToggleBatchOutcome | undefined,
  context: { providerLabel: string; original: string },
): string | null {
  const reason = writeStallReason(batch);
  if (reason === null) return null;
  return (
    `${MODEL_TOGGLE_WRITE_STALLED}: the model picker's trigger never became usable after ` +
    `the provider panel closed for ${context.providerLabel} — ${reason}. The panel's ` +
    `post-close refresh runs in that write's own onSettled, which never fired, so this is ` +
    `an INSTANCE stall — not a picker defect, not a missing testid and not a model that is ` +
    `gone. Do not raise this budget to make it pass (#1649). Original error: ` +
    `${context.original}`
  );
}

/**
 * Waits for the open provider panel to have rendered its model toggles, and
 * reports how many are displayed.
 *
 * Exported because the PLAN has to be built from the panel's own state, which means
 * enumerating the toggles before {@link enableAndSettleModelToggles} runs — and an
 * enumeration that races the panel's fetch returns `[]`, which the planner would
 * read as "the panel lists nothing" and answer with an empty plan. That is the
 * unobserved-source-read-as-negative failure #1012 is about, so the wait comes
 * first and is shared rather than duplicated per caller.
 *
 * Never throws: a panel with no toggles at all is a real state (an unconfigured
 * provider, a rejected key), and the picker read at the end of the setup is the
 * gate that reports it with evidence.
 */
export async function waitForModelToggles(page: Page, timeoutMs = 15000): Promise<number> {
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
  await toggles
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => {});
  return toggles.count();
}

/**
 * Enables the models the caller's {@link TogglePlan} asks for in the OPEN provider
 * panel, then waits for the product's own write to settle so the caller can close
 * the panel safely.
 *
 * It clicks the PLAN and nothing else. Enabling the whole panel here is what #1679
 * measured taking the instance down — see the per-model validation cost in this
 * file's header — and the plan is normally empty or one model.
 *
 * The wait runs ONLY when something was clicked, so an empty plan — the common
 * path, since the model a setup targets is usually one of the provider's five
 * `default: true` models — pays nothing.
 */
export async function enableAndSettleModelToggles(
  page: Page,
  options: { plan: TogglePlan; quietMs?: number; timeoutMs?: number },
): Promise<ToggleBatchResult> {
  const quietMs = options.quietMs ?? 1500;
  // 90 s, unchanged, and now a backstop rather than the mechanism: a one-model
  // write answers in 0.86 s (#1679). It stays because a saturated instance is
  // something the suite must keep reporting, and because the give-up message is
  // where a stall gets named. The budget is NOT additive
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

  const planned = options.plan.toClick;
  const hidden: string[] = [];

  try {
    const visible = await waitForModelToggles(page);

    for (const model of planned) {
      // Addressed by its own testid, not by index into the `:visible` list: the
      // plan names models, and resolving one by position would depend on the
      // panel's ordering, which is the catalog's and moves per build.
      const toggle = page.getByTestId(`llm-toggle-${model}`);
      if (!(await toggle.isVisible().catch(() => false))) {
        hidden.push(model);
        continue;
      }
      if ((await toggle.getAttribute("aria-checked")) !== "true") {
        await toggle.click();
        observation.clicked += 1;
        observation.lastClickAt = Date.now();
      }
    }

    if (hidden.length > 0) {
      // Warned rather than thrown: a deprecated model cannot be enabled at all
      // (`POST /models/enabled_models` answers `400 Cannot enable deprecated
      // model`), so failing here would replace a verdict the picker read states
      // with evidence by one stated from the panel alone.
      console.warn(
        `⚠️  provider panel: ${hidden.join(", ")} is listed but its toggle is not displayed — ` +
          `it sits in the collapsed "deprecated models" disclosure, so it was NOT clicked. ` +
          `The picker read below is what decides what that costs (#1679).`,
      );
    }

    const deadlineAt = Date.now() + timeoutMs;
    let verdict = flushVerdict(observation, Date.now(), { quietMs, deadlineAt });
    while (verdict.kind === "waiting") {
      await page.waitForTimeout(250);
      verdict = flushVerdict(observation, Date.now(), { quietMs, deadlineAt });
    }
    if (verdict.kind === "gave-up") {
      // The plan's reason is printed WITH the give-up: a stall on a one-model write
      // and a stall on a plan that clicked nothing are different failures, and the
      // give-up counters alone no longer say which (#1679).
      console.warn(`⚠️  ${verdict.message}`);
      console.warn(`⚠️  provider panel: the batch that stalled was — ${options.plan.reason}.`);
    }

    const checked = await page
      .locator('[data-testid^="llm-toggle"]:visible[aria-checked="true"]')
      .count();
    return {
      visible,
      planned,
      hidden,
      clicked: observation.clicked,
      checked,
      verdict: verdict.kind,
      // Returned, not merely printed: the give-up message already carried these
      // and the caller could not read them, which is the whole of #1649's reopen.
      writesStarted: observation.postsStarted,
      writesFinished: observation.postsFinished,
    };
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFinished);
  }
}
