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
  readModelsFile,
  selectManualModelTarget,
} from "./select-manual-model-target.mjs";

const SCRIPT = path.join(import.meta.dirname, "select-manual-model-target.mjs");
const RUN_E2E = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "actions",
  "run-e2e",
  "action.yml",
);
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

test("auto never fails on either file, whatever state they are in", () => {
  // The default path must not depend on a sweep that is continue-on-error here — not
  // even on a payload that throws. Both files are read now (the fan-out is only honest
  // when it accounts for the health map), so both must be survivable.
  const badReads = [
    () => {
      throw new Error("boom");
    },
    () => ({ models: null, providers: null, missing: true }),
    () => ({ models: [], providers: [], missing: false }),
    () => ({ models: { openai: [] }, providers: { openai: "active" }, missing: false }),
  ];
  for (const readModels of badReads) {
    for (const readProviders of badReads) {
      const d = selectManualModelTarget(AUTO, { readModels, readProviders });
      assert.equal(d.ok, true);
      assert.deepEqual(d.env, []);
    }
  }
});

test("auto fails LOUDLY when a reader seam is missing — that is a bug, not a state", () => {
  // An absent reader used to be swallowed by the same try/catch that tolerates an
  // unreadable file, and reported as "models.json cannot be parsed": a caller's wiring
  // mistake diagnosed as a CI file state, on the one path that never fails.
  for (const io of [
    {},
    { readModels: () => ({ models: [], missing: false }) },
    { readProviders: () => ({ providers: [], missing: false }) },
  ]) {
    assert.throws(() => selectManualModelTarget(AUTO, io), /must be a function/);
  }
});

