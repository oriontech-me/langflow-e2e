#!/usr/bin/env node
/**
 * Asks a provider, before the on-demand run builds anything, whether the provider and
 * model the request DECLARED can answer at all: one minimal completion ("hi", at most
 * one token where the provider takes a limit), with the key the run would use.
 *
 * ## Why before the build
 *
 * A declared provider is refused by run-e2e.sh only after collect-models has probed it,
 * per shard -- which is after the five to eight minutes of build, with the queue's one
 * slot held the whole time. A dry key (the anthropic credit was out on 2026-09-12) or a
 * model the account cannot reach is known in a second here, and the request is refused
 * with the provider's own words before the build starts.
 *
 * ## What it decides, and what it leaves to the run
 *
 * It answers ONLY when the answer is certain, and otherwise lets the run go on, where
 * collect-models decides as it always has:
 *
 *   usable     a probe answered (exit 0)
 *   refused    the key is not on the machine; or the declared model was turned down
 *              by the provider itself (400, 401, 403 or 404 with its JSON error, or
 *              openai's insufficient_quota); or, with no model declared, every
 *              candidate was turned down with the SAME message -- an account-level
 *              answer (credit, quota, a dead key), the discriminator collect-models
 *              uses too (#1011) (exit 2)
 *   undecided  anything else: a timeout, the network, a 5xx, a 429 that may pass, a
 *              provider this script has no probe for, candidates turned down for
 *              different reasons (the run may find another model in the catalog)
 *              (exit 3)
 *
 * With no model declared, the run uses the model collect-models settles on, the first
 * of CANDIDATE_PREFS (tests/helpers/provider-setup/collect-models.ts) that validates.
 * The candidates here are the exact ids that list names, which include the ones the
 * platform's closed list offers (RUN_TARGETS in quality-platform's contract.ts).
 *
 * What a probe proves is ACCESS, as collect-models' own probe does: not that
 * Langflow's Agent can drive the model. A declared model is asked ITSELF, which the run
 * never does (it only requires the provider active and the id in the catalog): a model
 * the provider has retired is refused here, where the run would have gone red on it.
 *
 * Azure AI Foundry (#2287) has no catalog: the run's model is the deployment named by
 * AZURE_AI_FOUNDRY_TEST_DEPLOYMENT, so that is the one candidate, and a declared model
 * other than that deployment is refused, because the run would refuse it too
 * (select-daily-model-target.mjs checks the declared model against models.json, whose
 * only Foundry entry is that deployment). The request is the one collect-models sends
 * (tests/helpers/provider-setup/azure-foundry.ts, validateAzureFoundry) to the same
 * URL; azure-foundry.test.ts holds the two URL mappings to each other. The endpoint is
 * treated as a secret, as it is there: it never appears in a reason.
 *
 * Run:
 *   node scripts/probe-declared-model.mjs --provider anthropic [--model claude-haiku-4-5]
 *
 * Reads OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY and the three
 * AZURE_AI_FOUNDRY_* variables from where the run reads them: the environment, else
 * the working copy's `.env`, which playwright.config.ts's `dotenv.config()` loads without overriding what is set (run-e2e.sh: the VM has no
 * secrets store for them). Run from the suite's worktree, whose `.env` is the clone's.
 * Prints the decision as one JSON line, {verdict, provider, model, reason}; never a key.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Every exact id CANDIDATE_PREFS names, in its order, so a refusal with no model
// declared takes three identical answers where a provider has three, as collect-models'
// IDENTICAL_ERROR_LIMIT does ("three, not two"). anthropic's list names two; past them,
// collect-models walks /haiku/ and /sonnet/ over the catalog.
export const CANDIDATES = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5"],
  google: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-latest"],
};

// dotenv's own line grammar (dotenv/lib/main.js, `LINE`): KEY=VALUE or KEY: VALUE, an
// optional `export`, single, double or backtick quotes, `#` ending an unquoted value.
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** The provider keys a `.env` holds, parsed as dotenv parses them; other names ignored. */
export function keysFromDotenv(text) {
  const keys = {};
  const lines = String(text).replace(/\r\n?/gm, "\n");
  for (const m of lines.matchAll(DOTENV_LINE)) {
    if (!DOTENV_NAMES.includes(m[1])) continue;
    let v = (m[2] || "").trim();
    const quote = v[0];
    v = v.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') v = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    keys[m[1]] = v;
  }
  return keys;
}

/**
 * The environment, with the `.env` filling only what it does not hold -- even empty, as
 * dotenv.config() leaves any name the environment already has.
 */
export function withDotenv(env, path = ".env") {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  const merged = { ...env };
  for (const [k, v] of Object.entries(keysFromDotenv(text))) if (!Object.hasOwn(merged, k)) merged[k] = v;
  return merged;
}

