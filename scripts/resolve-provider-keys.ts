/**
 * Resolves a LIVE API key per provider before the suite runs (issue #976).
 *
 * Run:
 *   npx ts-node scripts/resolve-provider-keys.ts
 *   PROVIDER_KEYS_STRICT=1 npx ts-node scripts/resolve-provider-keys.ts
 *
 * Why this exists. When a provider's key dies, collect-models records the
 * provider "inactive" and the 17 specs that read providers.json skip every
 * target bound to it — silently, because a skip never trips the daily-failure
 * gate. On the 2026-07-27 daily a drained Anthropic account took out 24 specs
 * that way (#967). The fallback that already existed in collect-models
 * iterates candidate MODELS, not KEYS, so a dead account had no recovery path.
 *
 * What it does. For each provider in providerConfigMap it probes
 * <PROVIDER>_API_KEY, then _2, _3, ... in order, and re-exports the first one
 * that answers to $GITHUB_ENV under the CANONICAL name. Everything downstream
 * — collect-models, the shards, the consumer specs — keeps reading the
 * canonical name and transparently receives a validated key.
 *
 * Why a separate step, not a loop inside collect-models. "Collect models" and
 * "Run @stable tests" are distinct steps. A fallback confined to collect-models
 * would import the backup key into Langflow while the test step still received
 * the dead primary from the workflow env block — and the first spec calling
 * setupAnthropic would overwrite the working credential with the dead one. The
 * winning key has to cross the step boundary, so it is resolved before anything
 * consumes it.
 *
 * Strictness. PROVIDER_KEYS_STRICT=1 (daily-stable) exits non-zero when a
 * configured provider has no live key. Anywhere else it warns: on PRs a billing
 * outage must not redden a job whose specs never touch an LLM (#952/#955).
 *
 * No key material is ever printed — output carries provider names, env var
 * names and candidate indexes only.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { providerConfigMap, type Provider } from "../tests/helpers/provider-setup/provider-config";
import { probeProviderKey } from "../tests/helpers/provider-setup/probe-provider-key";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

type Env = Record<string, string | undefined>;

/**
 * Candidate env var names for a provider, in probe order: the canonical name
 * first, then _2, _3, ... The scan stops at the first gap, so a stray _3 with
 * no _2 is never silently reached, and backups without a primary are not
 * reachable at all — the canonical name anchors the sequence.
 */
export function candidateEnvNames(base: string, env: Env = process.env): string[] {
  if (!env[base]) return [];

  const names = [base];
  for (let i = 2; ; i++) {
    const name = `${base}_${i}`;
    if (!env[name]) break;
    names.push(name);
  }
  return names;
}

interface Resolution {
  provider: Provider;
  envName: string | null;
  index: number; // 1-based; 0 when nothing was resolved
  candidates: number;
  error?: string;
}

async function resolveProvider(provider: Provider): Promise<Resolution | null> {
  const base = providerConfigMap[provider].envKeys[0];
  const model = providerConfigMap[provider].probeModel;
  const names = candidateEnvNames(base);

  // No key configured at all is a valid setup, not a failure — it is what
  // hasProviderEnvKeys() already handles downstream.
  if (names.length === 0) {
    console.log(`•  ${provider}: no key configured (${base} unset) — skipped`);
    return null;
  }

  let lastError = "";
  for (const [i, name] of names.entries()) {
    const apiKey = process.env[name] as string;
    const probe = await probeProviderKey(provider, apiKey, model);

    if (probe.ok) {
      return { provider, envName: name, index: i + 1, candidates: names.length };
    }

    lastError = probe.error ?? "Unknown error";

    // Only a key/account verdict burns a candidate. A model-scoped or
    // transport failure says nothing about the key: keep it and let the
    // model-candidate loop in collect-models make that call.
    if (probe.kind !== "key") {
      console.log(
        `⚠️  ${provider}: probe inconclusive on ${name} (${probe.kind}) — keeping it: ${lastError}`,
      );
      return { provider, envName: name, index: i + 1, candidates: names.length };
    }

    console.log(`   ${provider}: ${name} rejected — ${lastError}`);
  }

  return { provider, envName: null, index: 0, candidates: names.length, error: lastError };
}

function exportWinner(base: string, value: string): void {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;

  // ::add-mask:: is only safe INSIDE Actions, where the runner consumes the
  // workflow command and redacts the value from the log. Anywhere else it is
  // a plain console.log of the key — which is how this very script leaked one
  // during development. Guard on the runner, never on GITHUB_ENV alone.
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
  fs.appendFileSync(githubEnv, `${base}=${value}\n`);
}

function appendSummary(line: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  fs.appendFileSync(summary, `${line}\n`);
}

async function main(): Promise<void> {
  const strict = process.env.PROVIDER_KEYS_STRICT === "1";
  console.log(`Resolving provider API keys (strict=${strict ? "on" : "off"})...`);

  const failures: Resolution[] = [];

  for (const provider of Object.keys(providerConfigMap) as Provider[]) {
    const result = await resolveProvider(provider);
    if (!result) continue;

    if (!result.envName) {
      failures.push(result);
      console.log(
        `❌ ${provider}: all ${result.candidates} candidate key(s) failed — last error: ${result.error}`,
      );
      continue;
    }

    console.log(`✅ ${provider}: resolved to ${result.envName} (candidate ${result.index}/${result.candidates})`);

    if (result.index > 1) {
      const base = providerConfigMap[provider].envKeys[0];
      exportWinner(base, process.env[result.envName] as string);
      const note =
        `provider "${provider}" fell back to ${result.envName} — the primary ${base} is not usable and needs attention`;
      console.log(`::warning::${note}`);
      appendSummary(`⚠️ ${note}`);
    }
  }

  if (failures.length === 0) return;

  const detail = failures
    .map((f) => `${f.provider} (${f.candidates} candidate key(s)) — ${f.error}`)
    .join(" | ");

  if (strict) {
    console.error(`::error::No usable API key for: ${detail}`);
    process.exit(1);
  }

  console.log(`::warning::No usable API key for: ${detail}`);
  appendSummary(`⚠️ No usable API key for: ${detail}`);
}

// Only run when invoked directly, so the unit tests can import the pure helpers.
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(`::error::resolve-provider-keys crashed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
