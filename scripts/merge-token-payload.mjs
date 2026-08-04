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
 * mean anything -- and the LIVE definition is quality-platform's
 * supabase/migrations/20260803130600_e2e_token_ingest_preserve_upsert_clamp.sql,
 * which DROPped and replaced the original 20260803130300_e2e_ingest_run_tokens.sql
 * (#1253 review, finding 7: three files cited the dead one). Field names are
 * identical across the two, so nothing behaved wrongly -- but the semantics did
 * change: it upserts with DO UPDATE now, not ON CONFLICT DO NOTHING. Unknown
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

// The verdicts this script can reach, as the CLI prints them (`code=<…>`). Named
// here rather than inline so the workflow's own structural guard can assert that
// every one of them is handled by the step that reads them — a new code that the
// YAML silently falls through on would report a real outcome as the default one.
export const MERGE_CODES = [
  "merged",
  "block_missing",
  "block_unparseable",
  "payload_missing",
  "payload_unparseable",
];

// Every shard resolves the day's provider independently -- the rotation walks on
// to the next provider when the day's own is dry, and that verdict depends on the
// providers.json that shard's own collect-models produced. So they CAN disagree.
// When they do, no value is published: reporting one shard's provider as "the
// run's" would name a provider the other shard never used, and design §6.4
// requires the field to be the RESOLVED value or nothing.
//
// AN EMPTY FILE IS AN ABSTENTION, AND AN ABSTENTION IS NOT A VOTE (#1255 item 1)
//
// The shard writes its provider file UNCONDITIONALLY, and its comment in
// daily-stable.yml is explicit that an empty file means "the rotation declined to
// pin" and "must not be confused with a shard that failed to report". This function
// used to `.filter(Boolean)` and stop there, which made empty, whitespace and
// no-file-at-all the same thing -- discarding, one step later, exactly the
// distinction the shard takes care to preserve.
//
// The case that made it wrong: shard 1 pinned `anthropic`, shard 2's `Rotate the
// lane` step failed (it is continue-on-error) and wrote an empty file. One distinct
// value survived the filter, so the run published `target_provider: anthropic` for a
// run that partly swept every provider -- with no conflict to log, because there was
// none to see. That is a label that looks resolved and is not.
//
// So a PARTIAL pin resolves to no provider, the same way a disagreement does: the
// field is the resolved value or nothing. The counts ride along either way
// (`shards`), so the information is recorded rather than thrown away, and a reader
// can tell a full pin from a partial one from an absent one. Publishing the majority
// value plus a `partial: true` flag was the alternative and is one line from here --
// rejected because a consumer reading only `target_provider` (which is every
// consumer today, §6.3 not being built yet) would read a partial sweep as a full
// one, which is the failure this whole path exists to prevent.
//
// A SHARD THAT NEVER REPORTED IS THE THIRD CASE, AND `expected` IS HOW IT IS SEEN
//
// The same defect one layer up: a shard whose artifact never uploaded produces no
// file at all, so it is neither a vote nor an abstention -- it is invisible. Three
// shards of four naming `anthropic` would read as `{named: 3, abstained: 0}` and
// resolve as a full pin. `expected` (the run's own shard_total, passed in from the
// workflow) is the only thing that can see the gap, since nothing in the token
// artifacts records how many shards there were meant to be.
//
// Unknown `expected` keeps the old behaviour rather than defaulting to "partial":
// this function is also called from lanes that do not shard, and treating an absent
// count as a missing shard would omit the provider on every one of them.
export function resolveTargetProvider(values = [], expected) {
  const trimmed = values.map((v) => String(v ?? "").trim());
  const abstained = trimmed.filter((v) => !v).length;
  const distinct = [...new Set(trimmed.filter(Boolean))].sort();
  const total = Number(expected);
  const knownExpected = Number.isFinite(total) && total > 0;
  const missing = knownExpected ? Math.max(0, total - trimmed.length) : 0;
  const shards = {
    named: trimmed.length - abstained,
    abstained,
    ...(knownExpected ? { expected: total, missing } : {}),
  };
  if (distinct.length === 0) return { provider: null, conflict: [], shards, partial: false };
  if (distinct.length > 1) return { provider: null, conflict: distinct, shards, partial: false };
  // Exactly one named provider. It is the run's only if every shard that was meant
  // to report did, and each one pinned it.
  if (abstained > 0 || missing > 0) {
    return { provider: null, conflict: [], shards, partial: true, majority: distinct[0] };
  }
  return { provider: distinct[0], conflict: [], shards, partial: false };
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

  // `kind` separates ABSENT from UNPARSEABLE. Both end the same way here — no
  // POST — but they are different facts about the run, and the caller (the
  // workflow step) is the place where collapsing them does damage: an absent
  // block is a run that captured nothing, while an unparseable one is a run
  // whose numbers were computed and then lost. Reporting the second as the
  // first is the absent-vs-zero conflation this whole path exists to prevent,
  // reproduced one layer up (#1253 review, finding 3).
  const readJson = (p) => {
    let raw;
    try {
      raw = readFile(p);
    } catch (error) {
      return { kind: "missing", error: `could not read ${p}: ${error?.message || error}` };
    }
    try {
      return { value: JSON.parse(raw) };
    } catch (error) {
      return { kind: "unparseable", error: `could not parse ${p}: ${error?.message || error}` };
    }
  };

  const block = readJson(blockPath);
  if (block.error) {
    const reason = `no tokens block to merge (${block.error})`;
    log(`merge-token-payload: ${reason} — skipping the token POST.`);
    return { written: false, reason, code: `block_${block.kind}` };
  }

  const payload = readJson(payloadIn);
  if (payload.error) {
    const reason = `no run payload to merge into (${payload.error})`;
    log(`merge-token-payload: ${reason} — skipping the token POST.`);
    return { written: false, reason, code: `payload_${payload.kind}` };
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
  const { provider, conflict, shards, partial, majority } = resolveTargetProvider(
    values,
    env.TOKENS_SHARD_TOTAL,
  );
  if (conflict.length) {
    log(
      `merge-token-payload: shards disagree on the resolved provider (${conflict.join(", ")}) — ` +
        "omitting target_provider rather than publishing one shard's value as the run's.",
    );
  } else if (partial) {
    // The one outcome that used to publish a wrong label instead of no label.
    const of = shards.expected ?? shards.named + shards.abstained;
    log(
      `merge-token-payload: only ${shards.named} of ${of} shard(s) pinned a provider ` +
        `(${majority}); ${shards.abstained} abstained and ${shards.missing ?? 0} never reported, ` +
        "so part of this run swept every provider — omitting target_provider and carrying the " +
        "counts instead.",
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
  //
  // `target_provider_shards` rides ALWAYS, including when the provider itself is
  // omitted — that is the point (#1255 item 1). Omitting the label without recording
  // why leaves "no shard pinned anything", "the shards disagreed" and "some shards
  // abstained" looking identical from the platform's side, which is the same
  // three-outcomes-one-message failure the verdict `code` above exists to avoid. The
  // ingest accepts unknown keys and ignores them (§6.3 is not built yet), so this
  // costs nothing today and is already there when it is.
  const tokens = {
    ...block.value,
    ...(provider ? { target_provider: provider } : {}),
    target_provider_shards: shards,
  };
  writeFile(payloadOut, JSON.stringify({ ...payload.value, tokens }));
  log(
    `merge-token-payload: wrote ${payloadOut} — ${tokens.rows?.length ?? 0} token row(s), ` +
      `${tokens.total_tokens ?? "?"} tokens, provider ${provider ?? "unreported"} ` +
      `(${shards.named} pinned, ${shards.abstained} abstained).`,
  );
  return { written: true, reason: "merged", code: "merged" };
}

// `import.meta.url` guard: the test imports this module, and importing it must
// not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Deliberately no exit code branch: "nothing to merge" is a normal outcome and
  // the workflow gates on whether PAYLOAD_OUT exists, not on this process's
  // status. A non-zero exit here would only make the step's continue-on-error
  // swallow a message the log already carries.
  const result = await mergeTokenPayload();
  // The LAST line, and machine-readable on purpose: daily-stable.yml greps this
  // to tell "captured nothing" from "computed and then lost". The prose above is
  // for a human reading the log; `code=` is the contract, and MERGE_CODES below
  // is the list the workflow's own guard is pinned against.
  console.log(`merge-token-payload: code=${result.code}`);
}