const KEYS = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_API_KEY" };
// Azure AI Foundry needs three variables, named as in provider-config.ts's
// "azure-ai-foundry" entry; azure-foundry.test.ts holds the two to each other.
export const AZURE_FOUNDRY = "azure-ai-foundry";
export const AZURE_ENV = {
  key: "AZURE_AI_FOUNDRY_API_KEY",
  endpoint: "AZURE_AI_FOUNDRY_ENDPOINT",
  deployment: "AZURE_AI_FOUNDRY_TEST_DEPLOYMENT",
};
const DOTENV_NAMES = [...Object.values(KEYS), ...Object.values(AZURE_ENV)];
const TIMEOUT_MS = 20_000;
// collect-models gives Foundry 30 s (AZURE_FOUNDRY_PROBE_TIMEOUT_MS in azure-foundry.ts),
// so a deployment answering in 20-30 s is active for the run: the probe waits as long,
// rather than calling undecided what the run would accept.
export const TIMEOUT_MS_BY_PROVIDER = { "azure-ai-foundry": 30_000 };

/**
 * The chat-completions URL for a Foundry endpoint, with the one rewrite Langflow
 * applies: a PROJECT endpoint (`…/api/projects/<name>`) maps to `…/openai/v1`. A copy
 * of azureFoundryChatUrl in azure-foundry.ts, which a plain .mjs cannot import.
 * @throws {TypeError} when the endpoint is not a URL
 */
