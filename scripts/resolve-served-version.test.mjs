// Unit tests for scripts/resolve-served-version.mjs and the module it is the CLI
// for, scripts/lib/served-version.mjs — one file for both, the way
// check-vm-env-parity.test.mjs covers scripts/lib/vm-env-parity.mjs.
// Run with: npm run test:scripts
//
// WHAT THESE PROTECT. `langflow_version` is the premise of the two-lane
// comparison — `compare-lane-verdicts.mjs` blocks when the two rows disagree
// about it — and on the Actions side it used to be a matrix job output, where
// GitHub guarantees only that *"the last matrix job that runs will override the
// output value"* (#1731). So the row named whichever shard finished last, with no
// record that the shards might not have agreed, and a `null` could not say why.
// (#1731's stronger claim — a wedged shard's EMPTY value erasing three good ones —
// is NOT DEMONSTRATED, in either direction: see the module header, which is the one
// place that argument lives. Two earlier versions of THIS header got it wrong in
// both directions, first asserting the erasure and then asserting that the runner
// skips an empty output; the sweep is justified by the non-determinism and the
// attribution, and needs neither.) Nothing in a run can show any of it, so the
// tests below are the evidence.
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
  // Shard 1's backend answered nothing; the other three resolved. What the sweep
  // adds over the matrix output is that the surviving answer is the SAME one on
  // every run, and that shard 1's silence is on the record rather than inferred.
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

