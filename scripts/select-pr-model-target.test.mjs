// Unit tests for the PR lane's single-provider model target. Run with:
//   npm run test:scripts
//
// Why these exist: the two ways to get this wrong both read as success.
//
//  - Emitting `MODEL_TEST_PROVIDER` without `MODEL_TEST_ID` does not narrow the
//    lane, it *widens* it: `resolveTestTargets()` skips the first-per-provider dedup
//    on that branch and runs every model the provider exposes (41 openai entries
//    in the 2026-07-30 catalog). A cost fix that becomes a 41x cost regression
//    would look exactly like a working one in the log, so the pair invariant is
//    asserted against the real CLI, not just the pure function.
//  - Pinning to a provider whose key is dead makes every parametrized spec skip
//    and the PR still goes green — #570/#1012's silent-skip failure. So an
//    inactive provider must decline to pin and say so, and that decline is
//    asserted here rather than discovered by a quiet lane.
//
// The payloads are the real shapes, including the drained-Anthropic error string
// captured on 2026-07-30.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectPrModelTarget, readProvidersFile } from "./select-pr-model-target.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "select-pr-model-target.mjs");
const REPO_ROOT = path.resolve(HERE, "..");

/** providers.json as collect-models wrote it on 2026-07-30 (anthropic drained). */
const PROVIDERS = [
  {
    provider: "openai",
    model: "gpt-4o-mini",
    status: "active",
    error: null,
    checkedAt: "2026-07-30T03:10:08.427Z",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    status: "inactive",
    error:
      "3 of 13 candidate model(s) failed validation with the SAME " +
      "model-independent error — stopped early; last error: Your credit balance " +
      "is too low to access the Anthropic API.",
    checkedAt: "2026-07-30T03:10:08.282Z",
  },
  {
    provider: "google",
    model: "gemini-3.5-flash",
    status: "active",
    error: null,
    checkedAt: "2026-07-30T03:10:09.268Z",
  },
];

test("pins the settled model of an active provider", () => {
  const r = selectPrModelTarget(PROVIDERS);

  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  // The SETTLED model, not the catalog head — a hardcoded id skips silently the
  // day the CI project loses access to it.
  assert.equal(r.model, "gpt-4o-mini");
  assert.equal(r.reason, null);
});

test("honours an explicit provider override", () => {
  const r = selectPrModelTarget(PROVIDERS, { provider: "google" });

  assert.equal(r.ok, true);
  assert.equal(r.model, "gemini-3.5-flash");
});

test("declines to pin an inactive provider, and names the reason", () => {
  // Pinning here would skip every parametrized spec while the PR stayed green.
  // The lane must fall back to the costlier multi-provider run instead (#980).
  const r = selectPrModelTarget(PROVIDERS, { provider: "anthropic" });

  assert.equal(r.ok, false);
  assert.equal(r.model, null);
  assert.match(r.reason, /probed "inactive"/);
  assert.match(r.reason, /credit balance is too low/);
});

test("declines to pin a provider absent from providers.json", () => {
  const r = selectPrModelTarget(PROVIDERS, { provider: "mistral" });

  assert.equal(r.ok, false);
  assert.equal(r.model, null);
  assert.match(r.reason, /absent from providers\.json/);
  // Lists what WAS there, so the log says which sweep produced this.
  assert.match(r.reason, /openai, anthropic, google/);
});

test("a payload it cannot read is an error, never a quiet no-pin", () => {
  // #1035: a verdict the script cannot produce must fail loudly rather than
  // reading like the healthy "nothing to pin" path.
  assert.throws(() => selectPrModelTarget(null), /must be an array/);
  assert.throws(() => selectPrModelTarget({ openai: "gpt-4o-mini" }), /must be an array/);
  assert.throws(() => selectPrModelTarget([null]), /must be an object/);
  assert.throws(() => selectPrModelTarget([{ model: "x", status: "active" }]), /no "provider" name/);
  assert.throws(() => selectPrModelTarget([{ provider: "openai", model: "x" }]), /no "status"/);
  assert.throws(
    () => selectPrModelTarget([{ provider: "openai", status: "active" }]),
    /active but carries no settled "model"/,
  );
});

test("a missing providers.json is a state, not a crash", () => {
  // collect-models is skipped on LLM-free PRs and continue-on-error on a canary.
  const r = readProvidersFile("/nonexistent/providers.json", {
    exists: () => false,
    readFile: () => {
      throw new Error("must not read a file it decided is absent");
    },
  });

  assert.equal(r.missing, true);
  assert.equal(r.providers, null);
});

