// Unit tests for the daily lane's provider rotation (issue #1185).
// Run with: npm run test:scripts
//
// What rides on this: it decides which provider the daily's ~30 @stable agent tests
// bill against, every weekday. Three failure directions, and two of them are silent:
//
//  - Rotating to a DEAD provider loses the whole day of agent coverage. The daily
//    already recorded zero tests on 2026-07-28 and 2026-07-31; a rotation that adds
//    a third way to lose a day is worse than the multi-provider run it replaces.
//  - Declining to pin when a fallback WAS available pays 3x on exactly the day a key
//    is already broken.
//  - Emitting MODEL_TEST_PROVIDER without MODEL_TEST_ID does not narrow the run, it
//    runs that provider's whole catalog (41 openai entries on 2026-07-30) — the trap
//    #1169 wrote a script to avoid. The pair is asserted at the CLI boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {
  rotationSlot,
  selectDailyModelTarget,
} from "./select-daily-model-target.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = path.join(import.meta.dirname, "select-daily-model-target.mjs");

/** Shaped like a real providers.json written by collect-models. */
const healthy = () => [
  { provider: "openai", status: "active", model: "gpt-4o-mini" },
  { provider: "anthropic", status: "active", model: "claude-sonnet-5" },
  { provider: "google", status: "active", model: "gemini-2.5-flash" },
];

// 2026-07-27 is a Monday; the days below walk that week.
const MON = new Date("2026-07-27T08:00:00Z");
const TUE = new Date("2026-07-28T08:00:00Z");
const WED = new Date("2026-07-29T08:00:00Z");
const THU = new Date("2026-07-30T08:00:00Z");
const FRI = new Date("2026-07-31T08:00:00Z");
const SAT = new Date("2026-08-01T08:00:00Z");
const SUN = new Date("2026-08-02T08:00:00Z");

// ─── The rotation itself ─────────────────────────────────────────────────────

test("the weekday mapping is Mon→openai, Tue→anthropic, Wed→google, Thu→openai, Fri→anthropic", () => {
  // Fixed rather than evenly distributed, on purpose: two Mondays must be
  // comparable. If this table changes, day-over-day triage comparisons break.
  const on = (d) => selectDailyModelTarget(healthy(), { date: d }).provider;
  assert.equal(on(MON), "openai");
  assert.equal(on(TUE), "anthropic");
  assert.equal(on(WED), "google");
  assert.equal(on(THU), "openai");
  assert.equal(on(FRI), "anthropic");
});

test("the pinned model is the one collect-models settled on, never a hardcoded id", () => {
  const result = selectDailyModelTarget(healthy(), { date: TUE });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-sonnet-5");
});

test("a weekend dispatch still resolves a provider instead of erroring", () => {
  // The lane is Mon-Fri on schedule, but workflow_dispatch has no such limit.
  assert.equal(selectDailyModelTarget(healthy(), { date: SAT }).ok, true);
  assert.equal(selectDailyModelTarget(healthy(), { date: SUN }).ok, true);
});

test("rotationSlot is Monday-zero and wraps on the order length", () => {
  assert.equal(rotationSlot(MON, 3), 0);
  assert.equal(rotationSlot(WED, 3), 2);
  assert.equal(rotationSlot(THU, 3), 0);
  assert.equal(rotationSlot(MON, 1), 0);
  assert.equal(rotationSlot(FRI, 1), 0);
});

test("a custom --order changes the rotation", () => {
  const order = ["google", "openai"];
  assert.equal(selectDailyModelTarget(healthy(), { date: MON, order }).provider, "google");
  assert.equal(selectDailyModelTarget(healthy(), { date: TUE, order }).provider, "openai");
});

// ─── The fallback — the reason this is not a fixed pin ───────────────────────

test("the day's provider being inactive advances to the next, it does NOT lose the day", () => {
  // Tuesday is anthropic's slot. A drained anthropic key must cost a deviation,
  // not a day of agent coverage (#980).
  const providers = healthy();
  providers[1] = {
    provider: "anthropic",
    status: "inactive",
    model: null,
    error: "credit balance too low",
  };
  const result = selectDailyModelTarget(providers, { date: TUE });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "google");
  assert.deepEqual(
    result.skipped.map((s) => s.provider),
    ["anthropic"],
  );
});

