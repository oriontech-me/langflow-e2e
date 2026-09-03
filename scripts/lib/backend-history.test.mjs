// Unit tests for the run-history `backend` block (#1077).
// Run with: node --test scripts/lib/backend-history.test.mjs
//
// The block is what makes #1077's before/after possible at all: the wedge is
// measured into `liveness-N` artifacts that expire after 7 days, so every
// measurement on that issue is a table typed by hand into a comment. What these
// tests pin is therefore not a rendering but the two properties a longitudinal
// series has to have — that a row's per-shard counts reconcile with its own
// run-level totals, and that "not measured" can never read as "backend healthy".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBackendBlock, countByFile } from "./backend-history.mjs";

const APPENDER = fileURLToPath(new URL("../append-weekly-history.mjs", import.meta.url));

/** A per-shard liveness summary of the shape `watch-backend.mjs --summarize` writes. */
function summary(shard, files, over = {}) {
  return {
    shard: String(shard),
    files,
    measured: true,
    probeCount: 300,
    failedProbes: 0,
    ignoredBlips: 0,
    firstProbeAt: "2026-09-02T12:00:00.000Z",
    lastProbeAt: "2026-09-02T12:10:00.000Z",
    spanSeconds: 600,
    windows: [],
    outageCount: 0,
    downSeconds: 0,
    downPct: 0,
    ...over,
  };
}

const outage = (startAt, endAt, seconds) => ({
  startAt,
  endAt,
  seconds,
  probes: Math.round(seconds / 2),
  openEnded: false,
  reason: "timeout>4000ms",
});

/** One merged report whose specs are `{file, status}` pairs. */
function report(specs) {
  return {
    config: {},
    suites: specs.map((s, i) => ({
      title: s.file,
      file: s.file,
      specs: [
        {
          title: `t${i}`,
          file: s.file,
          line: 10,
          tests: [
            {
              status: s.status,
              results: [
                { status: s.status === "expected" ? "passed" : "failed", duration: 1000, startTime: s.startTime || "2026-09-02T12:05:00.000Z" },
              ],
            },
          ],
        },
      ],
    })),
    stats: { duration: 1000 },
  };
}

test("no summary at all yields no block — the run simply never measured", () => {
  assert.equal(buildBackendBlock([], report([{ file: "a.spec.ts", status: "expected" }]), 4), null);
});

test("summaries that measured nothing yield a block reading UNKNOWN, not clean", () => {
  const block = buildBackendBlock(
    [summary(1, ["a.spec.ts"], { measured: false, probeCount: 0 })],
    report([{ file: "a.spec.ts", status: "expected" }]),
    4,
  );
  assert.ok(block, "a shard that reported must appear on the row");
  assert.equal(block.shards_reported, 1);
  assert.equal(block.shards_measured, 0, "0 of 4 is the signal a reader has to see");
  assert.equal(block.wedged, false);
  assert.equal(block.shards[0].measured, false);
});

test("a shard that never uploaded is visible as the gap between reported and declared", () => {
  const block = buildBackendBlock(
    [summary(1, ["a.spec.ts"])],
    report([{ file: "a.spec.ts", status: "expected" }]),
    4,
  );
  assert.equal(block.shard_total, 4);
  assert.equal(block.shards_reported, 1, "3 shards uploaded nothing and must not vanish");
});

test("an undeclared shard count is null, never 0", () => {
  // 0 would read as "the run had no shards", which is the one thing that makes a
  // silent shard undetectable — the reason the reporter takes SHARD_TOTAL at all.
  const block = buildBackendBlock([summary(1, ["a.spec.ts"])], report([]), null);
  assert.equal(block.shard_total, null);
});

test("per-shard totals reconcile with the run's own totals", () => {
  const block = buildBackendBlock(
    [summary(1, ["a.spec.ts", "b.spec.ts"]), summary(2, ["c.spec.ts"])],
    report([
      { file: "a.spec.ts", status: "expected" },
      { file: "b.spec.ts", status: "unexpected" },
      { file: "c.spec.ts", status: "flaky" },
    ]),
    2,
  );
  assert.deepEqual(block.shards[0].totals, { passed: 1, failed: 1, flaky: 0, skipped: 0 });
  assert.deepEqual(block.shards[1].totals, { passed: 0, failed: 0, flaky: 1, skipped: 0 });
  assert.equal(block.unassigned, undefined, "nothing is unassigned when every file has a shard");
});

