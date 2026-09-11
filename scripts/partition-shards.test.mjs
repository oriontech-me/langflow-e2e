// Unit tests for the duration-balanced shard partitioner (issues #936, #1252, #1326).
// Run with: node --test scripts/partition-shards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  stableFilesFromReport,
  buildShards,
  classifyDurations,
  compareListing,
  listingOutputLines,
  refreshDurations,
  renderListingVerdict,
  weighting,
  UNKNOWN_QUANTILE,
} from "./partition-shards.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const CLI = path.join(import.meta.dirname, "partition-shards.mjs");

// A minimal Playwright-JSON-report shape: nested suites -> specs -> tests -> results.
// `tags` live on the spec (without the leading "@"), `duration` on each result (ms).
const report = {
  suites: [
    {
      file: "a.spec.ts",
      specs: [
        { tags: ["stable"], tests: [{ results: [{ duration: 1000 }, { duration: 500 }] }] },
        { tags: ["regression"], tests: [{ results: [{ duration: 9999 }] }] }, // not stable
      ],
    },
    {
      file: "b.spec.ts",
      suites: [
        {
          file: "b.spec.ts",
          specs: [{ tags: ["stable", "agents"], tests: [{ results: [{ duration: 2000 }] }] }],
        },
      ],
    },
    {
      file: "c.spec.ts",
      specs: [{ tags: ["release"], tests: [{ results: [{ duration: 3000 }] }] }], // no stable
    },
  ],
};

test("stableFilesFromReport returns only files carrying an @stable spec, deduped", () => {
  assert.deepEqual(stableFilesFromReport(report).sort(), ["a.spec.ts", "b.spec.ts"]);
});

test("buildShards assigns every file exactly once across exactly N shards", () => {
  const files = ["f1", "f2", "f3", "f4", "f5"];
  const shards = buildShards(files, {}, 3);
  assert.equal(shards.length, 3);
  const flat = shards.flatMap((s) => s.files);
  assert.equal(flat.length, files.length);
  assert.deepEqual([...flat].sort(), [...files].sort());
});

test("buildShards balances by duration (LPT) and beats a naive count-split on skew", () => {
  // One monster file + many small ones — the pathological case the count-split mishandles.
  const durations = { big: 300, s1: 10, s2: 10, s3: 10, s4: 10, s5: 10, s6: 10 };
  const files = Object.keys(durations);
  const shards = buildShards(files, durations, 4);
  const load = (s) => s.files.reduce((a, f) => a + durations[f], 0);
  const loads = shards.map(load);
  const max = Math.max(...loads), min = Math.min(...loads);
  // The 300s monster dominates one shard; LPT still packs the rest to minimize the max.
  assert.equal(max, 300); // monster isolated on its own shard
  // Remaining 60s spread over 3 shards -> 20 each; naive round-robin by count would
  // have stacked several small ones with the monster. Assert no shard exceeds monster.
  assert.ok(loads.every((l) => l <= 300));
  assert.ok(min >= 20); // small files fully packed, no empty shard
});

test("buildShards falls back to equal weights when durations are empty (count-balanced)", () => {
  const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
  const shards = buildShards(files, {}, 4);
  const counts = shards.map((s) => s.files.length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1); // counts within 1
});

test("buildShards gives unknown files a known-file weight, not zero", () => {
  // known weights: 100, 100, 100 ; unknown 'u' must NOT be treated as 0 (which would
  // let it pile onto a heavy shard for free). Every quantile of {100,100,100} is 100,
  // so 'u' is a heavy file whichever one the fallback uses.
  const durations = { a: 100, b: 100, c: 100 };
  const files = ["a", "b", "c", "u"];
  const shards = buildShards(files, durations, 2);
  const eff = { ...durations, u: 100 };
  const loads = shards.map((s) => s.files.reduce((x, f) => x + eff[f], 0));
  assert.equal(Math.max(...loads), 200); // 2 heavy files per shard, balanced
  assert.equal(Math.min(...loads), 200);
});

// ---- #1326: an unmeasured file is not an AVERAGE file ------------------------
//
// What a run fails to measure is not a random sample: a file is excluded when it
// failed, flaked or skipped, and the specs that do that here are the ones calling a
// real model — the slowest ones. So the table converges on the cheap files and the
// median of what IS measured systematically underweights what is not.

test("the unknown-file fallback is the p75 of the measured files, not their median", () => {
  // Median of 1..9 is 5; the p75 is 7. Pinning the VALUE (not just ">= median")
  // because "raise the quantile" is the whole change: reverting UNKNOWN_QUANTILE to
  // 0.5 must fail here rather than pass a directional assertion.
  const durations = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((v, i) => [`f${i}`, v]));
  const files = [...Object.keys(durations), "unknown"];
  const w = weighting(files, durations);
  assert.equal(UNKNOWN_QUANTILE, 0.75);
  assert.equal(w.fallback, 7);
  assert.equal(w.weightOf("unknown"), 7);
  assert.equal(w.weightOf("f0"), 1, "a measured file keeps its own duration");
});

test("the fallback is strictly above the median whenever the table is skewed", () => {
  // The property that matters, stated independently of the exact quantile: the shape
  // of a real table is a long right tail (the committed one runs 0.1 s to 161.8 s,
  // median 16.3 s, p75 30.6 s), and the fallback must sit in that tail.
  const durations = Object.fromEntries(
    [0.1, 0.2, 0.4, 0.5, 1, 2, 8, 16, 24, 30, 45, 62, 145].map((v, i) => [`f${i}`, v]),
  );
  const files = [...Object.keys(durations), "unknown"];
  const values = Object.values(durations).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  assert.ok(
    weighting(files, durations).fallback > median,
    "an unmeasured file must not be weighted like a typical measured one",
  );
});

