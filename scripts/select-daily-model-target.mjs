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
 * Every deviation is loud, and — since #1456 — costed: a displaced slot renders as a
 * run-summary block naming the provider, the cause and how long it now goes
 * uncovered (`rotationDisplacement` below).
 *
 * It is stated ON THE DAY because it cannot be reconstructed afterwards. This header
 * used to claim the opposite — "the resolved provider and model land in the `param`
 * field of `reports/daily-history.jsonl`, so 'which provider did Tuesday actually
 * run?' is answerable without opening the job log" — and that is FALSE, measured on
 * the committed series: `append-weekly-history.mjs` attaches `param` to entries in
 * `failures` and `flaky`, per TEST, so a green day records no provider at all and a
 * red one records only the providers that failed. The retrospective question needs a
 * run-level field the appender does not write; adding one is a separate decision.
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
import { displaySafe, tableCell } from "./lib/display-text.mjs";
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
        // Index-aware (#1801): only the FIRST candidate owns this weekday. Saying
        // "(this weekday's slot)" for the fallbacks made the run contradict itself
        // inside one annotation stream — the very defect `displacementLines` was
        // fixed for, still being emitted two lines above it.
        warnings: skipped.map((s, index) =>
          index === 0
            ? `rotation advanced past "${s.provider}", this weekday's slot: ${s.reason}`
            : `rotation also passed over the fallback "${s.provider}": ${s.reason}`,
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

/**
 * The next weekday this provider's rotation slot comes round, counted from `from`.
 *
 * DERIVED from the rotation rather than looked up in the run history, and that is
 * the whole reason this function exists (#1456). What a displaced slot COSTS is a
 * property of the schedule — the cron is Mon-Fri and the slot repeats every
 * `order.length` weekdays — so it is computable on the day it happens. The
 * retrospective question ("when did google last actually run?") is NOT computable:
 * `reports/daily-history.jsonl` records `param` per FAILING test, so a green day
 * leaves no record of which provider it resolved. Answering that needs a run-level
 * field the appender does not write today, which is a separate decision.
 *
 * Weekends are skipped rather than counted, because the schedule does not run them.
 * That is what makes google's cost 7 days and not 3: with the default three-provider
 * order it owns Wednesday alone, and Saturday's slot — which would also be its — is
 * not a run.
 *
 * @param {string} provider
 * @param {string[]} order rotation order
 * @param {Date} from the displaced run's own instant
 * @returns {{ days: number, date: Date }|null} null when the provider is not in the
 *   order at all, or when no weekday in the next fortnight resolves to it (only
 *   possible for an order longer than the working week)
 */
export function nextScheduledSlot(provider, order, from) {
  const slot = order.indexOf(provider);
  if (slot < 0) return null;
  for (let days = 1; days <= 14; days++) {
    const date = new Date(from.getTime() + days * 86400000);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // the cron is Mon-Fri
    if (rotationSlot(date, order.length) === slot) return { days, date };
  }
  return null;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** `2026-09-09` — the date half of an ISO instant, which is how the history keys days. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * What the rotation did, when it did not do the obvious thing.
 *
 * Returns `null` on the ordinary day — the day's provider was usable — because a
 * block printed on every run is the artifact #1252 already measured: `mode=count`
 * was in the daily's log for weeks and read by nobody.
 *
 * @param {{ ok: boolean, provider: string|null, skipped: Array<{provider: string, reason: string}> }} result
 * @param {{ order?: string[], date?: Date }} [options]
 */
export function rotationDisplacement(result, options = {}) {
  const skipped = result?.skipped ?? [];
  if (skipped.length === 0) return null;
  const order = options.order ?? DEFAULT_ORDER;
  const date = options.date ?? new Date();
  return {
    weekday: WEEKDAY_NAMES[date.getUTCDay()],
    day: isoDay(date),
    resolved: result.ok ? result.provider : null,
    // `skipped` holds EVERY candidate the rotation tried, and only the first owns
    // this weekday — the rest are fallbacks it reached for and also found unusable
    // (#1801). Describing all of them as "this weekday's slot" produced a line that
    // contradicted itself inside one sentence on a two-dead-provider day, and gave
    // a fallback a next-slot gap it does not have.
    displaced: skipped.map((entry, index) => {
      const owns = index === 0;
      const next = owns ? nextScheduledSlot(entry.provider, order, date) : null;
      return {
        provider: entry.provider,
        reason: entry.reason,
        owns,
        nextDay: next ? isoDay(next.date) : null,
        nextWeekday: next ? WEEKDAY_NAMES[next.date.getUTCDay()] : null,
        days: next ? next.days : null,
      };
    }),
  };
}

/**
 * One line per displaced provider, for the log — the only surface the VM lane has
 * (it runs this script outside Actions, so `$GITHUB_STEP_SUMMARY` is unset there).
 *
 * @param {ReturnType<typeof rotationDisplacement>} displacement
 * @returns {string[]}
 */
/**
 * `displaySafe`, not `tableCell`: these lines become `::warning::` ANNOTATIONS, which
 * are line-oriented — a newline inside the reason ends the annotation and drops the
 * rest into plain log. Not hypothetical, and it is the case `lib/display-text.mjs`'s
 * own header names: `collect-models.ts` writes a collector STALL reason built by
 * `formatSaveBusyFailure()`, which is deliberately several lines, so on a stall day
 * the annotation terminated at "…over 120 poll(s)." and its seven remaining lines —
 * including "Most likely: the credential write is still in flight." — fell out of it.
 *
 * The pipe is left alone here on purpose: nothing downstream renders these as a table,
 * and `\|` inside an annotation is noise. The table has `tableCell` for that.
 */
export function displacementLines(displacement) {
  if (!displacement) return [];
  const instead = displacement.resolved
    ? `the lane ran ${displacement.resolved} instead`
    : "the lane declined to pin at all";
  return displacement.displaced.map((entry) => {
    if (!entry.owns) {
      // A fallback, not this weekday's provider: it loses no slot of its own here,
      // so it gets no gap and no ownership claim (#1801).
      return (
        `rotation: the fallback "${entry.provider}" was also unusable, so it was ` +
        `passed over too. Cause: ${displaySafe(entry.reason)}`
      );
    }
    const cost =
      entry.days === null
        ? "it has no further slot in the next fortnight"
        : `its next slot is ${entry.nextWeekday} ${entry.nextDay}, ${entry.days} day(s) ` +
          `from this run — nothing runs an agent spec against it until then`;
    return (
      `rotation: ${displacement.weekday} is "${entry.provider}"'s slot and ` +
      `${instead}; ${cost}. Cause: ${displaySafe(entry.reason)}`
    );
  });
}

/**
 * The one-line form, for the shards that are not rendering the table (#1801).
 *
 * The first shape of this fix pinned the block to shard 1 and SUPPRESSED it
 * everywhere else, which made the only rendered surface depend on shard 1 reaching
 * step six of its job — and this workflow's own comments record shards dying before
 * that (#1011, 2026-07-28). On a day a provider key is drained AND shard 1's backend
 * never recovers, the run page would have shown the displacement nowhere at all,
 * which is strictly worse than showing it four times: #1252's lesson is that a fact
 * only in the log is not a signal.
 *
 * So every shard writes something to the summary; only one writes the table. The
 * line carries the provider, the gap and the cause, so a lost table costs detail
 * rather than the fact.
 *
 * @param {ReturnType<typeof rotationDisplacement>} displacement
 * @returns {string}
 */
function renderCompactRotationNote(displacement) {
  const owner = displacement.displaced.find((d) => d.owns);
  if (!owner) return "";
  const gap =
    owner.days === null
      ? "no further slot in the next fortnight"
      : `next ${owner.nextWeekday} ${owner.nextDay}, ${owner.days} day(s)`;
  const outcome = displacement.resolved
    ? `the lane ran \`${displacement.resolved}\``
    : "the lane declined to pin at all";
  return (
    `> ${displacement.resolved ? "⚠️" : "❌"} Rotation displaced — ` +
    `\`${owner.provider}\` lost ${displacement.weekday}'s slot (${gap}); ${outcome}. ` +
    `Full table in this run's shard-1 summary. Cause: ${tableCell(owner.reason)}\n\n`
  );
}

/**
 * The run-summary block for a displaced rotation (#1456).
 *
 * The rotation already emitted a `::warning::` for this before, which is precisely
 * the surface #1252 showed nobody reads. This lands in the run summary, and it leads
 * with the COST rather than with the mechanism: a provider losing its slot is only
 * legible if the reader is told how long the gap is.
 *
 * @param {ReturnType<typeof rotationDisplacement>} displacement
 * @returns {string} markdown, or "" when the rotation ran its own weekday's provider
 */
export function renderRotationSummary(displacement, { compact = false } = {}) {
  if (!displacement) return "";
  if (compact) return renderCompactRotationNote(displacement);
  // The weekday's own provider, and the fallbacks the rotation walked past. Only the
  // first is losing a slot; conflating them is what #1801 fixed.
  const owner = displacement.displaced.find((d) => d.owns);
  const fallbacks = displacement.displaced.filter((d) => !d.owns);

  const lines = [
    displacement.resolved
      ? `### ⚠️ Rotation displaced — ${displacement.weekday}'s provider could not run`
      : `### ❌ Rotation could not pin — no provider in the rotation is usable`,
    "",
    displacement.resolved
      ? `\`daily-stable\` runs ONE provider per weekday (#1185). ` +
        `${displacement.weekday} ${displacement.day} belongs to ` +
        `\`${owner ? owner.provider : "?"}\`, which could not serve this run, so the ` +
        `lane advanced to **${displacement.resolved}**` +
        (fallbacks.length > 0
          ? ` — past ${fallbacks
              .map((d) => `\`${d.provider}\``)
              .join(", ")}, also unusable`
          : "") +
        `. The day is not lost; that provider's is.`
      : `\`daily-stable\` found no usable provider in the rotation, so it kept its ` +
        `default per-provider parametrization.`,
    "",
    "| Provider | Role today | Next scheduled slot | Gap | Why it could not run |",
    "|---|---|---|---|---|",
  ];
  for (const entry of displacement.displaced) {
    lines.push(
      `| \`${entry.provider}\` | ${
        entry.owns
          ? `this weekday's slot`
          : // "passed over" claims the lane advanced to something. On a declined
            // pin nothing was passed over — it kept multi-provider (#1801).
            displacement.resolved
            ? "fallback, passed over"
            : "also unusable"
      } | ${
        !entry.owns
          ? "—"
          : entry.nextDay
            ? `${entry.nextWeekday} ${entry.nextDay}`
            : "none in the next fortnight"
      } | ${!entry.owns || entry.days === null ? "—" : `${entry.days} day(s)`} | ${
        tableCell(entry.reason)
      } |`,
    );
  }
  lines.push(
    "",
    "The gap is derived from the schedule, not from the run history: a history row " +
      "records the day's `skipped` count and never its reason, so this block is the " +
      "only place the loss is stated (#1456).",
    "",
  );
  return `${lines.join("\n")}\n`;
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

  // `result.warnings` is NOT printed here: on the path that produces it, every one
  // of its entries is the same fact `displacementLines` below states with the gap
  // attached, so printing both put two phrasings of one deviation in the same
  // annotation stream (#1801). The field stays on the returned JSON for consumers.

  // A displaced slot costs a provider up to a week of coverage, and until #1456 the
  // only trace of it was the `::warning::` above. The run summary is where a human
  // already looks; the log lines carry the same fact to the VM lane, which runs this
  // script outside Actions and has no step summary.
  const displacement = rotationDisplacement(result, {
    order: args.order,
    date: args.date ?? new Date(),
  });
  for (const line of displacementLines(displacement)) {
    process.stderr.write(`::warning::select-daily-model-target: ${line}\n`);
  }
  // ROTATION_SUMMARY=0 asks for the COMPACT line rather than the table — it does
  // not suppress. This script runs in the `test` job, one job per shard, so the full
  // block rendered 4-10 identical times across the run page (#1252's own shape); but
  // pinning it to shard 1 and writing nothing elsewhere made the only rendered
  // surface depend on that shard surviving to step six, which this workflow records
  // shards failing to do (#1011). Every shard writes something; one writes the table.
  // Unset (local, VM) means the full block.
  if (displacement && process.env.GITHUB_STEP_SUMMARY) {
    // Best effort: a summary that cannot be written must not cost the lane its pin.
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderRotationSummary(displacement, {
          compact: process.env.ROTATION_SUMMARY === "0",
        }),
      );
    } catch (error) {
      process.stderr.write(
        `::warning::select-daily-model-target: could not write the run summary: ${error.message}\n`,
      );
    }
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
    // `displaySafe` for the same reason `displacementLines` has it: an annotation is
    // LINE-ORIENTED, and `result.reason` carries the provider's own error body — a
    // collector stall reason is deliberately several lines, so the annotation
    // terminated at its first and the rest fell into plain log. The first fix of
    // #1801's defect 4 reached `displacementLines` and missed this one, on the same
    // stream and on the day it matters more: this is the line that fires when NO
    // provider in the rotation is usable.
    process.stderr.write(
      `::warning::select-daily-model-target: ${displaySafe(result.reason)}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
