// Unit tests for the duration-balanced shard partitioner (issues #936, #1252).
// Run with: node --test scripts/partition-shards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  stableFilesFromReport,
  stableDurationsByFile,
  buildShards,
  classifyDurations,
  refreshDurations,
} from "./partition-shards.mjs";

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

test("stableDurationsByFile sums all attempt durations of stable specs, in seconds", () => {
  const d = stableDurationsByFile(report);
  assert.equal(d["a.spec.ts"], 1.5); // 1000 + 500 ms, only the stable spec
  assert.equal(d["b.spec.ts"], 2.0);
  assert.equal(d["c.spec.ts"], undefined); // no stable spec
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

test("buildShards gives unknown files the median known weight, not zero", () => {
  // known weights: 100, 100, 100 ; unknown 'u' must NOT be treated as 0 (which would
  // let it pile onto a heavy shard for free). Median = 100, so 'u' is a heavy file.
  const durations = { a: 100, b: 100, c: 100 };
  const files = ["a", "b", "c", "u"];
  const shards = buildShards(files, durations, 2);
  const eff = { ...durations, u: 100 };
  const loads = shards.map((s) => s.files.reduce((x, f) => x + eff[f], 0));
  assert.equal(Math.max(...loads), 200); // 2 heavy files per shard, balanced
  assert.equal(Math.min(...loads), 200);
});

test("buildShards handles N greater than file count without dup or crash", () => {
  const shards = buildShards(["x", "y"], {}, 4);
  assert.equal(shards.length, 4);
  assert.equal(shards.flatMap((s) => s.files).length, 2);
  assert.deepEqual(shards.flatMap((s) => s.files).sort(), ["x", "y"]);
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

// ---- #1252: the workflow wiring the unit tests cannot reach -------------------

const daily = fs.readFileSync(
  path.join(import.meta.dirname, "..", ".github", "workflows", "daily-stable.yml"),
  "utf8",
);
const refreshStep = daily.slice(
  daily.indexOf("- name: Refresh spec durations"),
  daily.indexOf("- name: Summarize token consumption"),
);

test("the durations refresh is NOT gated on a fully green test job", () => {
  // The whole defect: this suite has 1-10 hard failures on a normal day, so that gate
  // never opened and the table was never written once.
  assert.ok(refreshStep.length > 0, "the Refresh spec durations step must exist");
  assert.ok(
    !/needs\.test\.result\s*==\s*'success'/.test(refreshStep),
    "re-adding the green-only gate closes the loop again (#1252)",
  );
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
