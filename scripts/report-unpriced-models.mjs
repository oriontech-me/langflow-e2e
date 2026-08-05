#!/usr/bin/env node
/**
 * Raise the one token-cost failure that cannot be repaired after the fact: a
 * model this run spent on that scripts/lib/model-prices.json does not price.
 *
 * ## Why this needs its own reporter
 *
 * The QA Platform freezes `price_key` at INGEST. The producer resolves it here
 * (resolvePriceKey in lib/token-cost.mjs), the ingest stores it verbatim, and
 * every dollar figure downstream joins `e2e_model_prices ON m.price_key =
 * t.price_key`. A NULL key joins to nothing forever. So the two ways a model can
 * be unpriced are NOT the same repair:
 *
 *   the platform's MIRROR lacks the row  -> fixable retroactively; the join is at
 *                                          read time, so one sync back-prices
 *                                          every run that already carries the key
 *   THIS FILE lacks the model            -> NOT fixable; the key froze as NULL.
 *                                          Adding the price fixes future runs and
 *                                          nothing past.
 *
 * This reporter is aimed at the second case, which is also the case only this
 * repository can see and only this repository can fix.
 *
 * ## Why it is not enough that summarize() already knows
 *
 * `--summarize` has always computed `unpricedModels` and always printed it -- as
 * `(a FLOOR — N model(s) have no price entry: …)` in the step summary of a
 * workflow that is usually green. Nobody opens the step summary of a green run.
 * It went unnoticed twice in two days: claude-haiku-4-5 (2026-08-03, 44,884
 * tokens) and gpt-5-mini (2026-08-04, 584 tokens from the Azure AI Foundry
 * provider spec, which left the whole run's dollars a floor). Both were found by
 * someone happening to open a dashboard, days later in the first case.
 *
 * ## What it does NOT do
 *
 * It does not open the issue. Like report-backend-outages.mjs, it computes and
 * emits -- GITHUB_OUTPUT for the workflow to act on, an annotation so the signal
 * exists even if the issue step is skipped, and markdown for the issue body. The
 * GitHub write stays in the workflow, where the token and the permission live.
 *
 * It also cannot see a model whose price EXISTS here but is missing from the
 * platform's mirror. That case is invisible from this side and does not need this
 * alarm: it back-prices itself the moment the mirror syncs, and the platform's
 * own gap panel names it.
 *
 * ## Contract
 *
 * Reads the tokens block written by `watch-tokens.mjs --summarize`
 * (TOKENS_SUMMARY_OUT). Deliberately NOT reports/token-history.jsonl, which
 * carries the same field but is SUPPRESSED on the manual and PR lanes
 * (TOKENS_SUPPRESS_HISTORY) -- and the manual lane is exactly where gpt-5-mini
 * appeared. The block is written on every lane that names an output path.
 *
 * Absent block means the run captured nothing to price, which is not the same as
 * a run whose models are all priced. Both are silent here, but the reasons are
 * logged differently so a reader can tell them apart.
 *
 * Outputs (GITHUB_OUTPUT):
 *   count       integer, 0 when there is nothing to raise
 *   models      comma-separated model ids, empty when count is 0
 *   summary_md  markdown for the issue body, empty when count is 0
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Exit codes are informational only; the workflow step is continue-on-error. */
export const VERDICTS = {
  NO_BLOCK: "no_block",
  UNPARSEABLE: "unparseable",
  ALL_PRICED: "all_priced",
  UNPRICED: "unpriced",
};

/**
 * Pull the unpriced model list out of a parsed block.
 *
 * Tolerant of shape on purpose: this runs in a telemetry step that must never
 * fail the suite, and a block written by an older revision of watch-tokens.mjs
 * simply has no such field. A non-array, or an array with non-string junk in it,
 * is filtered rather than thrown on -- but note that filtering is NOT silence:
 * `dropped` is reported so a malformed field cannot masquerade as "all priced".
 */
export function extractUnpriced(block) {
  const raw = block?.unpriced_models;
  if (!Array.isArray(raw)) return { models: [], dropped: raw === undefined ? 0 : 1 };
  const models = [];
  let dropped = 0;
  for (const m of raw) {
    if (typeof m === "string" && m.trim()) models.push(m.trim());
    else dropped++;
  }
  // Sorted and de-duplicated so the issue body is stable across runs: an
  // unstable order would make every run look like a new finding.
  return { models: [...new Set(models)].sort(), dropped };
}

/**
 * The issue body. Names the repair, not just the symptom -- the whole reason the
 * gpt-5-mini diagnosis took reading four files across two repositories is that
 * the message on screen pointed at the wrong repo.
 */