test("weighting names the unmeasured files, sorted, and counts the measured ones", () => {
  // The caller PRINTS these: a "170/178" ratio does not say the missing eight are the
  // expensive ones, which is the reportable half of #1326 (#1012's rule).
  const w = weighting(["z.spec.ts", "a.spec.ts", "m.spec.ts"], { "m.spec.ts": 10 });
  assert.deepEqual(w.unmeasured, ["a.spec.ts", "z.spec.ts"]);
  assert.deepEqual(w.measured, ["m.spec.ts"]);
});

test("weighting treats a 0, a negative and a non-number as unmeasured", () => {
  const w = weighting(["a", "b", "c", "d"], { a: 12, b: 0, c: -5, d: "8" });
  assert.deepEqual(w.unmeasured, ["b", "c", "d"]);
  assert.equal(w.fallback, 12, "a single measured file is its own quantile");
});

test("weighting falls back to 1 with no measured file at all, never to 0", () => {
  // Not 0: `buildShards` compares `b.load < best.load`, so over all-zero weights no
  // shard is ever lighter than shard 1 and every file lands there.
  const w = weighting(["a", "b"], {});
  assert.equal(w.fallback, 1);
  assert.equal(w.weightOf("a"), 1);
});

test("buildShards handles N greater than file count without dup or crash", () => {
  const shards = buildShards(["x", "y"], {}, 4);
  assert.equal(shards.length, 4);
  assert.equal(shards.flatMap((s) => s.files).length, 2);
  assert.deepEqual(shards.flatMap((s) => s.files).sort(), ["x", "y"]);
});

test("buildShards treats a 0 s duration as unknown, not as a free file", () => {
  // With every weight at 0, `b.load < best.load` is never true and all files land on
  // shard 1 — a silent single-shard run, the opposite of #936. `extract` refuses to
  // record a zero, so this only catches a hand-edited or legacy-shaped table.
  const files = ["a", "b", "c", "d"];
  const shards = buildShards(files, { a: 0, b: 0, c: 0, d: 0 }, 2);
  assert.deepEqual(
    shards.map((s) => s.files.length),
    [2, 2],
    "all-zero weights must degrade to a count balance, never to one shard",
  );
  // One real weight among zeros: the zeros must not undercut it either.
  const mixed = buildShards(files, { a: 100, b: 0, c: 0, d: 0 }, 2);
  assert.ok(mixed.every((s) => s.files.length >= 1));
});

test("buildShards is deterministic (stable tie-break by filename)", () => {
  const files = ["b", "a", "d", "c"];
  const a = buildShards(files, {}, 2);
  const b = buildShards([...files].reverse(), {}, 2);
  assert.deepEqual(a, b);
});

// ---- #1252: the refresh must converge from a real (imperfect) run -------------
//
// Context these pin: the old `extract` required a fully green daily, and the suite
// never produces one — so reports/spec-durations.json was never committed and every
// daily partitioned by file count. The fix excludes distortion per FILE and carries
// the previous value forward, which is only safe if each of those halves holds.

/** One @stable spec in `file`, with the given test statuses and durations (ms). */
const specFile = (file, tests) => ({
  file,
  specs: [{ tags: ["stable"], tests: tests.map(([status, ...ms]) => ({ status, results: ms.map((d) => ({ duration: d })) })) }],
});

test("classifyDurations records a file whose every @stable test passed unretried", () => {
  const { usable, excluded } = classifyDurations({
    suites: [specFile("ok.spec.ts", [["expected", 2000], ["expected", 500]])],
  });
  assert.deepEqual(usable, { "ok.spec.ts": 2.5 });
  assert.deepEqual(excluded, []);
});

test("classifyDurations excludes flaky, unexpected, skipped and an absent status", () => {
  const { usable, excluded } = classifyDurations({
    suites: [
      specFile("flaky.spec.ts", [["flaky", 900, 1000]]),
      specFile("failed.spec.ts", [["unexpected", 5000]]),
      specFile("skipped.spec.ts", [["skipped", 0]]),
      specFile("nostatus.spec.ts", [[undefined, 1000]]),
    ],
  });
  assert.deepEqual(usable, {});
  assert.deepEqual(excluded, [
    { file: "failed.spec.ts", reason: "unexpected" },
    // A flaky test's recorded time includes the attempt that failed — the original
    // reason the green-only gate existed.
    { file: "flaky.spec.ts", reason: "flaky" },
    // Undecidable is not a pass: a report-shape change must not start recording
    // distorted numbers silently.
    { file: "nostatus.spec.ts", reason: "unknown status" },
    // ~0s is FAST, not cheap — a fully skipped file would ride free onto the
    // heaviest shard. The old green-only gate did not prevent this either.
    { file: "skipped.spec.ts", reason: "skipped" },
  ]);
});

test("classifyDurations excludes a clean file that measured 0 s", () => {
  // A 0 in the table is not a light file: buildShards can never find a shard lighter
  // than it, so every file joins it on shard 1. Reachable the day a reporter change
  // stops emitting `duration` — which would zero all 171 entries at once, from a run
  // where every test legitimately came back `expected`.
  const { usable, excluded } = classifyDurations({
    suites: [specFile("instant.spec.ts", [["expected", 0]])],
  });
  assert.deepEqual(usable, {});
  assert.deepEqual(excluded, [{ file: "instant.spec.ts", reason: "measured 0 s" }]);
});

test("classifyDurations returns the same @stable file set stableFilesFromReport does", () => {
  // refreshDurations reads `files` from here instead of walking the report a second
  // time; the two predicates must not be able to drift apart.
  const r = {
    suites: [
      specFile("a.spec.ts", [["expected", 1000]]),
      specFile("b.spec.ts", [["unexpected", 1000]]),
      { file: "c.spec.ts", specs: [{ tags: ["release"], tests: [{ status: "expected" }] }] },
    ],
  };
  assert.deepEqual(classifyDurations(r).files.sort(), stableFilesFromReport(r).sort());
});

test("classifyDurations is per FILE — one bad test disqualifies the whole file", () => {
  const { usable, excluded } = classifyDurations({
    suites: [specFile("mixed.spec.ts", [["expected", 1000], ["flaky", 800, 900]])],
  });
  assert.deepEqual(usable, {}, "a partial file sum would understate it");
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].file, "mixed.spec.ts");
});

