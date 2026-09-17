// Unit tests for the merge-side liveness reporter (issue #1030).
// Run with: node --test scripts/report-backend-outages.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MD_DELIMITER,
  attribute,
  collateralPayload,
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

// ─── Collateral attempt IDENTITIES, the exemption's corroboration (#1589) ────
//
// The count `collateral_attempts` was enough for a summary line, but the
// `@stable` exemption has to ask a per-attempt question: "did THIS attempt of
// THIS test overlap a measured outage on ITS OWN shard". Only this module can
// answer it — the merged report never says which shard a test ran on, while a
// shard summary's `files` list does.

test("attribute carries the identity of every collateral attempt, not just its count", () => {
  const agg = attribute([shard3, shard4], collectAttempts(report));
  const s3 = agg.shards.find((s) => s.shard === "3");
  assert.equal(s3.collateralIds.length, s3.collateral);
  for (const id of s3.collateralIds) {
    assert.equal(id.file, FILE_A);
    assert.equal(typeof id.title, "string");
    assert.equal(typeof id.retry, "number");
  }
  // The retries are distinguished: the exemption keys on (spec, title, retry),
  // so collapsing two attempts of one test into one row would let an outage
  // during attempt 0 corroborate attempt 1.
  assert.deepEqual(
    [...new Set(s3.collateralIds.map((i) => i.retry))].sort(),
    [0, 1],
  );
  const s4 = agg.shards.find((s) => s.shard === "4");
  assert.deepEqual(s4.collateralIds, [], "shard 4 had no outage to be collateral of");
});

test("collateralPayload carries `measured` so an empty list is readable", () => {
  // #1012: "the recorder ran and nothing overlapped" is evidence; "no shard
  // produced probes" is its absence. An empty `attempts` array alone cannot
  // tell the consumer which one it is looking at.
  const measuredButClean = collateralPayload(attribute([shard4], collectAttempts(report)));
  assert.equal(measuredButClean.measured, true);
  assert.deepEqual(measuredButClean.attempts, []);

  const unmeasured = collateralPayload(attribute([], []));
  assert.equal(unmeasured.measured, false);
  assert.deepEqual(unmeasured.attempts, []);
});

test("collateralPayload dedups an attempt claimed by two shard summaries", () => {
  // A re-run shard can upload a second summary listing the same files; the
  // exemption only needs to know the attempt was corroborated once.
  const twice = collateralPayload(
    attribute([shard3, { ...shard3, shard: "3-rerun" }], collectAttempts(report)),
  );
  const keys = twice.attempts.map((a) => `${a.file}|${a.title}|${a.retry}`);
  assert.deepEqual(keys, [...new Set(keys)]);
});

test("the CLI writes the corroboration file only when asked, and says what it wrote", () => {
  const dir = makeTempDir("liveness-report-");
  const liveness = join(dir, "all-liveness");
  mkdirSync(join(liveness, "liveness-3"), { recursive: true });
  writeFileSync(join(liveness, "liveness-3", "backend-liveness.json"), JSON.stringify(shard3));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const attemptsPath = join(dir, "outage-attempts.json");

  const stdout = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      LIVENESS_DIR: liveness,
      PLAYWRIGHT_JSON: reportPath,
      OUTAGE_ATTEMPTS_OUT: attemptsPath,
    },
  });
  const payload = JSON.parse(readFileSync(attemptsPath, "utf8"));
  assert.equal(payload.measured, true);
  assert.equal(payload.wedged, true);
  assert.equal(payload.attempts.length, 2);
  assert.equal(payload.attempts[0].file, FILE_A);
  assert.match(stdout, /wrote 2 corroborated collateral attempt\(s\)/);
});

test("without OUTAGE_ATTEMPTS_OUT the CLI writes no corroboration file at all", () => {
  // The consumer is fail-closed on an absent file, so "not asked" must stay
  // distinguishable from "asked and empty" — writing one unconditionally would
  // make every caller look like it corroborated nothing.
  const dir = makeTempDir("liveness-report-");
  const liveness = join(dir, "all-liveness");
  mkdirSync(join(liveness, "liveness-3"), { recursive: true });
  writeFileSync(join(liveness, "liveness-3", "backend-liveness.json"), JSON.stringify(shard3));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(report));

  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, LIVENESS_DIR: liveness, PLAYWRIGHT_JSON: reportPath },
    stdio: "ignore",
  });
  assert.equal(existsSync(join(dir, "outage-attempts.json")), false);
});

