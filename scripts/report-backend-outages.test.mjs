// Unit tests for the merge-side liveness reporter (issue #1030).
// Run with: node --test scripts/report-backend-outages.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MD_DELIMITER,
  attribute,
  collectAttempts,
  normalizeSpecPath,
  outputLines,
  renderSection,
} from "./report-backend-outages.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./report-backend-outages.mjs", import.meta.url));

const FILE_A = "tests-automations/regression/core-functionality/llm-agents/agent-a.spec.ts";
const FILE_B = "tests-automations/regression/core-functionality/playground/playground-b.spec.ts";

// One outage on shard 3, none on shard 4 — the shape that proves attribution is
// per-shard and not global.
const shard3 = {
  shard: "3",
  files: [FILE_A],
  measured: true,
  probeCount: 300,
  spanSeconds: 600,
  downSeconds: 120,
  downPct: 20,
  outageCount: 1,
  windows: [
    {
      startAt: "2026-07-29T10:50:00.000Z",
      endAt: "2026-07-29T10:52:00.000Z",
      seconds: 120,
      probes: 60,
      openEnded: false,
      reason: "timeout>4000ms",
    },
  ],
};
const shard4 = {
  shard: "4",
  files: [FILE_B],
  measured: true,
  probeCount: 300,
  spanSeconds: 600,
  downSeconds: 0,
  downPct: 0,
  outageCount: 0,
  windows: [],
};

// Shard 3's spec fails twice inside the outage; shard 4's fails outside any
// window (and on a shard that never went down).
const report = {
  suites: [
    {
      file: FILE_A,
      specs: [
        {
          title: "agent answers",
          file: FILE_A,
          tests: [
            {
              results: [
                { status: "failed", retry: 0, startTime: "2026-07-29T10:50:30.000Z", duration: 40000 },
                { status: "failed", retry: 1, startTime: "2026-07-29T10:51:30.000Z", duration: 40000 },
              ],
            },
          ],
        },
      ],
      suites: [
        {
          file: FILE_A,
          specs: [
            {
              title: "nested passes",
              file: FILE_A,
              tests: [{ results: [{ status: "passed", retry: 0, startTime: "2026-07-29T10:45:00.000Z", duration: 5000 }] }],
            },
          ],
        },
      ],
    },
    {
      file: FILE_B,
      specs: [
        {
          title: "playground fails clean",
          file: FILE_B,
          tests: [{ results: [{ status: "failed", retry: 0, startTime: "2026-07-29T11:05:00.000Z", duration: 20000 }] }],
        },
      ],
    },
  ],
};

test("normalizeSpecPath reconciles the report's rootDir-relative paths with matrix.files", () => {
  assert.equal(normalizeSpecPath("tests/tests-automations/x.spec.ts"), "tests-automations/x.spec.ts");
  assert.equal(normalizeSpecPath("./tests/tests-automations/x.spec.ts"), "tests-automations/x.spec.ts");
  assert.equal(normalizeSpecPath("tests-automations/x.spec.ts"), "tests-automations/x.spec.ts");
  assert.equal(normalizeSpecPath(undefined), "");
});

test("collectAttempts flattens nested suites and keeps every retry", () => {
  const attempts = collectAttempts(report);
  assert.equal(attempts.length, 4);
  // Each retry counts: burning the retry budget IS the cost of a wedge.
  assert.equal(attempts.filter((a) => a.file === FILE_A && a.status === "failed").length, 2);
  assert.equal(attempts.filter((a) => a.status === "passed").length, 1);
  assert.equal(collectAttempts(null).length, 0);
});

test("collectAttempts drops attempts with no parseable startTime", () => {
  const attempts = collectAttempts({
    suites: [
      {
        file: FILE_A,
        specs: [{ title: "t", file: FILE_A, tests: [{ results: [{ status: "failed", retry: 0 }] }] }],
      },
    ],
  });
  assert.equal(attempts.length, 0);
});

