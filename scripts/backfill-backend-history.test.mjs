// Unit tests for the run-history backfill (#1077).
// Run with: node --test scripts/backfill-backend-history.test.mjs
//
// The script is committed and re-runnable, and it rewrites the one file in this
// repo that `CLAUDE.md` forbids editing by hand — so what has to be pinned is
// not the block it writes (scripts/lib/backend-history.test.mjs covers that) but
// the four refusals that keep a rerun from corrupting the series.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./backfill-backend-history.mjs", import.meta.url));

const summary = (shard, files, over = {}) => ({
  shard: String(shard),
  files,
  measured: true,
  probeCount: 300,
  failedProbes: 0,
  ignoredBlips: 0,
  spanSeconds: 600,
  windows: [],
  outageCount: 0,
  downSeconds: 0,
  downPct: 0,
  ...over,
});

const report = () => ({
  suites: [
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      specs: [
        {
          title: "t",
          file: "a.spec.ts",
          line: 1,
          tests: [{ status: "expected", results: [{ status: "passed", duration: 1, startTime: "2026-09-02T12:00:00.000Z" }] }],
        },
      ],
    },
  ],
  stats: { duration: 1 },
});

const historyLine = (runId, over = {}) =>
  JSON.stringify({
    version: 1,
    date: "2026-09-02",
    workflow: "daily-stable",
    run_id: runId,
    totals: { passed: 1, failed: 0, flaky: 0, skipped: 0 },
    failures: [],
    flaky: [],
    ...over,
  });

/**
 * @param runs  { [runId]: { shards: summary[], report?: object|null } }
 * @param lines the history file's raw lines
 */
function setup(runs, lines) {
  const dir = mkdtempSync(join(tmpdir(), "backfill-"));
  const artifacts = join(dir, "artifacts");
  for (const [runId, spec] of Object.entries(runs)) {
    const runDir = join(artifacts, runId);
    mkdirSync(runDir, { recursive: true });
    if (spec.report !== null) writeFileSync(join(runDir, "results.json"), JSON.stringify(spec.report ?? report()));
    spec.shards.forEach((s, i) => {
      mkdirSync(join(runDir, `liveness-${i + 1}`), { recursive: true });
      writeFileSync(join(runDir, `liveness-${i + 1}`, "backend-liveness.json"), JSON.stringify(s));
    });
  }
  const history = join(dir, "history.jsonl");
  writeFileSync(history, lines.join("\n") + "\n");
  return { artifacts, history };
}

/**
 * A line NOT produced by `JSON.stringify` — extra spacing and a key order the
 * writer would not emit. Without it, "untouched lines pass through as their
 * original bytes" is unfalsifiable: a fixture written by `JSON.stringify` reads
 * identically whether it was passed through or re-serialised.
 */
function nonCanonicalLine(runId) {
  return `{ "run_id": "${runId}",  "version": 1, "totals": {"passed": 1, "failed": 0, "flaky": 0, "skipped": 0} }`;
}

function run({ artifacts, history }, extra = []) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--history", history, "--artifacts", artifacts, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

const readRows = (history) =>
  readFileSync(history, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("only the named run's line changes, and only by an appended block", () => {
  const untouched = nonCanonicalLine("999");
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [untouched, historyLine("111")]);
  assert.equal(run(env, ["--shard-total", "1"]).code, 0);
  const [first, second] = readFileSync(env.history, "utf8").trim().split("\n");
  assert.equal(first, untouched, "an unrelated line must survive byte for byte");
  const row = JSON.parse(second);
  assert.equal(Object.keys(row).at(-1), "backend");
  const { backend, ...rest } = row;
  assert.equal(JSON.stringify(rest), historyLine("111"), "nothing but the block was added");
  assert.equal(backend.shards_measured, 1);
});

