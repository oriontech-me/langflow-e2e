#!/usr/bin/env node
/**
 * Picks the single model target the **PR lane** should run its LLM specs against,
 * out of what `collect-models` actually settled on (#1169).
 *
 * ## Why the PR lane pins one provider at all
 *
 * `getTestTargets()` (~17 agent specs) parametrizes over **one model per active
 * provider**, so every LLM spec selected by the impacted-specs job runs once per
 * provider whose key is in the repo secrets — openai *and* anthropic *and* google.
 * That is the right shape for `daily-stable.yml`, which is the lane that owes
 * multi-provider coverage. It is the wrong shape here, and the cost is not
 * theoretical: measured 2026-07-31, `pr-validation.yml` ran **141 times in
 * 3.5 days** (37/49/49/6 per day), each model-needing run paying an anthropic
 * variant of every impacted agent spec — on `claude-sonnet-5` at $3/$15 per MTok
 * against `gpt-4o-mini` at ~$0.15/$0.60, i.e. **20-25x the price per token** for
 * the same assertions, with no prompt caching on the anthropic side (Langflow
 * sets no `cache_control`, so every turn re-sends the agent prompt and tool
 * schemas at full price). Both the CI secret and the local `.env` key drained
 * inside that window — Anthropic credit is **account-scoped**, so the two share
 * one balance and the PR lane was the volume driver.
 *
 * So: the PR lane answers "does this PR break the specs it touches", which one
 * provider settles. The daily keeps answering "does it break on every provider".
 *
 * ## Why this is a script and not two `env:` lines
 *
 * Two reasons, both of which have already bitten this repo:
 *
 * 1. **`MODEL_TEST_PROVIDER` alone is a trap, not a filter.** In
 *    `getTestTargets()` the `MODEL_TEST_PROVIDER` branch filters the catalog by
 *    provider and **skips the first-per-provider dedup**, so setting it without
 *    `MODEL_TEST_ID` runs *every* model that provider exposes — 41 openai entries
 *    in the catalog collected 2026-07-30. That turns a cost fix into a 41x cost
 *    regression. The two variables are a **pair**; this script never emits one
 *    without the other.
 * 2. **The model has to be the settled one.** Hardcoding `gpt-4o-mini` in YAML
 *    fails silently the day it retires or the CI project loses access:
 *    `getTestTargets()` warns `MODEL_TEST_ID="…" not found in models.json` and
 *    returns a target with no provider, so the spec skips and the PR still reads
 *    green — the exact silent-skip failure #570 and #1012 exist to prevent.
 *    `providers.json` already records what `collect-models` probed successfully;
 *    read that.
 *
 * ## When it declines to pin
 *
 * If the chosen provider is not `active` (drained key, dead credential), pinning
 * to it would make every parametrized spec skip — trading spend for **zero**
 * coverage. The decision then is `ok: false`, the lane keeps its existing
 * multi-provider behaviour, and the reason is printed as a `::warning::`. That is
 * a deliberate fallback to the *more expensive* path, because a PR check that
 * runs nothing is worth less than one that costs more (#980's trade: a provider
 * outage must not silently erode coverage). A payload it cannot read at all is a
 * hard error (exit 2) rather than a quiet fallback — #1035's rule.
 *
 * Run:
 *   node scripts/select-pr-model-target.mjs \
 *     --providers-file tests/helpers/provider-setup/data/providers.json \
 *     --provider openai
 *
 * Output (stdout, JSON): { ok, provider, model, reason, warnings }
 * Side effect: appends `MODEL_TEST_ID` / `MODEL_TEST_PROVIDER` to `$GITHUB_ENV`
 * when it pins and that variable is set.
 */

import fs from "node:fs";

const HELP = `usage: select-pr-model-target.mjs [options]

  --providers-file PATH  providers.json written by collect-models
                         (default: tests/helpers/provider-setup/data/providers.json)
  --provider NAME        provider to pin the lane to (default: openai)
`;

const DEFAULT_PROVIDERS_FILE =
  "tests/helpers/provider-setup/data/providers.json";

/**
 * @param {unknown} providers parsed `providers.json` payload
 * @param {{ provider?: string }} [options]
 * @returns {{ ok: boolean, provider: string, model: string|null, reason: string|null, warnings: string[] }}
 * @throws {Error} when the payload is not a readable provider record list
 */