test("refreshDurations carries the previous value forward for an excluded file", () => {
  // THE point of #1252: one red spec must not discard the other 429 measurements,
  // and must not blank its own entry either.
  const report = {
    suites: [
      specFile("clean.spec.ts", [["expected", 3000]]),
      specFile("red.spec.ts", [["unexpected", 9000]]),
    ],
  };
  const r = refreshDurations(report, { "clean.spec.ts": 99, "red.spec.ts": 42 });
  assert.deepEqual(r.durations, { "clean.spec.ts": 3, "red.spec.ts": 42 });
  assert.deepEqual(r.recorded, ["clean.spec.ts"]);
  assert.deepEqual(r.carried, ["red.spec.ts"]);
  assert.deepEqual(r.unknown, []);
});

test("refreshDurations drops a file that is no longer @stable in the report", () => {
  // What the old full-replacement extract got right and a naive merge would lose:
  // a deleted or de-tagged spec must not linger in the table forever.
  const r = refreshDurations({ suites: [specFile("kept.spec.ts", [["expected", 1000]])] }, {
    "kept.spec.ts": 5,
    "gone.spec.ts": 77,
  });
  assert.deepEqual(Object.keys(r.durations), ["kept.spec.ts"]);
});

test("refreshDurations leaves a never-measured file OUT of the table", () => {
  // Absent is deliberate: buildShards weights an unknown file at the median of the
  // known ones, which beats a number measured under a retry.
  const r = refreshDurations({ suites: [specFile("new.spec.ts", [["flaky", 100, 200]])] }, {});
  assert.deepEqual(r.durations, {});
  assert.deepEqual(r.unknown, ["new.spec.ts"]);
});

test("refreshDurations overwrites a stale previous value with this run's measurement", () => {
  const r = refreshDurations({ suites: [specFile("a.spec.ts", [["expected", 4000]])] }, {
    "a.spec.ts": 1,
  });
  assert.deepEqual(r.durations, { "a.spec.ts": 4 });
});

// ---- #1252: `matrix` must not call a stale table a duration balance -----------

/** A `--list`-shaped report: one @stable spec per file, no statuses needed. */
const listReport = (files) => ({
  suites: files.map((f) => ({ file: f, specs: [{ tags: ["stable"], tests: [{}] }] })),
});