test("collateralPayload says which SPECS were measured, not only whether any shard was", () => {
  // `measured` is run-level. A consumer printing a per-shard sentence from it
  // claims the recorder measured a shard that uploaded nothing, whenever some
  // other shard did — the #1012 conflation this field exists to end.
  const silentShard = { ...shard4, shard: "5", files: [FILE_B], measured: false };
  const payload = collateralPayload(
    attribute([shard3, silentShard], collectAttempts(report)),
  );
  assert.equal(payload.measured, true, "shard 3 did produce probes");
  assert.equal(payload.specMeasured[FILE_A], true);
  assert.equal(
    payload.specMeasured[FILE_B],
    false,
    "the shard that ran FILE_B produced none, and the payload has to say so",
  );
  assert.equal(payload.reportRead, true);
});

test("a spec claimed by two shards counts as measured if EITHER measured it", () => {
  const payload = collateralPayload(
    attribute(
      [
        { ...shard3, shard: "6", files: [FILE_A], measured: false },
        { ...shard3, files: [FILE_A] },
      ],
      collectAttempts(report),
    ),
  );
  assert.equal(payload.specMeasured[FILE_A], true);
});

test("collateralPayload records whether the merged report was readable at all", () => {
  // With no report there are zero attempts, so an empty list is the absence of
  // a check rather than its result.
  const payload = collateralPayload(attribute([shard3], collectAttempts(null)), {
    reportRead: false,
  });
  assert.equal(payload.reportRead, false);
  assert.deepEqual(payload.attempts, []);
});

test("each collateral attempt names the shard that measured it", () => {
  const payload = collateralPayload(attribute([shard3], collectAttempts(report)));
  assert.ok(payload.attempts.length > 0);
  for (const a of payload.attempts) assert.equal(a.shard, "3");
});

test("an unwritable corroboration path costs the exemption, never the liveness outputs", () => {
  // Ordering, pinned. The corroboration write is the newest thing in `main()`
  // and the only one that writes to a caller-supplied path; ahead of
  // `writeOutputs` a throw was swallowed by the top-level catch and took
  // `backend_wedged` and the umbrella's whole liveness section with it —
  // trading a report everyone reads for a file that fails closed anyway.
  const dir = makeTempDir("liveness-report-");
  const liveness = join(dir, "all-liveness");
  mkdirSync(liveness, { recursive: true });
  writeFileSync(join(liveness, "backend-liveness.json"), JSON.stringify(shard3));
  const outputPath = join(dir, "gh-output");
  writeFileSync(outputPath, "");

  const stdout = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      LIVENESS_DIR: liveness,
      PLAYWRIGHT_JSON: join(dir, "absent.json"),
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: "",
      // A directory that does not exist, so `writeFileSync` throws ENOENT.
      OUTAGE_ATTEMPTS_OUT: join(dir, "no", "such", "dir", "attempts.json"),
    },
  });

  assert.match(
    stdout,
    /::warning::.*could not write/,
    "a failed write says so instead of leaving a missing file (#1012)",
  );
  const outputs = readFileSync(outputPath, "utf8");
  assert.match(
    outputs,
    /^wedged=/m,
    "the liveness outputs survive a failed corroboration write",
  );
  assert.match(outputs, /^measured=/m);
});

// ─── How MUCH of the attempt sat in downtime (#1763) ─────────────────────────
//
// `collateral` counts attempts that TOUCH a window, and this file's own honesty
// note says why that cannot decide anything: on a shard measured 33-73 % down,
// touching one is close to a coin flip. The fraction is a different instrument,
// and it is the only evidence available for a failure whose error text will
// never classify as transport-level — an assertion about state that never
// arrived. Measured, never adjudicated: the threshold lives with the consumer.

test("attemptCoverage measures the fraction of the attempt span inside downtime", () => {
  const agg = attribute([shard3, shard4], collectAttempts(report));
  const s3 = agg.shards.find((s) => s.shard === "3");
  const byRetry = Object.fromEntries(s3.collateralIds.map((i) => [i.retry, i]));
  // 10:50:30 +40 s sits wholly inside 10:50:00 -> 10:52:00.
  assert.equal(byRetry[0].coverage, 1);
  assert.equal(byRetry[0].downSeconds, 40);
  assert.equal(byRetry[0].spanSeconds, 40);
  // 10:51:30 +40 s runs 10 s past the window's end.
  assert.equal(byRetry[1].coverage, 0.75);
  assert.equal(byRetry[1].downSeconds, 30);
  // The shard's own down-share travels with it: a coverage figure is only
  // readable against the base rate on the shard that produced it.
  assert.equal(byRetry[0].shardDownPct, 20);
});

test("attemptCoverage scores the blip #1763 says must not exempt anything", () => {
  // "a 6-second blip inside a 130-second attempt should not exempt anything".
  const blipShard = {
    ...shard3,
    windows: [{ startAt: "2026-07-29T10:50:30.000Z", endAt: "2026-07-29T10:50:36.000Z", seconds: 6, probes: 3 }],
  };
  const longAttempt = {
    suites: [
      {
        file: FILE_A,
        specs: [
          {
            title: "agent answers",
            file: FILE_A,
            tests: [{ results: [{ status: "failed", retry: 0, startTime: "2026-07-29T10:50:00.000Z", duration: 130000 }] }],
          },
        ],
      },
    ],
  };
  const agg = attribute([blipShard], collectAttempts(longAttempt));
  const [id] = agg.shards[0].collateralIds;
  assert.equal(agg.shards[0].collateral, 1, "it IS collateral by the boolean rule — that is the point");
  assert.equal(id.coverage, 0.046);
});

