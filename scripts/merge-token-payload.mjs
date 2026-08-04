#!/usr/bin/env node
/**
 * Fold the run's token spend into the payload the QA Platform already receives
 * (issue #1217 §5.2).
 *
 * WHY A SECOND POST AND NOT A REORDER
 *
 * daily-stable.yml builds payload.json (~:931) and POSTs the run (~:950) well
 * before `watch-tokens.mjs --summarize` (~:989) computes what the run cost. The
 * run's own POST must not wait behind a telemetry step, so this script runs
 * after the summarize and re-POSTs the same payload with a `tokens` block added.
 * The platform's edge function calls the ingest at both of its exit points --
 * including the short-circuit for a run it already recorded -- so the second
 * POST lands the token rows and leaves the run row untouched. Verified against
 * production on 2026-08-03: `status: exists`, `received: 4, inserted: 4`.
 *
 * THE BLOCK'S CONTRACT IS NOT DEFINED HERE
 *
 * `tokens` is opaque jsonb to the edge function, which passes it straight to
 * `public.e2e_ingest_run_tokens`. That function is the authority on which keys
 * mean anything -- see quality-platform's
 * supabase/migrations/20260803130300_e2e_ingest_run_tokens.sql:103-131. Unknown
 * keys are accepted and ignored, which is what lets this script carry
 * `target_provider` and the coverage fields before the platform reads them
 * (design §6.3).
 *
 * WHY A MISSING BLOCK MEANS "DO NOT POST" AND NOT "POST ZEROS"
 *
 * `summarize()` deliberately writes no block for a run that captured nothing.
 * Sending `{traces: 0, total_tokens: 0, rows: []}` would clamp the run's token
 * columns to zero, which is indistinguishable from a run that genuinely spent
 * nothing -- the one distinction e2e_automation_runs' token columns exist to
 * keep (20260803130100_e2e_run_token_columns.sql:14-16). So `written: false` is
 * a real outcome and the caller must honour it by skipping the POST.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const realIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, body) => writeFileSync(p, body),
  listDir: (dir) => readdirSync(dir).map((f) => path.join(dir, f)),
};

// Every shard resolves the day's provider independently -- the rotation walks on
// to the next provider when the day's own is dry, and that verdict depends on the
// providers.json that shard's own collect-models produced. So they CAN disagree.
// When they do, no value is published: reporting one shard's provider as "the
// run's" would name a provider the other shard never used, and design §6.4
// requires the field to be the RESOLVED value or nothing.
export function resolveTargetProvider(values = []) {
  const distinct = [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))].sort();
  if (distinct.length === 0) return { provider: null, conflict: [] };
  if (distinct.length === 1) return { provider: distinct[0], conflict: [] };
  return { provider: null, conflict: distinct };
}

export async function mergeTokenPayload({
  env = process.env,
  readFile = realIo.readFile,
  writeFile = realIo.writeFile,
  listDir = realIo.listDir,
  log = console.log,
} = {}) {
  const blockPath = env.TOKENS_SUMMARY_OUT || "tokens-block.json";
  const payloadIn = env.PAYLOAD_IN || "payload.json";
  const payloadOut = env.PAYLOAD_OUT || "payload-with-tokens.json";
  const tokensDir = env.TOKENS_DIR || "all-tokens";

  const readJson = (p) => {
    let raw;
    try {
      raw = readFile(p);
    } catch (error) {
      return { error: `could not read ${p}: ${error?.message || error}` };
    }
    try {
      return { value: JSON.parse(raw) };
    } catch (error) {
      return { error: `could not parse ${p}: ${error?.message || error}` };
    }
  };

  const block = readJson(blockPath);
  if (block.error) {
    const reason = `no tokens block to merge (${block.error})`;
    log(`merge-token-payload: ${reason} — skipping the token POST.`);
    return { written: false, reason };
  }

  const payload = readJson(payloadIn);
  if (payload.error) {
    const reason = `no run payload to merge into (${payload.error})`;
    log(`merge-token-payload: ${reason} — skipping the token POST.`);
    return { written: false, reason };
  }

  let providerFiles = [];
  try {
    providerFiles = listDir(tokensDir).filter((f) => path.basename(f).startsWith("token-provider-"));
  } catch {
    providerFiles = [];
  }
  const values = [];
  for (const file of providerFiles) {
    try {
      values.push(readFile(file));
    } catch {
      // A shard that uploaded no provider file simply does not vote.
    }
  }
  const { provider, conflict } = resolveTargetProvider(values);
  if (conflict.length) {
    log(
      `merge-token-payload: shards disagree on the resolved provider (${conflict.join(", ")}) — ` +
        "omitting target_provider rather than publishing one shard's value as the run's.",
    );
  } else if (!provider) {
    log("merge-token-payload: no shard recorded a resolved provider — omitting target_provider.");
  }

  // Second, deliberate guard: `resolveTargetProvider` is the first line of
  // defense (it already filters blank/whitespace values out before a `provider`
  // ever reaches here, so today `provider` is always exactly `null` or a
  // non-empty string). This ternary re-checks truthiness anyway, on purpose --
  // if that upstream filter is ever loosened, an empty string must still fail
  // to produce a `target_provider` key rather than silently publishing one.
  // The two guards are redundant today by design, not by accident; a change to
  // either one alone, with the other left intact, is not expected to be
  // independently observable from outside this module.
  const tokens = { ...block.value, ...(provider ? { target_provider: provider } : {}) };
  writeFile(payloadOut, JSON.stringify({ ...payload.value, tokens }));
  log(
    `merge-token-payload: wrote ${payloadOut} — ${tokens.rows?.length ?? 0} token row(s), ` +
      `${tokens.total_tokens ?? "?"} tokens, provider ${provider ?? "unreported"}.`,
  );
  return { written: true, reason: "merged" };
}

// `import.meta.url` guard: the test imports this module, and importing it must
// not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Deliberately no exit code branch: "nothing to merge" is a normal outcome and
  // the workflow gates on whether PAYLOAD_OUT exists, not on this process's
  // status. A non-zero exit here would only make the step's continue-on-error
  // swallow a message the log already carries.
  await mergeTokenPayload();
}