export function renderBody(models, { runId, runUrl, workflow, runDate } = {}) {
  const lines = [
    `${models.length} model(s) reported token spend that \`scripts/lib/model-prices.json\` does not price:`,
    "",
    ...models.map((m) => `- \`${m}\``),
    "",
    "### Why this is urgent rather than cosmetic",
    "",
    "The QA Platform freezes `price_key` at ingest. Adding the price later prices",
    "every FUTURE run and **cannot** price the runs already recorded — their rows",
    "keep a NULL key and stay a floor permanently. Every hour this stays open is",
    "another run that can never be priced.",
    "",
    "### The fix",
    "",
    "1. Add each model above to `scripts/lib/model-prices.json` with a verified rate",
    "   and an explicit `provider`. A TIER id (Mini, Nano, Lite, Pro) always needs",
    "   its own row — the resolver refuses to guess a tier's price from its sibling.",
    "2. Merging fires `sync-model-prices.yml`, which installs the row on the platform.",
    "3. Runs already recorded need a backfill on the platform side; the price file",
    "   alone will not reach them.",
    "",
    "Do **not** hand-insert a row into the platform's `e2e_model_prices` — it is a",
    "projection of this file and the next sync deletes anything not here.",
  ];
  const where = [];
  if (workflow) where.push(`workflow \`${workflow}\``);
  if (runDate) where.push(`run date ${runDate}`);
  if (runId) where.push(runUrl ? `[run ${runId}](${runUrl})` : `run ${runId}`);
  if (where.length) {
    lines.push("", `First seen: ${where.join(" · ")}.`);
  }
  return lines.join("\n");
}

const realIo = {
  readFile: (p) => fs.readFileSync(p, "utf8"),
  appendFile: (p, text) => fs.appendFileSync(p, text),
};

export function reportUnpricedModels({
  env = process.env,
  readFile = realIo.readFile,
  appendFile = realIo.appendFile,
  log = console.log,
} = {}) {
  const blockPath = env.TOKENS_SUMMARY_OUT || "tokens-block.json";

  const emit = (count, models, body) => {
    if (!env.GITHUB_OUTPUT) return;
    // Multi-line values need the heredoc form; a bare `k=v` truncates at the
    // first newline and would ship a one-line issue body.
    const lines = [
      `count=${count}`,
      `models=${models.join(",")}`,
      "summary_md<<UNPRICED_MD_EOF",
      body,
      "UNPRICED_MD_EOF",
    ];
    try {
      appendFile(env.GITHUB_OUTPUT, lines.join("\n") + "\n");
    } catch (error) {
      log(`report-unpriced-models: could not write GITHUB_OUTPUT: ${error?.message || error}`);
    }
  };

  let text;
  try {
    text = readFile(blockPath);
  } catch {
    // Not a warning. No block means the run captured no tokens at all, which is
    // a different fact from "every model was priced" and must not be reported as
    // an all-clear.
    log(`report-unpriced-models: code=${VERDICTS.NO_BLOCK} — no tokens block at ${blockPath}; this run captured nothing to price.`);
    emit(0, [], "");
    return { verdict: VERDICTS.NO_BLOCK, models: [] };
  }

  let block;
  try {
    block = JSON.parse(text);
  } catch (error) {
    // The block was computed and then lost. Loud, because the unpriced list for
    // this run is now unknown -- not empty.
    log(`::warning::The tokens block at ${blockPath} is unparseable, so this run's unpriced-model list is UNKNOWN, not empty: ${error?.message || error}`);
    log(`report-unpriced-models: code=${VERDICTS.UNPARSEABLE}`);
    emit(0, [], "");
    return { verdict: VERDICTS.UNPARSEABLE, models: [] };
  }

  const { models, dropped } = extractUnpriced(block);
  if (dropped > 0) {
    log(`::warning::The tokens block's unpriced_models field held ${dropped} entr(y/ies) this reporter could not read. Treat the list below as INCOMPLETE.`);
  }

  if (models.length === 0) {
    log(`report-unpriced-models: code=${VERDICTS.ALL_PRICED} — every model this run spent on has a price entry.`);
    emit(0, [], "");
    return { verdict: VERDICTS.ALL_PRICED, models: [] };
  }

  const body = renderBody(models, {
    runId: env.GITHUB_RUN_ID,
    runUrl: env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY && env.GITHUB_SERVER_URL
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : "",
    workflow: env.WORKFLOW || env.GITHUB_WORKFLOW,
    runDate: env.RUN_DATE,
  });

  // The annotation is the floor of this feature: it shows on the run's Checks
  // view even if the issue step is skipped, misconfigured, or loses its
  // permission.
  log(`::warning::${models.length} model(s) spent tokens with no price entry in scripts/lib/model-prices.json: ${models.join(", ")}. price_key freezes at ingest, so every run recorded before this is fixed can NEVER be priced.`);
  log(`report-unpriced-models: code=${VERDICTS.UNPRICED} models=${models.join(",")}`);
  emit(models.length, models, body);
  return { verdict: VERDICTS.UNPRICED, models, body };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    reportUnpricedModels();
  } catch (error) {
    // Swallowed, like the liveness reporter: a defect in a diagnostic must never
    // be the reason a run's real reporting steps are skipped.
    console.log(`report-unpriced-models: unexpected failure, continuing: ${error?.message || error}`);
  }
}
