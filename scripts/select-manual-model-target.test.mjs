// Unit tests for manual.yml's `provider` input resolution (issue #1186).
// Run with: npm run test:scripts
//
// What rides on this: this lane is the ONLY one that still runs multi-provider, since
// pr-validation pins openai (#1169) and daily-stable rotates by weekday (#1185). Four
// failure directions, three of them silent:
//
//  - `auto` losing its "emit nothing" property would re-parametrize the default
//    dispatch — the one case that must behave exactly as it did before #1186.
//  - Emitting MODEL_TEST_PROVIDER without MODEL_TEST_ID does not narrow the run, it
//    sweeps that provider's whole catalog (41 openai entries on 2026-07-30).
//  - A pinned id that is not the settled one skips silently and reads green
//    (#570 / #1012).
//  - `all-models` over an empty/absent catalog resolves ONE "(fallback)" target per
//    spec, which is the opposite of the sweep that was asked for — and looks like a
//    successful sweep in the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUTO,
  ALL_MODELS,
  PIN_PROVIDERS,
  describeAutoFanout,
  readModelsFile,
  selectManualModelTarget,
} from "./select-manual-model-target.mjs";

const SCRIPT = path.join(import.meta.dirname, "select-manual-model-target.mjs");
const WORKFLOW = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "manual.yml",
);

/** Shaped like a real providers.json written by collect-models. */
const healthy = () => [
  { provider: "openai", status: "active", model: "gpt-4o-mini" },
  { provider: "anthropic", status: "active", model: "claude-haiku-4-5" },
  { provider: "google", status: "active", model: "gemini-2.5-flash" },
];

/** Shaped like a real models.json: the settled model first per provider (#570). */
const catalog = () => [
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openai", model: "gpt-4o" },
  { provider: "anthropic", model: "claude-haiku-4-5" },
];

/**
 * The reader seam. `providersMissing` / `modelsMissing` model the absent file, which
 * is a distinct state from an empty one and takes a distinct branch.
 */
const io = ({
  providers = healthy(),
  models = catalog(),
  providersMissing = false,
  modelsMissing = false,
} = {}) => ({
  readProviders: () => ({
    providers: providersMissing ? null : providers,
    missing: providersMissing,
  }),
  readModels: () => ({ models: modelsMissing ? null : models, missing: modelsMissing }),
});

/**
 * The lines of one workflow step, stopping at the next step OR the comment block that
 * introduces it. Slicing to the next `- name:` instead would pull in that block, and
 * the following step's comments mention `continue-on-error` — a guard fooled by prose
 * is worse than no guard (#1226).
 */
