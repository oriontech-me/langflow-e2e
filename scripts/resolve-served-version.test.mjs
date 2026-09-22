// Unit tests for scripts/lib/served-version.mjs and its CLI.
// Run with: npm run test:scripts
//
// WHAT THESE PROTECT. `langflow_version` is the premise of the two-lane
// comparison — `compare-lane-verdicts.mjs` blocks when the two rows disagree
// about it — and on the Actions side it used to be a matrix job output, so the
// run kept whichever shard finished last and a wedged shard's empty value erased
// three good ones (#1731). The defect is LATENT: it costs nothing on a healthy
// day and everything on a wedge day, which is the only day anybody reads the
// comparison. Nothing in a run can show it, so the tests below are the evidence.
//
// The failures they are written against:
//   - one shard's silence erasing another shard's answer (the whole issue)
//   - an absent version that cannot say WHY — unknown read as clean (#1012)
//   - an expectation that is wrong DROPPING the evidence it failed to predict
//   - a version carrying a newline, which stops being a value in $GITHUB_OUTPUT
//     and becomes another key (the `tr -d '\r\n'` this replaces, now assertable)
//   - the per-shard call speaking for the run it has not seen
//   - the two lanes drifting apart again, which is how the asymmetry returns
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

import {
  outputLines,
  parseVersionBody,
  readVersionDir,
  renderReport,
  resolveServedVersion,
  stepSummaryMarkdown,
  summaryLine,
  versionFileName,
} from "./lib/served-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI = join(HERE, "resolve-served-version.mjs");

/** A `readVersionDir` result built from `{shard: body}` without touching disk. */
const dirOf = (bodies) => ({
  available: true,
  reason: null,
  files: Object.entries(bodies)
    .map(([shard, raw]) => ({ shard: Number(shard), name: versionFileName(shard), raw }))
    .sort((a, b) => a.shard - b.shard),
});

const body = (version) => JSON.stringify({ version, main_version: "1.13.0", package: "Langflow" });

/** A temp dir holding `version-<shard>.json` files, for the CLI cases. */
function tmpDirWith(bodies) {
  const dir = makeTempDir("served-version-");
  for (const [shard, raw] of Object.entries(bodies)) {
    fs.writeFileSync(join(dir, versionFileName(shard)), raw);
  }
  return dir;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env },
  });
}

// ── The issue itself ────────────────────────────────────────────────────────

test("a wedged shard costs its own answer and nothing else", () => {
  // The motivating run: shard 1's backend answered nothing, the other three
  // resolved correctly. Under the matrix output, shard 1 finishing last erased
  // all of it.
  const verdict = resolveServedVersion(
    dirOf({ 1: "", 2: body("1.13.0.dev16"), 3: body("1.13.0.dev16"), 4: body("1.13.0.dev16") }),
    { expectShards: 4 },
  );
  assert.equal(verdict.version, "1.13.0.dev16");
  assert.equal(verdict.source, 2);
  assert.equal(verdict.answered.length, 3);
  assert.deepEqual(
    verdict.unanswered.map((u) => u.shard),
    [1],
  );
});

test("the pick is the lowest shard that answered, so the same run resolves the same way twice", () => {
  const files = { 1: body("a"), 2: body("b"), 3: body("c") };
  const forward = resolveServedVersion(dirOf(files), { expectShards: 3 });
  const reversed = resolveServedVersion(
    { available: true, reason: null, files: dirOf(files).files.slice().reverse() },
    { expectShards: 3 },
  );
  assert.equal(forward.version, "a");
  assert.equal(reversed.version, "a");
  assert.equal(reversed.source, 1);
});

// ── Unknown is not clean (#1012) ────────────────────────────────────────────

test("an empty answer and an absent file are two different reasons, both named", () => {
  const verdict = resolveServedVersion(dirOf({ 1: "", 3: body("1.13.0.dev16") }), {
    expectShards: 4,
  });
  const reasons = new Map(verdict.unanswered.map((u) => [u.shard, u.reason]));
  assert.match(reasons.get(1), /empty/);
  assert.match(reasons.get(1), /answered nothing/);
  assert.match(reasons.get(2), /no file/);
  assert.match(reasons.get(4), /no file/);
  assert.equal(reasons.size, 3);
});

test("no shard answering yields no version, and every expected shard is named", () => {
  const verdict = resolveServedVersion(dirOf({ 1: "", 2: "", 3: "", 4: "" }), { expectShards: 4 });
  assert.equal(verdict.version, null);
  assert.equal(verdict.source, null);
  assert.deepEqual(
    verdict.unanswered.map((u) => u.shard),
    [1, 2, 3, 4],
  );
  assert.match(summaryLine(verdict), /UNRESOLVED/);
});