/** Run `matrix` in a scratch dir over the given files; returns { out, stderr }. */
const runMatrix = (durArg, files) => {
  const dir = makeTempDir("partition-shards-");
  try {
    for (const [name, body] of Object.entries(files))
      fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
    const r = spawnSync(process.execPath, [CLI, "matrix", "list.json", durArg, "2"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `matrix exited ${r.status}: ${r.stderr}`);
    return { out: JSON.parse(r.stdout), stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("matrix reports mode=count when the table exists but matches no current file", () => {
  // The intersection, not the table's size, is what decides whether the partition is
  // duration-balanced: a table whose every key is stale (one spec-directory rename
  // does that in a single commit) leaves every file at the same fallback weight.
  // Counting keys called that `mode=duration` and suppressed the warning below on the
  // one day it was true.
  const { out, stderr } = runMatrix("dur.json", {
    "list.json": listReport(["new/a.spec.ts", "new/b.spec.ts"]),
    "dur.json": { version: 1, durations: { "old/a.spec.ts": 10, "old/b.spec.ts": 20 } },
  });
  assert.equal(out.mode, "count");
  assert.match(stderr, /::warning::/);
  assert.match(stderr, /none of\s+which match the current @stable file set/);
});

test("matrix reports mode=duration and no warning once the table matches", () => {
  const { out, stderr } = runMatrix("dur.json", {
    "list.json": listReport(["a.spec.ts", "b.spec.ts"]),
    "dur.json": { version: 1, durations: { "a.spec.ts": 10, "b.spec.ts": 20 } },
  });
  assert.equal(out.mode, "duration");
  assert.doesNotMatch(stderr, /::warning::/);
  assert.match(stderr, /2\/2 with a recorded duration/);
});

test("matrix warns on a cold start, and stays quiet when no table was asked for", () => {
  const cold = runMatrix("dur.json", { "list.json": listReport(["a.spec.ts"]) });
  assert.equal(cold.out.mode, "count");
  assert.match(cold.stderr, /::warning::.*dur\.json does not exist/s);

  const optedOut = runMatrix("-", { "list.json": listReport(["a.spec.ts"]) });
  assert.equal(optedOut.out.mode, "count");
  assert.doesNotMatch(
    optedOut.stderr,
    /::warning::/,
    "a caller passing '-' asked for no table and must not be warned",
  );
});

test("matrix NAMES the files with no recorded duration and the weight they got", () => {
  // The ratio alone reads as a rounding error. What it hides is that the missing files
  // are systematically the expensive ones — a heavy spec red for a month is invisible
  // in "170/178" and is exactly the file whose weight is a guess (#1326/#1012).
  const { stderr } = runMatrix("dur.json", {
    "list.json": listReport(["a.spec.ts", "b.spec.ts", "heavy.spec.ts", "new.spec.ts"]),
    "dur.json": { version: 1, durations: { "a.spec.ts": 4, "b.spec.ts": 8, "heavy.spec.ts": 40 } },
  });
  assert.match(stderr, /3\/4 with a recorded duration/);
  assert.match(stderr, /1 file\(s\) have NO recorded duration and were weighted at 24\.0 s/);
  assert.match(stderr, /^\s+new\.spec\.ts$/m, "the unmeasured file must be named, not just counted");
  assert.doesNotMatch(stderr, /^\s+a\.spec\.ts$/m, "a measured file must not be listed as missing");
});

test("matrix lists at most 30 unmeasured files, and says how many it elided", () => {
  // Capped so a cold start does not bury the shard sizes, but never silently (#1012).
  const files = Array.from({ length: 41 }, (_, i) => `f${String(i).padStart(2, "0")}.spec.ts`);
  const { stderr } = runMatrix("dur.json", {
    "list.json": listReport(files),
    "dur.json": { version: 1, durations: { "f00.spec.ts": 10 } },
  });
  const listed = stderr.split("\n").filter((l) => /^ {4}f\d\d\.spec\.ts$/.test(l));
  assert.equal(listed.length, 30);
  assert.match(stderr, /… and 10 more not listed here/);
});

test("matrix does not print an unmeasured list on a cold start", () => {
  // With NOTHING measured every file is "unmeasured" and the list would be the whole
  // suite; the ::warning:: already says the partition is a file-count balance.
  const { stderr } = runMatrix("dur.json", { "list.json": listReport(["a.spec.ts", "b.spec.ts"]) });
  assert.doesNotMatch(stderr, /have NO recorded duration/);
  assert.match(stderr, /::warning::/);
});

// ---- #1326: `@destructive` cannot reach the partition input -------------------
//
// #1326 reported folder-deletion-integrity.spec.ts as a permanently unmeasurable
// entry in the partition input, because @destructive runs in its own lane and never
// appears in the merged report the refresh reads. It is not in the input at all, and
// these two facts are why — assert them, because the claim expires the day either
// changes and the file would then really be an unmeasurable fallback entry forever.

const SPEC_DIR = path.join(import.meta.dirname, "..", "tests");

/** Every `.spec.ts` under tests/, recursively. */
const specFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? specFiles(p) : e.name.endsWith(".spec.ts") ? [p] : [];
  });

test("no test is tagged both @stable and @destructive", () => {
  // CLAUDE.md forbids the combination (#1010: daily-stable.yml has no destructive
  // lane, so such a test would silently never run). It is also what keeps the
  // partition input free of a file that cannot be measured on the lane that partitions
  // it — the @destructive test in folder-deletion-integrity is @release @api, and that
  // file's three @stable tests do run, and do measure.
  const offenders = [];
  for (const file of specFiles(SPEC_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    // `tag: [...]` arrays only — a mention in a comment is not a tag.
    for (const m of src.matchAll(/tag:\s*\[([^\]]*)\]/g)) {
      const tags = m[1];
      if (/@stable\b/.test(tags) && /@destructive\b/.test(tags))
        offenders.push(`${path.relative(SPEC_DIR, file)}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, [], "a @stable @destructive test would enter the partition input but never run in that lane");
});

test("playwright.config.ts still excludes @destructive from every non-destructive run", () => {
  // The second half: even a mis-tagged test would be kept out of `--grep @stable
  // --list` by grepInvert, which a CLI --grep cannot override. Without this the guard
  // above is the only thing standing between the partition and an unmeasurable file.
  //
  // Lane resolution moved into `tests/fixtures/lane.ts` when `@enterprise` became a
  // second selector, so this checks the two halves that live in reachable source:
  // the config DELEGATES (it must not compute a grepInvert of its own, which would
  // silently win over the module), and the module's DEFAULT lane still excludes
  // `@destructive`. Neither is the real proof — `tests/fixtures/lane.test.ts` owns
  // that, asserting every lane by SELECTION against representative tag strings,
  // which is what a spelling match cannot do (#1226). This node lane cannot import
  // the TypeScript module, so it pins the wiring and points at the behaviour.
  const config = fs.readFileSync(path.join(import.meta.dirname, "..", "playwright.config.ts"), "utf8");
  assert.match(
    config,
    /grepInvert:\s*LANE\.grepInvert\s*,/,
    "the config must take grepInvert from the lane module, not compute its own (#1326)",
  );

  const lane = fs.readFileSync(
    path.join(import.meta.dirname, "..", "tests", "fixtures", "lane.ts"),
    "utf8",
  );
  assert.match(
    lane,
    /grepInvert:\s*\/@destructive\|@enterprise\/,/,
    "the default lane must still exclude @destructive — the partition input assumes it (#1326)",
  );
});

// ---- #1252: the workflow wiring the unit tests cannot reach -------------------

const daily = fs.readFileSync(
  path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
  "utf8",
);
const refreshStart = daily.indexOf("- name: Refresh spec durations");
const refreshEnd = daily.indexOf("- name: Summarize token consumption");
// Asserted at module load, once: every check below this point is a NEGATIVE match on
// `refreshStep`, and a bad slice ("" if a step is renamed or reordered) would make all
// of them pass vacuously.
assert.ok(
  refreshStart >= 0 && refreshEnd > refreshStart,
  "cannot locate the Refresh spec durations step in daily-stable.yml — the structural checks below would pass vacuously",
);
const refreshStep = daily.slice(refreshStart, refreshEnd);

test("the durations refresh is NOT gated on a fully green test job", () => {
  // The whole defect: this suite has 1-10 hard failures on a normal day, so that gate
  // never opened and the table was never written once.
  assert.ok(
    !/needs\.test\.result\s*==\s*'success'/.test(refreshStep),
    "re-adding the green-only gate closes the loop again (#1252)",
  );
});

test("the durations refresh survives an unrelated earlier step failure (always())", () => {
  // A step `if:` with no status function gets an implicit success(), so without
  // `always()` an un-continue-on-error step earlier in the merge job (the report
  // upload, the payload build) silently skips the refresh — a milder rerun of the
  // defect this issue is about, and just as invisible in the log.
  assert.match(
    refreshStep,
    /if:\s*always\(\)\s*&&/,
    "the refresh must be if: always() && <runguard gates>",
  );
});

test("the durations refresh cannot turn a green daily red on its own", () => {
  // #980's trade: the table is an optimisation, not a verdict, and this step now runs
  // every day. A crash in it would otherwise fail the merge job while `Create issue on
  // failure` (gated on the test job) opens nothing — a red run with no triage.
  assert.match(refreshStep, /continue-on-error:\s*true/);
});

test("the durations refresh keeps both runguard gates", () => {
  // empty (#1012): extract on an empty report emits {} and the commit step would wipe
  // the table. partial (#1058): surviving shards competed for a saturated backend.
  assert.match(refreshStep, /runguard\.outputs\.empty\s*==\s*'false'/);
  assert.match(refreshStep, /runguard\.outputs\.partial\s*==\s*'false'/);
});

test("the refresh passes the previous table in, and never redirects onto its own input", () => {
  // `> reports/spec-durations.json` truncates the file before node opens it, so the
  // carry-forward would silently degrade to "measured this run only" — the exact
  // behaviour #1252 removes, with nothing in the log to say so.
  assert.match(
    refreshStep,
    /extract results\.json reports\/spec-durations\.json/,
    "the committed table must be passed as the previous-values argument",
  );
  assert.ok(
    !/>\s*reports\/spec-durations\.json/.test(refreshStep),
    "write via a temp file and mv — a redirect truncates the input",
  );
  assert.match(refreshStep, /mv .*reports\/spec-durations\.json/);
});

test("the refresh runs on a manual dispatch too, while only the COMMIT is schedule-only", () => {
  // Split deliberately (#1252): a manual dispatch must be able to exercise the extract
  // — otherwise the only proof of a change to it is the next scheduled daily — while
  // the write to main stays schedule-only, which the commit step enforces itself.
  assert.ok(
    !/github\.event_name\s*==\s*'schedule'/.test(refreshStep),
    "the refresh must not be schedule-gated; that makes it unverifiable by dispatch",
  );
  const commitStep = daily.slice(daily.indexOf("- name: Commit daily history"));
  assert.match(
    commitStep.slice(0, 400),
    /github\.event_name\s*==\s*'schedule'/,
    "the commit back to main MUST stay schedule-only",
  );
});

// ---- #1812: the listing-completeness detector --------------------------------
//
// The daily shards by FILE, so the `--list` this partition is built from decides
// which files exist at all. A spec whose tests are generated at COLLECTION time
// from something the environment did not supply collects zero tests, leaves the
// partition and is handed to no shard — not skipped, not red, ABSENT (#1764).
// These tests are about the two things the detector must never do: miss a lost
// file, and report agreement it did not establish.

const listingOf = (files, root = "/repo/tests") => ({ files, root });
const declaredOf = (files, root = "/repo/tests", extra = {}) => ({ root, files, ...extra });

test("compareListing reports an exact match with no missing and no listed-only", () => {
  const v = compareListing(listingOf(["a.spec.ts", "b.spec.ts"]), declaredOf(["b.spec.ts", "a.spec.ts"]));
  assert.equal(v.verified, true);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.unexpected, []);
  assert.equal(v.declaredCount, 2);
  assert.equal(v.listedCount, 2);
});

test("compareListing NAMES a declared file the listing does not contain", () => {
  // #1764's exact shape: the file is on disk, carries @stable, and no shard got it.
  const v = compareListing(
    listingOf(["a.spec.ts"]),
    declaredOf(["a.spec.ts", "llm-agents/provider-invalid-auth-error.spec.ts"]),
  );
  assert.equal(v.verified, true);
  assert.deepEqual(v.missing, ["llm-agents/provider-invalid-auth-error.spec.ts"]);
});

test("compareListing reports a listed file the declaration does not know about", () => {
  const v = compareListing(listingOf(["a.spec.ts", "factory.spec.ts"]), declaredOf(["a.spec.ts"]));
  assert.deepEqual(v.unexpected, ["factory.spec.ts"]);
  assert.deepEqual(v.missing, []);
});

test("compareListing matches through each side's own root, not on the path strings", () => {
  // A Playwright release that reported paths from the config directory instead of
  // from testDir would otherwise make all 247 files simultaneously lost AND
  // invented — a false red big enough to get the detector switched off.
  const v = compareListing(
    { files: ["tests/a.spec.ts"], root: "/repo" },
    declaredOf(["a.spec.ts"], "/repo/tests"),
  );
  assert.equal(v.verified, true);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.unexpected, []);
});

test("compareListing is UNVERIFIED, never agreement, when it cannot resolve its inputs", () => {
  // Fail-closed on all four: a detector that cannot look must not read as a
  // detector that found nothing (#1012).
  const cases = [
    ["no declared set", compareListing(listingOf(["a.spec.ts"]), null)],
    ["no declared root", compareListing(listingOf(["a.spec.ts"]), { files: ["a.spec.ts"] })],
    ["no declared file list", compareListing(listingOf(["a.spec.ts"]), { root: "/repo/tests" })],
    ["no listing root", compareListing({ files: ["a.spec.ts"], root: undefined }, declaredOf(["a.spec.ts"]))],
  ];
  for (const [why, v] of cases) {
    assert.equal(v.verified, false, why);
    assert.ok(v.reason.length > 0, `${why}: an unverified verdict must say why`);
    // And it must not smuggle a finding out of an input it could not read.
    assert.deepEqual(v.missing, [], why);
    assert.deepEqual(v.unexpected, [], why);
  }
});

test("compareListing carries the declaration's laneOnly and unparseable notes through", () => {
  const v = compareListing(
    listingOf(["a.spec.ts"]),
    declaredOf(["a.spec.ts"], "/repo/tests", { laneOnly: ["ent.spec.ts"], unparseable: ["u.spec.ts"] }),
  );
  assert.deepEqual(v.laneOnly, ["ent.spec.ts"]);
  assert.deepEqual(v.unparseable, ["u.spec.ts"]);
});

test("renderListingVerdict names every missing file and warns", () => {
  const { lines, warnings } = renderListingVerdict(
    compareListing(listingOf(["a.spec.ts"]), declaredOf(["a.spec.ts", "lost.spec.ts"])),
  );
  const text = lines.join("\n");
  assert.match(text, /1 missing/);
  assert.match(text, /lost\.spec\.ts/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::/);
  assert.match(warnings[0], /lost\.spec\.ts/);
});

test("renderListingVerdict says UNVERIFIED and never renders it as a match", () => {
  const { lines, warnings } = renderListingVerdict(compareListing(listingOf(["a.spec.ts"]), null));
  const text = lines.join("\n");
  assert.match(text, /UNVERIFIED/);
  assert.doesNotMatch(text, /exact match/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::/);
});

test("renderListingVerdict still says UNVERIFIED when nobody asked, but does not warn", () => {
  // Same split the durations table already makes: a caller that ASKED and got
  // nothing is a different event from a caller that never asked. The verdict is
  // unchanged — the daily's gate reads it fail-closed either way — so what this
  // buys is only that a caller which does not run the check is not warned on
  // every invocation, which is how `mode=count` became unreadable (#1252).
  const { lines, warnings } = renderListingVerdict(
    compareListing(listingOf(["a.spec.ts"]), null),
    /* asked */ false,
  );
  assert.match(lines.join("\n"), /UNVERIFIED/);
  assert.deepEqual(warnings, []);
});

test("renderListingVerdict does not warn at all on an exact match", () => {
  const { lines, warnings } = renderListingVerdict(
    compareListing(listingOf(["a.spec.ts"]), declaredOf(["a.spec.ts"])),
  );
  assert.deepEqual(warnings, []);
  assert.match(lines.join("\n"), /exact match/);
});

test("renderListingVerdict warns about listed-only files WITHOUT calling them a loss", () => {
  const { lines, warnings } = renderListingVerdict(
    compareListing(listingOf(["a.spec.ts", "factory.spec.ts"]), declaredOf(["a.spec.ts"])),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No coverage is lost/);
  // But it must say the missing list is then only a lower bound: a file the
  // predicate cannot see is a file whose later disappearance it cannot report.
  assert.match(lines.join("\n"), /lower bound/);
});

test("renderListingVerdict caps the named files at 30 and says how many it elided", () => {
  const lost = Array.from({ length: 42 }, (_, i) => `lost-${String(i).padStart(2, "0")}.spec.ts`);
  const { lines } = renderListingVerdict(compareListing(listingOf([]), declaredOf(lost)));
  const text = lines.join("\n");
  assert.match(text, /lost-00\.spec\.ts/);
  assert.doesNotMatch(text, /lost-41\.spec\.ts/);
  assert.match(text, /and 12 more not listed here/);
});

test("matrix emits a listing verdict on stdout and prints it, with --declared", () => {
  const dir = makeTempDir("partition-listing-");
  const listPath = path.join(dir, "list.json");
  const declaredPath = path.join(dir, "declared.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [
        { file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] },
      ],
    }),
  );
  fs.writeFileSync(
    declaredPath,
    JSON.stringify({ version: 1, root: "/repo/tests", files: ["a.spec.ts", "gone.spec.ts"] }),
  );
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2", "--declared", declaredPath], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.listing.verified, true);
  assert.deepEqual(out.listing.missing, ["gone.spec.ts"]);
  assert.match(r.stderr, /::warning::.*gone\.spec\.ts/);
  // The partition itself is unaffected: a file the listing never produced cannot
  // be handed to a shard, and inventing one here would fail the shard command.
  assert.equal(out.include.map((s) => s.files).join(" ").includes("gone.spec.ts"), false);
});