test("attribute blames only the shard whose own backend went down", () => {
  const agg = attribute([shard3, shard4], collectAttempts(report));
  assert.equal(agg.measured, true);
  assert.equal(agg.wedged, true);
  assert.equal(agg.outagesTotal, 1);
  assert.equal(agg.downSecondsTotal, 120);

  const s3 = agg.shards.find((s) => s.shard === "3");
  assert.equal(s3.failing, 2);
  assert.equal(s3.collateral, 2);
  assert.deepEqual(s3.collateralFiles, ["agent-a.spec.ts"]);

  const s4 = agg.shards.find((s) => s.shard === "4");
  assert.equal(s4.failing, 1);
  // Shard 4's failure must never be attributed to shard 3's outage window.
  assert.equal(s4.collateral, 0);
  assert.equal(agg.collateralAttempts, 2);
});

test("attribute counts an attempt that merely overlaps the window edge", () => {
  const agg = attribute(
    [{ ...shard3, files: [FILE_A] }],
    collectAttempts({
      suites: [
        {
          file: FILE_A,
          specs: [
            {
              title: "started before the outage, still running when it hit",
              file: FILE_A,
              tests: [{ results: [{ status: "timedOut", retry: 0, startTime: "2026-07-29T10:49:30.000Z", duration: 60000 }] }],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(agg.shards[0].collateral, 1);
});

test("renderSection distinguishes NOT MEASURED from a clean backend", () => {
  const unmeasured = renderSection(attribute([], []));
  assert.match(unmeasured, /Not measured/);
  assert.doesNotMatch(unmeasured, /No mid-run outage/);

  const clean = renderSection(attribute([shard4], collectAttempts(report)));
  assert.match(clean, /No mid-run outage measured/);
  assert.match(clean, /answered \*\*every\*\* probe/);
});

// The clean verdict's failure mode: `outageCount` excludes runs below minProbes,
// so a shard that timed out on thirty isolated probes used to render as "answered
// every probe". Under a saturated single worker that is the expected shape, not a
// corner case.
test("renderSection refuses to clear a shard that had discarded blips", () => {
  const blippy = { ...shard4, failedProbes: 30, ignoredBlips: 30 };
  const md = renderSection(attribute([blippy], collectAttempts(report)));
  assert.match(md, /No mid-run outage measured/);
  assert.match(md, /30 single-probe failure\(s\) were discarded/);
  assert.match(md, /did \*\*not\*\* answer/);
  // It must NOT clear the run's failures on the strength of outageCount alone.
  assert.doesNotMatch(md, /answered \*\*every\*\* probe/);
  assert.doesNotMatch(md, /are not wedge collateral/);
});

test("renderSection counts a shard that uploaded nothing at all", () => {
  // Two of four shards reported; the other two never wrote a summary. "2 measured
  // shard(s)" alone would read as a complete picture.
  const md = renderSection(attribute([shard3, shard4], collectAttempts(report)), { shardTotal: 4 });
  assert.match(md, /2 shard\(s\) uploaded no liveness artifact at all/);
  assert.match(md, /\*\*unknown\*\*/);
  const clean = renderSection(attribute([shard4], collectAttempts(report)), { shardTotal: 4 });
  assert.match(clean, /1 of 4 measured shard\(s\)/);
  assert.match(clean, /3 shard\(s\) uploaded no liveness artifact/);
});

test("renderSection names the wedge, tabulates each shard, and prints the down-share caveat", () => {
  const md = renderSection(attribute([shard3, shard4], collectAttempts(report)));
  assert.match(md, /backend stopped answering mid-run/);
  // The measurement is taken through the specs' own forward, so the section must
  // not overclaim which component died.
  assert.match(md, /a dead socat would read the same way/);
  assert.match(md, /\| 3 \| 1 \| 2 min \(20%\)/);
  // The caveat is mandatory: at high down-share, overlap is chance, not proof.
  assert.match(md, /lead, not a/);
  assert.match(md, /10:50:00→10:52:00/);
  assert.match(md, /agent-a\.spec\.ts/);
});

test("renderSection truncates the window list out loud, never silently", () => {
  const many = {
    ...shard3,
    outageCount: 5,
    windows: Array.from({ length: 5 }, (_, i) => ({
      startAt: `2026-07-29T10:5${i}:00.000Z`,
      endAt: `2026-07-29T10:5${i}:30.000Z`,
      seconds: 30,
      probes: 15,
      openEnded: false,
      reason: "",
    })),
  };
  const md = renderSection(attribute([many], collectAttempts(report)), { maxWindows: 2 });
  assert.match(md, /and 3 more window\(s\)/);
});

test("renderSection flags a shard that recorded nothing as unknown, not clean", () => {
  const md = renderSection(attribute([shard3, { ...shard4, measured: false, probeCount: 0 }], collectAttempts(report)));
  assert.match(md, /Shard\(s\) 4 recorded no probes/);
  assert.match(md, /unknown\*\*, not clean/);
});

test("outputLines cannot be closed early by rendered markdown", () => {
  const agg = attribute([shard3], collectAttempts(report));
  const lines = outputLines(agg, `hello\n${MD_DELIMITER}\nmeasured=false\nworld`);
  // Exactly one terminator, and it is the last line.
  assert.equal(lines.filter((l) => l === MD_DELIMITER).length, 1);
  assert.equal(lines[lines.length - 1], MD_DELIMITER);
  const body = lines[lines.length - 2];
  assert.equal(body, "hello\nmeasured=false\nworld");
});

test("the CLI aggregates a directory of shard summaries and writes step outputs", () => {
  const dir = makeTempDir("liveness-report-");
  const liveness = join(dir, "all-liveness");
  // Nested one level, the way download-artifact lays artifacts out without
  // merge-multiple — the reader has to cope with both.
  mkdirSync(join(liveness, "liveness-3"), { recursive: true });
  mkdirSync(join(liveness, "liveness-4"), { recursive: true });
  writeFileSync(join(liveness, "liveness-3", "backend-liveness.json"), JSON.stringify(shard3));
  writeFileSync(join(liveness, "liveness-4", "backend-liveness.json"), JSON.stringify(shard4));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const outputPath = join(dir, "gh-output");
  writeFileSync(outputPath, "");
  const summaryPath = join(dir, "step-summary.md");
  writeFileSync(summaryPath, "");

  execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      LIVENESS_DIR: liveness,
      PLAYWRIGHT_JSON: reportPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    stdio: "ignore",
  });

  const outputs = readFileSync(outputPath, "utf8");
  assert.match(outputs, /^measured=true$/m);
  assert.match(outputs, /^wedged=true$/m);
  assert.match(outputs, /^shards_measured=2$/m);
  assert.match(outputs, /^outages_total=1$/m);
  assert.match(outputs, /^collateral_attempts=2$/m);
  assert.match(outputs, /^blips_total=0$/m);
  assert.match(outputs, new RegExp(`^summary_md<<${MD_DELIMITER}$`, "m"));
  assert.match(readFileSync(summaryPath, "utf8"), /Backend liveness/);
});

test("the CLI reports NOT MEASURED when no liveness artifact was downloaded", () => {
  const dir = makeTempDir("liveness-report-");
  const outputPath = join(dir, "gh-output");
  writeFileSync(outputPath, "");
  const stdout = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      LIVENESS_DIR: join(dir, "absent"),
      PLAYWRIGHT_JSON: join(dir, "absent.json"),
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: "",
    },
  });
  assert.match(stdout, /Not measured/);
  const outputs = readFileSync(outputPath, "utf8");
  assert.match(outputs, /^measured=false$/m);
  assert.match(outputs, /^wedged=false$/m);
});

// The load-bearing contract: the merge job's `Auto-remove @stable from hard failures`
// has no always(), so ANY red step before it silently skips the tag removal. A
// malformed summary must therefore degrade, never exit non-zero.
//
// `Create issue on failure` was in this list until #1176 gave it `always()` — the same
// trap cost the umbrella issue on a total shard abort, where a failed `Merge blob
// reports` skipped the step outright. The guarantee below is unchanged and still
// wanted: it is what keeps a diagnostic from reddening a step, and the auto-removal
// still depends on it.
test("the CLI exits 0 on a malformed summary instead of failing the merge job", () => {
  const dir = makeTempDir("liveness-report-");
  const liveness = join(dir, "all-liveness");
  mkdirSync(liveness, { recursive: true });
  // `files` as a string, not an array — enough to throw inside attribute().
  writeFileSync(join(liveness, "backend-liveness.json"), JSON.stringify({ ...shard3, files: FILE_A }));

  const stdout = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, LIVENESS_DIR: liveness, PLAYWRIGHT_JSON: join(dir, "absent.json") },
  });
  assert.match(stdout, /reporter error \(ignored\)/);
});