test("a directory that cannot be read carries its reason onto every expected shard", () => {
  const read = readVersionDir("/nonexistent-served-version-dir", {
    readdir: () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  assert.equal(read.available, false);
  const verdict = resolveServedVersion(read, { expectShards: 2 });
  assert.equal(verdict.version, null);
  assert.equal(verdict.unanswered.length, 2);
  for (const { reason } of verdict.unanswered) assert.match(reason, /ENOENT/);
  assert.match(renderReport(verdict), /directory:/);
});

test("a file that exists but cannot be read is unanswered WITH its reason, never silently absent", () => {
  const read = readVersionDir("dir", {
    readdir: () => [versionFileName(1)],
    readFile: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const verdict = resolveServedVersion(read, { expectShards: 1 });
  assert.equal(verdict.version, null);
  assert.match(verdict.unanswered[0].reason, /EACCES/);
});

test("a non-Error throw is still reported rather than crashing the reader", () => {
  // `Error.message` is a plain own property, so a thrown value can be anything.
  const read = readVersionDir("dir", {
    readdir: () => [versionFileName(1)],
    readFile: () => {
      throw { message: Symbol("nope") };
    },
  });
  assert.equal(read.files.length, 1);
  assert.match(read.files[0].error, /could not be read/);
});

// ── What a body has to be ───────────────────────────────────────────────────

test("a body that is not JSON, or carries no version, is refused with the reason", () => {
  assert.match(parseVersionBody("<html>502 Bad Gateway</html>").reason, /not JSON/);
  assert.match(parseVersionBody('{"detail":"Not authenticated"}').reason, /no .version. field/);
  assert.match(parseVersionBody('{"version":""}').reason, /no .version. field/);
  assert.match(parseVersionBody('{"version":123}').reason, /no .version. field/);
  assert.match(parseVersionBody("").reason, /empty/);
  assert.match(parseVersionBody(null).reason, /nothing was captured/);
});

test("a version that is not a single line is REFUSED, not trimmed into shape", () => {
  // It is emitted as `key=value` into $GITHUB_OUTPUT: an embedded newline stops
  // being a value and becomes another key. The shell this replaced spelled that
  // guarantee as `tr -d '\r\n'`, where nothing could test it.
  assert.equal(parseVersionBody('{"version":"1.13.0\\ninjected=1"}').version, null);
  assert.match(parseVersionBody('{"version":"1.13.0\\ninjected=1"}').reason, /single line/);
  const verdict = resolveServedVersion(dirOf({ 1: '{"version":"1.13.0\ninjected=1"}' }), {
    expectShards: 1,
  });
  assert.equal(verdict.version, null);
  assert.equal(outputLines(verdict).filter((l) => l.startsWith("version=")).length, 1);
  assert.ok(!outputLines(verdict).some((l) => l.startsWith("injected=")));
});

test("surrounding whitespace in a real body is tolerated", () => {
  assert.equal(parseVersionBody(`\n ${body("1.13.0.dev16")} \n`).version, "1.13.0.dev16");
});

// ── The expectation must not delete evidence ────────────────────────────────

test("a shard outside the expected range still answers, and the disagreement is said out loud", () => {
  // `--expect-shards` being wrong (prep and the matrix out of step) must not drop
  // the one file that did arrive: an expectation is a claim about the run, not a
  // filter on its evidence.
  const verdict = resolveServedVersion(dirOf({ 3: body("1.13.0.dev16") }), { expectShards: 2 });
  assert.equal(verdict.version, "1.13.0.dev16");
  assert.deepEqual(verdict.unexpected, [3]);
  assert.match(renderReport(verdict), /expected 2/);
});

test("with no expectation at all, only the files present are reported", () => {
  const verdict = resolveServedVersion(dirOf({ 2: body("1.13.0.dev16") }));
  assert.equal(verdict.version, "1.13.0.dev16");
  assert.deepEqual(verdict.unanswered, []);
  assert.equal(verdict.expected, null);
});

// ── Two products in one run ─────────────────────────────────────────────────

test("shards serving different versions are reported, not silently reduced to the first", () => {
  const verdict = resolveServedVersion(
    dirOf({ 1: body("1.13.0.dev16"), 2: body("1.13.0.dev17") }),
    { expectShards: 2 },
  );
  assert.equal(verdict.disagreement, true);
  assert.deepEqual(verdict.versions, ["1.13.0.dev16", "1.13.0.dev17"]);
  assert.equal(verdict.version, "1.13.0.dev16");
  assert.match(renderReport(verdict), /DISAGREEMENT/);
  assert.match(stepSummaryMarkdown(verdict), /did not agree/);
});

// ── Surfaces ────────────────────────────────────────────────────────────────

test("a clean, unanimous sweep writes NO run-summary block", () => {
  const verdict = resolveServedVersion(dirOf({ 1: body("v"), 2: body("v") }), { expectShards: 2 });
  assert.equal(stepSummaryMarkdown(verdict), null);
});

test("a partial sweep writes one, naming the shard that could not answer", () => {
  const verdict = resolveServedVersion(dirOf({ 1: "", 2: body("v") }), { expectShards: 2 });
  const md = stepSummaryMarkdown(verdict);
  assert.match(md, /shard 1:/);
  assert.match(md, /shard 2: `v`/);
});

test("the output lines carry the version, its shard, and the counts", () => {
  const verdict = resolveServedVersion(dirOf({ 1: "", 2: body("1.13.0.dev16") }), {
    expectShards: 4,
  });
  assert.deepEqual(outputLines(verdict), [
    "version=1.13.0.dev16",
    "source=2",
    "answered=1",
    "expected=4",
    "disagreement=false",
    "versions=1.13.0.dev16",
  ]);
});

test("an unresolved sweep emits an EMPTY version rather than omitting the key", () => {
  // The consumer reads `steps.lfver.outputs.version` into an env var; an omitted
  // key and an empty one are the same null on the row, but only one of them is
  // predictable.
  const lines = outputLines(resolveServedVersion(dirOf({ 1: "" }), { expectShards: 1 }));
  assert.ok(lines.includes("version="));
  assert.ok(lines.includes("source="));
});

// ── The CLI ─────────────────────────────────────────────────────────────────

test("the CLI writes its outputs and its summary block, and stays green when unresolved", () => {
  const dir = tmpDirWith({ 1: "", 2: "" });
  const out = join(dir, "out.txt");
  const sum = join(dir, "sum.md");
  const res = runCli(["--dir", dir, "--expect-shards", "2"], {
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: sum,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(fs.readFileSync(out, "utf8"), /^version=$/m);
  assert.match(fs.readFileSync(sum, "utf8"), /### Langflow version/);
  assert.match(res.stderr, /::warning::/);
});

test("the CLI stays silent on every surface when the sweep is clean", () => {
  const dir = tmpDirWith({ 1: body("1.13.0.dev16"), 2: body("1.13.0.dev16") });
  const out = join(dir, "out.txt");
  const sum = join(dir, "sum.md");
  const res = runCli(["--dir", dir, "--expect-shards", "2"], {
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: sum,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(fs.readFileSync(out, "utf8"), /^version=1\.13\.0\.dev16$/m);
  assert.equal(fs.existsSync(sum), false);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /from shard 1/);
});

test("--quiet prints the line and speaks for nothing else", () => {
  // The per-shard call reads ONE file. Without this it would emit a run-level
  // verdict ("no shard reported…") from a directory holding one shard's answer.
  const dir = tmpDirWith({ 3: "" });
  const out = join(dir, "out.txt");
  const sum = join(dir, "sum.md");
  const res = runCli(["--dir", dir, "--quiet"], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(sum), false);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /UNRESOLVED/);
});

test("an absent directory is a state, not a crash", () => {
  const res = runCli(["--dir", join(os.tmpdir(), "served-version-does-not-exist")]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /UNRESOLVED/);
});

test("--expect-shards given an EMPTY value degrades instead of aborting the step", () => {
  // An unset workflow variable expands to one, and this step carries the value a
  // later job reads — an abort here would lose it for the whole run (#1812).
  const dir = tmpDirWith({ 1: body("1.13.0.dev16") });
  const res = runCli(["--dir", dir, "--expect-shards", ""]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1\.13\.0\.dev16/);
});

test("a usage error is an exit 2, never a silent empty answer", () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(["--dir"]).status, 2);
  assert.equal(runCli(["--dir", "x", "--nope"]).status, 2);
  assert.equal(runCli(["--help"]).status, 0);
});

test("--json prints the whole verdict", () => {
  const dir = tmpDirWith({ 1: body("1.13.0.dev16") });
  const res = runCli(["--dir", dir, "--json", "--expect-shards", "1"]);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.version, "1.13.0.dev16");
  assert.equal(parsed.source, 1);
});
