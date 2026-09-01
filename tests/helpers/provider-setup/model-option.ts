import type { Locator, Page } from "@playwright/test";
import {
  MODEL_TOGGLE_WRITE_STALLED,
  modelTriggerStallMessage,
  writeStallReason,
  type ToggleBatchOutcome,
} from "./model-toggle-batch";

/**
 * One entry of the unified ModelInput picker, read straight from the DOM.
 *
 * The frontend renders each option as
 *
 *   <div data-testid="${provider}-${model}-option" data-value="${provider}::${model}">
 *     <svg/>                                     <- provider icon
 *     <div class="truncate text-[13px]">${model}</div>
 *     <span class="sr-only">${index} of ${total}</span>   <- 1.12.0.dev26+
 *     <span data-testid="${model}-deprecated-badge">Deprecated</span>  <- optional
 *     <svg/>                                     <- selected check
 *   </div>
 *
 * so the option's *text* carries more than the model name, while `data-value`
 * and `data-testid` carry the identity. Everything below reads the identity and
 * treats the text as evidence only — the inverse of what the helpers did until
 * #1459, where the `sr-only` position counter (added on dev26) silently defeated
 * every `^model$` matcher.
 */
export type RawModelOption = {
  /** `${provider}-${model}-option`, or "" when the attribute is gone. */
  testId: string;
  /** cmdk value, `${provider}::${model}` — the unambiguous identity. */
  value: string;
  /** Option text with `sr-only` and badge nodes removed: what a user reads. */
  visibleLabel: string;
  /** Full `textContent`, counter included — reported as evidence, never matched. */
  rawText: string;
  deprecated: boolean;
};

export type ModelOption = RawModelOption & {
  /** Provider as the picker groups it ("Anthropic", "Google Generative AI"). */
  provider: string | null;
  /** Model id as the backend knows it ("claude-haiku-4-5"). */
  model: string | null;
};

/**
 * The verdict of looking for a pinned model in an open picker.
 *
 * `absent` is the ONLY outcome that may become a `test.skip`, and it is reached
 * only when the picker was populated and neither it nor the provider panel
 * knows the model. Every other outcome is loud: #1461 was filed because a single
 * negative observation (one anchored matcher returning nothing) was reported as
 * "model may not be supported" and skipped ~30 `@stable` tests in one daily.
 */
export type ModelOptionVerdict =
  | { kind: "match"; option: ModelOption }
  | { kind: "unmatchable"; message: string; evidence: string[] }
  | { kind: "empty"; message: string }
  | { kind: "not-enabled"; message: string }
  | { kind: "write-stalled"; message: string }
  | { kind: "absent"; message: string };

export type ResolveContext = {
  /**
   * Every `llm-toggle-<model>` id the provider panel RENDERED, whatever its
   * `aria-checked` state — what `enumerateEnabledModels` returns. It proves the
   * provider LISTS the model and nothing more. `undefined` means "not observed"
   * and is reported as such — an unobserved source must never read as a negative
   * one (#1012).
   */
  listedModels?: string[];
  /**
   * The subset whose toggle is actually ON — what `enumerateCheckedModels`
   * returns. This is the second independent source the picker can be
   * CONTRADICTED by: a model enabled here but missing from the picker is not an
   * absence, it is a disagreement.
   *
   * Kept separate from `listedModels` because the two answer different
   * questions and the resolver's loudest message asserts the stronger one. Until
   * #1649 the listed set was passed as the only source and the message said
   * "is ENABLED in the provider panel" on evidence that could not establish it —
   * true by luck on 2026-08-31, where the real cause was the panel being closed
   * inside its own toggle-queue debounce. `undefined` again means "not observed":
   * the message then says LISTED, and no branch infers a toggle is off from it.
   */
  checkedModels?: string[];
  /** Provider the caller is configuring, for the message only. */
  providerLabel?: string;
  /**
   * What the panel's own toggle batch did before the panel was closed —
   * `enableAndSettleModelToggles`' return value.
   *
   * It is the THIRD source, and the only one that can tell a picker/panel
   * disagreement with a known cause from one without: `checkedModels` reads
   * `aria-checked`, which is `useModelToggleQueue`'s OPTIMISTIC cache and flips at
   * click time before any request. So when the batched write never answers, the
   * panel claims the model is on while the server still holds its
   * `MIN_DEFAULT_MODELS` five, and the picker — rendering the server — is the
   * honest one. `undefined` means "not observed" and changes no verdict (#1012).
   */
  toggleWrite?: ToggleBatchOutcome;
};

const MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE";
/**
 * Deliberately NOT prefixed `MODEL_NOT_AVAILABLE`: every caller turns that
 * prefix into `test.skip`, so a suite-side defect carrying it would be silent.
 */
const MODEL_PICKER_DEFECT = "MODEL_PICKER_DEFECT";
/**
 * Also deliberately NOT prefixed `MODEL_NOT_AVAILABLE`: a model the panel LISTS
 * is not absent, so this must never reach a caller as a skip. It is the setup's
 * own failure to enable it (#1649).
 */
const MODEL_NOT_ENABLED = "MODEL_NOT_ENABLED";

/** Derives the model identity from the attributes, text last. */
export function toModelOption(raw: RawModelOption): ModelOption {
  const [valueProvider, ...valueRest] = raw.value.split("::");
  if (raw.value.includes("::") && valueRest.join("::").trim()) {
    return { ...raw, provider: valueProvider, model: valueRest.join("::") };
  }

  // No `data-value`: fall back to the testid. Both provider and model may carry
  // "-", so the split is anchored on the "-option" suffix and the *first*
  // separator only — good enough for evidence, and never used when data-value
  // is present.
  const withoutSuffix = raw.testId.replace(/-option$/, "");
  const firstDash = withoutSuffix.indexOf("-");
  if (raw.testId.endsWith("-option") && firstDash > 0) {
    return {
      ...raw,
      provider: withoutSuffix.slice(0, firstDash),
      model: withoutSuffix.slice(firstDash + 1),
    };
  }

  // Neither attribute is usable — the visible label is all that is left, and it
  // is reported as such rather than trusted as an identity.
  return { ...raw, provider: null, model: raw.visibleLabel || null };
}