test("a spec no shard claimed is named, not dropped", () => {
  // Otherwise the per-shard counts silently fail to sum to the line's totals and
  // the reader cannot tell that from a shard having genuinely run nothing.
  const block = buildBackendBlock(
    [summary(1, ["a.spec.ts"])],
    report([
      { file: "a.spec.ts", status: "expected" },
      { file: "orphan.spec.ts", status: "expected" },
    ]),
    1,
  );
  assert.deepEqual(block.unassigned, { passed: 1, failed: 0, flaky: 0, skipped: 0 });
});

test("every per-shard field is pinned, not just the aggregates", () => {
  // The aggregates come from `attribute()`, so asserting only those leaves the
  // block's OWN shard records unpinned — 8 of 12 fields survived being replaced
  // by 0 before this test existed, `span_seconds` (#1077's per-shard wall-clock
  // axis) and `down_seconds` among them. A mis-mapped field would then record a
  // plausible-looking series for months, which is the one failure a durable
  // baseline cannot recover from.
  const block = buildBackendBlock(
    [
      summary(1, ["a.spec.ts"], {
        outageCount: 2,
        downSeconds: 196,
        spanSeconds: 928.7,
        downPct: 21.1,
        failedProbes: 53,
        ignoredBlips: 4,
        windows: [outage("2026-09-02T12:04:00.000Z", "2026-09-02T12:05:48.000Z", 108)],
      }),
    ],
    report([
      { file: "a.spec.ts", status: "expected", startTime: "2026-09-02T12:00:00.000Z" },
      { file: "a.spec.ts", status: "unexpected", startTime: "2026-09-02T12:04:30.000Z" },
    ]),
    1,
  );
  assert.deepEqual(block.shards[0], {
    shard: "1",
    measured: true,
    outages: 2,
    down_seconds: 196,
    span_seconds: 928.7,
    down_pct: 21.1,
    failed_probes: 53,
    blips: 4,
    attempts: 2,
    failing: 1,
    collateral: 1,
    totals: { passed: 1, failed: 1, flaky: 0, skipped: 0 },
  });
});

test("a file listed twice for one shard is counted once", () => {
  // `a.spec.ts` and `./a.spec.ts` are both accepted spellings of one file. A
  // duplicate inflates that shard's totals, and `unassigned` can only ever
  // detect the UNDER-count — so the sum-to-run-totals invariant would break
  // silently, in the direction nothing checks.
  const block = buildBackendBlock(
    [summary(1, ["a.spec.ts", "./a.spec.ts"])],
    report([{ file: "a.spec.ts", status: "expected" }]),
    1,
  );
  assert.deepEqual(block.shards[0].totals, { passed: 1, failed: 0, flaky: 0, skipped: 0 });
  assert.equal(block.unassigned, undefined);
});

test("two summaries with no shard label do not collapse onto each other", () => {
  // `watch-backend.mjs` writes `shard: ""` when WATCH_LABEL is unset. Joining by
  // label would hand the second shard the first one's file list and totals;
  // `attribute()` maps summaries positionally, so the index is the join.
  const block = buildBackendBlock(
    [summary("", ["a.spec.ts"]), summary("", ["c.spec.ts"])],
    report([
      { file: "a.spec.ts", status: "expected" },
      { file: "c.spec.ts", status: "unexpected" },
    ]),
    2,
  );
  assert.deepEqual(block.shards[0].totals, { passed: 1, failed: 0, flaky: 0, skipped: 0 });
  assert.deepEqual(block.shards[1].totals, { passed: 0, failed: 1, flaky: 0, skipped: 0 });
  assert.equal(block.unassigned, undefined, "neither shard's files may go unclaimed");
});