test("a rerun refuses rather than overwriting a block that is already there", () => {
  // The block is derived from artifacts that expire; a second pass over a
  // partial download would silently replace a good row with a worse one.
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  assert.equal(run(env, ["--shard-total", "1"]).code, 0);
  const again = run(env, ["--shard-total", "1"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already carries a backend block/);
});

test("a run with no history line fails instead of writing nothing quietly", () => {
  const env = setup({ "222": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  const out = run(env, ["--shard-total", "1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /No history line for run\(s\): 222/);
  assert.equal(readRows(env.history)[0].backend, undefined);
});

test("more shard summaries than the declared shard_total is refused", () => {
  // `shard_total` exists to make a shard that uploaded nothing visible. A wrong
  // one is worse than an absent one, and `--shard-total` defaults to 4 for a
  // caller who may not have checked.
  const env = setup(
    { "111": { shards: [summary(1, ["a.spec.ts"]), summary(2, [])] } },
    [historyLine("111")],
  );
  const out = run(env, ["--shard-total", "1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /2 shard summaries but --shard-total 1/);
});

test("a run whose merged report is missing is refused, not written partial", () => {
  // Without it the per-shard test counts and the collateral attribution are
  // gone, and a block missing half its axes reads as a measured run with
  // nothing to show.
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])], report: null } }, [historyLine("111")]);
  const out = run(env, ["--shard-total", "1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /results\.json missing/);
});

test("results.json in the run directory is not mistaken for a shard summary", () => {
  // `readSummaries` recurses and takes any *.json; the merged report sits in the
  // same tree. Counting it would invent a shard.
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  assert.equal(run(env, ["--shard-total", "1"]).code, 0);
  assert.equal(readRows(env.history)[0].backend.shards_reported, 1);
});

test("--dry-run reports what it would do and writes nothing", () => {
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  const before = readFileSync(env.history, "utf8");
  const out = run(env, ["--shard-total", "1", "--dry-run"]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /\[dry-run\] 1 line\(s\) would be rewritten/);
  assert.equal(readFileSync(env.history, "utf8"), before);
});

test("an empty artifacts directory fails instead of reporting a successful no-op", () => {
  const env = setup({}, [historyLine("111")]);
  mkdirSync(env.artifacts, { recursive: true });
  const out = run(env, ["--shard-total", "1"]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /No run directories/);
});

test("an untouched line keeps its original bytes, not a re-serialisation", () => {
  // `CLAUDE.md` forbids hand-editing this file; the script's promise is that a
  // rerun rewrites only what it was asked for. A fixture written by
  // `JSON.stringify` cannot tell passthrough from re-serialisation, so this one
  // deliberately is not.
  const untouched = nonCanonicalLine("999");
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [untouched, historyLine("111")]);
  assert.equal(run(env, ["--shard-total", "1"]).code, 0);
  assert.equal(readFileSync(env.history, "utf8").split("\n")[0], untouched);
});

test("a run with liveness but no usable summary is refused, naming the artifact", () => {
  // Without this branch the run falls through carrying a null block and dies
  // later with "No history line for run(s)" — pointing the operator at the
  // history file when the cause is a missing download.
  const dir = mkdtempSync(join(tmpdir(), "backfill-"));
  const artifacts = join(dir, "artifacts");
  mkdirSync(join(artifacts, "111"), { recursive: true });
  writeFileSync(join(artifacts, "111", "results.json"), JSON.stringify(report()));
  const history = join(dir, "history.jsonl");
  writeFileSync(history, historyLine("111") + "\n");
  const out = run({ artifacts, history }, ["--shard-total", "1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /no liveness summary found/);
});

test("--artifacts is required", () => {
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  try {
    execFileSync(process.execPath, [SCRIPT, "--history", env.history, "--shard-total", "1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("must not run without an artifacts directory");
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /--artifacts <dir> is required/);
  }
});

test("--shard-total is required, and a guess is not offered as a default", () => {
  // It used to default to 4. A 2-shard repro backfilled under that default
  // records `shard_total: 4` against 2 summaries, which reads as "two shards
  // died" forever — and the shards_reported > shard_total refusal cannot see
  // it, because it only catches the excess.
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  const out = run(env, []);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--shard-total <n> is required/);
});

for (const bad of ["abc", "4x", "0", "-1", "2.5"]) {
  test(`--shard-total ${bad} is refused rather than read as unknown`, () => {
    // `Number(x) || null` turned every one of these into `shard_total: null`,
    // which short-circuits the refusal below AND records the one state the code
    // calls undetectable.
    const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
    const out = run(env, ["--shard-total", bad]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /must be a positive integer/);
  });
}

test("--shard-total=N is honoured, not silently ignored", () => {
  // The `=` form used to fall through to the default, so the refusal could name
  // a number the caller never typed.
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"]), summary(2, [])] } }, [historyLine("111")]);
  const out = run(env, ["--shard-total=1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /2 shard summaries but --shard-total 1/);
});

test("a --history path that does not exist is named, not a node:fs stack", () => {
  const env = setup({ "111": { shards: [summary(1, ["a.spec.ts"])] } }, [historyLine("111")]);
  const out = run({ artifacts: env.artifacts, history: join(env.history, "nope.jsonl") }, ["--shard-total", "1"]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /History file not found/);
});