export function azureFoundryChatUrl(endpoint) {
  const trimmed = String(endpoint).replace(/\/+$/, "");
  const url = new URL(trimmed);
  const path = url.pathname.toLowerCase();
  if (path.startsWith("/api/projects/") || path === "/api/projects") {
    return `${url.protocol}//${url.host}/openai/v1/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}
const REASON_MAX = 300;

/**
 * The one request each provider takes for a completion of at most one token.
 * `endpoint` is read only for Azure AI Foundry.
 */
export function probeRequest(provider, model, key, endpoint) {
  switch (provider) {
    case "openai":
      // No token limit, as collect-models sends none: the reasoning models refuse
      // `max_tokens` with a 400 that would read as a certain no.
      return {
        url: "https://api.openai.com/v1/chat/completions",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        },
      };
    case "google":
      // The key in a header, not in the URL collect-models uses: a URL can end up in
      // an error message, and the reason reaches the platform.
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } }),
        },
      };
    case AZURE_FOUNDRY:
      // As validateAzureFoundry sends it: no temperature (the deployment refuses a
      // non-default one) and max_completion_tokens, which gpt-5* models take where they
      // refuse max_tokens. 16 rather than 1, so a reasoning-capable deployment cannot
      // spend its cap before answering and read as turned down.
      return {
        url: azureFoundryChatUrl(endpoint),
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": key },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 16 }),
        },
      };
    default:
      return null;
  }
}

/**
 * One probe's answer: `ok`, `no` (turned down for good, with the provider's message)
 * or `unknown` (nothing certain was learned).
 */
export async function probeOnce(provider, model, key, fetchImpl = fetch, endpoint = undefined) {
  const req = probeRequest(provider, model, key, endpoint);
  const timeoutMs = TIMEOUT_MS_BY_PROVIDER[provider] ?? TIMEOUT_MS;
  let res;
  try {
    res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { outcome: "unknown", message: `no answer from ${provider}: ${e?.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : e?.message ?? "unknown error"}` };
  }
  if (res.ok) return { outcome: "ok", message: null };
  const body = await res.json().catch(() => null);
  const error = body?.error ?? (Array.isArray(body) ? body[0]?.error : undefined);
  const said = typeof error?.message === "string" && error.message ? error.message : null;
  // Certain only when it is the PROVIDER judging the key or the model: its JSON error,
  // on a status that means that. A proxy's 407, a CDN's HTML 403 or a 409 is not.
  // openai's 429 is a rate limit that passes, except for an account with no quota.
  const outOfQuota = res.status === 429 && error?.code === "insufficient_quota";
  const settled = (said !== null && [400, 401, 403, 404].includes(res.status)) || outOfQuota;
  return { outcome: settled ? "no" : "unknown", message: said ? `HTTP ${res.status}: ${said}` : `HTTP ${res.status}` };
}

/**
 * A reason fit for the platform: one line, bounded, and with no key in it -- not even
 * the masked one openai's 401 quotes ("Incorrect API key provided: sk-proj-****abcd").
 */
export function cleanReason(text, secrets = []) {
  // The exact keys first: a key holding a newline would no longer match once flattened.
  let s = String(text);
  // Case-insensitively: a host is case-insensitive, and an error body may quote it in
  // the operator's casing where URL.host has lowered it.
  for (const k of secrets) {
    if (k && k.length >= 8) s = s.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<key>");
  }
  s = s.replace(/[\r\n]+/g, " ");
  s = s.replace(/\b(?:sk-|AIza)[A-Za-z0-9_*-]+/g, "<key>");
  // Any other masked key a provider echoes, e.g. openai's "tes*****1234".
  s = s.replace(/[\w-]{0,12}\*{3,}[\w-]{0,12}/g, "<key>");
  return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s;
}

/**
 * The decision for a declared provider and, optionally, model.
 * @returns {Promise<{verdict: "usable"|"refused"|"undecided", provider: string, model: string|null, reason: string}>}
 */
export async function probeDeclared({ provider, model = "", env = process.env, fetchImpl = fetch }) {
  const keyName = KEYS[provider];
  const decide = (verdict, reason, used = model || null) => ({ verdict, provider, model: used, reason: cleanReason(reason, secretsOf(env)) });
  if (provider === AZURE_FOUNDRY) return probeAzureFoundry({ model, env, fetchImpl, decide });
  if (!keyName) return decide("undecided", `no pre-build probe for provider '${provider}'; the run decides`);
  const key = env[keyName] ?? "";
  if (!key) return decide("refused", `${keyName} is set neither in the run's environment nor in its .env, so ${provider} cannot run`);

  if (model) {
    const r = await probeOnce(provider, model, key, fetchImpl);
    if (r.outcome === "ok") return decide("usable", `${provider} answered for ${model}`);
    if (r.outcome === "no") return decide("refused", `${provider} turned down ${model}: ${r.message}`);
    return decide("undecided", `${provider} gave no certain answer for ${model}: ${r.message}`);
  }

  const answers = [];
  for (const candidate of CANDIDATES[provider]) {
    const r = await probeOnce(provider, candidate, key, fetchImpl);
    if (r.outcome === "ok") return decide("usable", `${provider} answered for ${candidate}`, candidate);
    answers.push(r);
  }
  const first = answers[0].message;
  if (answers.every((a) => a.outcome === "no" && a.message === first)) {
    return decide("refused", `${provider} turned down every candidate (${CANDIDATES[provider].join(", ")}) the same way: ${first}`, null);
  }
  return decide("undecided", `${provider} gave no certain answer for ${CANDIDATES[provider].join(", ")}: ${answers.map((a) => a.message).join("; ")}`, null);
}

/**
 * Every value a reason must not carry: the keys, and the Foundry endpoint with its host,
 * which a network error message can quote.
 */
function secretsOf(env) {
  const secrets = [...Object.values(KEYS), AZURE_ENV.key, AZURE_ENV.endpoint].map((k) => env[k]);
  try {
    secrets.push(new URL(env[AZURE_ENV.endpoint]).host);
  } catch {
    // not a URL: the full value above is all there is to scrub
  }
  return secrets;
}

/** The Azure AI Foundry branch of probeDeclared: one deployment, no catalog. */
async function probeAzureFoundry({ model, env, fetchImpl, decide }) {
  const missing = Object.values(AZURE_ENV).filter((k) => !env[k]);
  if (missing.length > 0) {
    return decide("refused", `${missing.join(", ")} set neither in the run's environment nor in its .env, so ${AZURE_FOUNDRY} cannot run`);
  }
  const deployment = env[AZURE_ENV.deployment];
  if (model && model !== deployment) {
    return decide(
      "refused",
      `${AZURE_FOUNDRY} runs the deployment ${AZURE_ENV.deployment} names (${deployment}), not ${model}; the run would refuse the declared model`,
    );
  }
  try {
    azureFoundryChatUrl(env[AZURE_ENV.endpoint]);
  } catch {
    return decide("refused", `${AZURE_ENV.endpoint} is not a URL`, deployment);
  }
  const r = await probeOnce(AZURE_FOUNDRY, deployment, env[AZURE_ENV.key], fetchImpl, env[AZURE_ENV.endpoint]);
  if (r.outcome === "ok") return decide("usable", `${AZURE_FOUNDRY} answered for ${deployment}`, deployment);
  if (r.outcome === "no") return decide("refused", `${AZURE_FOUNDRY} turned down ${deployment}: ${r.message}`, deployment);
  return decide("undecided", `${AZURE_FOUNDRY} gave no certain answer for ${deployment}: ${r.message}`, deployment);
}

const EXIT = { usable: 0, refused: 2, undecided: 3 };

async function main(argv) {
  let provider = "";
  let model = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider") provider = argv[++i] ?? "";
    else if (argv[i] === "--model") model = argv[++i] ?? "";
    else {
      process.stderr.write(`unknown argument: ${argv[i]}\n`);
      return 3;
    }
  }
  if (!/^[a-z0-9-]{1,40}$/.test(provider) || !/^[A-Za-z0-9._:/-]{0,120}$/.test(model)) {
    process.stderr.write("usage: probe-declared-model.mjs --provider NAME [--model ID]\n");
    return 3;
  }
  const decision = await probeDeclared({ provider, model, env: withDotenv(process.env) });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return EXIT[decision.verdict];
}

// By URL, so a path that needs encoding still runs the CLI instead of exiting 0 silent.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// `.then`, not a top-level await: a module with one cannot be loaded by require(esm),
// and azure-foundry.test.ts loads this one from the TypeScript unit lane.
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