test("the deviation is LOUD and names the provider and the collected reason", () => {
  const providers = healthy();
  providers[1] = {
    provider: "anthropic",
    status: "inactive",
    model: null,
    error: "credit balance too low",
  };
  const result = selectDailyModelTarget(providers, { date: TUE });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /advanced past "anthropic"/);
  assert.match(result.warnings[0], /credit balance too low/);
});

test("the advance warning does NOT claim the lane kept multi-provider — it did not", () => {
  // Caught by reading a real run's log: the reason string inherited from the PR
  // lane's decision function ends with "the lane keeps its default per-provider
  // parametrization", which is true when that lane declines and FALSE here, where the
  // rotation advanced to the next provider. A log line that contradicts what the run
  // did is worse than no line.
  const providers = healthy();
  providers[1] = {
    provider: "anthropic",
    status: "inactive",
    model: null,
    error: "credit balance too low",
  };
  const result = selectDailyModelTarget(providers, { date: TUE });
  assert.equal(result.provider, "google", "sanity: it advanced");
  assert.doesNotMatch(result.warnings[0], /keeps its default per-provider/);
  assert.doesNotMatch(result.skipped[0].reason, /keeps its default per-provider/);
});

test("the all-down decline DOES say the lane keeps multi-provider — there it is true", () => {
  const providers = healthy().map((p) => ({
    provider: p.provider,
    status: "inactive",
    model: null,
    error: "dry",
  }));
  const result = selectDailyModelTarget(providers, { date: MON });
  assert.equal(result.ok, false);
  assert.match(result.reason, /keeps its default per-provider/);
});

test("it advances more than once when it has to", () => {
  const providers = [
    { provider: "openai", status: "active", model: "gpt-4o-mini" },
    { provider: "anthropic", status: "inactive", model: null, error: "dry" },
    { provider: "google", status: "inactive", model: null, error: "spend cap" },
  ];
  const result = selectDailyModelTarget(providers, { date: TUE });
  assert.equal(result.provider, "openai");
  assert.deepEqual(
    result.skipped.map((s) => s.provider),
    ["anthropic", "google"],
  );
  assert.equal(result.warnings.length, 2);
});

test("a provider absent from providers.json is skipped like an inactive one", () => {
  const result = selectDailyModelTarget(
    [{ provider: "openai", status: "active", model: "gpt-4o-mini" }],
    { date: WED }, // google's slot, and google is not in the file
  );
  assert.equal(result.provider, "openai");
  assert.match(result.skipped[0].reason, /absent from providers\.json/);
});

test("every provider down declines to pin instead of pretending, and explains per provider", () => {
  // With no live key the fallback is moot: pinning would skip every parametrized
  // spec while the run read green. Declining keeps the failure attributable.
  const providers = healthy().map((p) => ({
    provider: p.provider,
    status: "inactive",
    model: null,
    error: `${p.provider} is dry`,
  }));
  const result = selectDailyModelTarget(providers, { date: MON });
  assert.equal(result.ok, false);
  assert.equal(result.provider, null);
  assert.equal(result.model, null);
  assert.match(result.reason, /no provider in the rotation/);
  for (const name of ["openai", "anthropic", "google"]) {
    assert.match(result.reason, new RegExp(`${name} is dry`));
  }
});

// ─── Undecidable input must fail loud, never fall back ───────────────────────

test("a malformed payload throws rather than falling back to the next provider", () => {
  // The first candidate already proves the file is undecidable. Catching this and
  // trying the rest would turn a hard error into a quiet fallback (#1035).
  assert.throws(
    () => selectDailyModelTarget({ not: "an array" }, { date: MON }),
    /must be an array of provider records/,
  );
  assert.throws(
    () => selectDailyModelTarget([{ status: "active" }], { date: MON }),
    /has no "provider" name/,
  );
});

test("an empty rotation order throws instead of silently doing nothing", () => {
  assert.throws(
    () => selectDailyModelTarget(healthy(), { date: MON, order: [] }),
    /non-empty list/,
  );
});