function providerCounts(options: ModelOption[]): string {
  const counts = new Map<string, number>();
  for (const option of options) {
    const key = option.provider ?? "(unknown provider)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([provider, n]) => `${provider}: ${n}`).join(", ");
}

/**
 * Models whose id is close enough that a human reading the failure can tell a
 * rename from a retirement — the picker's own answer to "did you mean…".
 */
export function nearestModels(requested: string, options: ModelOption[], limit = 5): string[] {
  const wanted = requested.toLowerCase();
  const stem = wanted.split(/[-.:]/)[0] ?? wanted;
  const scored = options
    .map((option) => option.model ?? option.visibleLabel)
    .filter((model): model is string => Boolean(model))
    .map((model) => {
      const lower = model.toLowerCase();
      let score = 0;
      if (lower === wanted) score = 100;
      else if (lower.includes(wanted) || wanted.includes(lower)) score = 90;
      else if (stem && lower.startsWith(stem)) score = 50 + sharedPrefix(lower, wanted);
      else score = sharedPrefix(lower, wanted);
      return { model, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

  return scored.slice(0, limit).map((entry) => entry.model);
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Decides what an open picker actually proves about a pinned model.
 *
 * Pure on purpose: the branch that must never regress is "a model the picker
 * offers can only ever resolve to a LOUD failure", and a unit test can pin that
 * where a live spec cannot reproduce a markup change on demand.
 */
export function resolveModelOption(
  requested: string,
  options: ModelOption[],
  context: ResolveContext = {},
): ModelOptionVerdict {
  const provider = context.providerLabel ? ` for ${context.providerLabel}` : "";

  if (options.length === 0) {
    return {
      kind: "empty",
      message:
        `${MODEL_PICKER_DEFECT}: the model picker rendered ZERO options${provider}, so it ` +
        `proves nothing about "${requested}". An empty picker means no provider is ` +
        `configured (a rejected or drained API key leaves the credential unsaved) or the ` +
        `list never loaded — not that the model is unsupported. Reported as a FAILURE, ` +
        `not a skip: an unevaluated test is unknown, not clean (#1012/#1461).`,
    };
  }

  const exact = options.find((option) => option.model === requested);
  if (exact) return { kind: "match", option: exact };

  // The model is in the picker but its identity did not parse — the exact shape
  // of the #1459 break, one markup change later. Absence is contradicted by the
  // picker itself, so this can never be a skip.
  const evidence: string[] = [];
  for (const option of options) {
    if (option.visibleLabel === requested) {
      evidence.push(`visible label "${option.visibleLabel}" (testid "${option.testId}")`);
    } else if (option.testId.endsWith(`-${requested}-option`)) {
      evidence.push(`testid "${option.testId}"`);
    } else if (option.rawText.split("\n")[0]?.trim() === requested) {
      evidence.push(`option text "${option.rawText.replace(/\n/g, "\\n")}"`);
    }
  }

  if (evidence.length > 0) {
    return {
      kind: "unmatchable",
      evidence,
      message:
        `${MODEL_PICKER_DEFECT}: "${requested}" IS offered by the model picker${provider} ` +
        `but this suite could not select it — ${evidence.join("; ")}. ` +
        `The model identity (data-value / data-testid) no longer resolves to the id the ` +
        `test pinned, which is a suite defect, not a missing model. Reported as a FAILURE ` +
        `so it cannot become a silent skip (#1461).`,
    };
  }

  // The panel is TWO sources, not one, and which of them knows the model decides
  // how loud the verdict is and what it may claim (#1649).
  const listed = context.listedModels;
  const checked = context.checkedModels;

  if (checked?.includes(requested)) {
    // The panel says ON — but `aria-checked` is the optimistic cache, so before
    // that claim may be turned into a picker defect, ask whether the write behind
    // it ever landed. Consulted HERE and not earlier on purpose: `empty`, `match`
    // and `unmatchable`-by-identity are already decided above, and a stalled write
    // says nothing about a model the picker IS offering — reporting a stall there
    // would hide the #1459 class of defect (identity no longer resolving).
    const stalled = writeStallReason(context.toggleWrite);
    if (stalled !== null) {
      return {
        kind: "write-stalled",
        message:
          `${MODEL_TOGGLE_WRITE_STALLED}: "${requested}" reads as enabled in the provider ` +
          `panel (llm-toggle-${requested})${provider}, but that is the OPTIMISTIC client ` +
          `cache — ${stalled}. The model was therefore never enabled server-side, and the ` +
          `picker is CORRECT to offer ${options.length} option(s) ` +
          `(${providerCounts(options)}): a freshly configured provider's ` +
          `${"`"}MIN_DEFAULT_MODELS${"`"} default. This is an INSTANCE stall — not a picker ` +
          `defect and not a missing model. Do not raise the flush budget to make it pass ` +
          `(#1649).`,
      };
    }
    return {
      kind: "unmatchable",
      evidence: [`llm-toggle-${requested} in the provider panel`],
      message:
        `${MODEL_PICKER_DEFECT}: "${requested}" is ENABLED in the provider panel ` +
        `(llm-toggle-${requested})${provider} but the model picker does not offer it — ` +
        `${options.length} option(s) enumerated (${providerCounts(options)}). ` +
        `The two sources disagree, so the model is not absent: either the picker did not ` +
        `refresh after the panel closed, or the option list is filtered. Reported as a ` +
        `FAILURE, not a skip (#1461).`,
    };
  }

  if (listed?.includes(requested)) {
    // The toggle state was never read, so the strongest true statement is LISTED.
    // Saying ENABLED here is the overclaim #1649 removed: an unobserved source
    // must not be reported as a stronger one (#1012).
    if (checked === undefined) {
      return {
        kind: "unmatchable",
        evidence: [`llm-toggle-${requested} in the provider panel`],
        message:
          `${MODEL_PICKER_DEFECT}: "${requested}" is listed by the provider panel ` +
          `(llm-toggle-${requested})${provider} but the model picker does not offer it — ` +
          `${options.length} option(s) enumerated (${providerCounts(options)}). ` +
          `Its toggle state was NOT observed on this path, so this is reported on the ` +
          `listing alone: the model is not absent, and the picker either did not refresh ` +
          `after the panel closed or the option list is filtered. Reported as a FAILURE, ` +
          `not a skip (#1461).`,
      };
    }

    // Listed, toggle OFF, absent from the picker: all three agree, and the picker
    // is RIGHT to omit a disabled model. Nothing about the product is wrong here —
    // the setup did not enable it. Loud anyway: a listed model is not absent, so
    // this may never reach a caller as `test.skip`.
    return {
      kind: "not-enabled",
      message:
        `${MODEL_NOT_ENABLED}: "${requested}" is listed by the provider panel ` +
        `(llm-toggle-${requested})${provider} but its toggle is OFF — ` +
        `${checked.length} of ${listed.length} listed model(s) are enabled, and the picker ` +
        `offers ${options.length} option(s) (${providerCounts(options)}). ` +
        `The picker is correct to omit a disabled model, so this is NOT a picker defect: ` +
        `the setup failed to enable it. On a freshly configured provider the enabled set ` +
        `is the ${"`"}MIN_DEFAULT_MODELS${"`"} default, which is what a panel closed inside its own ` +
        `toggle-queue debounce leaves behind (#1649). Reported as a FAILURE, never a skip.`,
    };
  }

  const nearest = nearestModels(requested, options);
  const toggleEvidence =
    listed === undefined
      ? "provider toggles were not observed on this path"
      : `${listed.length} provider toggle(s) observed, none of them "${requested}"`;

  return {
    kind: "absent",
    message:
      `${MODEL_NOT_AVAILABLE}: "${requested}" is not offered${provider} — established from ` +
      `${options.length} enumerated option(s) (${providerCounts(options)}) and ` +
      `${toggleEvidence}. ` +
      (nearest.length > 0 ? `Nearest offered: ${nearest.join(", ")}. ` : "") +
      `The model was retired from the catalog or is not enabled for this account.`,
  };
}

/**
 * Reads every option of the OPEN model picker.
 *
 * `sr-only` and badge nodes are stripped inside the page so `visibleLabel` is
 * what a user reads, while `rawText` keeps the polluted string for the failure
 * message — the picker's own answer to "what did you actually see".
 */
export async function enumerateModelOptions(
  page: Page,
  timeout = 10000,
): Promise<ModelOption[]> {
  const options = page.locator('[data-testid$="-option"]');
  await options.first().waitFor({ state: "visible", timeout }).catch(() => {});
  return readModelOptions(options);
}

/**
 * The same read over a caller-scoped locator — for pickers that are filtered to
 * one provider (`setup-ollama`) and must not wait on the shared selector.
 */
export async function readModelOptions(options: Locator): Promise<ModelOption[]> {
  const raw = await options.evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll('.sr-only, [data-testid$="-deprecated-badge"]')
        .forEach((node) => node.remove());
      return {
        testId: el.getAttribute("data-testid") ?? "",
        value: el.getAttribute("data-value") ?? "",
        visibleLabel: (clone.textContent ?? "").trim(),
        rawText: (el.textContent ?? "").trim(),
        deprecated: el.querySelector('[data-testid$="-deprecated-badge"]') !== null,
      };
    }),
  );

  return raw.map(toModelOption);
}

/**
 * Whether an option can be matched against at all.
 *
 * A target carrying neither attribute matches NOTHING, so every "it is no longer
 * offered" verdict about it is vacuous. That state is not hypothetical: reviewing
 * #1464 reproduced it by blanking both attributes on a target whose model HAD been
 * disabled, and the removal step passed — the run only reddened 25 s later, at the
 * re-enable, blaming the product for what was a suite defect.
 */
export function hasOptionIdentity(
  option: Pick<ModelOption, "testId" | "value">,
): boolean {
  return option.value !== "" || option.testId !== "";
}

/** What one read of the picker establishes about a single target option. */
export type PickerCensus = {
  /** Options offered, every provider included. */
  total: number;
  /** Options whose IDENTITY is the target's — 0 or 1 in a healthy picker. */
  target: number;
  /** OTHER models of the caller's provider that still resolve by identity. */
  providerOthers: number;
  /** What a user would read, for the failure message. */
  labels: string[];
};

/**
 * Counts what an enumerated picker establishes about one target option.
 *
 * Pure for the same reason `resolveModelOption` is: the property that must never
 * regress is that a NEGATIVE verdict about one option can only be reached from a
 * picker that was populated and is still parsable — and a unit test can pin that
 * where a live spec cannot reproduce a markup change on demand. `target: 0` alone
 * is also exactly what an empty list and a renamed attribute produce, so a caller
 * asserting it without `total` and `providerOthers` is asserting nothing
 * (#1012/#1461). Matching is on `data-value` then `data-testid`; the option's text
 * is never consulted, because the `sr-only` position counter added on
 * 1.12.0.dev26 renders inside it with no separator ("claude-opus-5" + "1 of 69").
 *
 * `providerOthers` keys on the model ID rather than the provider label on purpose:
 * it answers "does this provider's catalog still resolve at all", which is the
 * question that separates a model the product removed from a reader we broke.
 */
export function censusForTarget(
  options: ModelOption[],
  target: Pick<ModelOption, "testId" | "value">,
  providerModels: ReadonlySet<string>,
): PickerCensus {
  const isTarget = (option: ModelOption): boolean =>
    (target.value !== "" && option.value === target.value) ||
    (target.testId !== "" && option.testId === target.testId);

  return {
    total: options.length,
    target: options.filter(isTarget).length,
    providerOthers: options.filter(
      (option) =>
        !isTarget(option) &&
        option.model !== null &&
        providerModels.has(option.model),
    ).length,
    labels: options.map((option) => option.visibleLabel),
  };
}

/**
 * Model ids of the provider panel's toggles — the second source of truth.
 *
 * The name is narrower than the behavior and callers must not over-trust it: this
 * returns EVERY rendered `llm-toggle-*` id regardless of `aria-checked`, including
 * the rows inside the collapsed `llm-deprecated-disclosure` (measured on
 * 1.12.0.dev30: 49 ids for OpenAI, 41 checked and 8 not, the 8 being exactly the
 * deprecated ones). So it answers "which models does this provider LIST", not
 * "which are enabled" — which is what its callers want, and why the behavior is
 * left alone; a count taken from it is never a count of enabled models.
 */
export async function enumerateEnabledModels(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="llm-toggle-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
  return ids.map((id) => id.replace(/^llm-toggle-/, "")).filter(Boolean);
}

/**
 * The subset of `enumerateEnabledModels` whose toggle is actually ON.
 *
 * This is the one that may be reported as ENABLED. Its sibling above returns every
 * rendered id regardless of `aria-checked`, and passing that as the resolver's
 * only source is how the loud verdict came to assert "is ENABLED in the provider
 * panel" from evidence that established only "is listed" (#1649). Both are read
 * because the two together separate three states a single count cannot: the
 * picker disagreeing with an enabled model, the setup having failed to enable it,
 * and the model genuinely being gone.
 *
 * `:visible` is deliberately NOT applied: the deprecated disclosure's toggles are
 * collapsed, not absent, and one that is checked is genuinely enabled.
 */
export async function enumerateCheckedModels(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="llm-toggle-"][aria-checked="true"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
  return ids.map((id) => id.replace(/^llm-toggle-/, "")).filter(Boolean);
}

/**
 * Clicks an enumerated option by identity.
 *
 * Prefers the testid and falls back to the cmdk value, so a build that drops one
 * attribute is still selectable instead of degrading into a false absence.
 */
export async function clickModelOption(page: Page, option: ModelOption): Promise<void> {
  const locator = option.testId
    ? page.getByTestId(option.testId)
    : page.locator(`[data-testid$="-option"][data-value="${option.value.replace(/"/g, '\\"')}"]`);
  await locator.first().click();
}

/**
 * Opens the model picker after the provider panel was closed, attributing a
 * failure to the toggle batch when the batch is what explains it.
 *
 * Shared by the three provider setups because the block was copy-pasted three
 * times and had already drifted: #1651 landed the same 60 s budgets in each with
 * three differently-worded comments, and this is the second change to touch all
 * three. Both budgets stay 60 s and are NOT a retry: taking the correct flush path
 * means the product genuinely re-fetches, measured at 30 020 ms and 29 640 ms
 * against the 4 327 ms the broken path returned in. The click carries its own
 * budget because it otherwise falls back to the 20 s `actionTimeout` while the
 * trigger re-enters `ModelInputLoadingButton` between "visible" and the click.
 *
 * What is new is the catch. On a batch that never settled, the post-close refresh
 * runs in a write's `onSettled` that never fired, so the trigger can stay
 * unusable for the whole budget — measured twice on the 2026-09-01 daily as a bare
 * `locator.waitFor: Timeout 60000ms exceeded ... getByTestId('model_model')` with
 * nothing naming a cause. The batch's own observation is re-thrown instead, and
 * Playwright's original message is kept inside it.
 */
export async function openModelPickerAfterPanelClose(
  page: Page,
  context: { providerLabel: string; toggleWrite?: ToggleBatchOutcome },
): Promise<void> {
  const trigger = page.getByTestId("model_model");
  try {
    await trigger.waitFor({ state: "visible", timeout: 60000 });
    // The locator is re-resolved on every actionability retry, so this survives the
    // element being replaced, and nothing about the assertion that follows is
    // weakened.
    await trigger.click({ timeout: 60000 });
  } catch (error) {
    const attributed = modelTriggerStallMessage(context.toggleWrite, {
      providerLabel: context.providerLabel,
      original: (error as Error).message,
    });
    if (attributed !== null) throw new Error(attributed);
    // No stall to blame: a trigger that never returns on a healthy flush is a real
    // defect and must keep surfacing as Playwright's own error, call log included.
    throw error;
  }
}

export type PinnedSelection =
  | { status: "selected"; model: string }
  | { status: "absent"; message: string };

/**
 * Selects a pinned model in the OPEN picker, or reports what the picker proved.
 *
 * Loud verdicts (`empty`, `unmatchable`, `not-enabled`) always throw: they are the suite's own
 * defects and must never reach a caller that would skip on them. Only an
 * *established* absence is handed back, and even then the caller decides —
 * `absentBehavior: "return"` exists for `setup-openai`'s `fallbackToRanking`
 * consumers (#606), which must degrade rather than fail on a stale pin.
 */
export async function selectPinnedModelOption(
  page: Page,
  opts: {
    requested: string;
    listedModels?: string[];
    checkedModels?: string[];
    providerLabel?: string;
    /**
     * `enableAndSettleModelToggles`' result. `write-stalled` is deliberately NOT
     * returnable through `absentBehavior: "return"`: that hatch exists for a stale
     * pin from `models.json` (#606), and degrading on an instance that could not
     * accept the write would hide exactly the state #1649 was reopened for.
     */
    toggleWrite?: ToggleBatchOutcome;
    absentBehavior?: "throw" | "return";
    timeout?: number;
  },
): Promise<PinnedSelection> {
  const options = await enumerateModelOptions(page, opts.timeout ?? 10000);
  const verdict = resolveModelOption(opts.requested, options, {
    listedModels: opts.listedModels,
    checkedModels: opts.checkedModels,
    providerLabel: opts.providerLabel,
    toggleWrite: opts.toggleWrite,
  });

  if (verdict.kind === "match") {
    await clickModelOption(page, verdict.option);
    return { status: "selected", model: verdict.option.model ?? opts.requested };
  }

  await page.keyboard.press("Escape");

  if (verdict.kind === "absent") {
    if ((opts.absentBehavior ?? "throw") === "return") {
      return { status: "absent", message: verdict.message };
    }
    throw new Error(verdict.message);
  }

  throw new Error(verdict.message);
}
