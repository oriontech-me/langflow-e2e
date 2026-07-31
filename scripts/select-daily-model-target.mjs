#!/usr/bin/env node
/**
 * Picks the single model target `daily-stable.yml` should run its LLM specs against
 * on a given day, rotating through the providers by weekday (#1185).
 *
 * ## Why the daily narrows at all
 *
 * The parametrized agent specs resolve **one model per active provider**, so every
 * `@stable` agent test runs an openai variant *and* an anthropic variant *and* a
 * google variant. That is ~30 multi-turn agent tests × 3 providers, every weekday,
 * with the Simple Agent tool schemas re-sent on every turn (Langflow sets no
 * `cache_control`, so nothing is cached on the anthropic side). `claude-sonnet-5` is
 * $3/$15 per MTok against `gpt-4o-mini` at ~$0.15/$0.60 — 20-25x per token for
 * assertions that are about **Langflow**, not about the provider.
 *
 * The PR lane stopped paying that on 2026-07-31 (#1169 / PR #1170). This is the same
 * argument applied to the lane #1170 deliberately left alone.
 *
 * ## Why a rotation and not a fixed pin
 *
 * A fixed pin is cheaper to reason about, but it makes the detection window for a
 * provider-specific regression a standing human decision — anthropic and google
 * agent behaviour would run only when someone dispatched `manual.yml`. This suite
 * catches real provider-specific regressions (#643, anthropic streaming dropping the
 * `thinking` block; #963, gemini returning "Message empty." while the tool fires), so
 * that window matters.
 *
 * Rotating costs exactly the same — one provider per run — and bounds the window to
 * **≤3 days, automatically**.
 *
 * The weekday mapping is FIXED rather than an even round-robin:
 *
 *   Mon → openai   Tue → anthropic   Wed → google   Thu → openai   Fri → anthropic
 *
 * so every Monday resolves the same provider and two Mondays are comparable. The
 * price is an uneven 2/2/1 split across three providers over a Mon-Fri week, which is
 * the right trade: comparability is what triage needs, evenness buys nothing. `openai`
 * leads because it is the cheapest and is already the PR lane's target, so a Monday
 * red is directly comparable to a PR red.
 *
 * ## Why the fallback is the whole point
 *
 * A rotation that loses the day when its provider is dry is WORSE than the
 * multi-provider run it replaces. Lost coverage costs more than spend — #980's trade —
 * and it is not hypothetical: the daily recorded **zero tests on 2026-07-28 and
 * 2026-07-31**, and the shared anthropic key drained mid-window (#1169).
 *
 * So this walks the rotation order from the day's slot and takes the first provider
 * `collect-models` probed `active`:
 *
 *  - day's provider active            → use it.
 *  - inactive / absent from the file  → advance to the next, with a `::warning::`
 *                                       naming what was skipped and why. NOT a
 *                                       decline to multi-provider: that pays 3x on
 *                                       exactly the day a key is already broken.
 *  - every provider inactive          → decline to pin, keep the lane's existing
 *                                       behaviour, warn. There is no live key to
 *                                       spend, so the fallback is moot and declining
 *                                       keeps the failure attributable.
 *  - providers.json missing           → decline and warn. The sweep is
 *                                       `continue-on-error` on this lane by design.
 *  - providers.json unreadable        → exit 2. An undecidable verdict must not read
 *                                       as "nothing to pin" (#1035).
 *
 * Every deviation is loud, and recoverable after the fact: the resolved provider and
 * model land in the `param` field of `reports/daily-history.jsonl`, so "which provider
 * did Tuesday actually run?" is answerable without opening the job log.
 *
 * ## Why it reuses the PR lane's decision function
 *
 * `selectPrModelTarget` already validates the payload shape and answers
 * "is this provider usable, and what did it settle on" with a reason string. Calling
 * it per candidate means the two lanes cannot drift on what `active` means, and a
 * fallback attempt produces the same `reason` text a decline would. Only the
 * *iteration* is new here.
 *
 * Run:
 *   node scripts/select-daily-model-target.mjs \
 *     --providers-file tests/helpers/provider-setup/data/providers.json \
 *     --order openai,anthropic,google
 *
 * Side effect: appends `MODEL_TEST_ID` / `MODEL_TEST_PROVIDER` to `$GITHUB_ENV` when
 * it pins. Always prints the decision as JSON on stdout.
 */
import * as fs from "fs";
import {
  readProvidersFile,
  // Named for the lane that first needed it (#1169); it is really
  // "is this provider usable, and what model did collect-models settle on".
  selectPrModelTarget as selectSettledTarget,
} from "./select-pr-model-target.mjs";

const DEFAULT_ORDER = ["openai", "anthropic", "google"];

const HELP = `Usage: node scripts/select-daily-model-target.mjs [options]

  --providers-file PATH  providers.json written by collect-models
  --order LIST           comma-separated rotation order
                         (default: ${DEFAULT_ORDER.join(",")})
  --date ISO             UTC instant deciding the weekday (default: now)
  -h, --help             this text
`;

/**
 * The rotation slot for a UTC date. Monday is slot 0 — the daily's cron is 05:00 BRT
 * = 08:00 UTC, so the UTC weekday and the Brazilian one always agree for this lane.
 * Saturday and Sunday map onto the same slots as Mon/Tue rather than being rejected:
 * the lane is Mon-Fri on schedule, but a `workflow_dispatch` on a weekend must still
 * resolve a provider instead of erroring.
 * @param {Date} date
 * @param {number} orderLength
 * @returns {number}
 */