test("an unparseable --date throws", () => {
  assert.throws(
    () => selectDailyModelTarget(healthy(), { date: new Date("not a date") }),
    /not a valid instant/,
  );
});

// ─── The CLI boundary: the pair invariant and the exit codes ─────────────────

function runCli(args, { providers, env = {} } = {}) {
  const dir = makeTempDir("daily-target-");
  const file = path.join(dir, "providers.json");
  if (providers !== undefined) {
    fs.writeFileSync(
      file,
      typeof providers === "string" ? providers : JSON.stringify(providers),
    );
  }
  const ghEnv = path.join(dir, "github_env");
  fs.writeFileSync(ghEnv, "");
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--providers-file", file, ...args],
      { encoding: "utf-8", env: { ...process.env, GITHUB_ENV: ghEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      code: 0,
      json: JSON.parse(stdout),
      githubEnv: fs.readFileSync(ghEnv, "utf-8"),
    };
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("pinning writes BOTH variables to GITHUB_ENV — never the provider alone", () => {
  const r = runCli(["--date", TUE.toISOString()], { providers: healthy() });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const lines = r.githubEnv.trim().split("\n").sort();
  assert.deepEqual(lines, [
    "MODEL_TEST_ID=claude-sonnet-5",
    "MODEL_TEST_PROVIDER=anthropic",
  ]);
});

test("declining to pin writes NOTHING to GITHUB_ENV", () => {
  // A half-written pair is worse than no pin: MODEL_TEST_PROVIDER alone sweeps the
  // provider's whole catalog.
  const providers = healthy().map((p) => ({
    provider: p.provider,
    status: "inactive",
    model: null,
    error: "dry",
  }));
  const r = runCli(["--date", MON.toISOString()], { providers });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.equal(r.githubEnv.trim(), "");
});

test("a missing providers.json declines with a reason and exits 0", () => {
  // The sweep is continue-on-error on this lane by design (#980), so a missing file
  // is a legitimate state, not a crash.
  const r = runCli(["--date", MON.toISOString()]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /does not exist/);
  assert.equal(r.githubEnv.trim(), "");
});

test("an unreadable providers.json exits 2 — an undecidable verdict is not 'nothing to pin'", () => {
  const r = runCli(["--date", MON.toISOString()], { providers: "{ not json" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /::error::select-daily-model-target/);
});

test("an unknown flag exits 2 rather than running with a silently ignored argument", () => {
  const r = runCli(["--nope", "x"], { providers: healthy() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

// ─── Structural guard on the workflow wiring ─────────────────────────────────

test("daily-stable.yml runs the rotation between the health gate and the @stable run", () => {
  // The step is worthless before collect-models has written providers.json, and it
  // must not sit after the run it is supposed to configure. Mirrors the guard the PR
  // lane carries for its own pin step.
  const yml = fs.readFileSync(
    path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
    "utf-8",
  );
  const gate = yml.indexOf("wait-for-backend");
  const pin = yml.indexOf("select-daily-model-target.mjs");
  const run = yml.indexOf("Run @stable tests");
  assert.ok(gate > -1, "the post-collect-models health gate is gone");
  assert.ok(pin > -1, "daily-stable.yml no longer runs the rotation");
  assert.ok(run > -1, "the @stable run step is gone");
  assert.ok(gate < pin, "the rotation must run AFTER the health gate");
  assert.ok(pin < run, "the rotation must run BEFORE the @stable run");
});

test("the daily emits the provider/model pair from the script, not from inline env", () => {
  // Two inline `env:` lines would reintroduce both failure modes the script exists
  // to prevent: a hardcoded id that skips silently when access is lost (#570/#1012),
  // and a provider set without an id (the catalog sweep, #1169).
  const yml = fs.readFileSync(
    path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
    "utf-8",
  );
  const runStep = yml.slice(yml.indexOf("Run @stable tests"));
  const envBlock = runStep.slice(0, runStep.indexOf("- name:", 10));
  assert.doesNotMatch(
    envBlock,
    /MODEL_TEST_(ID|PROVIDER):/,
    "the @stable run sets a pin variable inline — it must come from GITHUB_ENV",
  );
});