test("matrix reports UNVERIFIED rather than dying when the declared file is unreadable", () => {
  // The load-bearing half of the placement: this step's product is the shard
  // matrix, so a detector able to abort `prep` would cost the whole day it was
  // added to protect.
  const dir = makeTempDir("partition-listing-bad-");
  const listPath = path.join(dir, "list.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  const r = spawnSync(
    process.execPath,
    [CLI, "matrix", listPath, "-", "2", "--declared", path.join(dir, "absent.json")],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, "an unreadable declaration must not abort the matrix");
  const out = JSON.parse(r.stdout);
  assert.equal(out.listing.verified, false);
  assert.match(out.listing.reason, /could not be read/);
  assert.equal(out.include.length, 2, "the partition is still produced");
});

test("matrix without --declared still emits a listing block, and it is UNVERIFIED", () => {
  // An absent block would make the daily's `listing_verified` output empty, which
  // the merge job's gate reads fail-closed — but only as long as the field exists
  // to be read. Emitting it unconditionally is what makes the absence meaningful.
  const dir = makeTempDir("partition-listing-none-");
  const listPath = path.join(dir, "list.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).listing.verified, false);
});

test("matrix refuses --declared with no value instead of silently skipping the check", () => {
  const dir = makeTempDir("partition-listing-usage-");
  const listPath = path.join(dir, "list.json");
  fs.writeFileSync(listPath, JSON.stringify({ config: { rootDir: "/r" }, suites: [] }));
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2", "--declared"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

// ---- #1812: the daily's wiring ----------------------------------------------
//
// Structural, and deliberately narrow. A regex over workflow text cannot prove
// the gate behaves (#1226 — every such guard here was shown to pass its own
// mutation); what it CAN prove is that the two ends are still connected, which is
// the failure mode a detector added to one job and read by another actually has.

const DAILY = fs.readFileSync(
  path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
  "utf8",
);

test("the daily derives the declared spec set and passes it to the matrix", () => {
  assert.match(DAILY, /scripts\/declared-stable-specs\.ts > \/tmp\/declared-specs\.json/);
  assert.match(DAILY, /partition-shards\.mjs matrix .*--declared \/tmp\/declared-specs\.json/);
});

test("deriving the declared set cannot abort the prep job", () => {
  // `prep`'s product is the matrix. A detector that kills it loses 247 files to
  // report one — the trade #980 names, and the one #1813 already settled for the
  // sibling reporter in this same step.
  const step = DAILY.slice(
    DAILY.indexOf("name: Compute duration-balanced shard matrix"),
    DAILY.indexOf("name: \"Shard ${{ matrix.shard }}"),
  );
  assert.match(step, /if ! npx ts-node scripts\/declared-stable-specs\.ts/);
  assert.match(step, /::warning::could not derive the declared @stable spec set/);
});

test("prep publishes the listing verdict and the merge job's final gate reads it fail-closed", () => {
  assert.match(DAILY, /listing_verified: \$\{\{ steps\.mk\.outputs\.listing_verified \}\}/);
  assert.match(DAILY, /listing_missing: \$\{\{ steps\.mk\.outputs\.listing_missing \}\}/);
  const gate = DAILY.slice(DAILY.indexOf("- name: Fail scheduled run on an incomplete"));
  // `!= 'true'`, never `== 'false'`: an unset output means the derivation never
  // ran, and an unknown verdict must fail rather than read as agreement.
  assert.match(gate, /needs\.prep\.outputs\.listing_verified != 'true'/);
  assert.match(gate, /needs\.prep\.outputs\.listing_missing != '\[\]'/);
});

test("the listing gate does not fire on listed-only files", () => {
  // A listed-but-undeclared file is coverage the run HAS. Failing the day for it
  // inverts the trade this check exists to make.
  const gate = DAILY.slice(DAILY.indexOf("- name: Fail scheduled run on an incomplete"));
  const condition = gate.slice(gate.indexOf("if:"), gate.indexOf("env:"));
  assert.doesNotMatch(condition, /listing_unexpected/);
});

// ---- #1812, round two: the three ways the detector could still lose ----------
//
// From the independent review of the first version. Each of these was a live
// defect, and the first one was the worst kind: it made the detector able to
// kill the day it exists to protect.

test("compareListing is UNVERIFIED — never a throw — on a non-string entry, from either side", () => {
  // `path.resolve` THROWS on a non-string. A throw does not degrade to
  // UNVERIFIED: it leaves the CLI at exit 1 with empty stdout, and the prep
  // step's `MATRIX="$(…)"` under `bash -eo pipefail` then aborts, losing the
  // whole daily. Measured on the first version, with `[null]`, `[1]` and a
  // report whose @stable spec carries no `file`.
  const cases = [
    [null], [1], [{}], ["ok.spec.ts", null], [undefined], [""],
  ];
  for (const files of cases) {
    const v = compareListing(listingOf(["a.spec.ts"]), declaredOf(files));
    assert.equal(v.verified, false, `declared ${JSON.stringify(files)}`);
    assert.match(v.reason, /not a file path/);
    const w = compareListing({ files, root: "/repo/tests" }, declaredOf(["a.spec.ts"]));
    assert.equal(w.verified, false, `listed ${JSON.stringify(files)}`);
    assert.match(w.reason, /no resolvable file path/);
  }
});

test("matrix survives a declaration with a non-string entry, and still prints the partition", () => {
  // The property that matters is not the message, it is the exit code and the
  // stdout: `prep` reads the matrix out of this process's stdout.
  const dir = makeTempDir("partition-listing-nonstring-");
  const listPath = path.join(dir, "list.json");
  const declaredPath = path.join(dir, "declared.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  fs.writeFileSync(declaredPath, JSON.stringify({ root: "/repo/tests", files: [null] }));
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2", "--declared", declaredPath], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `the matrix must still be produced: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.listing.verified, false);
  assert.equal(out.include.length, 2);
});

test("matrix survives a listing whose @stable spec has no file path at all", () => {
  const dir = makeTempDir("partition-listing-nofile-");
  const listPath = path.join(dir, "list.json");
  const declaredPath = path.join(dir, "declared.json");
  // No `file` on the suite and none on the spec: `stableFilesFromReport` yields
  // `undefined`. The parent commit tolerated this report at exit 0, so the first
  // version of the check was a NEW way to abort the day.
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  fs.writeFileSync(declaredPath, JSON.stringify({ root: "/repo/tests", files: ["a.spec.ts"] }));
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2", "--declared", declaredPath], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).listing.verified, false);
});

test("compareListing refuses an EMPTY declaration instead of certifying every listing", () => {
  // The check is one-sided: it sees the listing shrink, never the declaration.
  // An empty declaration produces `missing: []` over ANY listing — measured
  // against the real key-less listing, which really had lost a file, it reported
  // `0 missing, 246 listed-only` and `listing_verified=true`, and the gate passed.
  const v = compareListing(listingOf(["a.spec.ts", "b.spec.ts"]), declaredOf([]));
  assert.equal(v.verified, false);
  assert.match(v.reason, /empty/);
  assert.deepEqual(v.missing, []);
});

test("listingOutputLines emits exactly the values the daily's gate reads", () => {
  // The one-liner this replaces was pinned by nothing: swapping the verified
  // expression for a literal `true`, or the missing list for a literal `[]`,
  // disabled the mechanism and survived the whole suite (#1226).
  assert.deepEqual(
    listingOutputLines(compareListing(listingOf(["a.spec.ts"]), declaredOf(["a.spec.ts", "gone.spec.ts"]))),
    [
      "listing_verified=true",
      'listing_missing=["gone.spec.ts"]',
      "listing_unexpected=[]",
    ],
  );
  assert.deepEqual(listingOutputLines(compareListing(listingOf(["a.spec.ts"]), null)), [
    "listing_verified=false",
    "listing_missing=[]",
    "listing_unexpected=[]",
  ]);
});

test("listingOutputLines never emits a value that spans two lines", () => {
  // `$GITHUB_OUTPUT` is line-oriented: a raw newline inside a value would inject
  // an output key. `JSON.stringify` escapes it — assert that, do not assume it.
  const lines = listingOutputLines(
    compareListing(listingOf([]), declaredOf(["we\nird.spec.ts", 'qu"ote.spec.ts'])),
  );
  assert.equal(lines.length, 3);
  for (const l of lines) assert.equal(l.includes("\n"), false);
  assert.match(lines[1], /listing_missing=\[.*\]$/);
});

test("matrix --github-output appends the verdict to the file the caller names", () => {
  const dir = makeTempDir("partition-listing-out-");
  const listPath = path.join(dir, "list.json");
  const declaredPath = path.join(dir, "declared.json");
  const outPath = path.join(dir, "outputs.txt");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  fs.writeFileSync(
    declaredPath,
    JSON.stringify({ root: "/repo/tests", files: ["a.spec.ts", "gone.spec.ts"] }),
  );
  fs.writeFileSync(outPath, "existing=1\n");
  const r = spawnSync(
    process.execPath,
    [CLI, "matrix", listPath, "-", "2", "--declared", declaredPath, "--github-output", outPath],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  // APPEND, never truncate: the step writes `matrix=` and `shard_total=` to the
  // same file.
  assert.deepEqual(fs.readFileSync(outPath, "utf8").trim().split("\n"), [
    "existing=1",
    "listing_verified=true",
    'listing_missing=["gone.spec.ts"]',
    "listing_unexpected=[]",
  ]);
});

test("matrix warns rather than dying when the output file cannot be written", () => {
  const dir = makeTempDir("partition-listing-outbad-");
  const listPath = path.join(dir, "list.json");
  fs.writeFileSync(
    listPath,
    JSON.stringify({
      config: { rootDir: "/repo/tests" },
      suites: [{ file: "a.spec.ts", specs: [{ tags: ["stable"], tests: [{ results: [] }] }] }],
    }),
  );
  const r = spawnSync(
    process.execPath,
    [CLI, "matrix", listPath, "-", "2", "--github-output", path.join(dir, "no", "such", "dir", "o.txt")],
    { encoding: "utf8" },
  );
  // Absent outputs are read fail-closed by the gate; an abort here loses the day.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /::warning::could not write the listing verdict/);
  assert.equal(JSON.parse(r.stdout).shard_total, 2);
});

test("matrix refuses --github-output with no value", () => {
  const dir = makeTempDir("partition-listing-outusage-");
  const listPath = path.join(dir, "list.json");
  fs.writeFileSync(listPath, JSON.stringify({ config: { rootDir: "/r" }, suites: [] }));
  const r = spawnSync(process.execPath, [CLI, "matrix", listPath, "-", "2", "--github-output"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

test("the daily emits the listing outputs from the script, not from a workflow one-liner", () => {
  assert.match(DAILY, /partition-shards\.mjs matrix .*--github-output "\$GITHUB_OUTPUT"/);
  // And the one-liner it replaced must not come back: a `node -e` composing
  // `listing_verified=` in YAML is exactly the shape two disabling mutations
  // survived (#1226).
  const prep = DAILY.slice(
    DAILY.indexOf("name: Compute duration-balanced shard matrix"),
    DAILY.indexOf('name: "Shard ${{ matrix.shard }}'),
  );
  assert.doesNotMatch(prep, /node -e[^\n]*listing_verified/);
});

test("the daily's umbrella step fires on the listing axis too", () => {
  // The gate reddens the day, but `Create issue on failure` is gated on the TEST
  // job (plus the two report guards) — and a missing-file day has a green test
  // job. Without these clauses the run goes red with one annotation and nothing
  // durable naming why: #1176's defect, on a fourth axis. Read exactly as the
  // gate reads them, so the two cannot disagree about whether the day had a
  // finding.
  const step = DAILY.slice(
    DAILY.indexOf("- name: Create issue on failure"),
    DAILY.indexOf("- name: Fail scheduled run on an incomplete"),
  );
  const condition = step.slice(step.indexOf("if:"), step.indexOf("run:"));
  assert.match(condition, /needs\.prep\.outputs\.listing_verified != 'true'/);
  assert.match(condition, /needs\.prep\.outputs\.listing_missing != '\[\]'/);
  assert.match(step, /LISTING_VERIFIED: \$\{\{ needs\.prep\.outputs\.listing_verified \}\}/);
  assert.match(step, /LISTING_MISSING: \$\{\{ needs\.prep\.outputs\.listing_missing \}\}/);
});

test("compareListing flags the MISSING files whose titles it could not evaluate", () => {
  // A title built from a template substitution — on the test or on an enclosing
  // `test.describe` — is greppable at run time and opaque to the declaration, so
  // a lane tag arriving through one looks exactly like a lost file. Reported,
  // never subtracted: 19 of this suite's files carry such a title, almost all of
  // them the provider-parametrized specs — #1764's own family.
  const v = compareListing(
    listingOf(["a.spec.ts"]),
    declaredOf(["a.spec.ts", "param.spec.ts", "plain.spec.ts"], "/repo/tests", {
      unresolvedTitles: ["param.spec.ts", "listed-anyway.spec.ts"],
    }),
  );
  assert.deepEqual(v.missing, ["param.spec.ts", "plain.spec.ts"]);
  // Only the intersection: a file that was listed carries no doubt.
  assert.deepEqual(v.unresolvedMissing, ["param.spec.ts"]);
  const { lines } = renderListingVerdict(v);
  const text = lines.join("\n");
  assert.match(text, /carry a title this check cannot evaluate/);
  assert.match(text, /template substitution/);
  // Never worded over a construct the file may not contain: one real file in
  // `unresolvedTitles` has no `test.describe` at all, its interpolation being in
  // the TEST title, so naming a describe would send the reader looking for
  // something that is not there.
  assert.doesNotMatch(text, /carry a `test\.describe` title/);
  assert.match(lines.join("\n"), /param\.spec\.ts/);
});

test("renderListingVerdict says nothing about unresolved titles when none are missing", () => {
  const { lines } = renderListingVerdict(
    compareListing(
      listingOf(["a.spec.ts"]),
      declaredOf(["a.spec.ts", "gone.spec.ts"], "/repo/tests", {
        unresolvedTitles: ["a.spec.ts"],
      }),
    ),
  );
  assert.match(lines.join("\n"), /gone\.spec\.ts/);
  assert.doesNotMatch(lines.join("\n"), /template substitution/);
});

test("an unverified verdict carries no unresolvedMissing either", () => {
  const v = compareListing(listingOf(["a.spec.ts"]), null);
  assert.deepEqual(v.unresolvedMissing, []);
});