test("outages, unreachable seconds and blips aggregate across shards", () => {
  const block = buildBackendBlock(
    [
      summary(1, ["a.spec.ts"], {
        outageCount: 2,
        downSeconds: 196,
        downPct: 21.1,
        failedProbes: 53,
        ignoredBlips: 4,
        windows: [
          outage("2026-09-02T12:04:00.000Z", "2026-09-02T12:05:48.000Z", 108),
          outage("2026-09-02T12:06:00.000Z", "2026-09-02T12:07:28.000Z", 88),
        ],
      }),
      summary(2, ["c.spec.ts"], { outageCount: 1, downSeconds: 92, ignoredBlips: 3 }),
    ],
    report([
      { file: "a.spec.ts", status: "unexpected" },
      { file: "c.spec.ts", status: "expected" },
    ]),
    2,
  );
  assert.equal(block.wedged, true);
  assert.equal(block.outages_total, 3);
  assert.equal(block.down_seconds_total, 288);
  assert.equal(block.blips_total, 7, "sub-threshold probes are a floor on the down-share, so they ride along");
  assert.equal(block.shards[0].collateral, 1, "the failing attempt fell inside its own shard's window");
  assert.equal(block.shards[1].collateral, 0);
});

test("a failing attempt is attributed to ITS OWN shard's windows", () => {
  // The merged report has no shard column; blaming shard 1's outage for a shard-2
  // failure is the confusion the per-shard file list exists to prevent (#1030).
  const block = buildBackendBlock(
    [
      summary(1, ["a.spec.ts"], {
        outageCount: 1,
        downSeconds: 100,
        windows: [outage("2026-09-02T12:04:00.000Z", "2026-09-02T12:05:40.000Z", 100)],
      }),
      summary(2, ["c.spec.ts"]),
    ],
    report([
      { file: "a.spec.ts", status: "expected", startTime: "2026-09-02T12:04:30.000Z" },
      { file: "c.spec.ts", status: "unexpected", startTime: "2026-09-02T12:04:30.000Z" },
    ]),
    2,
  );
  assert.equal(block.collateral_attempts, 0, "shard 2 failed while shard 2's backend was up");
});

test("countByFile speaks Playwright's own statuses", () => {
  const counts = countByFile(
    report([
      { file: "a.spec.ts", status: "expected" },
      { file: "a.spec.ts", status: "skipped" },
    ]),
  );
  assert.deepEqual(counts.get("a.spec.ts"), { passed: 1, failed: 0, flaky: 0, skipped: 1 });
});

test("spec paths normalise across the two forms the shard list can carry", () => {
  // matrix.files may be rootDir-relative or repo-relative depending on how the
  // list was built; the merged report is rootDir-relative. Both must claim.
  const block = buildBackendBlock(
    [summary(1, ["tests/tests-automations/regression/smoke/a.spec.ts"])],
    report([{ file: "tests-automations/regression/smoke/a.spec.ts", status: "expected" }]),
    1,
  );
  assert.deepEqual(block.shards[0].totals.passed, 1);
  assert.equal(block.unassigned, undefined);
});

// --- through the appender, as the workflow drives it -------------------------

function append(env) {
  const dir = mkdtempSync(join(tmpdir(), "backend-history-"));
  const reportPath = join(dir, "results.json");
  const historyPath = join(dir, "history.jsonl");
  writeFileSync(
    reportPath,
    JSON.stringify(report([{ file: "a.spec.ts", status: "expected" }])),
  );
  execFileSync(process.execPath, [APPENDER], {
    env: {
      ...process.env,
      PLAYWRIGHT_JSON: reportPath,
      HISTORY_FILE: historyPath,
      WORKFLOW: "unit",
      GITHUB_RUN_ID: "1",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      LANGFLOW_IMAGE: "img:tag",
      ...env(dir),
    },
    encoding: "utf8",
  });
  return JSON.parse(readFileSync(historyPath, "utf8").trim());
}

test("a lane that sets no LIVENESS_DIR writes the same line it always did", () => {
  // weekly-stable.yml and every local run share this appender. The block must be
  // an addition to the daily, not a change to them.
  const entry = append(() => ({ LIVENESS_DIR: "", SHARD_TOTAL: "" }));
  assert.equal("backend" in entry, false);
});

