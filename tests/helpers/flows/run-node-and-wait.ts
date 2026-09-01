import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Runs one node on the canvas and waits for a VERDICT — not for a badge.
 *
 * Why this exists (issue #1667). `node_duration_*` is an observable of a
 * SUCCESSFUL build, never of a run having finished. The running image renders it
 * inside a ternary: success yields `node_duration_<node>`, and every other build
 * status falls through to `node_status_icon_<node>_<status>`. A wait that gates
 * on the badge alone therefore cannot observe a failed run — it burns its whole
 * budget and reports `element(s) not found`, naming the badge instead of the
 * cause.
 *
 * That is precisely how `rag-pipeline.spec.ts` spent four dailies (2026-07-16,
 * 2026-07-22, 2026-08-18, 2026-09-01) reporting an unattributable 90 s timeout.
 * The real reason was on screen within ~1 s and in the run stream within ~16 s:
 * the account's Google Vertex project-wide per-minute quota
 * (`global_embed_content_requests_per_minute_per_base_model`, base model
 * `gemini-embedding`) answered the embedding call with 429 RESOURCE_EXHAUSTED.
 * Nothing failed the test on it, because the run is `POST /api/v2/workflows`,
 * whose flow-error verdict is ADVISORY by design (#1162 staging).
 *
 * **A failed run has TWO surfaces, and watching only one is how this defect
 * comes back.** Both measured on 1.12.0.dev44, and they are disjoint:
 *
 * | Run-stream shape         | `Flow build failed` banner | `node_status_icon_*_error` |
 * |--------------------------|----------------------------|----------------------------|
 * | `event_type=error` (429) | visible, ~1 s              | renders `_undefined`, hidden |
 * | `node status=error`      | never appears              | visible                      |
 *
 * So the race watches both, and reads the reason from whichever fired: the
 * banner carries its reason NEXT TO it in the page text (the read
 * `api-component-regression.spec.ts` documents), while the status icon carries
 * no text at all — no `title`, no `aria-label`, no inner text — and yields its
 * reason only through the hover tooltip (measured: "The requested model provider
 * is not available Duration: 3.8 seconds"). The error toast
 * (`.error-build-message`) was measured on both shapes and fired on neither, so
 * it is deliberately not in the race.
 *
 * What this is not: a way to make a red test green. No assertion is softened —
 * the retry is scoped to the *provisioning* attempt, a non-transient reason
 * throws on the first attempt, and a sustained provider outage still fails,
 * quoting what it saw. A failure that cannot be attributed is reported as
 * unattributed rather than absorbed (#1012: unknown is not clean).
 */

/**
 * Ceiling for one attempt of a node run.
 *
 * Calibrated, not inherited: measured on 1.12.0.dev44, the Knowledge ingest
 * badge appears in 2-4 s across 26 clean runs, and a failure signal in ~1 s.
 * 45 s is >10x the measured p100 with headroom for a slower CI runner, and
 * matches the sibling `api-component-regression.spec.ts`. The prior 90 s was
 * ~30x — and, more to the point, was what DETECTED a failure. The signals detect
 * it now, so this ceiling only bounds a run that reports nothing at all.
 */
export const NODE_RUN_TIMEOUT_MS = 45_000;

/** Attempts per node run, including the first. Bounded on purpose. */
export const NODE_RUN_MAX_ATTEMPTS = 3;

/**
 * Wait between attempts.
 *
 * The quota that motivates the retry is a per-MINUTE window, and the 2026-09-01
 * daily recovered ~84 s after its failing attempt. Two 30 s waits straddle that
 * window without letting a single test approach the 5-minute per-test timeout —
 * see the arithmetic pinned in `run-node-and-wait.test.ts`.
 */
export const NODE_RUN_RETRY_DELAY_MS = 30_000;

/** The page-level build-failure signal (i18n key `flowBuild.buildFailed`). */
export const BUILD_FAILED_SIGNAL = "Flow build failed";

/** Upper bound on the reason slice — an error message, not a page dump. */
const REASON_MAX_CHARS = 600;

/**
 * Reasons worth another attempt: a provider rate-limit or quota rejection.
 *
 * Deliberately narrow. Everything else — a graph that cannot build, a component
 * raising, an SSRF rejection, a model the registry no longer recognises — is a
 * verdict this suite exists to report, and re-running it three times only
 * delays the same answer.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /resource_exhausted/i,
  /\bquota\b/i,
  /rate[ _-]?limit/i,
];

/**
 * True when `reason` names a provider rate-limit/quota condition.
 *
 * An empty or whitespace-only reason is NOT transient: "we could not read why it
 * failed" and "it failed for a reason we retry" are opposite verdicts, and
 * retrying an unknown spends the budget to report the same silence.
 */
export function isTransientRunFailure(reason: string): boolean {
  if (!reason.trim()) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(reason));
}

/**
 * Slices the build-failure reason out of a page's text.
 *
 * The reason renders next to the signal rather than inside it, so the slice
 * starts AT the signal and runs forward. Returns `""` when the signal is absent
 * — never a slice of unrelated page chrome, which a bare `indexOf` result fed to
 * `slice` would produce (`-1` slices the last character).
 */
export function extractBuildFailureReason(pageText: string): string {
  const flat = pageText.replace(/\s+/g, " ").trim();
  const start = flat.indexOf(BUILD_FAILED_SIGNAL);
  if (start < 0) return "";
  return flat.slice(start, start + REASON_MAX_CHARS).trim();
}

/**
 * Collapses the node tooltip's repeated body down to one copy.
 *
 * The status tooltip renders its message more than once (measured: the same
 * "…is not available Duration: 3.8 seconds" twice over), so the raw text would
 * put a doubled sentence into the failure message. Cuts at the first repeat of
 * the opening probe; a message with no repeat is returned whole.
 */
export function dedupeRepeatedReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const PROBE = 24;
  if (flat.length < PROBE * 2) return flat.slice(0, REASON_MAX_CHARS);
  const repeat = flat.indexOf(flat.slice(0, PROBE), 1);
  const once = repeat > 0 ? flat.slice(0, repeat) : flat;
  return once.trim().slice(0, REASON_MAX_CHARS);
}

/** What the caller should do next after one attempt of a node run. */
export type NodeRunOutcome =
  | { action: "done" }
  | { action: "retry"; reason: string }
  | { action: "fail"; message: string };

export interface NodeRunObservation {
  /** Whether the node's success badge is visible right now. */
  badgeVisible: boolean;
  /**
   * The reason read off the page, `""` when a failure signal was seen but its
   * text could not be read, or `null` when no failure signal appeared at all.
   */
  reason: string | null;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
  /** Canvas `data-id` of the node, for attribution in the message. */
  nodeId: string;
}

/**
 * The whole decision, in one pure function.
 *
 * It lives here rather than inside the polling loop because #1226 established
 * that a guard pinning a spelling does not pin a behaviour — and a decision
 * buried in a loop body is unreachable from a test. `run-node-and-wait.test.ts`
 * asserts on this function's output; the loop below is only I/O.
 */
export function decideNodeRunOutcome(o: NodeRunObservation): NodeRunOutcome {
  // Success outranks everything. A failure signal from a prior attempt animates
  // out, so it is routinely still painted on the tick where this attempt's badge
  // first renders; reading that as a failure would red a run that recovered.
  if (o.badgeVisible) return { action: "done" };

  const where = `Node "${o.nodeId}"`;
  const budget = `${o.maxAttempts} attempt(s)`;

  if (o.reason === null) {
    return {
      action: "fail",
      message:
        `${where} produced neither its success badge nor a failure signal ` +
        `("${BUILD_FAILED_SIGNAL}", or an error node status) within ` +
        `${NODE_RUN_TIMEOUT_MS / 1000}s. The run neither completed nor reported ` +
        `an error, so there is nothing on the page naming a cause — see the trace.`,
    };
  }

  if (!o.reason.trim()) {
    return {
      action: "fail",
      message:
        `${where} FAILED to build: a failure signal appeared, but its reason ` +
        `could not be read from the page (the signal was gone by the time it ` +
        `was read) — see the trace.`,
    };
  }

  if (isTransientRunFailure(o.reason) && o.attempt < o.maxAttempts) {
    return { action: "retry", reason: o.reason };
  }

  if (isTransientRunFailure(o.reason)) {
    return {
      action: "fail",
      message:
        `${where} FAILED to build on all ${budget} with a provider ` +
        `rate-limit/quota condition — a sustained provider outage, or a ` +
        `regression surfacing as one. On screen: ${o.reason}`,
    };
  }

  return {
    action: "fail",
    message:
      `${where} FAILED to build on attempt ${o.attempt}. The reason is not a ` +
      `provider rate-limit, so it is NOT retried — re-running a build that ` +
      `cannot succeed only delays the same verdict. On screen: ${o.reason}`,
  };
}

export interface RunNodeAndWaitOptions {
  /** Canvas `data-id` of the node to run, e.g. `"Knowledge-ingest"`. */
  nodeId: string;
  /** The node's run-control testid, e.g. `"button_run_knowledge"`. */
  runButtonTestId: string;
  /**
   * The success-badge testid. Defaults to the shared `node_duration` prefix,
   * matched with `^=` so a per-node suffix does not have to be spelled out.
   */
  durationTestId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Clicks a node's run control and waits for a verdict, retrying only a provider
 * rate-limit/quota failure within a bounded budget.
 *
 * Throws with the on-screen reason on any other failure, on an exhausted budget,
 * and on a run that reports nothing at all.
 */
export async function runNodeAndWait(
  page: Page,
  {
    nodeId,
    runButtonTestId,
    durationTestId,
    timeoutMs = NODE_RUN_TIMEOUT_MS,
    maxAttempts = NODE_RUN_MAX_ATTEMPTS,
    retryDelayMs = NODE_RUN_RETRY_DELAY_MS,
  }: RunNodeAndWaitOptions,
): Promise<void> {
  const node = page.locator(`[data-id="${nodeId}"]`);
  const badge = durationTestId
    ? node.getByTestId(durationTestId)
    : node.locator('[data-testid^="node_duration"]');
  const buildFailed = page.getByText(BUILD_FAILED_SIGNAL).first();
  const errorStatus = node
    .locator('[data-testid^="node_status_icon"][data-testid$="_error"]')
    .first();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt === 1) {
      // Clean slate before the first run: a badge or a failure signal already
      // painted would decide this attempt before it has run.
      await expect(badge).toBeHidden();
      await expect(buildFailed).toBeHidden();
      await expect(errorStatus).toBeHidden();
    }

    await node.getByTestId(runButtonTestId).click({ timeout: 15000 });

    if (attempt > 1) {
      // A retry begins with the PREVIOUS attempt's error status still painted:
      // the node clears it only when the new run enters BUILDING, so asserting
      // it hidden before the click deadlocks the loop (measured — this is what
      // the first version of this helper did). Gate on the transition instead,
      // and treat "never cleared" as the retry click not having taken effect,
      // which is a different failure from the run failing again. Measured on
      // 1.12.0.dev44: an ingest spends 2-4 s building whether it goes on to
      // succeed or to error, so the gap is seconds wide, not a frame.
      const restarted = await errorStatus
        .waitFor({ state: "hidden", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!restarted) {
        throw new Error(
          `Node "${nodeId}": the retry click on attempt ${attempt} did not start ` +
            `a new run — the node still carries the previous attempt's error ` +
            `status after 15s.`,
        );
      }
    }

    // Race the three verdicts. `.or()` resolves as soon as any is visible, so a
    // failure costs ~1 s instead of the whole budget; the budget now only bounds
    // a run that reports nothing at all.
    const settled = await badge
      .or(buildFailed)
      .or(errorStatus)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);

    const badgeVisible = settled
      ? await badge.isVisible().catch(() => false)
      : false;
    const reason = badgeVisible
      ? null
      : await readFailureReason(page, buildFailed, errorStatus, settled);

    const outcome = decideNodeRunOutcome({
      badgeVisible,
      reason,
      attempt,
      maxAttempts,
      nodeId,
    });
    if (outcome.action === "done") return;
    if (outcome.action === "fail") throw new Error(outcome.message);

    console.log(
      `[run-node-and-wait] ${nodeId}: attempt ${attempt}/${maxAttempts} hit a ` +
        `provider rate-limit/quota; retrying in ${retryDelayMs / 1000}s. ` +
        `On screen: ${outcome.reason.slice(0, 200)}`,
    );
    // Clear the signal so the next attempt's guards can pass, then wait out the
    // provider's window. There is nothing to poll for here — the window is the
    // provider's, not the page's — so the sleep is the honest primitive.
    await dismissBuildFailure(page);
    await page.waitForTimeout(retryDelayMs);
  }
  // Unreachable: the final attempt always returns or throws above.
  throw new Error(
    `Node "${nodeId}" exhausted its run attempts without a verdict.`,
  );
}

/**
 * Reads the failure reason from whichever surface fired.
 *
 * Returns `null` when nothing fired at all (a run that reported nothing, which
 * is a different verdict from a build that failed), and `""` when a signal fired
 * but yielded no readable text.
 */
async function readFailureReason(
  page: Page,
  buildFailed: Locator,
  errorStatus: Locator,
  settled: boolean,
): Promise<string | null> {
  if (!settled) return null;

  if (await buildFailed.isVisible().catch(() => false)) {
    const pageText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    return extractBuildFailureReason(pageText);
  }

  if (await errorStatus.isVisible().catch(() => false)) {
    // The icon itself carries no text (measured: no `title`, no `aria-label`, no
    // inner text) — the message exists only in the hover tooltip, so it has to
    // be opened to be read. The assistant onboarding popover also renders as a
    // tooltip, so it is excluded by testid rather than hoped away.
    await errorStatus.hover({ timeout: 3000 }).catch(() => {});
    const tip = page
      .locator('[role="tooltip"]:not([data-testid="assistant-onboarding-tooltip"])')
      .first();
    const text = await tip.innerText({ timeout: 3000 }).catch(() => "");
    return dedupeRepeatedReason(text);
  }

  return null;
}

/**
 * Clears the build-failure banner between attempts.
 *
 * Uses the banner's own `Dismiss` control (i18n key `flowBuild.dismiss`) when it
 * is there, and otherwise leaves the signal to age out — the caller's
 * `toBeHidden` guards are what actually enforce a clean start, so this never has
 * to succeed for correctness, only for speed.
 */
async function dismissBuildFailure(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss" }).last();
  if (await dismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dismiss.click().catch(() => {});
  }
}
