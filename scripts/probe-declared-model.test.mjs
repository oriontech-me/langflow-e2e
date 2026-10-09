// Unit tests for scripts/probe-declared-model.mjs, the on-demand run's provider
// pre-check. Run with: npm run test:scripts
//
// The provider is faked at fetch: what these pin is which answers refuse a request
// before its build, and that every other answer lets the run decide, as it did before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { probeDeclared, probeRequest, cleanReason, keysFromDotenv, withDotenv, CANDIDATES } from "./probe-declared-model.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "probe-declared-model.mjs");
const ENV = { OPENAI_API_KEY: "sk-openai-0123456789", ANTHROPIC_API_KEY: "sk-ant-0123456789", GOOGLE_API_KEY: "AIza-0123456789" };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A provider that answers each model from `byModel`, and records what it was asked. */
function provider(byModel) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const model = body.model ?? decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
    calls.push({ url, model, init, body });
    const answer = byModel[model] ?? byModel["*"];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetchImpl };
}

test("a declared model that answers is usable, and the probe costs at most one token", async () => {
  for (const [name, model] of [["openai", "gpt-4o-mini"], ["anthropic", "claude-haiku-4-5"], ["google", "gemini-2.5-flash"]]) {
    const p = provider({ "*": json(200, {}) });
    const d = await probeDeclared({ provider: name, model, env: ENV, fetchImpl: p.fetchImpl });
    assert.equal(d.verdict, "usable", name);
    assert.equal(d.model, model);
    assert.equal(p.calls.length, 1);
    const b = p.calls[0].body;
    // openai takes no limit, as collect-models sends none: its reasoning models refuse
    // `max_tokens` with a 400 that would read as a certain no.
    if (name === "openai") assert.ok(!("max_tokens" in b), "openai was sent max_tokens");
    else assert.equal(b.max_tokens ?? b.generationConfig?.maxOutputTokens, 1, `${name} may spend more than one token`);
  }
});

test("a declared model turned down with a 4xx is refused, in the provider's words", async () => {
  const p = provider({ "*": json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }) });
  const d = await probeDeclared({ provider: "anthropic", model: "claude-nope", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
  assert.equal(d.reason, "anthropic turned down claude-nope: HTTP 404: model: claude-nope");
});

test("a dry account is refused: every candidate turned down the same way", async () => {
  const dry = json(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } });
  const p = provider({ "*": dry });
  const d = await probeDeclared({ provider: "anthropic", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
  assert.deepEqual(p.calls.map((c) => c.model), CANDIDATES.anthropic);
  assert.match(d.reason, /every candidate \(claude-haiku-4-5, claude-sonnet-5\) the same way: HTTP 400: Your credit balance is too low/);
  assert.equal(d.model, null);
});