test("CLI writes BOTH env vars or neither — never MODEL_TEST_PROVIDER alone", () => {
  // The pair invariant, asserted end-to-end: MODEL_TEST_PROVIDER on its own is
  // not a narrower run, it is the whole 41-model catalog.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-model-target-"));
  const providersFile = path.join(dir, "providers.json");
  const githubEnv = path.join(dir, "github_env");
  fs.writeFileSync(providersFile, JSON.stringify(PROVIDERS));
  fs.writeFileSync(githubEnv, "");

  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--providers-file", providersFile, "--provider", "openai"],
    { env: { ...process.env, GITHUB_ENV: githubEnv }, encoding: "utf-8" },
  );

  assert.equal(JSON.parse(stdout).model, "gpt-4o-mini");
  const written = fs.readFileSync(githubEnv, "utf-8");
  assert.match(written, /^MODEL_TEST_ID=gpt-4o-mini$/m);
  assert.match(written, /^MODEL_TEST_PROVIDER=openai$/m);

  // And the declining path writes NOTHING — a stale MODEL_TEST_PROVIDER with no
  // MODEL_TEST_ID would be the 41-model regression.
  fs.writeFileSync(githubEnv, "");
  execFileSync(
    process.execPath,
    [SCRIPT, "--providers-file", providersFile, "--provider", "anthropic"],
    { env: { ...process.env, GITHUB_ENV: githubEnv }, encoding: "utf-8" },
  );
  assert.equal(fs.readFileSync(githubEnv, "utf-8"), "");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI exits 2 on an unreadable payload, 0 on a legitimate no-pin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-model-target-"));
  const bad = path.join(dir, "providers.json");
  fs.writeFileSync(bad, '{"openai": "gpt-4o-mini"}');

  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, "--providers-file", bad], {
        encoding: "utf-8",
        stdio: "pipe",
      }),
    (error) => error.status === 2,
  );

  // Absent file: the lane continues (exit 0) with a warning, because an LLM-free
  // or canary run legitimately has no sweep output.
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--providers-file", path.join(dir, "absent.json")],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("pr-validation.yml still runs the pin between the health gate and the specs", () => {
  // Structural guard, same shape as the wait-for-backend one (#1045): the pin is
  // only worth anything if it runs AFTER collect-models settled a model and
  // BEFORE the specs read the env. A refactor that reorders the steps silently
  // restores the multi-provider spend.
  const yaml = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"),
    "utf-8",
  );
  const lines = yaml.split("\n");
  const indexOf = (needle) => lines.findIndex((l) => l.includes(needle));

  const collect = indexOf("- name: Collect models");
  const gate = indexOf("uses: ./.github/actions/wait-for-backend");
  const pin = indexOf("scripts/select-pr-model-target.mjs");
  const run = indexOf("- name: Run impacted specs");

  assert.ok(collect > 0, "Collect models step is missing");
  assert.ok(gate > collect, "health gate must follow Collect models");
  assert.ok(pin > gate, "the model pin must follow the health gate");
  assert.ok(run > pin, "the model pin must precede the impacted-specs run");
});

test("pr-validation.yml gates and pins on ONE provider name, not two literals (#1370)", () => {
  // What this pins is an ABSENCE, like the --grep composition guard (#1275): no
  // provider name spelled twice. It cannot prove the lane behaves correctly —
  // the tests above and collect-models.test.ts do that — but the defect it
  // guards is drift between two independent literals, which is exactly the class
  // a structural read catches.
  //
  // Why it matters: `Collect models` now fails a COLLECTOR stall only on the
  // provider this lane pins itself to. If a later change moves the pin to
  // anthropic and leaves the gate on openai, the lane would gate on a provider
  // it does not run and run one it does not gate — reopening #1370 from the
  // other side, with every check green.
  const yaml = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"),
    "utf-8",
  );

  assert.match(
    yaml,
    /^\s*PR_LANE_PROVIDER:\s*\S+/m,
    "the lane's provider must be declared once, at job level",
  );
  assert.match(
    yaml,
    /COLLECT_REQUIRED_PROVIDERS:\s*\$\{\{\s*env\.PR_LANE_PROVIDER\s*\}\}/,
    "the collector-stall gate must read the lane's provider, not a literal",
  );
  assert.match(
    yaml,
    /select-pr-model-target\.mjs --provider "\$PR_LANE_PROVIDER"/,
    "the model pin must read the lane's provider, not a literal",
  );
  // The literal may appear exactly once in EXECUTABLE yaml — as the value of
  // PR_LANE_PROVIDER itself. A second occurrence is a second source of truth.
  // Comment lines are excluded on purpose: the surrounding prose names the
  // provider several times while explaining the trade, and a guard that forbade
  // that would be answered by deleting the explanation.
  const declared = yaml.match(/^\s*PR_LANE_PROVIDER:\s*(\S+)/m)[1];
  const executable = yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const occurrences = executable.split(new RegExp(`\\b${declared}\\b`)).length - 1;
  assert.equal(
    occurrences,
    1,
    `"${declared}" appears ${occurrences}x outside comments in pr-validation.yml — it must be ` +
      "spelled once, as PR_LANE_PROVIDER's value, or the gate and the pin can drift apart",
  );
});

test("daily-stable.yml does NOT narrow the collector-stall gate (#1370)", () => {
  // The asymmetry is deliberate and this is the half that can regress silently.
  // The daily rotates providers by weekday (#1185) and owes multi-provider
  // coverage, so every env-keyed provider stays required there; copying the PR
  // lane's narrowing across would let a stalled provider go unreported on the
  // one lane whose whole job is to notice.
  const yaml = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/daily-stable.yml"),
    "utf-8",
  );
  assert.doesNotMatch(
    yaml,
    /COLLECT_REQUIRED_PROVIDERS:/,
    "daily-stable.yml must leave the collector-stall gate at its default (every env-keyed provider)",
  );
});