test("auto reports the fan-out it will actually get: first model per provider", () => {
  // The catalog is the file resolveTestTargets() reads, and its default branch takes the
  // first entry per provider — so this must be derived from models.json, not from
  // providers.json, or the log could disagree with the run.
  const d = selectManualModelTarget(AUTO, io());
  assert.deepEqual(d.fanout, [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  assert.deepEqual(d.warnings, []);
});

test("auto WARNS when an absent catalog will collapse it to a single fallback target", () => {
  // The regression this exists for: collect-models writes models.json at the END of its
  // sweep and is continue-on-error here, so a sweep that throws part-way leaves no
  // catalog. resolveTestTargets() then returns ONE "provider:openai (fallback)" target
  // with skipReason undefined (the health map is empty on an absent providers.json),
  // openai's key IS forwarded on this lane, so nothing skips: ~30 parametrized agent
  // tests run one provider and the release-gate dispatch reads green.
  const d = selectManualModelTarget(AUTO, io({ modelsMissing: true }));
  assert.equal(d.ok, true, "auto must still not fail");
  assert.deepEqual(d.fanout, []);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /does not exist/);
  assert.match(d.warnings[0], /NOT deliver multi-provider/);
});

test("auto warns on an empty catalog and on an unreadable one, distinctly", () => {
  const empty = selectManualModelTarget(AUTO, io({ models: [] }));
  assert.equal(empty.ok, true);
  assert.match(empty.warnings[0], /is empty/);
  assert.match(empty.warnings[0], /NOT deliver multi-provider/);

  const bad = selectManualModelTarget(AUTO, io({ models: { openai: [] } }));
  assert.equal(bad.ok, true);
  assert.match(bad.warnings[0], /cannot be parsed/);
});

test("auto warns when the catalog leaves it single-provider in practice", () => {
  // Not an error — one provider probing active is a legitimate state — but a dispatch
  // made for the release gate is asking for multi-provider, so a partially failed sweep
  // must not read as a successful one.
  const d = selectManualModelTarget(
    AUTO,
    io({ models: [{ provider: "openai", model: "gpt-4o-mini" }] }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.fanout.length, 1);
  assert.match(d.warnings[0], /single-provider in practice/);
  assert.match(d.warnings[0], /absent from the catalog/);
});

test("auto counts the RUNNABLE targets, not the catalog's providers", () => {
  // The gap this closes. models.json mirrors the Langflow catalog, NOT the probe:
  // collectAll() scrapes the model lists in step 2 and validates the keys in step 3, so a
  // drained provider keeps every one of its models in the catalog (#1029 left all 36
  // google models there under a spending cap). resolveTestTargets() then resolves a
  // target for it and providerSkipReasons() makes that target test.skip().
  //
  // Counting the catalog therefore reported "3 target(s)" for a dispatch that ran ONE —
  // the release-gate dispatch claiming multi-provider coverage it did not have, which is
  // the exact shape the auto guard exists to prevent, reached through the file it was
  // not reading. This is also the state the account has been in three times: #772
  // (openai), #1029 (google), #1169 (anthropic).
  const providers = healthy().map((p) =>
    p.provider === "openai"
      ? p
      : { ...p, status: "inactive", model: null, error: `${p.provider} key is drained` },
  );
  const d = selectManualModelTarget(
    AUTO,
    io({
      providers,
      models: [
        { provider: "openai", model: "gpt-4o-mini" },
        { provider: "anthropic", model: "claude-sonnet-5" },
        { provider: "google", model: "gemini-2.5-flash" },
      ],
    }),
  );
  assert.equal(d.ok, true, "auto must still not fail");
  assert.equal(d.fanout.length, 3, "the fan-out still describes the whole catalog");
  // Each skipped target carries the reason collect-models recorded, so the dispatcher
  // does not have to open the job log to learn which credential is dead.
  assert.deepEqual(
    d.fanout.filter((t) => t.skipReason).map((t) => t.provider),
    ["anthropic", "google"],
  );
  assert.match(d.warnings[0], /single-provider in practice/);
  assert.match(d.warnings[0], /1 of 3 catalog provider\(s\) can run/);
  assert.match(d.warnings[0], /anthropic: anthropic key is drained/);
  assert.match(d.warnings[0], /google: google key is drained/);
});

test("a runnable target carries no skipReason key at all", () => {
  // Not cosmetic: `{ provider, model }` is the record the typedef documents and what the
  // fan-out assertions compare against, so an always-present `skipReason: undefined`
  // would make every one of them structurally unequal.
  const d = selectManualModelTarget(AUTO, io());
  assert.deepEqual(Object.keys(d.fanout[0]), ["provider", "model"]);
});

test("auto still warns when a provider is skipped but two remain — multi-provider, narrower", () => {
  // Above the single-provider threshold, so not the failure the warning above reports,
  // but the printed fan-out is smaller than the catalog and the line must not imply
  // otherwise.
  const providers = healthy().map((p) =>
    p.provider === "google" ? { ...p, status: "inactive", model: null } : p,
  );
  const d = selectManualModelTarget(
    AUTO,
    io({
      providers,
      models: [
        { provider: "openai", model: "gpt-4o-mini" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "google", model: "gemini-2.5-flash" },
      ],
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /1 of 3 catalog provider\(s\) will resolve a target/);
  assert.match(d.warnings[0], /still covers 2 providers/);
});

test("an absent providers.json is FAIL-OPEN: nothing is assumed skipped, and it says so", () => {
  // readProviderHealth() returns null on an absent file and providerSkipReasons() then
  // returns an empty map, so nothing skips at run time — a provider with a dead key
  // fails live instead. Reporting those targets as skipped would be the same
  // overstatement pointing the other way, so they count as runnable and the gap is
  // named.
  const d = selectManualModelTarget(AUTO, io({ providersMissing: true }));
  assert.equal(d.ok, true);
  assert.deepEqual(
    d.fanout.map((t) => t.skipReason),
    [undefined, undefined],
  );
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /providers\.json is absent or unparseable/);
  assert.match(d.warnings[0], /nothing will skip/);
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
  assert.match(d.warnings[0], /up to 3 target\(s\) across 2 provider\(s\)/);
  // "for EVERY parametrized spec" was wrong: the two specs that declare a `requires`
  // capability sweep a capability-filtered subset (CAPABILITY_EXCLUDES in
  // test-targets.ts), so a dispatcher multiplying this by the spec count mis-counts.
  assert.match(d.warnings[0], /requires/);
  assert.match(d.warnings[0], /90-minute timeout/);
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

test("all-models validates each record, not just the array shape", () => {
  // Everything after this point counts and names providers. A null entry used to crash
  // with a bare "Cannot read properties of null" and a missing field used to put
  // `undefined` into the sweep-size warning — the one line a dispatcher reads before
  // committing an hour of agent runs. Undecidable payload, so exit 2 (#1035).
  assert.throws(
    () => selectManualModelTarget(ALL_MODELS, io({ models: [null] })),
    /models\.json\[0\] must be an object, got null/,
  );
  assert.throws(
    () => selectManualModelTarget(ALL_MODELS, io({ models: [{ model: "gpt-4o-mini" }] })),
    /models\.json\[0\] has no "provider"/,
  );
  assert.throws(
    () => selectManualModelTarget(ALL_MODELS, io({ models: [{ provider: "openai" }] })),
    /models\.json\[0\] has no "model"/,
  );
});

// ─── the one interaction only this lane can have (#1186 × #1187) ──────────────

test("a pin announces that any-completion routing OUTRANKS it", () => {
  // This is the only workflow that can set both inputs, and resolveTestTargets() makes
  // ANY_COMPLETION_PROVIDER win for `tier: "any-completion"` on purpose (#1187). The
  // specs warn about the override themselves, but only in the Playwright log, one line
  // per routed spec, long after the dispatch is committed — and this lane's whole
  // argument is that a request it cannot honour as asked must say so where the
  // dispatcher is looking.
  const d = selectManualModelTarget("anthropic", {
    ...io(),
    env: { ANY_COMPLETION_PROVIDER: "ollama" },
  });
  assert.equal(d.ok, true, "the pin is still honoured — routing is scoped to one tier");
  assert.deepEqual(d.env, [
    "MODEL_TEST_ID=claude-haiku-4-5",
    "MODEL_TEST_PROVIDER=anthropic",
  ]);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /routing OUTRANKS the pin/);
  assert.match(d.warnings[0], /any-completion/);
});

test("all-models announces the same override, and no selection warns without routing", () => {
  const routed = selectManualModelTarget(ALL_MODELS, {
    ...io(),
    env: { ANY_COMPLETION_PROVIDER: "ollama" },
  });
  assert.match(routed.warnings[0], /routing OUTRANKS the pin/);
  assert.match(routed.warnings[1], /up to 3 target\(s\)/);

  // "hosted" maps to an EMPTY variable in manual.yml, which is what resolveTestTargets
  // reads as "not routed" — so an empty value must not produce the warning.
  for (const env of [{}, { ANY_COMPLETION_PROVIDER: "" }]) {
    const d = selectManualModelTarget("openai", { ...io(), env });
    assert.equal(d.warnings.length, 0);
  }
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

test("PIN_PROVIDERS is exactly the set of keys run-e2e DECLARES", () => {
  // A spec calls hasProviderEnvKeys(<provider>) and skips itself when its own key is
  // absent (#967), so pinning to a provider whose key this lane never passes would skip
  // everything and read green.
  const action = fs.readFileSync(RUN_E2E, "utf-8");
  const declared = [...action.matchAll(/^ {2}(\w+)_api_key:$/gm)].map((m) => m[1]);
  assert.deepEqual(declared.slice().sort(), PIN_PROVIDERS.slice().sort());
});

test("every run-e2e step that forwards ONE provider key forwards ALL of them", () => {
  // Declaring the input is not forwarding it. Deleting a single
  // `GOOGLE_API_KEY: ${{ inputs.google_api_key }}` line from a step's `env:` leaves the
  // input declared and the guard above green, while `provider=google` pins fine and then
  // every google spec skips on hasProviderEnvKeys — #967 reached from the other side.
  // run-e2e starts Playwright twice (the main run and the destructive lane), so this
  // holds per step, not once per file.
  const action = fs.readFileSync(RUN_E2E, "utf-8");
  const counts = PIN_PROVIDERS.map((p) => [
    p,
    [
      ...action.matchAll(
        new RegExp(
          `${p.toUpperCase()}_API_KEY: \\$\\{\\{ inputs\\.${p}_api_key \\}\\}`,
          "g",
        ),
      ),
    ].length,
  ]);
  const [firstProvider, first] = counts[0];
  assert.ok(first > 0, "run-e2e forwards no provider key at all");
  for (const [provider, count] of counts) {
    assert.equal(
      count,
      first,
      `run-e2e forwards ${provider}'s key ${count} time(s) and ${firstProvider}'s ` +
        `${first} — a step that forwards one must forward all three`,
    );
  }
});

test("the Docker job passes every provider key it can pin to into run-e2e", () => {
  // The caller's side of the same failure: dropping `google_api_key:` from the `with:`
  // block leaves both guards above green and still makes `provider=google` a green
  // all-skip (#967 is exactly this, found the hard way).
  const yml = fs.readFileSync(WORKFLOW, "utf-8");
  const docker = yml.slice(yml.indexOf("  e2e-docker:"), yml.indexOf("  e2e-url:"));
  const call = docker.slice(docker.indexOf("uses: ./.github/actions/run-e2e"));
  for (const provider of PIN_PROVIDERS) {
    assert.match(
      call,
      new RegExp(
        `${provider}_api_key: \\$\\{\\{ secrets\\.${provider.toUpperCase()}_API_KEY \\}\\}`,
      ),
      `the Docker job does not pass ${provider}'s key to run-e2e`,
    );
  }
});

// ─── the file readers ────────────────────────────────────────────────────────

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

test("the auto line reports what RUNS and names what skips, never the raw catalog", () => {
  // The line a dispatcher screenshots. Printing "Resolves 3 target(s)" while two of the
  // three test.skip() is the overstatement the fan-out guard exists to prevent, so the
  // count is over the runnable targets and the skipped ones are named on the same line —
  // not left to a ::warning:: that scrolls past.
  const providers = healthy().map((p) =>
    p.provider === "openai"
      ? p
      : { ...p, status: "inactive", model: null, error: "credit balance is too low" },
  );
  const r = runCli(["--selection", "auto"], {
    providers,
    models: [
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.githubEnv.trim(), "");
  assert.match(r.stderr, /Runs 1 target\(s\): openai \/ gpt-4o-mini\./);
  assert.match(r.stderr, /Skips 2 \(recorded inactive\): anthropic, google\./);
  assert.doesNotMatch(r.stderr, /Runs 3 target/);
  assert.match(r.stderr, /::warning::select-manual-model-target/);
});

test("the routing override reaches the log through the process environment", () => {
  const r = runCli(["--selection", "openai"], {
    providers: healthy(),
    env: { ANY_COMPLETION_PROVIDER: "ollama" },
  });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /::warning::.*routing OUTRANKS the pin/);
  // Still pinned: the override is scoped to one tier, so the variables must still be set.
  assert.deepEqual(r.githubEnv.trim().split("\n").sort(), [
    "MODEL_TEST_ID=gpt-4o-mini",
    "MODEL_TEST_PROVIDER=openai",
  ]);
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
  const from = yml.indexOf("      provider:");
  assert.ok(from > -1, "the provider input is gone");
  // Closed at the NEXT input rather than run to end of file: a slice that reaches the
  // rest of the workflow would satisfy the `default: "auto"` assertion from any other
  // input's default, so deleting this one's would still pass.
  const next = yml.slice(from + 1).search(/^ {6}\w+:$/m);
  const input = next === -1 ? yml.slice(from) : yml.slice(from, from + 1 + next);
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

test("the selection step passes the dispatch INPUT through, not a fixed value", () => {
  // Hardcoding `--selection auto` (or dropping the env binding, which resolves to the
  // empty string and therefore to auto) makes the whole input decorative: every dispatch
  // runs multi-provider whatever was chosen, and the log agrees with itself. No
  // behavioural test can catch that — the value is bound in YAML.
  const body = stepBody(
    fs.readFileSync(WORKFLOW, "utf-8"),
    "Resolve the run's provider selection",
  );
  assert.match(body, /--selection "\$SELECTION"/);
  assert.match(body, /SELECTION: \$\{\{ github\.event\.inputs\.provider \}\}/);
});

test("the selection step cannot be softened into a non-gate", () => {
  // The daily's rotation is continue-on-error on purpose (#980). Here the input is the
  // request: continuing past a failed pin runs the other providers, answers a different
  // question and reports success (#1012). `continue-on-error` is only ONE spelling of
  // that — `|| true` after the node call achieves it with different characters, and an
  // `if:` would let the step be skipped entirely.
  const body = stepBody(
    fs.readFileSync(WORKFLOW, "utf-8"),
    "Resolve the run's provider selection",
  );
  for (const softener of [/continue-on-error/, /\|\|\s*true/, /;\s*true/, /^\s+if:/m]) {
    assert.doesNotMatch(body, softener);
  }
});

test("the pin variables reach the run through GITHUB_ENV, never an inline env:", () => {
  // Two inline lines would reintroduce both failure modes the script exists to
  // prevent: a hardcoded id that skips silently when access is lost (#570/#1012),
  // and a provider without an id (the catalog sweep, #1169).
  //
  // run-e2e is checked too, and it is the more dangerous of the two: a step-level `env:`
  // OUTRANKS $GITHUB_ENV, so a MODEL_TEST_ID declared there would silently shadow
  // everything this step resolved — and that is where the Playwright process actually
  // starts, for both jobs.
  for (const file of [WORKFLOW, RUN_E2E]) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf-8"),
      /^\s+(MODEL_TEST_(ID|PROVIDER)|ALL_MODELS):/m,
      `${path.basename(file)} sets a pin variable inline`,
    );
  }
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
  // The whole condition, normalized — not two substring probes. Asserting that both
  // operands appear says nothing about the OPERATOR, and flipping `&&` to `||` makes it
  // always true: EVERY external-URL dispatch would fail, `auto` and empty included.
  // Empty is accepted alongside auto so a dispatch queued before the input existed can
  // still be re-run, which is why the condition has two clauses at all.
  const condition = body
    .slice(body.indexOf("if:"), body.indexOf("env:"))
    .replace(/^\s*if: >-/, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(
    condition,
    "github.event.inputs.provider != '' && github.event.inputs.provider != 'auto'",
  );
});