test("overlapping windows are unioned, so coverage can never exceed 1", () => {
  // A shard summary is not required to emit disjoint windows. Summing them would
  // let a doubly-covered attempt report 150 % of itself and clear any threshold.
  const doubled = {
    ...shard3,
    windows: [
      { startAt: "2026-07-29T10:50:00.000Z", endAt: "2026-07-29T10:52:00.000Z", seconds: 120, probes: 60 },
      { startAt: "2026-07-29T10:50:20.000Z", endAt: "2026-07-29T10:51:20.000Z", seconds: 60, probes: 30 },
    ],
  };
  const agg = attribute([doubled], collectAttempts(report));
  for (const id of agg.shards[0].collateralIds) {
    assert.ok(id.coverage <= 1, `coverage ${id.coverage} exceeded the attempt's own span`);
  }
});

test("collateralPayload carries the coverage through to the file the consumers read", () => {
  const payload = collateralPayload(attribute([shard3, shard4], collectAttempts(report)));
  assert.ok(payload.attempts.length > 0);
  for (const a of payload.attempts) {
    assert.equal(typeof a.coverage, "number");
    assert.equal(typeof a.downSeconds, "number");
    assert.equal(typeof a.shardDownPct, "number");
    assert.equal(a.shard, "3");
  }
});

test("a zero-duration failed attempt scores 0, never NaN", () => {
  // `span > 0 ? covered / span : 0` is the guard. Without it the ratio is 0/0,
  // which JSON.stringify writes as `null` and every downstream `Number(x) || 0`
  // silently reads as 0 — a documented behaviour held up by luck rather than by
  // the guard that claims it.
  const instant = {
    suites: [
      {
        file: FILE_A,
        specs: [
          {
            title: "agent answers",
            file: FILE_A,
            tests: [{ results: [{ status: "failed", retry: 0, startTime: "2026-07-29T10:51:00.000Z", duration: 0 }] }],
          },
        ],
      },
    ],
  };
  const agg = attribute([shard3], collectAttempts(instant));
  const [id] = agg.shards[0].collateralIds;
  assert.equal(agg.shards[0].collateral, 1, "it is inside the window, so the reporter does count it");
  assert.equal(id.coverage, 0);
  assert.ok(Number.isFinite(id.coverage), "coverage must be a number, not NaN");
});

test("collectAttempts records the parameterization variant from the enclosing describe", () => {
  // Without it, two providers of one spec are indistinguishable here: same file,
  // same spec.title, same line (#1763).
  const parameterized = {
    suites: [
      {
        title: "agent-a.spec.ts",
        file: FILE_A,
        suites: [
          {
            title: "Agent max iterations [google / gemini-3.5-flash]",
            file: FILE_A,
            specs: [
              {
                title: "agent answers",
                file: FILE_A,
                tests: [{ results: [{ status: "failed", retry: 0, startTime: "2026-07-29T10:50:30.000Z", duration: 40000 }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const [attempt] = collectAttempts(parameterized);
  assert.equal(attempt.param, "google / gemini-3.5-flash");
  const [id] = attribute([shard3], collectAttempts(parameterized)).shards[0].collateralIds;
  assert.equal(id.param, "google / gemini-3.5-flash");
  // And a spec with no parameterization carries null rather than the file name.
  assert.equal(collectAttempts(report)[0].param, null);
});

test("two variants that BOTH sat in an outage each get their own payload record", () => {
  // The dedupe key carries the variant too. Collapsing them would leave the
  // dropped variant looking unmeasured to the per-entry reader (#1763).
  const both = {
    suites: [
      {
        title: "agent-a.spec.ts",
        file: FILE_A,
        suites: ["openai / gpt-4o-mini", "google / gemini-3.5-flash"].map((label) => ({
          title: `Agent max iterations [${label}]`,
          file: FILE_A,
          specs: [
            {
              title: "agent answers",
              file: FILE_A,
              tests: [{ results: [{ status: "failed", retry: 0, startTime: "2026-07-29T10:50:30.000Z", duration: 40000 }] }],
            },
          ],
        })),
      },
    ],
  };
  const payload = collateralPayload(attribute([shard3], collectAttempts(both)));
  assert.equal(payload.attempts.length, 2);
  assert.deepEqual(
    payload.attempts.map((a) => a.param).sort(),
    ["google / gemini-3.5-flash", "openai / gpt-4o-mini"],
  );
});