test("a LIVENESS_DIR pointing nowhere writes no block and does not fail the append", () => {
  const entry = append((dir) => ({ LIVENESS_DIR: join(dir, "absent"), SHARD_TOTAL: "4" }));
  assert.equal("backend" in entry, false);
  assert.equal(entry.totals.passed, 1, "the history line itself still lands");
});

test("the daily's nested artifact layout is read through, one summary per shard", () => {
  // download-artifact without merge-multiple nests each `liveness-N` in its own
  // directory, and every shard names its file `backend-liveness.json`.
  const entry = append((dir) => {
    const live = join(dir, "all-liveness");
    for (const shard of ["1", "2"]) {
      mkdirSync(join(live, `liveness-${shard}`), { recursive: true });
      writeFileSync(
        join(live, `liveness-${shard}`, "backend-liveness.json"),
        JSON.stringify(summary(shard, shard === "1" ? ["a.spec.ts"] : [], { outageCount: Number(shard) - 1, downSeconds: shard === "2" ? 92 : 0 })),
      );
      // The raw probe log rides in the same artifact and must not be read as a summary.
      writeFileSync(join(live, `liveness-${shard}`, "backend-liveness.jsonl"), '{"t":"x","ok":true}\n');
    }
    return { LIVENESS_DIR: live, SHARD_TOTAL: "2" };
  });
  assert.equal(entry.backend.shards_reported, 2);
  assert.equal(entry.backend.shards_measured, 2);
  assert.equal(entry.backend.outages_total, 1);
  assert.equal(entry.backend.down_seconds_total, 92);
  assert.deepEqual(entry.backend.shards[0].totals, { passed: 1, failed: 0, flaky: 0, skipped: 0 });
});

test("a hostile LIVENESS_DIR loses the block, never the history line", () => {
  const entry = append((dir) => {
    const live = join(dir, "hostile");
    mkdirSync(live, { recursive: true });
    // A `.json` that is not JSON, and one that parses to something that is not a
    // summary at all. Both are states an interrupted upload can leave behind.
    writeFileSync(join(live, "truncated.json"), '{"shard": "1", "files": [');
    writeFileSync(join(live, "notasummary.json"), "42");
    return { LIVENESS_DIR: live, SHARD_TOTAL: "4" };
  });
  assert.equal(entry.totals.passed, 1, "the run history is written regardless");
});

// --- the one thing no behavioural test can reach -----------------------------

test("the appender does not statically import the liveness block builder", () => {
  // An ABSENCE, not a spelling. A static import runs the module body — and the
  // body of `report-backend-outages.mjs`, which it pulls in — before a single
  // line of the appender executes, so a top-level throw anywhere in that chain
  // would abort the append before any line existed, on EVERY lane: the weekly
  // one, and every local run that wants nothing to do with this feature.
  // Measured before the import was made dynamic: a module-scope throw gave
  // exit=1 and no history file at all. No behavioural test can reach this
  // without poisoning the real module on disk.
  const appender = readFileSync(APPENDER, "utf8");
  assert.equal(
    /^\s*import\s[^\n]*backend-history\.mjs/m.test(appender),
    false,
    "the block builder must be imported inside the try that guards it",
  );
  assert.ok(
    /await import\(["'\.\/]*lib\/backend-history\.mjs["']\)/.test(appender),
    "…and it must still be imported at all",
  );
});


test("the daily's history step reads the same liveness directory the reporter does", () => {
  // Structural, and deliberately narrow. It cannot tell whether the block is
  // built correctly — the tests above do that — but the row and the umbrella
  // section are supposed to describe the SAME run with the same numbers, and
  // that guarantee is one YAML value on each of two steps. Nothing else in the
  // repo would notice them drifting apart.
  const wf = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/daily-stable.yml", import.meta.url)),
    "utf8",
  );
  const dirs = [...wf.matchAll(/^\s*LIVENESS_DIR:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.equal(dirs.length, 2, "the outage reporter and the history append, and nothing else");
  assert.equal(dirs[0], dirs[1], "a row built from a different directory is a row about a different run");
});
