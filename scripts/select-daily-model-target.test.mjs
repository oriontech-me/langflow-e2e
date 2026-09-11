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
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {
  displacementLines,
  nextScheduledSlot,
  renderRotationSummary,
  rotationDisplacement,
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

test("daily-stable.yml asks exactly one shard for the full rotation block", () => {
  // The script's own default is the FULL block (local, and the VM twin, which calls it
  // once), so the one-shard behaviour lives entirely in this `env:` line — remove it
  // and every shard renders the table again, which is the #1252 artifact #1801 came to
  // remove. Measured: the whole unit suite stays green with the line deleted, so the
  // script-side test two hundred lines down does not reach it.
  const yml = fs.readFileSync(
    path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
    "utf-8",
  );
  const step = yml
    .slice(
      yml.lastIndexOf("- name:", yml.indexOf("select-daily-model-target.mjs")),
      yml.indexOf("select-daily-model-target.mjs"),
    )
    // COMMENTS STRIPPED, and that is the whole difference between a pin and a spelling
    // check (#1226). Three evasions were measured against earlier versions of this
    // test, each changing the behaviour while keeping the matched spelling on the
    // page: commenting the line out (every shard renders the full table again — the
    // #1252 artifact), parking the old expression in a full-line comment above a
    // hardcoded `ROTATION_SUMMARY: '1'`, and — the one a line-anchored filter still
    // let through — parking it in a TRAILING comment beside one:
    //
    //     ROTATION_SUMMARY: '1'  # was ${{ matrix.shard == 1 && '1' || '0' }}
    //
    // Trailing comments after a mapping value are ordinary in this workflow
    // (`daily-stable.yml` has them), so that is the natural way to park an old value
    // rather than a contrived one. Both forms go.
    //
    // A string strip rather than a YAML parse because this repo has no YAML
    // dependency. It is imprecise in one direction only — a `#` inside a quoted value
    // would be cut — and that costs a false FAILURE, never a false pass, which is the
    // side a guard may be wrong on.
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");
  assert.match(step, /ROTATION_SUMMARY:/, "the rotation step no longer chooses a shape");
  // ONE assertion binding the key to its VALUE, not two independent ones. Two let the
  // expression be parked on a live SIBLING key — `ROTATION_SHAPE_LEGACY: &rot ${{ … }}`
  // beside a hardcoded `ROTATION_SUMMARY: '1'` — which is not a comment, survives both
  // comment strips, and puts the full table back on every shard. Measured green.
  //
  // `'1'` for shard 1 and `'0'` elsewhere — NOT a suppression, which is the half of
  // this the first shape got wrong: writing nothing on the other shards made the only
  // rendered surface depend on shard 1 surviving to this step, on a lane whose own
  // comments record shards dying before it (#1011).
  assert.match(step, /ROTATION_SUMMARY:\s*\$\{\{ matrix\.shard == 1 && '1' \|\| '0' \}\}/);
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

// --- what a displaced slot COSTS (issue #1456) -------------------------------
// The rotation advancing past a dead provider is the right call — losing the day
// costs more than spend (#980) — but until #1456 the only trace was a `::warning::`,
// the surface #1252 measured nobody reading. What was missing is not the fact that a
// provider was skipped; it is how long that provider then goes uncovered.

const ORDER = ["openai", "anthropic", "google"];

test("google displaced on its Wednesday waits a full week, not three days", () => {
  // The number the issue was written around. With three providers over a Mon-Fri
  // cron, google owns Wednesday alone: Saturday's slot would also be its, and
  // Saturday is not a run.
  const next = nextScheduledSlot("google", ORDER, WED);
  assert.equal(next.days, 7);
  assert.equal(next.date.toISOString().slice(0, 10), "2026-08-05");
});

test("openai and anthropic wait at most four days, and it depends on the day", () => {
  // CLAUDE.md's "≤3 days" is the intra-week gap; the real bound is 4, because the
  // cron does not run the weekend. Derived here rather than asserted in prose.
  assert.equal(nextScheduledSlot("openai", ORDER, MON).days, 3); // Mon → Thu
  assert.equal(nextScheduledSlot("openai", ORDER, THU).days, 4); // Thu → Mon
  assert.equal(nextScheduledSlot("anthropic", ORDER, TUE).days, 3); // Tue → Fri
  assert.equal(nextScheduledSlot("anthropic", ORDER, FRI).days, 4); // Fri → Tue
});

test("a provider outside the rotation order has no slot to wait for", () => {
  assert.equal(nextScheduledSlot("mistral", ORDER, WED), null);
});

test("an undisplaced rotation reports nothing at all", () => {
  // No block on the ordinary day: a summary printed every run is the artifact, not
  // the signal.
  const result = selectDailyModelTarget(healthy(), { date: WED });
  assert.equal(rotationDisplacement(result, { date: WED }), null);
  assert.equal(renderRotationSummary(null), "");
  assert.deepEqual(displacementLines(null), []);
});

test("a displaced Wednesday names the provider, the cause and the gap", () => {
  const providers = healthy().map((p) =>
    p.provider === "google"
      ? { ...p, status: "inactive", model: null, error: "monthly spending cap" }
      : p,
  );
  const result = selectDailyModelTarget(providers, { date: WED });
  assert.equal(result.ok, true, "the day must still run — #980's trade");
  assert.equal(result.provider, "openai");

  const displacement = rotationDisplacement(result, { date: WED });
  assert.equal(displacement.weekday, "Wednesday");
  assert.equal(displacement.resolved, "openai");
  assert.deepEqual(
    displacement.displaced.map((d) => [d.provider, d.days]),
    [["google", 7]],
  );

  const summary = renderRotationSummary(displacement);
  assert.match(summary, /^### /, "the block leads with a heading");
  assert.match(summary, /Rotation displaced/);
  assert.match(summary, /google/);
  assert.match(summary, /monthly spending cap/, "the cause the sweep measured");
  assert.match(summary, /7 day\(s\)/, "the cost, which is the point");
  assert.match(summary, /openai/, "and what ran instead");

  // The log line carries the same facts, for the VM lane — which runs this script
  // outside Actions and has no step summary.
  const [line] = displacementLines(displacement);
  assert.match(line, /Wednesday is "google"'s slot/);
  assert.match(line, /7 day\(s\)/);
  assert.match(line, /monthly spending cap/);
});

test("declining to pin renders as a decline, not as an advance", () => {
  // Every provider down: the lane keeps its multi-provider default, so there is no
  // "ran X instead" to claim.
  const providers = healthy().map((p) => ({
    ...p,
    status: "inactive",
    model: null,
    error: "dead key",
  }));
  const result = selectDailyModelTarget(providers, { date: WED });
  assert.equal(result.ok, false);
  const displacement = rotationDisplacement(result, { date: WED });
  assert.equal(displacement.resolved, null);
  assert.equal(displacement.displaced.length, 3);
  const summary = renderRotationSummary(displacement);
  assert.match(summary, /could not pin/);
  assert.doesNotMatch(summary, /advanced to/);
  // "passed over" would claim the lane advanced to something. It did not — it kept
  // multi-provider parametrization, so nothing was passed over (#1801).
  assert.doesNotMatch(summary, /passed over/);
  assert.match(summary, /also unusable/);
});

test("the CLI writes the block to \$GITHUB_STEP_SUMMARY, and only when displaced", () => {
  const dir = makeTempDir("rotation-1456-");
  const providersFile = path.join(dir, "providers.json");
  const summaryFile = path.join(dir, "summary.md");
  const envFile = path.join(dir, "env.txt");

  const run = (providers) => {
    fs.writeFileSync(providersFile, JSON.stringify(providers));
    fs.writeFileSync(summaryFile, "");
    return execFileSync(
      process.execPath,
      [SCRIPT, "--providers-file", providersFile, "--date", WED.toISOString()],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_ENV: envFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  };

  run(healthy());
  assert.equal(
    fs.readFileSync(summaryFile, "utf-8"),
    "",
    "an undisplaced rotation must add nothing to the run summary",
  );

  run(
    healthy().map((p) =>
      p.provider === "google"
        ? { ...p, status: "inactive", model: null, error: "monthly spending cap" }
        : p,
    ),
  );
  const written = fs.readFileSync(summaryFile, "utf-8");
  assert.match(written, /Rotation displaced/);
  assert.match(written, /7 day\(s\)/);
});

// --- a fallback is not the weekday's slot (issue #1801) ---------------------
// `skipped` holds every candidate the rotation tried. Only the first owns the day;
// describing the rest the same way produced a line that contradicted itself and
// gave a fallback a gap it does not have.

test("two dead providers: the first owns the day, the second is a passed-over fallback", () => {
  const providers = healthy().map((p) =>
    p.provider === "openai"
      ? { ...p, status: "inactive", model: null, error: "credit balance too low" }
      : p.provider === "anthropic"
        ? { ...p, status: "inactive", model: null, error: "no credit" }
        : p,
  );
  // Monday is openai's slot; anthropic is the first fallback and also dead.
  const result = selectDailyModelTarget(providers, { date: MON });
  assert.equal(result.provider, "google");

  const displacement = rotationDisplacement(result, { date: MON });
  assert.deepEqual(
    displacement.displaced.map((d) => [d.provider, d.owns, d.days]),
    [
      ["openai", true, 3], // Mon → Thu
      ["anthropic", false, null], // a fallback loses no slot of its own here
    ],
  );

  const [ownerLine, fallbackLine] = displacementLines(displacement);
  assert.match(ownerLine, /Monday is "openai"'s slot/);
  assert.match(ownerLine, /3 day\(s\)/);
  assert.match(fallbackLine, /fallback "anthropic" was also unusable/);
  assert.doesNotMatch(fallbackLine, /Monday is "anthropic"/, "a fallback does not own the day");
  assert.doesNotMatch(fallbackLine, /day\(s\) from this run/, "and it has no gap to claim");

  const summary = renderRotationSummary(displacement);
  assert.match(summary, /belongs to `openai`/);
  assert.match(summary, /past `anthropic`, also unusable/);
  assert.match(summary, /\| `openai` \| this weekday's slot \| Thursday/);
  assert.match(summary, /\| `anthropic` \| fallback, passed over \| — \| — \|/);
});

test("a reason carrying a pipe cannot split the rotation table", () => {
  const providers = healthy().map((p) =>
    p.provider === "openai"
      ? { ...p, status: "inactive", model: null, error: "403 Forbidden | check billing" }
      : p,
  );
  const result = selectDailyModelTarget(providers, { date: MON });
  const summary = renderRotationSummary(rotationDisplacement(result, { date: MON }));
  const row = summary.split("\n").find((l) => l.startsWith("| `openai`"));
  assert.match(row, /403 Forbidden \\\| check billing/, "the pipe must be escaped");
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, "the row must keep its five columns");
});

test("ROTATION_SUMMARY=0 writes the COMPACT note, never nothing", () => {
  // One shard writes the block; every shard logs the fact (#1801).
  const dir = makeTempDir("rotation-1801-");
  const providersFile = path.join(dir, "providers.json");
  const summaryFile = path.join(dir, "summary.md");
  fs.writeFileSync(
    providersFile,
    JSON.stringify(
      healthy().map((p) =>
        p.provider === "google"
          ? { ...p, status: "inactive", model: null, error: "monthly spending cap" }
          : p,
      ),
    ),
  );

  const run = (rotationSummary) => {
    fs.writeFileSync(summaryFile, "");
    const env = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_ENV: path.join(dir, "env.txt"),
    };
    // DELETED, not just left unassigned (#1801): `{...process.env}` inherits, so the
    // "unset" case was asserting whatever the ambient shell exported — vacuous at
    // best, and spuriously red for anyone who exports ROTATION_SUMMARY=0.
    if (rotationSummary === undefined) delete env.ROTATION_SUMMARY;
    else env.ROTATION_SUMMARY = rotationSummary;
    const proc = spawnSync(
      process.execPath,
      [SCRIPT, "--providers-file", providersFile, "--date", WED.toISOString()],
      { encoding: "utf-8", env },
    );
    return { summary: fs.readFileSync(summaryFile, "utf-8"), stderr: proc.stderr };
  };

  // Suppressing it here was the first shape of this fix and it was wrong: the only
  // rendered surface would then depend on shard 1 surviving to this step (#1801).
  const compact = run("0");
  assert.match(compact.summary, /Rotation displaced/, "every shard writes SOMETHING");
  assert.match(compact.summary, /^> /, "the compact form is a one-line blockquote");
  assert.doesNotMatch(compact.summary, /\| Provider \|/, "and not the table");
  assert.match(compact.summary, /7 day\(s\)/, "the gap is the part worth keeping");
  assert.match(compact.summary, /monthly spending cap/, "so is the cause");
  assert.equal(
    compact.summary.trim().split("\n").length,
    1,
    "one line, so four shards cost four lines",
  );
  assert.match(compact.stderr, /::warning::/, "and the log still carries it");

  const full = run("1");
  assert.match(full.summary, /^### /, "shard 1 writes the table");
  assert.match(full.summary, /\| Provider \|/);
  assert.match(run(undefined).summary, /\| Provider \|/, "unset means the full block");
});

test("the rotation's own warnings stop claiming a fallback owns the day (#1801)", () => {
  // The renderers were fixed first and this array was left behind, so the run
  // contradicted itself two lines apart in the same annotation stream.
  const providers = healthy().map((p) =>
    p.provider === "openai" || p.provider === "anthropic"
      ? { ...p, status: "inactive", model: null, error: "dead" }
      : p,
  );
  const result = selectDailyModelTarget(providers, { date: MON });
  assert.equal(result.provider, "google");
  const [first, second] = result.warnings;
  assert.match(first, /"openai", this weekday's slot/);
  assert.match(second, /passed over the fallback "anthropic"/);
  assert.doesNotMatch(second, /this weekday's slot/, "a fallback never owns the day");
});

test("a multi-line reason cannot terminate the rotation table (#1801)", () => {
  // `collect-models` records a collector STALL through `formatSaveBusyFailure()`,
  // which is deliberately several lines. Unescaped, the table ended at that row and
  // every row after it fell out of it.
  const providers = healthy().map((p) =>
    p.provider === "google"
      ? {
          ...p,
          status: "inactive",
          model: null,
          error: "collector stalled\n  aria-busy stayed true\n  verdict: save-busy",
        }
      : p,
  );
  const result = selectDailyModelTarget(providers, { date: WED });
  const summary = renderRotationSummary(rotationDisplacement(result, { date: WED }));
  const rows = summary.split("\n").filter((l) => l.startsWith("| `"));
  assert.equal(rows.length, 1, "the row must survive as ONE row");
  assert.match(rows[0], /aria-busy stayed true/, "and keep the measured text");
  assert.equal(rows[0].split(/(?<!\\)\|/).length - 2, 5, "with its five columns");
  assert.ok(summary.trim().endsWith("(#1456)."), "and the table must not end the doc");
});