test("openai with no quota is refused, though it answers 429", async () => {
  const p = provider({ "*": json(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }) });
  const d = await probeDeclared({ provider: "openai", model: "gpt-4o-mini", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
});

test("with no model, the first candidate that answers is enough, and the rest are not asked", async () => {
  // As the run settles: the first of the list that answers, not necessarily the first.
  const p = provider({ "gemini-2.5-flash": json(404, { error: { message: "models/gemini-2.5-flash is not found" } }), "gemini-3.5-flash": json(200, {}) });
  const d = await probeDeclared({ provider: "google", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "usable");
  assert.equal(d.model, "gemini-3.5-flash");
  const first = provider({ "*": json(200, {}) });
  await probeDeclared({ provider: "google", env: ENV, fetchImpl: first.fetchImpl });
  assert.equal(first.calls.length, 1);
});

test("with no model, candidates turned down for different reasons are undecided: the catalog may hold another", async () => {
  const p = provider({
    "gpt-4o-mini": json(404, { error: { message: "The model `gpt-4o-mini` does not exist" } }),
    "gpt-4o": json(404, { error: { message: "The model `gpt-4o` does not exist" } }),
    "gpt-4.1": json(404, { error: { message: "The model `gpt-4.1` does not exist" } }),
  });
  const d = await probeDeclared({ provider: "openai", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "undecided");
});

test("nothing certain refuses: a timeout, the network, a 5xx, a rate limit, a status or body not the provider's", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const html = { ok: false, status: 403, json: async () => { throw new SyntaxError("Unexpected token <"); } };
  const said = { error: { message: "said something" } };
  for (const answer of [timeout, new Error("fetch failed"), json(500, {}), json(529, { error: { message: "Overloaded" } }), json(429, { error: { message: "rate limited" } }), json(408, said), json(407, said), json(409, said), json(451, said), html, json(401, {})]) {
    for (const model of ["claude-haiku-4-5", ""]) {
      const p = provider({ "*": answer });
      const d = await probeDeclared({ provider: "anthropic", model, env: ENV, fetchImpl: p.fetchImpl });
      assert.equal(d.verdict, "undecided", `${answer.message ?? answer.status} with model '${model}'`);
    }
  }
});

test("a key missing from the machine is refused without asking anyone", async () => {
  const p = provider({ "*": json(200, {}) });
  const d = await probeDeclared({ provider: "google", model: "gemini-2.5-flash", env: { OPENAI_API_KEY: "x" }, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
  assert.equal(d.reason, "GOOGLE_API_KEY is set neither in the run's environment nor in its .env, so google cannot run");
  assert.equal(p.calls.length, 0);
});

test("a provider with no probe here is left to the run", async () => {
  const p = provider({ "*": json(200, {}) });
  const d = await probeDeclared({ provider: "mistral", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "undecided");
  assert.equal(p.calls.length, 0);
});

test("the key never reaches the reason, nor google's URL", async () => {
  const p = provider({ "*": json(400, { error: { message: `API key not valid: ${ENV.GOOGLE_API_KEY}` } }) });
  const d = await probeDeclared({ provider: "google", model: "gemini-2.5-flash", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
  assert.ok(!d.reason.includes(ENV.GOOGLE_API_KEY), d.reason);
  assert.match(d.reason, /<key>/);
  assert.ok(!p.calls[0].url.includes(ENV.GOOGLE_API_KEY), "google's key went in the URL");
  assert.equal(p.calls[0].init.headers["x-goog-api-key"], ENV.GOOGLE_API_KEY);
});

test("openai's masked key in a 401 does not reach the reason either", async () => {
  const p = provider({ "*": json(401, { error: { message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys." } }) });
  const d = await probeDeclared({ provider: "openai", model: "gpt-4o-mini", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "refused");
  assert.doesNotMatch(d.reason, /abcd/);
  assert.match(d.reason, /Incorrect API key provided: <key>/);
});

test("the keys come from the environment, else from the .env the run reads, as dotenv reads it", () => {
  const keys = keysFromDotenv([
    "# comment",
    "OPENAI_API_KEY=sk-from-dotenv # trailing",
    'export ANTHROPIC_API_KEY="sk-ant-quoted"',
    "GOOGLE_API_KEY='AIza-single'",
    "SOME_PROVIDER_API_KEY=not-ours",
    "",
  ].join("\r\n"));
  assert.deepEqual(keys, { OPENAI_API_KEY: "sk-from-dotenv", ANTHROPIC_API_KEY: "sk-ant-quoted", GOOGLE_API_KEY: "AIza-single" });
  // The lines a hand-rolled reader got wrong, each checked against dotenv 18.0.5.
  assert.deepEqual(keysFromDotenv('OPENAI_API_KEY="sk-abc" # note'), { OPENAI_API_KEY: "sk-abc" });
  assert.deepEqual(keysFromDotenv("OPENAI_API_KEY=`sk-abc`"), { OPENAI_API_KEY: "sk-abc" });
  assert.deepEqual(keysFromDotenv("OPENAI_API_KEY: sk-abc"), { OPENAI_API_KEY: "sk-abc" });
  assert.deepEqual(keysFromDotenv("OPENAI_API_KEY=sk-abc#x"), { OPENAI_API_KEY: "sk-abc" });
  const dir = makeTempDir("probe-dotenv-");
  const path = join(dir, ".env");
  writeFileSync(path, "OPENAI_API_KEY=from-file\nGOOGLE_API_KEY=from-file\n");
  // What is set wins, as dotenv.config() does not override.
  assert.deepEqual(withDotenv({ OPENAI_API_KEY: "from-env" }, path), { OPENAI_API_KEY: "from-env", GOOGLE_API_KEY: "from-file" });
  assert.deepEqual(withDotenv({ A: "1" }, join(dir, "missing")), { A: "1" });
  // Set but empty is still set: dotenv leaves it, so the run has no key, and neither
  // does the probe.
  assert.equal(withDotenv({ OPENAI_API_KEY: "" }, path).OPENAI_API_KEY, "");
});

test("the CLI reads the .env of the directory it runs from", () => {
  const dir = makeTempDir("probe-cli-");
  writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=\n");
  // An empty value is no key: refused, and named as missing from both places.
  const r = spawnSync(process.execPath, [SCRIPT, "--provider", "anthropic"], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /neither in the run's environment nor in its \.env/);
});

test("a masked key of any shape is redacted, and ordinary words are not", () => {
  assert.equal(cleanReason("Incorrect API key provided: tes*****1234. See docs."), "Incorrect API key provided: <key>. See docs.");
  assert.equal(cleanReason("a risk-free task-runner on the desk-top"), "a risk-free task-runner on the desk-top");
});

test("importing the module with an argv[1] that does not exist does not throw", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT)}); console.log("ok")`, "no-such-file"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok$/m);
});

test("a key holding a newline is redacted whole, before the reason is flattened", () => {
  const key = "sk-abc123\ndef456";
  assert.equal(cleanReason(`invalid header value: ${key}`, [key]), "invalid header value: <key>");
});

test("with no model, every listed candidate must agree before a refusal: three where the provider has three", async () => {
  const dry = json(403, { error: { message: "Project does not have access" } });
  const p = provider({ "gpt-4o-mini": dry, "gpt-4o": dry, "gpt-4.1": json(200, {}) });
  const d = await probeDeclared({ provider: "openai", env: ENV, fetchImpl: p.fetchImpl });
  assert.equal(d.verdict, "usable");
  assert.equal(d.model, "gpt-4.1");
});

test("a reason is one line, bounded", () => {
  const r = cleanReason(`a\nb\r\n${"x".repeat(1000)}`);
  assert.ok(!/[\r\n]/.test(r));
  assert.ok(r.length <= 300);
});

test("a model id cannot change google's path", () => {
  assert.match(probeRequest("google", "../x?y", "k").url, /models\/\.\.%2Fx%3Fy:generateContent$/);
});

test("the CLI prints one JSON line and exits 0, 2 or 3 by verdict; a bad argument is 3", () => {
  // From an empty directory: a developer's .env must not answer for the machine's.
  const cwd = makeTempDir("probe-cli-");
  const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd, env: { PATH: process.env.PATH, ...env } });
  const missing = run(["--provider", "anthropic"], {});
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).verdict, "refused");
  assert.equal(run(["--provider", "mistral"], {}).status, 3);
  assert.equal(run(["--provider", "Bad Name"], {}).status, 3);
  assert.equal(run(["--nope"], {}).status, 3);
});