export function rotationSlot(date, orderLength) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`--date is not a valid instant: ${date}`);
  }
  if (!Number.isInteger(orderLength) || orderLength < 1) {
    throw new Error(`rotation order must have at least one provider`);
  }
  // getUTCDay(): Sunday 0 … Saturday 6. Shift so Monday is 0.
  const mondayFirst = (date.getUTCDay() + 6) % 7;
  return mondayFirst % orderLength;
}

/**
 * Why the *decision* is shared but the *message* is not.
 *
 * `selectSettledTarget` ends its reason with the PR lane's remedy — "the lane keeps
 * its default per-provider parametrization". On the rotation that sentence is FALSE:
 * the lane does not keep multi-provider, it advances to the next active provider. A
 * log line that contradicts what the run did is worse than no line, so the advance
 * path composes its own diagnosis from the record while the verdict (`ok`) and the
 * payload validation stay shared — the two lanes still cannot drift on what "active"
 * means, which is the part that matters.
 * @param {Array<{provider: string, status: string, error?: string}>} providers
 * @param {string} provider
 * @returns {string}
 */
function advanceReason(providers, provider) {
  const record = providers.find((r) => r.provider === provider);
  if (!record) {
    return (
      `provider "${provider}" is absent from providers.json (present: ` +
      `${providers.map((r) => r.provider).join(", ") || "none"})`
    );
  }
  return (
    `provider "${provider}" probed "${record.status}" — collect-models reported: ` +
    `${record.error ?? "no error message"}`
  );
}

/**
 * Resolve the day's target, advancing through the rotation past unusable providers.
 *
 * @param {unknown} providers  parsed providers.json
 * @param {{ order?: string[], date?: Date }} [options]
 * @returns {{ ok: boolean, provider: string|null, model: string|null, reason: string|null, warnings: string[], skipped: Array<{provider: string, reason: string}> }}
 * @throws {Error} when the payload is not a readable provider record list, or the
 *   rotation order is empty — both are undecidable, not "nothing to pin" (#1035).
 */
export function selectDailyModelTarget(providers, options = {}) {
  const order = options.order ?? DEFAULT_ORDER;
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error("rotation order must be a non-empty list of provider names");
  }
  const start = rotationSlot(options.date ?? new Date(), order.length);

  // Rotate the order so the day's provider is first, then the fallbacks in order.
  const candidates = order.map((_, i) => order[(start + i) % order.length]);

  const skipped = [];
  for (const provider of candidates) {
    // Throws on a malformed payload — deliberately NOT caught: the first candidate
    // already proves the file is undecidable, and trying the rest would turn a hard
    // error into a quiet fallback.
    const attempt = selectSettledTarget(providers, { provider });
    if (attempt.ok) {
      return {
        ok: true,
        provider: attempt.provider,
        model: attempt.model,
        reason: null,
        warnings: skipped.map(
          (s) =>
            `rotation advanced past "${s.provider}" (this weekday's slot): ${s.reason}`,
        ),
        skipped,
      };
    }
    skipped.push({ provider, reason: advanceReason(providers, provider) });
  }

  return {
    ok: false,
    provider: null,
    model: null,
    reason:
      `no provider in the rotation (${order.join(", ")}) is usable, so there is no ` +
      `settled model to pin to — the lane keeps its default per-provider ` +
      `parametrization. With every key down that costs nothing extra and keeps the ` +
      `failure attributable. Per provider: ` +
      skipped.map((s) => `${s.provider} — ${s.reason}`).join(" | "),
    warnings: [],
    skipped,
  };
}

function parseArgs(argv) {
  const args = {
    providersFile: "tests/helpers/provider-setup/data/providers.json",
    order: DEFAULT_ORDER,
    date: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      args.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--providers-file") args.providersFile = value;
    else if (flag === "--order") {
      args.order = value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (args.order.length === 0) throw new Error("--order is empty");
    } else if (flag === "--date") args.date = new Date(value);
    else throw new Error(`unknown flag: ${flag}`);
    i++;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::select-daily-model-target: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let result;
  try {
    const { providers, missing } = readProvidersFile(args.providersFile);
    result = missing
      ? {
          ok: false,
          provider: null,
          model: null,
          reason:
            `${args.providersFile} does not exist — collect-models did not write ` +
            `it, so there is no settled model to pin to`,
          warnings: [],
          skipped: [],
        }
      : selectDailyModelTarget(providers, { order: args.order, date: args.date });
  } catch (error) {
    // Fail loud (#1035): a payload this cannot read must not read as "nothing to
    // pin". The lane is expected to fail here rather than quietly pay for a
    // multi-provider run nobody chose.
    process.stderr.write(`::error::select-daily-model-target: ${error.message}\n`);
    process.exit(2);
  }

  // Deviations first, so they are visible even when the pin succeeded.
  for (const warning of result.warnings) {
    process.stderr.write(`::warning::select-daily-model-target: ${warning}\n`);
  }

  if (result.ok) {
    // Both variables, always together — MODEL_TEST_PROVIDER on its own makes the
    // resolver skip the per-provider dedup and run that provider's whole catalog.
    const lines = [
      `MODEL_TEST_ID=${result.model}`,
      `MODEL_TEST_PROVIDER=${result.provider}`,
    ];
    if (process.env.GITHUB_ENV) {
      fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
    }
    process.stderr.write(
      `daily lane pinned to ${result.provider} / ${result.model} ` +
        `(settled by collect-models). The other providers' agent variants run on ` +
        `their own weekday; the provider-contract specs still cover every provider ` +
        `today.\n`,
    );
  } else {
    process.stderr.write(`::warning::select-daily-model-target: ${result.reason}\n`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