function stepBody(yml, name) {
  const from = yml.indexOf(`- name: ${name}`);
  assert.ok(from > -1, `step "${name}" is gone`);
  const lines = yml.slice(from).split("\n");
  const body = [lines[0]];
  for (const line of lines.slice(1)) {
    if (/^ {6}[-#]/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

// ─── auto: the default must stay inert ───────────────────────────────────────

test("auto emits nothing at all — the default dispatch behaves as it did pre-#1186", () => {
  const d = selectManualModelTarget(AUTO, io());
  assert.equal(d.ok, true);
  assert.deepEqual(d.env, []);
  assert.equal(d.provider, null);
  assert.equal(d.model, null);
});

test("auto needs no file: it resolves even with providers.json and models.json absent", () => {
  // The default path must not depend on a sweep that is continue-on-error here.
  const d = selectManualModelTarget(AUTO, {
    readProviders: () => {
      throw new Error("auto must not read providers.json");
    },
    readModels: () => {
      throw new Error("auto must not read models.json");
    },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.env, []);
});

// ─── a provider pin ──────────────────────────────────────────────────────────

test("a provider pin emits the SETTLED model, as a pair", () => {
  for (const provider of PIN_PROVIDERS) {
    const d = selectManualModelTarget(provider, io());
    assert.equal(d.ok, true, `${provider} should pin`);
    assert.equal(d.provider, provider);
    const settled = healthy().find((p) => p.provider === provider).model;
    assert.equal(d.model, settled);
    assert.deepEqual(d.env.slice().sort(), [
      `MODEL_TEST_ID=${settled}`,
      `MODEL_TEST_PROVIDER=${provider}`,
    ]);
  }
});

test("an inactive provider does NOT fall back to multi-provider — it declines", () => {
  // The two scheduled lanes fall back (#980: coverage beats spend on a lane nobody
  // parameterized). Here the input IS the request, and answering a different question
  // while reporting success is what #1012 forbids.
  const providers = healthy().map((p) =>
    p.provider === "anthropic"
      ? { ...p, status: "inactive", model: null, error: "credit balance too low" }
      : p,
  );
  const d = selectManualModelTarget("anthropic", io({ providers }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.env, []);
  assert.match(d.reason, /probed "inactive"/);
  // The useful half of the diagnosis is the tail of collect-models' own message; a
  // reason that dropped it would send the dispatcher to the job log for nothing.
  assert.match(d.reason, /credit balance too low/);
  assert.match(d.reason, /provider=auto/);
});

test("a provider absent from providers.json declines and lists what is present", () => {
  const providers = healthy().filter((p) => p.provider !== "google");
  const d = selectManualModelTarget("google", io({ providers }));
  assert.equal(d.ok, false);
  assert.match(d.reason, /absent from providers\.json/);
  assert.match(d.reason, /openai, anthropic/);
});

test("a missing providers.json declines instead of pinning to a guessed model", () => {
  const d = selectManualModelTarget("openai", io({ providersMissing: true }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.env, []);
  assert.match(d.reason, /does not exist/);
});

test("a malformed providers.json throws — undecidable is not 'nothing to pin'", () => {
  assert.throws(
    () => selectManualModelTarget("openai", io({ providers: { openai: "active" } })),
    /must be an array of provider records/,
  );
  assert.throws(
    () => selectManualModelTarget("openai", io({ providers: [{ status: "active" }] })),
    /has no "provider" name/,
  );
});

// ─── all-models ──────────────────────────────────────────────────────────────

test("all-models emits ALL_MODELS alone — never narrowed by a pin variable", () => {
  const d = selectManualModelTarget(ALL_MODELS, io());
  assert.equal(d.ok, true);
  assert.deepEqual(d.env, ["ALL_MODELS=true"]);
  // MODEL_TEST_ID would collapse the sweep to one model and MODEL_TEST_PROVIDER
  // would scope it to one provider — either one silently answers a smaller question.
  assert.equal(
    d.env.some((line) => line.startsWith("MODEL_TEST_")),
    false,
  );
});

test("all-models announces the size of the sweep it is about to run", () => {
  const d = selectManualModelTarget(ALL_MODELS, io());
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /3 target\(s\) across 2 provider\(s\)/);
});

test("all-models over an ABSENT catalog declines — a fallback target is not a sweep", () => {
  // With no models.json the resolver returns ONE "(fallback)" target per spec. Setting
  // ALL_MODELS=true anyway would log a successful sweep that swept nothing.
  const d = selectManualModelTarget(ALL_MODELS, io({ modelsMissing: true }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.env, []);
  assert.match(d.reason, /does not exist/);
  assert.match(d.reason, /fallback/);
});

test("all-models over an EMPTY catalog declines for the same reason", () => {
  const d = selectManualModelTarget(ALL_MODELS, io({ models: [] }));
  assert.equal(d.ok, false);
  assert.match(d.reason, /empty/);
});

test("a malformed models.json throws rather than sweeping nothing", () => {
  assert.throws(
    () => selectManualModelTarget(ALL_MODELS, io({ models: { openai: [] } })),
    /must be an array of \{ provider, model \} records/,
  );
});

// ─── the selection vocabulary ────────────────────────────────────────────────

test("an unknown selection throws — it must not resolve to auto", () => {
  // Resolving an unknown value to `auto` would run multi-provider while the dispatch
  // summary said something else. It also catches a drift between this list and the
  // workflow's `choice` options.
  assert.throws(() => selectManualModelTarget("groq", io()), /is not one of/);
  assert.throws(() => selectManualModelTarget("OpenAI", io()), /is not one of/);
  assert.throws(() => selectManualModelTarget("all_models", io()), /is not one of/);
});

test("PIN_PROVIDERS is exactly the set of keys run-e2e forwards to the specs", () => {
  // A spec calls hasProviderEnvKeys(<provider>) and skips itself when its own key is
  // absent (#967), so pinning to a provider whose key this lane never passes would
  // skip everything and read green.
  const action = fs.readFileSync(
    path.join(import.meta.dirname, "..", ".github", "actions", "run-e2e", "action.yml"),
    "utf-8",
  );
  const forwarded = [...action.matchAll(/^ {2}(\w+)_api_key:$/gm)].map((m) => m[1]);
  assert.deepEqual(forwarded.slice().sort(), PIN_PROVIDERS.slice().sort());
});

// ─── the log-only helper ─────────────────────────────────────────────────────

test("describeAutoFanout lists the active providers and never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-target-"));
  try {
    const file = path.join(dir, "providers.json");
    fs.writeFileSync(file, JSON.stringify(healthy()));
    assert.match(describeAutoFanout(file), /openai \/ gpt-4o-mini/);

    // A file it cannot read must not turn the default dispatch red: the auto path
    // needs no file, and this listing is a convenience.
    fs.writeFileSync(file, "{ not json");
    assert.equal(describeAutoFanout(file), null);
    assert.equal(describeAutoFanout(path.join(dir, "absent.json")), null);

    fs.writeFileSync(
      file,
      JSON.stringify([{ provider: "openai", status: "inactive", model: null }]),
    );
    assert.equal(describeAutoFanout(file), "none probed active");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readModelsFile reports a missing file rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-target-"));
  try {
    assert.deepEqual(readModelsFile(path.join(dir, "absent.json")), {
      models: null,
      missing: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the CLI boundary: exit codes and what reaches GITHUB_ENV ────────────────

function runCli(args, { providers, models, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-target-cli-"));
  const providersFile = path.join(dir, "providers.json");
  const modelsFile = path.join(dir, "models.json");
  const write = (file, value) => {
    if (value === undefined) return;
    fs.writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  write(providersFile, providers);
  write(modelsFile, models);
  const ghEnv = path.join(dir, "github_env");
  fs.writeFileSync(ghEnv, "");
  const argv = [
    SCRIPT,
    "--providers-file",
    providersFile,
    "--models-file",
    modelsFile,
    ...args,
  ];
  // stderr goes to a FILE, not a pipe: `execFileSync` returns only stdout on success,
  // so a piped stderr is unreadable on the exit-0 paths — and the ::warning:: lines
  // this asserts on are emitted precisely there.
  const errFile = path.join(dir, "stderr.txt");
  const errFd = fs.openSync(errFile, "w");
  const stderr = () => fs.readFileSync(errFile, "utf-8");
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_ENV: ghEnv, ...env },
      stdio: ["ignore", "pipe", errFd],
    });
    return {
      code: 0,
      json: JSON.parse(stdout),
      stderr: stderr(),
      githubEnv: fs.readFileSync(ghEnv, "utf-8"),
    };
  } catch (error) {
    return {
      code: error.status,
      stderr: stderr(),
      githubEnv: fs.readFileSync(ghEnv, "utf-8"),
    };
  } finally {
    fs.closeSync(errFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("pinning writes BOTH variables to GITHUB_ENV — never the provider alone", () => {
  const r = runCli(["--selection", "anthropic"], { providers: healthy() });
  assert.equal(r.code, 0);
  assert.deepEqual(r.githubEnv.trim().split("\n").sort(), [
    "MODEL_TEST_ID=claude-haiku-4-5",
    "MODEL_TEST_PROVIDER=anthropic",
  ]);
});

test("auto writes NOTHING to GITHUB_ENV and exits 0", () => {
  const r = runCli(["--selection", "auto"], { providers: healthy() });
  assert.equal(r.code, 0);
  assert.equal(r.githubEnv.trim(), "");
  assert.equal(r.json.ok, true);
});

test("no --selection at all is auto, and so is an empty one", () => {
  // A workflow_dispatch queued before this input existed sends no value; failing it
  // would break the re-run of an older dispatch.
  for (const args of [[], ["--selection", ""]]) {
    const r = runCli(args, { providers: healthy() });
    assert.equal(r.code, 0);
    assert.equal(r.json.mode, "auto");
    assert.equal(r.githubEnv.trim(), "");
  }
});

test("all-models writes ALL_MODELS=true and nothing else", () => {
  const r = runCli(["--selection", "all-models"], {
    providers: healthy(),
    models: catalog(),
  });
  assert.equal(r.code, 0);
  assert.equal(r.githubEnv.trim(), "ALL_MODELS=true");
});

test("a request this lane cannot honour exits 1 with an ::error:: and writes nothing", () => {
  const providers = healthy().map((p) =>
    p.provider === "google" ? { ...p, status: "inactive", model: null } : p,
  );
  const r = runCli(["--selection", "google"], { providers });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /::error::select-manual-model-target/);
  assert.equal(r.githubEnv.trim(), "");
});

test("an unreadable providers.json exits 2, not 1 — undecidable outranks 'cannot honour'", () => {
  const r = runCli(["--selection", "openai"], { providers: "{ not json" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /::error::select-manual-model-target/);
});

test("an unknown selection exits 2 at the CLI boundary", () => {
  const r = runCli(["--selection", "mistral"], { providers: healthy() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /is not one of/);
});

test("an unknown flag exits 2 rather than running with it silently ignored", () => {
  const r = runCli(["--nope", "x"], { providers: healthy() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

test("the all-models sweep size is printed as a ::warning::, not only in the JSON", () => {
  const r = runCli(["--selection", "all-models"], {
    providers: healthy(),
    models: catalog(),
  });
  assert.equal(r.code, 0);
  // Reported the same way every other deviation in this repo is (#1012): a sweep this
  // expensive must be visible in the log, not only in a JSON nobody opens.
  assert.match(r.stderr, /::warning::select-manual-model-target/);
});

// ─── Structural guards on the workflow wiring ────────────────────────────────

test("manual.yml offers exactly the selections this script accepts", () => {
  // The choice list and the script's vocabulary are two halves of one contract; a
  // drift makes the workflow offer a value that exits 2, or hide one that works.
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  const input = yml.slice(yml.indexOf("      provider:"));
  const options = input.slice(input.indexOf("options:"), input.indexOf("default:"));
  const offered = [...options.matchAll(/^ +- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(offered, [AUTO, ...PIN_PROVIDERS, ALL_MODELS]);
  assert.match(input, /default: "auto"/);
});

test("the Docker job resolves the selection between the health gate and the run", () => {
  // Worthless before collect-models wrote providers.json, useless after the run it
  // configures. Mirrors the guards the PR and daily lanes carry for their own pins.
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  const docker = yml.slice(yml.indexOf("  e2e-docker:"), yml.indexOf("  e2e-url:"));
  const collect = docker.indexOf("collect-models.spec.ts");
  const gate = docker.indexOf("uses: ./.github/actions/wait-for-backend");
  const pin = docker.indexOf("select-manual-model-target.mjs");
  const run = docker.indexOf("uses: ./.github/actions/run-e2e");
  assert.ok(collect > -1, "the Collect models step is gone");
  assert.ok(gate > -1, "the post-collect-models health gate is gone");
  assert.ok(pin > -1, "the Docker job no longer resolves the provider selection");
  assert.ok(run > -1, "the run step is gone");
  assert.ok(collect < pin, "the selection must resolve AFTER Collect models");
  assert.ok(gate < pin, "the selection must resolve AFTER the health gate");
  assert.ok(pin < run, "the selection must resolve BEFORE the run");
});

test("the selection step is NOT continue-on-error", () => {
  // The daily's rotation is continue-on-error on purpose (#980). Here the input is
  // the request: continuing past a failed pin runs the other providers, answers a
  // different question and reports success (#1012).
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  const body = stepBody(yml, "Resolve the run's provider selection");
  assert.doesNotMatch(body, /continue-on-error/);
});

test("the pin variables reach the run through GITHUB_ENV, never an inline env:", () => {
  // Two inline lines would reintroduce both failure modes the script exists to
  // prevent: a hardcoded id that skips silently when access is lost (#570/#1012),
  // and a provider without an id (the catalog sweep, #1169).
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  assert.doesNotMatch(yml, /^\s+(MODEL_TEST_(ID|PROVIDER)|ALL_MODELS):/m);
});

test("the external-URL job rejects any selection other than auto", () => {
  // Never a silent all-skip: that job runs no collect-models and gets no provider
  // key, so every parametrized LLM spec would skip while the run read green.
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  const urlJob = yml.slice(yml.indexOf("  e2e-url:"));
  const reject = urlJob.indexOf("Reject a provider selection on an external target");
  const run = urlJob.indexOf("uses: ./.github/actions/run-e2e");
  assert.ok(reject > -1, "the external-URL job stopped rejecting the input");
  assert.ok(reject < run, "the rejection must come BEFORE the run");
  const body = stepBody(urlJob, "Reject a provider selection on an external target");
  assert.match(body, /exit 1/);
  // Empty is accepted alongside auto so a dispatch queued before the input existed
  // can still be re-run.
  assert.match(body, /inputs\.provider != ''/);
  assert.match(body, /inputs\.provider != 'auto'/);
});