export function selectPrModelTarget(providers, options = {}) {
  const provider = options.provider ?? "openai";

  if (!Array.isArray(providers)) {
    throw new Error(
      `providers.json must be an array of provider records, got ${
        providers === null ? "null" : typeof providers
      }`,
    );
  }

  for (const [i, record] of providers.entries()) {
    if (record === null || typeof record !== "object") {
      throw new Error(
        `providers.json[${i}] must be an object, got ${
          record === null ? "null" : typeof record
        }`,
      );
    }
    if (typeof record.provider !== "string" || record.provider === "") {
      throw new Error(`providers.json[${i}] has no "provider" name`);
    }
    if (typeof record.status !== "string" || record.status === "") {
      throw new Error(
        `providers.json[${i}] ("${record.provider}") has no "status"`,
      );
    }
  }

  const record = providers.find((r) => r.provider === provider);
  if (!record) {
    return {
      ok: false,
      provider,
      model: null,
      reason:
        `provider "${provider}" is absent from providers.json (present: ` +
        `${providers.map((r) => r.provider).join(", ") || "none"}) — ` +
        `leaving the lane on its default per-provider parametrization`,
      warnings: [],
    };
  }

  if (record.status !== "active") {
    return {
      ok: false,
      provider,
      model: null,
      reason:
        `provider "${provider}" probed "${record.status}" — pinning the lane to ` +
        `it would skip every parametrized spec, so the lane keeps its default ` +
        `per-provider parametrization (costlier, but it covers something). ` +
        `collect-models reported: ${record.error ?? "no error message"}`,
      warnings: [],
    };
  }

  if (typeof record.model !== "string" || record.model === "") {
    throw new Error(
      `provider "${provider}" is active but carries no settled "model" — ` +
        `providers.json is inconsistent`,
    );
  }

  return {
    ok: true,
    provider,
    model: record.model,
    reason: null,
    warnings: [],
  };
}

/**
 * Reads the providers file. A missing file is a legitimate state (the sweep was
 * skipped, or ran `continue-on-error` on a canary), not a crash.
 * @returns {{ providers: unknown, missing: boolean }}
 */
export function readProvidersFile(providersFile, { readFile, exists } = {}) {
  const fileExists = exists ?? ((p) => fs.existsSync(p));
  const read = readFile ?? ((p) => fs.readFileSync(p, "utf-8"));

  if (!fileExists(providersFile)) return { providers: null, missing: true };
  return { providers: JSON.parse(read(providersFile)), missing: false };
}

function parseArgs(argv) {
  const args = { providersFile: DEFAULT_PROVIDERS_FILE, provider: "openai" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i++;
    if (flag === "--providers-file") args.providersFile = value;
    else if (flag === "--provider") args.provider = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::select-pr-model-target: ${error.message}\n`);
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
          provider: args.provider,
          model: null,
          reason:
            `${args.providersFile} does not exist — collect-models did not write ` +
            `it, so there is no settled model to pin to`,
          warnings: [],
        }
      : selectPrModelTarget(providers, { provider: args.provider });
  } catch (error) {
    // Fail loud: a payload this cannot read must not read as "nothing to pin"
    // (#1035). The lane is expected to fail here rather than quietly pay for a
    // multi-provider run it did not choose.
    process.stderr.write(`::error::select-pr-model-target: ${error.message}\n`);
    process.exit(2);
  }

  if (result.ok) {
    // Both variables, always together — MODEL_TEST_PROVIDER on its own makes
    // getTestTargets skip the per-provider dedup and run the whole catalog.
    const lines = [
      `MODEL_TEST_ID=${result.model}`,
      `MODEL_TEST_PROVIDER=${result.provider}`,
    ];
    if (process.env.GITHUB_ENV) {
      fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
    }
    process.stderr.write(
      `PR lane pinned to ${result.provider} / ${result.model} ` +
        `(settled by collect-models); other providers' variants will not run here — ` +
        `daily-stable.yml keeps the multi-provider coverage.\n`,
    );
  } else {
    process.stderr.write(`::warning::select-pr-model-target: ${result.reason}\n`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