test("the pick is the lowest shard on disk, whatever order the directory lists them in", () => {
  // The determinism guarantee, pinned where it can actually fail: with no
  // `--expect-shards` the iteration order is the DIRECTORY's, and `readdirSync`
  // returns hash order on ext4 — the runner's filesystem. Measured in review:
  // both sorts could be deleted with the whole suite green, because every other
  // case seeds the shard set from an ascending expected range.
  const read = readVersionDir("d", {
    readdir: () => [versionFileName(3), versionFileName(1), versionFileName(2)],
    readFile: (path) => body(path.endsWith(versionFileName(1)) ? "first" : "other"),
  });
  assert.equal(resolveServedVersion(read).version, "first");
  assert.equal(resolveServedVersion(read).source, 1);
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

test("readVersionDir with no directory is a reported state, not a throw", () => {
  // Unreachable from the CLI — `--dir ""` is a usage error, by the asymmetry argued
  // there — but `readVersionDir` is exported and this is its answer for a caller
  // that has no directory to offer.
  const read = readVersionDir("");
  assert.equal(read.available, false);
  assert.match(read.reason, /no directory was given/);
  assert.equal(resolveServedVersion(read, { expectShards: 1 }).version, null);
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
  // Re-PARSED, not scanned as an array: `outputLines` returns seven fixed elements, so
  // an injected key would sit INSIDE element 0 and a `startsWith` scan would miss it
  // — which is how the file that receives these lines actually reads them.
  const emitted = outputLines(verdict).join("\n").split("\n");
  const keys = emitted.map((line) => line.slice(0, line.indexOf("=")));
  assert.ok(!keys.includes("injected"), `a value became a key: ${emitted.join(" | ")}`);
  assert.equal(keys.filter((k) => k === "version").length, 1);
});

test("a version carrying the list separator is REFUSED, not split downstream", () => {
  // The distinct versions reach the history row as `versions=a,b` and the appender
  // re-splits on the comma (#1964). A version containing one arrives as two, which the
  // comparator reads as a duplicate and reports UNREADABLE — a real straddle described
  // as a corrupt row. Refused here, where the value is still one string.
  assert.equal(parseVersionBody('{"version":"1.13.0,dev16"}').version, null);
  assert.match(parseVersionBody('{"version":"1.13.0,dev16"}').reason, /list separator/);
  const verdict = resolveServedVersion(dirOf({ 1: '{"version":"1.13.0,dev16"}' }), { expectShards: 1 });
  assert.equal(verdict.version, null);
  assert.ok(!outputLines(verdict).some((l) => l.startsWith("versions=1")));
});

test("surrounding whitespace in a real body is tolerated", () => {
  assert.equal(parseVersionBody(`\n ${body("1.13.0.dev16")} \n`).version, "1.13.0.dev16");
});

test("only a 1-based shard index without leading zeros is an answer", () => {
  // Both lanes number from 1 (`matrix.shard`, `$idx`). `version-0.json` would be
  // pickable and `version-01.json` would silently collide with shard 1 in the map.
  const read = readVersionDir("d", {
    readdir: () => ["version-0.json", "version-01.json", "version-1.json", "versions.json"],
    readFile: (path) => body(path.endsWith("/version-1.json") ? "real" : "impostor"),
  });
  assert.deepEqual(
    read.files.map((f) => f.shard),
    [1],
  );
  assert.equal(resolveServedVersion(read).version, "real");
});

// ── The expectation must not delete evidence ────────────────────────────────

test("the ratio counts what the sweep reasoned about, and is omitted when it knows of no run", () => {
  // Both halves of this shipped unpinned and reverted silently in review. The first
  // printed "3/2 shard(s) answered" for a file outside the expected range; the
  // second printed a run-level ratio for the per-shard `--quiet` call, which reads
  // ONE file — the overstatement `--quiet` exists to prevent.
  // Two answers, three shards reasoned about (1 and 2 expected, 3 present). The
  // old denominator was `expected` alone, so this read "2/2" — hiding both shard
  // 2's silence and shard 3's existence — and with all three answering it read the
  // impossible "3/2".
  const strayFile = resolveServedVersion(dirOf({ 1: body("v"), 3: body("v") }), {
    expectShards: 2,
  });
  assert.match(summaryLine(strayFile), /2\/3 shard\(s\) answered/);
  const allThree = resolveServedVersion(
    dirOf({ 1: body("v"), 2: body("v"), 3: body("v") }),
    { expectShards: 2 },
  );
  assert.match(summaryLine(allThree), /3\/3 shard\(s\) answered/);
  const oneShard = resolveServedVersion(dirOf({ 3: body("v") }));
  assert.match(summaryLine(oneShard), /1 answer\(s\) found/);
  assert.doesNotMatch(summaryLine(oneShard), /\d+\/\d+/, "a ratio the sweep cannot know");
  const partial = resolveServedVersion(dirOf({ 1: "", 2: body("v") }), { expectShards: 4 });
  assert.match(summaryLine(partial), /1\/4 shard\(s\) answered/);
});

test("an out-of-range shard file reaches the run summary, not only stdout", () => {
  // It means `prep`'s shard count and the matrix disagree. The clean-check has to
  // list every anomaly the verdict can carry, or the anomaly is stdout-only (#1012).
  const verdict = resolveServedVersion(dirOf({ 1: body("v"), 2: body("v"), 3: body("v") }), {
    expectShards: 2,
  });
  assert.deepEqual(verdict.unexpected, [3]);
  assert.match(stepSummaryMarkdown(verdict) ?? "", /expectation and the matrix disagree/);
});

test("a shard outside the expected range still answers, and the disagreement is said out loud", () => {
  // `--expect-shards` being wrong (prep and the matrix out of step) must not drop
  // the one file that did arrive: an expectation is a claim about the run, not a
  // filter on its evidence.
  const verdict = resolveServedVersion(dirOf({ 3: body("1.13.0.dev16") }), { expectShards: 2 });
  assert.equal(verdict.version, "1.13.0.dev16");
  assert.deepEqual(verdict.unexpected, [3]);
  assert.match(renderReport(verdict), /expected 2/);
});

test("an expectation that cannot describe a run is REFUSED and said out loud", () => {
  // `--expect-shards 1e9` used to materialise one Set entry per expected shard and
  // throw `RangeError: Set maximum size exceeded` out of a CLI whose header
  // promises that only a usage error exits non-zero (measured in review).
  // `0x10` and `4.0` are in the list because `Number` alone honoured them as 16
  // and 4 — an input nobody meant, accepted without a word. `[]` is there because
  // it stringifies to "", which is how "no expectation given" is spelled. `04` is
  // deliberately NOT here: `\d+` accepts a leading zero and 4 is what it means.
  for (const absurd of [1e9, 257, 0, -3, "abc", "0x10", "4.0", "+4", [], {}]) {
    const verdict = resolveServedVersion(dirOf({ 1: body("1.13.0.dev16") }), {
      expectShards: absurd,
    });
    assert.equal(verdict.expected, null, `expected ${absurd} to be refused`);
    assert.equal(verdict.version, "1.13.0.dev16", "the files found still answer");
    assert.ok(verdict.expectedIgnored, `${absurd} was dropped without a word`);
  }
  // A refusal changes what every count means, so it reaches both surfaces.
  const verdict = resolveServedVersion(dirOf({ 1: body("v") }), { expectShards: 1e9 });
  assert.match(renderReport(verdict), /IGNORED/);
  assert.match(stepSummaryMarkdown(verdict), /matrix cap/);
});

test("naming a refused value cannot itself throw", () => {
  // `JSON.stringify` is not total — it REJECTS a BigInt and a circular object, and
  // returns undefined for a function or a symbol — and it ran outside any try, in a
  // function whose entire contract is that it cannot throw. Reachable only through
  // the export, which is the surface the typeof gate was added to make tolerant.
  const circular = {};
  circular.self = circular;
  // Every element reaches a DIFFERENT branch of `describeValue`, which is what the
  // first version of this list did not do: `circular` is caught before it renders,
  // so on its own it proved nothing about the object, number and escaping branches
  // — all three of which leaked (an odd number of quotes, a 200-digit number nobody
  // passed, a 1293-character line).
  for (const hostile of [
    4n,
    circular,
    () => 1,
    Symbol("s"),
    "9".repeat(400),
    { a: "x".repeat(300) },
    "\u0001".repeat(200),
    10n ** 400n,
  ]) {
    const verdict = resolveServedVersion(dirOf({ 1: body("1.13.0.dev16") }), {
      expectShards: hostile,
    });
    assert.equal(verdict.version, "1.13.0.dev16");
    assert.ok(verdict.expectedIgnored, `${String(hostile)} was dropped without a word`);
    // Capped like every other diagnostic here, and a long value keeps its quotes:
    // capping the STRINGIFIED form instead drops the closing one, so the message
    // runs into the sentence after it.
    assert.ok(verdict.expectedIgnored.length < 400, `the refusal ran long: ${verdict.expectedIgnored.length}`);
    const quotes = (verdict.expectedIgnored.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes: ${verdict.expectedIgnored}`);
  }
  // The above-cap branch built its own message from `Number(text)`, so a 400-digit
  // argument was reported as "Infinity" — a value nobody passed.
  const huge = resolveServedVersion(dirOf({ 1: body("v") }), { expectShards: "9".repeat(400) });
  assert.doesNotMatch(huge.expectedIgnored, /Infinity/);
  // Nor 200 of its digits, which reads just as much like a value somebody passed.
  assert.doesNotMatch(huge.expectedIgnored, /9{50}/);
  assert.match(huge.expectedIgnored, /400-character string/);
});

test("an absent expectation is not a refusal — it is simply no expectation", () => {
  for (const none of [null, undefined, ""]) {
    const verdict = resolveServedVersion(dirOf({ 1: body("v") }), { expectShards: none });
    assert.equal(verdict.expected, null);
    assert.equal(verdict.expectedIgnored, null, `${JSON.stringify(none)} reported a refusal`);
    assert.equal(stepSummaryMarkdown(verdict), null);
  }
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
    "silent=3",
    "disagreement=false",
    "versions=1.13.0.dev16",
  ]);
});

test("a shard OUTSIDE the expected range cannot hide a silent one", () => {
  // #1964 review: `answered` counts a stray shard (a leftover file under a reused
  // RUN_ID), so `expected - answered` downstream read 4 - 4 = 0 and the comparator
  // called a run with a dead shard 4 fully answered. `silent` counts in-range only.
  const verdict = resolveServedVersion(
    dirOf({ 1: body("v"), 2: body("v"), 3: body("v"), 5: body("v") }),
    { expectShards: 4 },
  );
  assert.equal(verdict.answered.length, 4, "the stray still answers — evidence is kept");
  assert.deepEqual(verdict.unexpected, [5]);
  assert.equal(verdict.silent, 1);
  assert.ok(outputLines(verdict).includes("silent=1"));
});

test("silent is empty exactly when expected is", () => {
  const verdict = resolveServedVersion(dirOf({ 1: body("v") }));
  assert.equal(verdict.silent, null);
  const lines = outputLines(verdict);
  assert.ok(lines.includes("expected="));
  assert.ok(lines.includes("silent="));
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

test("an unwritable output file costs one surface, never the step", () => {
  // The report is already on stdout when the append runs, so throwing here would
  // cost the step AND the `version=` line the consumer reads. Reachable on the VM
  // lane whenever "$RUN_DIR/logs" is missing.
  const dir = tmpDirWith({ 1: body("1.13.0.dev16") });
  const res = runCli(["--dir", dir, "--expect-shards", "1"], {
    GITHUB_OUTPUT: join(dir, "no-such-dir", "out.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "no-such-dir", "sum.md"),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1\.13\.0\.dev16/);
  assert.match(res.stderr, /::warning::.*could not be written/);
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

test("invoked through a symlinked absolute path, the CLI still runs", () => {
  // The main guard compares `import.meta.url` to argv[1]. A `file://` template
  // fails on a percent-encoded path, and `pathToFileURL` alone fails on a
  // symlinked one: either way the process exits 0 having printed NOTHING, which is
  // a null with no diagnostic — the one shape this module exists to prevent, and
  // the reason the promise "the only non-zero exit is a usage error" is not enough
  // on its own.
  const dir = tmpDirWith({ 1: body("1.13.0.dev16") });
  const link = join(dir, "repo-link");
  fs.symlinkSync(REPO_ROOT, link);
  const res = spawnSync(process.execPath, [join(link, "scripts", "resolve-served-version.mjs"), "--dir", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1\.13\.0\.dev16/, "the CLI printed nothing at all");
});

test("--json prints the whole verdict", () => {
  const dir = tmpDirWith({ 1: body("1.13.0.dev16") });
  const res = runCli(["--dir", dir, "--json", "--expect-shards", "1"]);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.version, "1.13.0.dev16");
  assert.equal(parsed.source, 1);
});
// ── Wiring: the class no behaviour test can reach ───────────────────────────
//
// These pin an ABSENCE and two references. They cannot show that a lane resolves
// correctly — the cases above do that — but the defect reached production as a
// single line of workflow plumbing, and plumbing is not reachable from a unit
// test any other way. The FILE NAME is derived from the module (`versionFileName`),
// so renaming it breaks these guards rather than passing them; the script path, the
// flags and the step-output expression are restated literals — a rename there fails
// them too, but only because the literal stops matching, not because anything
// derived it (#1226's own lesson about what a spelling guard is worth).

const WORKFLOW = fs.readFileSync(join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8");
const ORCHESTRATOR = fs.readFileSync(join(REPO_ROOT, "scripts/run-e2e.sh"), "utf8");

test("the shard matrix declares NO langflow_version output", () => {
  // The mechanism #1731 indicts: GitHub keeps whichever matrix job writes last, over
  // an order it does not guarantee.
  const from = WORKFLOW.indexOf("\n  test:");
  const to = WORKFLOW.indexOf("\n  stable-ownership:");
  // Both anchors asserted, and their ORDER: reorder those two jobs and the slice
  // silently becomes "", at which point the assertion below passes about nothing.
  assert.ok(from >= 0, "the `test` job anchor is gone — this guard scopes nothing");
  assert.ok(to > from, "the job anchors moved; the slice no longer holds the test job");
  const testJob = WORKFLOW.slice(from, to);
  assert.ok(!/langflow_version:\s*\$\{\{\s*steps\./.test(testJob), "the matrix output is back");
  assert.ok(!/needs\.test\.outputs\.langflow_version/.test(WORKFLOW));
});

test("every consumer of LANGFLOW_VERSION reads the merge job's swept value", () => {
  const consumers = [...WORKFLOW.matchAll(/^\s*LANGFLOW_VERSION:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(consumers.length >= 2, `expected the payload and the history row, found ${consumers.length}`);
  for (const value of consumers) {
    assert.equal(value, "${{ steps.lfver.outputs.version }}", `a consumer reads ${value}`);
  }
});

test("the shard captures its version BEFORE the artifact that carries it is uploaded", () => {
  // After the upload the file exists on a runner nobody ever reads again: the
  // ordering IS the mechanism, and it is invisible in any single step's text.
  const capture = WORKFLOW.indexOf(`> "tokens/${versionFileName("${{ matrix.shard }}")}"`);
  const upload = WORKFLOW.indexOf("- name: Upload token consumption");
  assert.ok(capture > 0, "the shard no longer writes the per-shard version file");
  assert.ok(upload > capture, "the version file is written after the artifact upload");
});

test("the merge job sweeps every shard, with the expected count", () => {
  const step = WORKFLOW.slice(WORKFLOW.indexOf("- name: Resolve served Langflow version"));
  assert.match(step.slice(0, 600), /scripts\/resolve-served-version\.mjs/);
  assert.match(step.slice(0, 600), /--dir all-tokens/);
  assert.match(step.slice(0, 600), /--expect-shards "\$\{\{ needs\.prep\.outputs\.shard_total \}\}"/);
});

test("the VM lane writes the same file name and runs the same reader", () => {
  // #1731's own argument: two lanes writing one field to one series must not have
  // different odds of writing it, and two implementations is how that returns.
  assert.match(ORCHESTRATOR, new RegExp(`all-tokens/${versionFileName("\\$idx")}`));
  assert.match(ORCHESTRATOR, /scripts\/resolve-served-version\.mjs/);
  assert.match(ORCHESTRATOR, /--expect-shards "\$\{SHARD_TOTAL:-\}"/);
});
