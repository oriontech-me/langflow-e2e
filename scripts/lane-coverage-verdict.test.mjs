// The lane coverage verdict (issue #1456).
// Run with: npm run test:scripts
//
// These tests are over the VERDICT, deliberately, and not over the workflow text that
// consumes it — #1226's lesson: a guard that pins a spelling does not pin a behaviour.
// What must hold is that a run whose provider-health skips left nothing executed is
// classified `uncovered` and that a run which still executed something is not, and
// both are properties of this function, reachable without Actions.
//
// One test does run the real Playwright CLI. The whole design rests on an assumption
// about the installed version — that `test.skip(condition, reason)` reaches the JSON
// report as a `skip` annotation carrying that reason — and an assumption is not pinned
// by fixtures written from it. It needs no browser and no backend: the specs it
// generates either skip or assert on a number.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERED,
  DEGRADED,
  UNCOVERED,
  UNREADABLE,
  classifyRun,
  displaySafe,
  flattenSpecs,
  groupByProvider,
  laneCoverageVerdict,
  outputLines,
  providerPhrase,
  tableCell,
  parseArgs,
  renderSummary,
  shouldFail,
} from "./lane-coverage-verdict.mjs";
import { formatProviderInactiveReason } from "./lib/provider-health-reason.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "lane-coverage-verdict.mjs");
/** The local CLI entrypoint. NOT `npx`, which would download from the registry when
 *  the binary is missing instead of failing — a test must not reach the network. */
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js");
/**
 * Where the transient Playwright project below is created.
 *
 * INSIDE the repo, because `@playwright/test` resolves from the config file's own
 * directory and a project under `$TMPDIR` cannot see this repo's `node_modules`
 * (measured). NOT under `test-results/`, the obvious gitignored candidate: that is
 * Playwright's default output directory name and it excludes it from test discovery,
 * so a project placed there collects zero tests and the run dies with "No tests
 * found" (also measured). `.unit-tmp/` is gitignored for this, so a leaked directory
 * cannot dirty the tree — the one thing that would break the VM wrapper's
 * `git pull --ff-only`.
 */
const TMP_ROOT = path.join(REPO_ROOT, ".unit-tmp");

// --- fixture builders -------------------------------------------------------
// Shaped exactly like Playwright's JSON report (measured on 1.58.2 by the real-CLI
// test below): a file-level suite whose title IS its path, describes nested under it,
// and one `tests` entry per spec carrying the outcome and the annotations.

function skipped(title, reason) {
  return {
    title,
    tests: [
      {
        status: "skipped",
        expectedStatus: "skipped",
        annotations: reason === undefined ? [] : [{ type: "skip", description: reason }],
      },
    ],
  };
}

function executed(title, status = "expected") {
  return { title, tests: [{ status, expectedStatus: "passed", annotations: [] }] };
}

function report(file, specs, describes = []) {
  return {
    stats: {},
    suites: [
      {
        title: file,
        file,
        specs,
        suites: describes,
      },
    ],
  };
}

const OPENAI_DEAD = formatProviderInactiveReason("openai", "credit balance is too low");
const GOOGLE_DEAD = formatProviderInactiveReason("google", "monthly spending cap reached");

// --- the verdict ------------------------------------------------------------

test("a run with no provider-health skip is `covered`", () => {
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [executed("one"), executed("two")]),
  );
  assert.equal(result.verdict, COVERED);
  assert.equal(result.executed, 2);
  assert.equal(result.providerSkips.length, 0);
  // Nothing to say, and nothing rendered: a block on every green run trains the
  // reader to scroll past the one that matters.
  assert.equal(renderSummary(result), "");
});

test("skips for OTHER reasons leave the run `covered`", () => {
  // The skips a healthy run legitimately carries. Counting any of them here would
  // make the verdict fire on days nothing is wrong — and, when nothing else ran,
  // fail the lane for a `fixme`.
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [
      executed("one"),
      skipped("fixme", undefined),
      skipped("no key at all", "OPENAI_API_KEY required to run this test"),
      skipped("unresolvable model", "MODEL_NOT_AVAILABLE: gpt-4o-mini"),
      skipped("lane", "@destructive tests run in their own lane"),
    ]),
  );
  assert.equal(result.verdict, COVERED);
  assert.equal(result.skippedTotal, 4);
  assert.equal(result.providerSkips.length, 0);
});

test("a provider-health skip alongside real coverage is `degraded`, not a failure", () => {
  // #980's trade: the openai targets skipped, the other providers' ran. That is real
  // coverage — narrower and costlier, but real — so the lane keeps reporting success.
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [
      executed("anthropic target"),
      executed("google target"),
      skipped("openai target", OPENAI_DEAD),
    ]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  assert.equal(result.verdict, DEGRADED);
  assert.equal(result.executed, 2);
  assert.equal(result.providerSkips.length, 1);
  assert.deepEqual(
    result.providers.map((p) => p.provider),
    ["openai"],
  );
  assert.equal(result.laneProviderSkipped, true);
  assert.match(result.headline, /did not cover openai/);
});

test("the measured run — 3 skipped / 5 passed / 1 flaky — is `degraded`", () => {
  // Run 31698035402 (2026-08-13), the run this issue was written from. It reported
  // SUCCESS and stays reporting success; what changes is that it now SAYS what it
  // did not cover.
  const specs = [
    ...[1, 2, 3].map((n) => skipped(`openai target ${n}`, OPENAI_DEAD)),
    ...[1, 2, 3, 4, 5].map((n) => executed(`other target ${n}`)),
    executed("a flaky one", "flaky"),
  ];
  const result = laneCoverageVerdict(report("tests/agent-multi-tool-selection.spec.ts", specs), {
    lane: "pr-validation",
    laneProvider: "openai",
  });
  assert.equal(result.verdict, DEGRADED);
  assert.equal(result.executed, 6, "a flaky test executed — it produced a verdict");
  assert.equal(result.providerSkips.length, 3);
});

test("a provider-health skip with NOTHING executed is `uncovered`", () => {
  // The case the gate exists for: the PR's own diff got no verdict at all, and the
  // check would otherwise read exactly like a run that covered it.
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [
      skipped("openai target", OPENAI_DEAD),
      skipped("another openai target", OPENAI_DEAD),
    ]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  assert.equal(result.verdict, UNCOVERED);
  assert.equal(result.executed, 0);
  assert.match(result.headline, /NO verdict at all/);
  assert.match(result.headline, /not evidence that anything works/);
});

test("an all-skip run with no provider-health skip is NOT this guard's business", () => {
  // A selection that is entirely `@serving`, or entirely `fixme`, executes nothing
  // too — and failing there would redden PRs for a reason this gate is not about
  // (#1010 owns the lane-selector case). The trigger stays "a provider-health skip
  // happened", which is the narrowest condition that closes the measured gap.
  const result = laneCoverageVerdict(
    report("tests/serving.spec.ts", [skipped("serving", "serving identity is off on this instance")]),
  );
  assert.equal(result.verdict, COVERED);
  assert.equal(result.executed, 0);
});

test("a missing or unparseable report is `unreadable`, never `covered`", () => {
  for (const payload of [null, undefined, {}, { suites: null }, "not a report", 7]) {
    const result = laneCoverageVerdict(payload, { lane: "pr-validation", reportPath: "results.json" });
    assert.equal(result.verdict, UNREADABLE, `read as ${JSON.stringify(payload)}`);
    assert.match(result.headline, /could not look/);
  }
});

test("an empty report — zero tests, no skips — is `covered`, and says so", () => {
  // `--pass-with-no-tests` and a fully excluded selection both reach this. It is not
  // this guard's failure class: `check-run-integrity.mjs` owns the empty run.
  const result = laneCoverageVerdict(report("tests/a.spec.ts", []));
  assert.equal(result.verdict, COVERED);
  assert.equal(result.executed, 0);
});

// --- identity and grouping --------------------------------------------------

test("the test identity carries its describes, so three provider targets are told apart", () => {
  const built = report(
    "tests/agent.spec.ts",
    [],
    [
      {
        title: "Agent Multi-Tool Selection [openai / gpt-4o-mini]",
        file: "tests/agent.spec.ts",
        specs: [skipped("selects the right tool", OPENAI_DEAD)],
        suites: [],
      },
      {
        title: "Agent Multi-Tool Selection [google / gemini-2.5-flash]",
        file: "tests/agent.spec.ts",
        specs: [skipped("selects the right tool", GOOGLE_DEAD)],
        suites: [],
      },
    ],
  );
  const flat = flattenSpecs(built);
  assert.deepEqual(
    flat.map((s) => s.title),
    [
      "Agent Multi-Tool Selection [openai / gpt-4o-mini] › selects the right tool",
      "Agent Multi-Tool Selection [google / gemini-2.5-flash] › selects the right tool",
    ],
  );
  // The file-level suite titles itself with its path; that must not enter the chain.
  assert.ok(flat.every((s) => !s.title.startsWith("tests/")));
});

test("two dead providers are reported as two rows, in first-seen order", () => {
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [
      executed("anthropic target"),
      skipped("google target", GOOGLE_DEAD),
      skipped("openai target", OPENAI_DEAD),
      skipped("another google target", GOOGLE_DEAD),
    ]),
    { lane: "daily-stable" },
  );
  assert.equal(result.verdict, DEGRADED);
  assert.deepEqual(
    result.providers.map((p) => [p.provider, p.tests.length]),
    [
      ["google", 2],
      ["openai", 1],
    ],
  );
  // One reason per provider: every target of a provider quotes the same measurement.
  assert.deepEqual(result.providers[0].reasons, ["monthly spending cap reached"]);
});

test("two DIFFERENT reasons for one provider are both kept", () => {
  // Two records disagreeing is a signal of its own — collapsing it would hide which
  // measurement the skip was taken on.
  const grouped = groupByProvider([
    { provider: "openai", error: "credit balance is too low", title: "a", file: "f" },
    { provider: "openai", error: "collector never configured this provider", title: "b", file: "f" },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].reasons.length, 2);
});

test("the first parseable skip annotation decides, among several", () => {
  // `agent-multi-tool-selection.spec.ts` gates on provider health AND on the model
  // being resolvable, so a skipped test can carry more than one annotation.
  const built = report("tests/agent.spec.ts", [
    {
      title: "two gates",
      tests: [
        {
          status: "skipped",
          annotations: [
            { type: "skip", description: "MODEL_NOT_AVAILABLE: gpt-4o-mini" },
            { type: "skip", description: OPENAI_DEAD },
          ],
        },
      ],
    },
  ]);
  const { providerSkips } = classifyRun(built);
  assert.equal(providerSkips.length, 1);
  assert.equal(providerSkips[0].provider, "openai");
});

// --- the surfaces the workflows consume -------------------------------------

test("the summary block leads with what was NOT covered", () => {
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [
      executed("anthropic target"),
      skipped("openai target", OPENAI_DEAD),
    ]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  const summary = renderSummary(result);
  assert.match(summary, /^### /, "the block must start with a heading, not a table");
  assert.match(summary, /covered less than the check status shows/);
  assert.match(summary, /credit balance is too low/);
  assert.match(summary, /\(lane pin\)/);
  assert.match(summary, /openai target/, "the tests that lost coverage are named");
});

test("the uncovered summary says the run covered nothing", () => {
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [skipped("openai target", OPENAI_DEAD)]),
    { lane: "pr-validation" },
  );
  assert.match(renderSummary(result), /covered nothing/);
});

test("a long skip list is capped and says how many it dropped", () => {
  // #1012's rule: a cap is fine, a SILENT cap is not.
  const specs = Array.from({ length: 40 }, (_, i) => skipped(`target ${i}`, OPENAI_DEAD));
  const result = laneCoverageVerdict(report("tests/agent.spec.ts", [executed("one"), ...specs]));
  const summary = renderSummary(result);
  assert.match(summary, /and 15 more/);
  assert.ok(summary.includes("target 24"));
  assert.ok(!summary.includes("target 25"));
});

test("every step output is one line, whatever the provider said", () => {
  // The runner reads $GITHUB_OUTPUT line-wise, so a newline in a provider's error
  // body could forge a second `key=value` line — `verdict=covered` included.
  const nasty = formatProviderInactiveReason(
    "openai",
    "credit balance is too low\nverdict=covered\r\n[2mansi[22m",
  );
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [executed("one"), skipped("openai target", nasty)]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  const lines = outputLines(result);
  for (const line of lines) {
    assert.equal(line.split("\n").length, 1, `multi-line output: ${JSON.stringify(line)}`);
    assert.doesNotMatch(line, /\r/);
  }
  assert.equal(lines.filter((l) => l.startsWith("verdict=")).length, 1);
  assert.ok(lines.includes(`verdict=${DEGRADED}`));
  const safe = displaySafe(nasty);
  assert.ok(!safe.includes("\n") && !safe.includes("\r"), "the headline must be one line");
  assert.doesNotMatch(safe, /\u001b/, "ANSI codes render as literal noise in a summary");
});

test("the outputs carry the counts a workflow gates on", () => {
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [skipped("openai target", OPENAI_DEAD)]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  const lines = outputLines(result);
  assert.ok(lines.includes("verdict=uncovered"));
  assert.ok(lines.includes("executed=0"));
  assert.ok(lines.includes("provider_skips=1"));
  assert.ok(lines.includes("providers=openai"));
  assert.ok(lines.includes("lane_provider_skipped=true"));
});

test("--provider is reported, never gated on", () => {
  // The declined branch, pinned: a dead PIN with other coverage present stays
  // `degraded`. Failing here is a decision to make on evidence, and a test is what
  // makes it visible if someone makes it by accident.
  const result = laneCoverageVerdict(
    report("tests/agent.spec.ts", [executed("anthropic target"), skipped("openai target", OPENAI_DEAD)]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  assert.equal(result.laneProviderSkipped, true);
  assert.equal(result.verdict, DEGRADED);
});

test("parseArgs rejects an unknown flag rather than ignoring it", () => {
  assert.throws(() => parseArgs(["--no-such-flag"]), /unknown flag/);
  assert.throws(() => parseArgs(["--lane"]), /needs a value/);
  const args = parseArgs(["--lane", "daily-stable", "--provider", "google", "--fail-closed"]);
  assert.equal(args.lane, "daily-stable");
  assert.equal(args.provider, "google");
  assert.equal(args.failClosed, true);
});

// --- the CLI contract the workflows depend on -------------------------------

function runCli(reportBody, args = [], { dir } = {}) {
  const workdir = dir ?? makeTempDir("verdict-", { dir: TMP_ROOT });
  const reportPath = path.join(workdir, "results.json");
  if (reportBody !== null) fs.writeFileSync(reportPath, JSON.stringify(reportBody));
  const outputs = path.join(workdir, "outputs.txt");
  const summary = path.join(workdir, "summary.md");
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--report", reportPath, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    outputs: fs.existsSync(outputs) ? fs.readFileSync(outputs, "utf-8") : "",
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf-8") : "",
    workdir,
  };
}

test("--fail-closed exits 1 on `uncovered` with no account evidence, 0 on `degraded`", () => {
  // No `--providers` here, so the account axis is UNKNOWN and `shouldFail` is
  // fail-closed on it (#1800). The case where it is KNOWN-alive is the next test.
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const uncovered = runCli(report("tests/a.spec.ts", [skipped("openai", OPENAI_DEAD)]), [
    "--lane",
    "pr-validation",
    "--provider",
    "openai",
    "--fail-closed",
  ]);
  try {
    assert.equal(uncovered.status, 1);
    assert.match(uncovered.outputs, /verdict=uncovered/);
    assert.match(uncovered.stderr, /^::error::/m);
    assert.match(uncovered.summary, /covered nothing/);
  } finally {
    fs.rmSync(uncovered.workdir, { recursive: true, force: true });
  }

  const degraded = runCli(
    report("tests/a.spec.ts", [executed("one"), skipped("openai", OPENAI_DEAD)]),
    ["--lane", "pr-validation", "--provider", "openai", "--fail-closed"],
  );
  try {
    assert.equal(degraded.status, 0, "a degraded run must not fail the lane");
    assert.match(degraded.outputs, /verdict=degraded/);
    assert.match(degraded.stderr, /^::warning::/m);
  } finally {
    fs.rmSync(degraded.workdir, { recursive: true, force: true });
  }
});

test("without --fail-closed an uncovered run reports and exits 0", () => {
  // The shape the daily's merge job needs: the guard reports facts and the LAST step
  // decides, because failing mid-job would skip the `@stable` auto-removal and the
  // umbrella issue that carry no `always()` (#1176).
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const run = runCli(report("tests/a.spec.ts", [skipped("openai", OPENAI_DEAD)]), [
    "--lane",
    "daily-stable",
  ]);
  try {
    assert.equal(run.status, 0);
    assert.match(run.outputs, /verdict=uncovered/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
  }
});

test("a missing report file with --fail-closed exits 1", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const run = runCli(null, ["--lane", "pr-validation", "--fail-closed"]);
  try {
    assert.equal(run.status, 1);
    assert.match(run.outputs, /verdict=unreadable/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
  }
});

// --- the assumption the whole design rests on -------------------------------

test("a REAL Playwright run puts the skip reason where the verdict reads it", () => {
  // Everything above is written from a fixture shaped like Playwright's report. This
  // is the test that the shape is Playwright's — run through the installed CLI, so a
  // version bump that moves the annotation fails here instead of silently turning
  // every future provider outage back into a green.
  //
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("verdict-pw-", { dir: TMP_ROOT });
  try {
    fs.mkdirSync(path.join(dir, "specs"));
    fs.writeFileSync(
      path.join(dir, "pw.config.ts"),
      `import { defineConfig } from "@playwright/test";\n` +
        `export default defineConfig({ testDir: "./specs", reporter: [["json"]] });\n`,
    );
    // Both gate shapes the suite actually uses: `providerSkipGate` fires at describe
    // level, the parametrized resolvers fire in the test body.
    fs.writeFileSync(
      path.join(dir, "specs", "gate.spec.ts"),
      [
        `import { test, expect } from "@playwright/test";`,
        `test.describe("suite-level gate", () => {`,
        `  test.skip(true, ${JSON.stringify(OPENAI_DEAD)});`,
        `  test("openai target", async () => { expect(1).toBe(1); });`,
        `});`,
        `test("in-body gate", async () => {`,
        `  test.skip(true, ${JSON.stringify(GOOGLE_DEAD)});`,
        `  expect(1).toBe(1);`,
        `});`,
        `test("unrelated skip", async () => { test.skip(true, "no backend here"); });`,
        `test.fixme("fixme", async () => {});`,
        `test("runs", async () => { expect(1).toBe(1); });`,
        ``,
      ].join("\n"),
    );

    const reportPath = path.join(dir, "results.json");
    execFileSync(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", "-c", path.join(dir, "pw.config.ts"), "--reporter=json"],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    const result = laneCoverageVerdict(JSON.parse(fs.readFileSync(reportPath, "utf-8")), {
      lane: "pr-validation",
      laneProvider: "openai",
    });

    assert.equal(result.verdict, DEGRADED, "one test passed, so this is degraded");
    assert.equal(result.executed, 1);
    assert.equal(result.skippedTotal, 4, "two provider skips, one unrelated, one fixme");
    assert.deepEqual(
      result.providers.map((p) => p.provider).sort(),
      ["google", "openai"],
      "both gate shapes must be recognised",
    );
    assert.equal(result.laneProviderSkipped, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the skip reason survives `merge-reports`, which is what the daily reads", () => {
  // The test above proves the annotation on a DIRECT json run — the PR lane's
  // path. The daily never reads that: its shards write `blob` and the merge job
  // rebuilds the json with `merge-reports`, so the whole daily half of #1456 rests
  // on the annotation surviving that rebuild. Measured here rather than assumed,
  // because if it did not, the daily's verdict would be a permanent `covered` and
  // nothing would say so.
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("verdict-merge-", { dir: TMP_ROOT });
  try {
    fs.mkdirSync(path.join(dir, "specs"));
    fs.writeFileSync(
      path.join(dir, "pw.config.ts"),
      `import { defineConfig } from "@playwright/test";\n` +
        `export default defineConfig({ testDir: "./specs", reporter: [["blob", ` +
        `{ outputDir: ${JSON.stringify(path.join(dir, "blob"))} }]] });\n`,
    );
    fs.writeFileSync(
      path.join(dir, "specs", "gate.spec.ts"),
      [
        `import { test, expect } from "@playwright/test";`,
        `test.describe("suite-level gate", () => {`,
        `  test.skip(true, ${JSON.stringify(OPENAI_DEAD)});`,
        `  test("openai target", async () => { expect(1).toBe(1); });`,
        `});`,
        `test("runs", async () => { expect(1).toBe(1); });`,
        ``,
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", "-c", path.join(dir, "pw.config.ts")],
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "ignore", "pipe"] },
    );

    const merged = path.join(dir, "results.json");
    execFileSync(
      process.execPath,
      [PLAYWRIGHT_CLI, "merge-reports", "--reporter=json", path.join(dir, "blob")],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: merged },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    const result = laneCoverageVerdict(JSON.parse(fs.readFileSync(merged, "utf-8")), {
      lane: "daily-stable",
    });
    assert.equal(result.verdict, DEGRADED);
    assert.equal(result.executed, 1);
    assert.deepEqual(
      result.providers.map((p) => [p.provider, p.reasons[0]]),
      [["openai", "credit balance is too low"]],
      "the reason must survive the blob round trip, or the daily's verdict is a lie",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the reason is quoted, never diagnosed (issue #1801) --------------------
// The same `inactive` record is written for a key that was never imported as a
// Langflow global variable (`degradeProviders`, #1058). On that day the repair is
// the import, not the account — so no surface may assert a cause from the fact of a
// skip.

const NOT_IMPORTED = formatProviderInactiveReason(
  "openai",
  "OPENAI_API_KEY is set in the environment but was never imported as a Langflow " +
    "global variable — `Collect models` did not complete",
);

test("the headline quotes the measured reason instead of asserting a dead account", () => {
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [skipped("openai target", NOT_IMPORTED)]),
    { lane: "pr-validation", laneProvider: "openai" },
  );
  assert.equal(result.verdict, UNCOVERED, "coverage really is zero — the gate stays");
  assert.match(result.headline, /never imported/, "the measured reason must reach the line");
  assert.doesNotMatch(
    result.headline,
    /could not serve a call/,
    "that is a diagnosis, and it is the wrong one for a structural degrade (#1801)",
  );
});

test("a long reason is capped in the phrase, and the counts survive", () => {
  const long = formatProviderInactiveReason("openai", "x".repeat(400));
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [executed("one"), skipped("openai target", long)]),
    { lane: "pr-validation" },
  );
  assert.ok(result.headline.length < 320, `headline is ${result.headline.length} chars`);
  assert.match(result.headline, /1 of 2 test\(s\)/, "the counts must not be pushed off");
  assert.match(result.headline, /…/, "and the reason must say it was cut");
});

test("providerPhrase degrades to the bare name when nothing was recorded", () => {
  assert.equal(providerPhrase({ provider: "openai", reasons: [] }), "openai");
  assert.equal(providerPhrase({ provider: "openai" }), "openai");
});

test("a provider NAME carrying a newline cannot forge a step output", () => {
  // `parseProviderInactiveReason`'s capture is `([^"]+)`, which matches newlines.
  // Sanitising happens at the output boundary, deliberately NOT in the parser: a
  // name the parser rejected would stop being a provider-health skip at all, which
  // is the silent-green direction this mechanism exists to remove (#1801).
  const forged = 'Provider "openai\nverdict=covered" inactive — dead key';
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [executed("one"), skipped("target", forged)]),
    { lane: "pr-validation" },
  );
  assert.equal(result.providerSkips.length, 1, "it is still classified as a skip");
  const lines = outputLines(result);
  for (const line of lines) {
    assert.equal(line.split("\n").length, 1, `multi-line output: ${JSON.stringify(line)}`);
  }
  assert.equal(lines.filter((l) => l.startsWith("verdict=")).length, 1);
  assert.ok(lines.includes(`verdict=${DEGRADED}`), "and the verdict cannot be flipped");
});

test("a reason carrying a pipe cannot split the summary table", () => {
  const piped = formatProviderInactiveReason("google", "403 Forbidden | check your billing");
  const result = laneCoverageVerdict(
    report("tests/a.spec.ts", [executed("one"), skipped("target", piped)]),
    { lane: "daily-stable" },
  );
  const row = renderSummary(result)
    .split("\n")
    .find((l) => l.startsWith("| `google`"));
  assert.match(row, /403 Forbidden \\\| check your billing/);
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 3, "the row must keep its three columns");
  assert.equal(tableCell("a | b"), "a \\| b");
});

// --- the wiring, and what it cannot prove -----------------------------------
//
// Everything above pins the verdict itself, which is the part #1456 asks to be
// covered "by a unit test over the verdict, not by a regex over the workflow text".
// These last tests ARE regexes over the workflow text, and they are here for the
// half that no behavioural test can reach: whether the lanes still call the script
// at all, and whether the PR lane still writes the report it reads. #1176 is the
// precedent — a step whose `if:` silently never fired, with every test green — and
// #1159 is the other half: a lane can be rewired with every check passing.
//
// What they prove: the call sites exist, with the flags that carry the decision.
// What they cannot prove: that the step RUNS in a real job, that the report lands
// where it is read, or that the gate expression evaluates as intended. The first CI
// run on this branch is the only thing that proves those, which is stated in the PR
// rather than implied here.

const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");
const readWorkflow = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf-8");

test("the PR lane writes the JSON report the verdict reads", () => {
  // `--reporter=github` alone REPLACES the config's reporter list, which is why this
  // lane produced no machine-readable report at all before #1456. Both halves are
  // needed: the reporter, and the path it writes to.
  const yml = readWorkflow("pr-validation.yml");
  const runStep = yml.slice(yml.indexOf("- name: Run impacted specs"));
  const step = runStep.slice(0, runStep.indexOf("- name:", 10));
  assert.match(step, /--reporter=github,json/, "the json reporter is gone from the PR run");
  assert.match(step, /PLAYWRIGHT_JSON_OUTPUT_NAME:\s*results\.json/);
});

test("the PR lane runs the verdict fail-closed, on the same condition as the run", () => {
  const yml = readWorkflow("pr-validation.yml");
  const idx = yml.indexOf("- name: Coverage verdict");
  assert.ok(idx > -1, "pr-validation.yml no longer runs the coverage verdict");
  const step = yml.slice(idx, yml.indexOf("- name:", idx + 10));
  assert.match(step, /lane-coverage-verdict\.mjs/);
  assert.match(step, /--fail-closed/, "the PR lane's gate is the whole point (#1456)");
  assert.match(step, /--provider "\$PR_LANE_PROVIDER"/, "read the pin from one place (#1370)");
  // The destructive-only case skips the run step, so there would be no report.
  assert.match(step, /excluded_only != 'true'/);
});

test("every PR-lane step after the verdict survives its failure", () => {
  // The placement guarantee the step's own comment claims, pinned structurally
  // rather than reviewed: a failing verdict must not skip an upload, the token
  // summary, or the destructive lane. That is only true while every step after it
  // carries `always()` (or `failure()`), and nothing stops someone appending one
  // that does not.
  const yml = readWorkflow("pr-validation.yml");
  const after = yml.slice(yml.indexOf("- name: Coverage verdict"));
  const steps = after.split(/\n      - name: /).slice(1);
  assert.ok(steps.length >= 5, "the e2e job lost the steps that follow the verdict");
  for (const step of steps) {
    const title = step.split("\n")[0];
    assert.match(
      step,
      /if: (always\(\)|failure\(\))/,
      `"${title}" runs after the coverage verdict without always()/failure(), so a ` +
        `failing verdict would skip it`,
    );
  }
});

test("the daily runs the verdict report-only, and the last step gates on it", () => {
  const yml = readWorkflow("daily-stable.yml");
  const idx = yml.indexOf("- name: Guard — the run covered the providers");
  assert.ok(idx > -1, "daily-stable.yml no longer runs the coverage verdict");
  const step = yml.slice(idx, yml.indexOf("- name:", idx + 10));
  assert.match(step, /id: coverage/);
  assert.match(step, /if: always\(\)/);
  assert.match(step, /continue-on-error: true/);
  assert.doesNotMatch(
    step,
    /--fail-closed/,
    "failing HERE would skip the @stable auto-removal and the umbrella issue (#1176)",
  );

  // FAIL-CLOSED at the gate, on the guard's OWN decision since #1800: anything but
  // `fail_recommended=false` fails, including an absent output because the step was
  // skipped or crashed. A `== 'true'` test would go green on silence.
  const gate = yml.slice(yml.indexOf("- name: Fail scheduled run on an incomplete"));
  const gateStep = gate.slice(0, gate.indexOf("\n      - name:", 10) + 1 || undefined);
  assert.match(gateStep, /steps\.coverage\.outputs\.fail_recommended != 'false'/);
  assert.doesNotMatch(gateStep, /steps\.coverage\.outputs\.fail_recommended == 'true'/);
  // The policy must not be re-derived here: two spellings of one rule is how the
  // lanes drift apart (#1045), and the old one could not reach this lane's real case.
  assert.doesNotMatch(gateStep, /outputs\.verdict != 'covered'/);
});

// --- the account axis, and what it changes about failing (#1800) -------------

const ALIVE = { known: true, active: ["anthropic", "google"] };
const DRY = { known: true, active: [] };
const UNKNOWN_ACCOUNT = { known: false, active: [] };

/** The verdict for one report under one account state. */
const verdictWith = (reportBody, usability, options = {}) =>
  laneCoverageVerdict(reportBody, { lane: "pr-validation", usability, ...options });

// THE DEFECT #1800 was filed for, as the run that produces it. The PR lane's "run" is
// whatever the import graph selected — frequently ONE spec file — so a PR editing a
// single wholly-gated spec during a drain of that spec's provider executes nothing.
// Under the old rule that was `uncovered` and `--fail-closed` blocked the merge, for
// an outage its author cannot fix. TWELVE specs reach this today — eight on openai,
// two on google, two on anthropic, none on a pair; `chatInputOutputUser-shard-2`
// below is one of them. The count is derived in `lib/provider-usability.mjs`, which
// also records the two figures this comment used to carry (two, then thirteen).
test("a one-spec selection wholly skipped does NOT fail while the account is alive", () => {
  const result = verdictWith(
    report("tests/chatInputOutputUser-shard-2.spec.ts", [skipped("agent", OPENAI_DEAD)]),
    ALIVE,
  );

  // The verdict is unchanged — the run really did produce no evidence — and that is
  // exactly why the two questions are separate.
  assert.equal(result.verdict, UNCOVERED);
  assert.equal(result.account, "alive");
  assert.equal(shouldFail(result), false);
  assert.match(result.headline, /anthropic, google were still usable/);
});

// The other half: the same shape with nothing usable stays failing, because a re-run
// cannot help until someone acts.
test("the same run with a DRY account fails", () => {
  const result = verdictWith(
    report("tests/chatInputOutputUser-shard-2.spec.ts", [skipped("agent", OPENAI_DEAD)]),
    DRY,
  );
  assert.equal(result.verdict, UNCOVERED);
  assert.equal(result.account, "dry");
  assert.equal(shouldFail(result), true);
  assert.match(result.headline, /No provider was RECORDED usable/);
});

// Fail-closed on the unknown is preserved: `uncovered` is already a strong signal, and
// "nothing ran and nothing says a provider was reachable" must not go green.
test("an uncovered run with no account evidence still fails", () => {
  const result = verdictWith(
    report("tests/a.spec.ts", [skipped("agent", OPENAI_DEAD)]),
    UNKNOWN_ACCOUNT,
  );
  assert.equal(shouldFail(result), true);
  assert.match(result.headline, /UNKNOWN/);
});

// What this WIDENS, and the reason the daily half of #1456 was decorative: a full
// `@stable` run always executes hundreds of non-LLM tests, so `executed === 0` never
// held there and the daily's gate could not fire at all. A dry account can.
test("a degraded run on a dry account fails — the case the daily can actually reach", () => {
  const result = verdictWith(
    report("tests/a.spec.ts", [
      executed("one"),
      executed("two"),
      skipped("agent", OPENAI_DEAD),
    ]),
    DRY,
  );
  assert.equal(result.verdict, DEGRADED);
  assert.equal(shouldFail(result), true);
});

test("a degraded run on a live account still does not fail", () => {
  const result = verdictWith(
    report("tests/a.spec.ts", [executed("one"), skipped("agent", OPENAI_DEAD)]),
    ALIVE,
  );
  assert.equal(shouldFail(result), false);
});

// A dry account with nothing to lose is not a failure: no spec asked for a provider,
// so no coverage went missing. Without this clause every LLM-free PR would go red on
// the day an account drained.
test("a dry account with no provider-health skip does not fail", () => {
  const result = verdictWith(report("tests/a.spec.ts", [executed("one")]), DRY);
  assert.equal(result.verdict, COVERED);
  assert.equal(shouldFail(result), false);
});

test("an unreadable report fails whatever the account says", () => {
  for (const usability of [ALIVE, DRY, UNKNOWN_ACCOUNT]) {
    const result = verdictWith(null, usability);
    assert.equal(result.verdict, UNREADABLE);
    assert.equal(shouldFail(result), true);
  }
});

test("the summary states the account, so the colour is not the only clue", () => {
  const alive = renderSummary(
    verdictWith(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), ALIVE),
  );
  assert.match(alive, /Still usable/);
  assert.match(alive, /anthropic, google/);

  const dry = renderSummary(
    verdictWith(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), DRY),
  );
  assert.match(dry, /No provider was recorded usable/);
  assert.match(dry, /re-running\s+changes nothing/);
  // It must not assert HOW the record got there: `globalSetup`'s credential
  // degradation (#1058) writes the same `inactive` records the sweep does, so "the
  // account is drained" is a cause this cannot observe.
  assert.match(dry, /globalSetup/);

  const unknown = renderSummary(
    verdictWith(
      report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]),
      UNKNOWN_ACCOUNT,
    ),
  );
  assert.match(unknown, /UNKNOWN/);
});

test("the outputs carry the account and the decision, not just the verdict", () => {
  const lines = outputLines(
    verdictWith(report("tests/a.spec.ts", [skipped("a", OPENAI_DEAD)]), ALIVE),
  );
  assert.ok(lines.includes("account=alive"));
  assert.ok(lines.includes("usable_providers=anthropic,google"));
  assert.ok(lines.includes("fail_recommended=false"));
  // The verdict is still emitted unchanged — the workflows and the umbrella both read
  // it, and #1800 adds an axis rather than replacing one.
  assert.ok(lines.includes("verdict=uncovered"));
});

test("--providers is repeatable and every value is kept", () => {
  const args = parseArgs([
    "--providers",
    "a.json",
    "--providers",
    "b.json",
    "--lane",
    "daily-stable",
  ]);
  assert.deepEqual(args.providers, ["a.json", "b.json"]);
  // Not defaulted: a caller that passes none gets UNKNOWN and says so, which is the
  // honest answer for a lane that never ran the sweep.
  assert.deepEqual(parseArgs([]).providers, []);
});

test("the CLI reads providers.json and lets a live account pass", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-usability-");
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(
    providers,
    JSON.stringify([
      { provider: "openai", model: null, status: "inactive", error: "no credits" },
      { provider: "google", model: "gemini-2.5-flash", status: "active", error: null },
    ]),
  );

  const run = runCli(report("tests/a.spec.ts", [skipped("agent", OPENAI_DEAD)]), [
    "--lane",
    "pr-validation",
    "--provider",
    "openai",
    "--providers",
    providers,
    "--fail-closed",
  ]);
  try {
    assert.equal(run.status, 0, "a live account must not fail a narrow selection");
    assert.match(run.outputs, /verdict=uncovered/);
    assert.match(run.outputs, /account=alive/);
    assert.match(run.outputs, /fail_recommended=false/);
    // The annotation follows the DECISION: an ::error:: on a step that exits 0 is how
    // an annotation stops being read.
    assert.match(run.stderr, /^::warning::/m);
    assert.doesNotMatch(run.stderr, /^::error::/m);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI names a providers.json it could not read", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const run = runCli(
    report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]),
    ["--lane", "daily-stable", "--providers", "definitely/not/here.json"],
  );
  try {
    // Silently dropping it would leave the account UNKNOWN with no way to tell that
    // from "no file was asked for" (#1012).
    assert.match(run.stderr, /definitely\/not\/here\.json is missing or unreadable/);
    assert.match(run.outputs, /account=unknown/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
  }
});

test("both lanes feed the account axis, and the daily carries it across the shards", () => {
  const pr = readWorkflow("pr-validation.yml");
  const prIdx = pr.indexOf("- name: Coverage verdict");
  const prStep = pr.slice(prIdx, pr.indexOf("- name:", prIdx + 10));
  assert.match(
    prStep,
    /--providers tests\/helpers\/provider-setup\/data\/providers\.json/,
    "without it the PR lane's account axis is permanently UNKNOWN (#1800)",
  );

  const daily = readWorkflow("daily-stable.yml");
  // The shard writes it onto the artifact the merge job already downloads. Anchored to
  // a line START and scoped to the step, because the loose `assert.match(daily, …)`
  // this replaces passed with the two `cp` lines COMMENTED OUT, and passed again with
  // the SOURCE path replaced by one that does not exist — measured. At runtime both
  // are silent (`2>/dev/null || true`, then an empty directory reads as UNKNOWN), so
  // the daily half of the mechanism would have been inert with every test green: the
  // exact shape #1226 names, in the guard written to answer it.
  const collectIdx = daily.indexOf("- name: Stop and collect token consumption");
  assert.ok(collectIdx > 0, "the shard's collect step must exist to carry the file");
  const collectStep = daily.slice(collectIdx, daily.indexOf("\n      - name:", collectIdx + 10));
  assert.match(
    collectStep,
    /^ +cp tests\/helpers\/provider-setup\/data\/providers\.json \\$/m,
    "the source is collect-models' own PROVIDERS_PATH; a path that does not exist is silent",
  );
  assert.match(collectStep, /^ +"tokens\/providers-\$\{\{ matrix\.shard \}\}\.json"/m);
  // Order matters as much as presence: written before the artifact that carries it.
  assert.ok(
    daily.indexOf("- name: Upload token consumption") > collectIdx,
    "the copy must precede the upload that carries it",
  );
  // ...and the merge job hands the DIRECTORY to the script. Deliberately not a shell
  // loop building `--providers` args: a mutation that found the files and never
  // passed them survived every guard available in YAML (#1226). The globbing is
  // `readUsabilityDir`, whose behaviour these tests can actually assert.
  const idx = daily.indexOf("- name: Guard — the run covered the providers");
  const step = daily.slice(idx, daily.indexOf("- name:", idx + 10));
  assert.match(step, /--providers-dir all-tokens/);
  assert.doesNotMatch(step, /for f in/, "the argument list must not be built in YAML");
  // The daily keeps the pre-#1800 `uncovered` rule, which this lane declares rather
  // than the script guessing it from the account (#1800 review).
  //
  // Anchored to the COMMAND, not to the step text: the step's own comment explains the
  // flag, so a bare `/--fail-on-uncovered/` matched the prose and survived deleting the
  // flag from the invocation — the guard failing exactly the way #1226 says a guard
  // over workflow text fails, inside the test written to answer it.
  const invocation = step.slice(step.indexOf("run: |"));
  assert.match(invocation, /^ +--fail-on-uncovered$/m);
  assert.match(
    invocation,
    /^ +--expect-shards "\$\{\{ needs\.prep\.outputs\.shard_total \}\}" \\$/m,
  );
  assert.match(invocation, /^ +--providers-dir all-tokens \\$/m);
  // The PR lane must NOT ask for it: its run is an import-graph selection, and that
  // is the false red this whole change exists to remove.
  assert.doesNotMatch(prStep, /--fail-on-uncovered/);
});

test("the umbrella opens on the decision, not on a verdict this lane cannot reach", () => {
  const daily = readWorkflow("daily-stable.yml");
  const idx = daily.indexOf("- name: Create issue on failure");
  const step = daily.slice(idx, daily.indexOf("- name:", idx + 10));
  assert.match(step, /steps\.coverage\.outputs\.fail_recommended == 'true'/);
  assert.doesNotMatch(
    step,
    /steps\.coverage\.outputs\.verdict == 'uncovered'/,
    "`uncovered` needs ZERO executed tests, which a full @stable run never reaches",
  );
  // The account state reaches the issue body, which is what lets it pick the shape
  // that is true for a dry-but-degraded day.
  assert.match(step, /COVERAGE_ACCOUNT: \$\{\{ steps\.coverage\.outputs\.account \}\}/);
});

// Found while proving the fix on a real report: naming the raw active set produced
// "openai could not serve a call … openai was still usable" in one sentence. The
// account DECISION stays on the raw record (that is the account's state), but what the
// text NAMES is the set difference — a provider that skipped here is not evidence that
// anything was covered. The two sets can legitimately differ, since the daily unions
// four shards and one shard can reach a provider another could not.
test("a provider that skipped is never named as still usable", () => {
  const result = verdictWith(
    report("tests/a.spec.ts", [executed("one"), skipped("agent", OPENAI_DEAD)]),
    { known: true, active: ["openai", "google"] },
  );

  assert.equal(result.account, "alive", "the account decision stays on the raw record");
  assert.match(result.headline, /google was still usable/);
  assert.doesNotMatch(result.headline, /openai was still usable/);
  assert.doesNotMatch(result.headline, /openai, google were still usable/);
  assert.match(renderSummary(result), /Still usable: \*\*google\*\*/);
});

test("a sweep that disagrees with the run says so instead of contradicting itself", () => {
  // Only openai is active AND only openai skipped: the difference is empty, so there
  // is nothing honest to name. Saying it was "still usable" would deny the skip in the
  // line above it.
  const result = verdictWith(
    report("tests/a.spec.ts", [executed("one"), skipped("agent", OPENAI_DEAD)]),
    { known: true, active: ["openai"] },
  );

  assert.equal(result.account, "alive");
  assert.equal(shouldFail(result), false, "the account was up — this must not fail");
  assert.match(result.headline, /the sweep and the run disagree/);
  assert.doesNotMatch(result.headline, /openai was still usable/);
  assert.match(renderSummary(result), /disagree/);
});

// --- #1800 review: the wiring the first round left unasserted -----------------
//
// Every test below kills a mutation that survived the full lane. They are grouped
// because they share one finding: `shouldFail`'s decision matrix was well pinned and
// everything AROUND it — the flag that reaches it, the output that carries it, the
// heading that reports it — was not, so the mechanism could be disabled with the
// suite green.

test("the CLI actually uses --providers-dir, and the glob does not eat its neighbours", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-shards-");
  fs.writeFileSync(
    path.join(dir, "providers-1.json"),
    JSON.stringify([{ provider: "openai", model: null, status: "inactive", error: "no credits" }]),
  );
  fs.writeFileSync(
    path.join(dir, "providers-3.json"),
    JSON.stringify([{ provider: "google", model: "gemini", status: "active", error: null }]),
  );
  // The daily's tokens artifact carries three other file families in the same
  // directory; the reader must ignore them rather than fail on them.
  fs.writeFileSync(path.join(dir, "token-provider-1.txt"), "openai");
  fs.writeFileSync(path.join(dir, "token-probes-1.jsonl"), "{}\n");

  const run = runCli(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), [
    "--lane",
    "daily-stable",
    "--providers-dir",
    dir,
    "--expect-shards",
    "2",
  ]);
  try {
    // Dropping the `providersDir` branch in the CLI — reading `args.providers`, which
    // is empty — left every test green and made the daily's whole account axis
    // permanently UNKNOWN, silently. This is the assertion that sees it.
    assert.match(run.outputs, /account=alive/);
    assert.match(run.outputs, /usable_providers=google/);
    assert.match(run.stdout, /Provider health read from 2 shard file\(s\)/);
    assert.doesNotMatch(run.stderr, /expected shard provider file/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial shard download is named, because the union can only bias toward dry", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-partial-");
  fs.writeFileSync(
    path.join(dir, "providers-2.json"),
    JSON.stringify([{ provider: "openai", model: null, status: "inactive", error: "no credits" }]),
  );

  const run = runCli(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), [
    "--lane",
    "daily-stable",
    "--providers-dir",
    dir,
    "--expect-shards",
    "4",
    "--fail-on-uncovered",
  ]);
  try {
    assert.match(run.stderr, /read 1 of 4 expected shard provider file\(s\)/);
    // Reported, never gated on: the missing files are not a second way to fail a run.
    assert.match(run.outputs, /account=dry/);
    assert.match(run.outputs, /fail_recommended=true/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("`fail_recommended=true` is emitted, not just its `false` half", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-dry-out-");
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(
    providers,
    JSON.stringify([{ provider: "openai", model: null, status: "inactive", error: "no credits" }]),
  );

  const run = runCli(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), [
    "--lane",
    "daily-stable",
    "--providers",
    providers,
    "--fail-closed",
  ]);
  try {
    // Hardcoding this output to `false` survived every test in the first round, and
    // it is the SOLE input to both of the daily's new gates.
    assert.match(run.outputs, /fail_recommended=true/);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^::error::/m);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--fail-on-uncovered is what makes the daily fail an all-skip run on a live account", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-live-uncovered-");
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(
    providers,
    JSON.stringify([{ provider: "google", model: "gemini", status: "active", error: null }]),
  );
  const args = [
    "--lane",
    "daily-stable",
    "--providers",
    providers,
    "--fail-closed",
  ];
  const body = report("tests/a.spec.ts", [skipped("a", OPENAI_DEAD)]);

  const withoutFlag = runCli(body, args);
  const withFlag = runCli(body, [...args, "--fail-on-uncovered"]);
  try {
    // Same run, same account: only the lane's declared unit of work differs. Without
    // the flag this is a narrow selection (#980); with it, a suite that collected
    // nothing while a provider was reachable — which the account cannot explain.
    assert.equal(withoutFlag.status, 0);
    assert.match(withoutFlag.outputs, /fail_recommended=false/);
    assert.equal(withFlag.status, 1);
    assert.match(withFlag.outputs, /fail_recommended=true/);
  } finally {
    fs.rmSync(withoutFlag.workdir, { recursive: true, force: true });
    fs.rmSync(withFlag.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every new output line is sanitised, not just the headline", () => {
  // `$GITHUB_OUTPUT` is read LINE-WISE, so a newline inside a value forges a second
  // `key=value` line and the later one wins — `verdict=` included. `provider` comes
  // from an external file written by another process, which is the whole reason this
  // module reads it defensively.
  //
  // BOTH provider-carrying outputs, from both directions: `usable_providers` comes from
  // the account file, and `providers=` from the skip REASON, whose capture is
  // `([^"]+)` — which matches a newline. Feeding a clean value to the second one is how
  // the first draft of this test passed while leaving it forgeable.
  const lines = outputLines(
    verdictWith(
      report("tests/a.spec.ts", [
        skipped("a", 'Provider "openai\nverdict=covered" inactive — no credits'),
      ]),
      { known: true, active: ["google\nverdict=covered", "anthropic"] },
    ),
  );
  for (const line of lines) assert.doesNotMatch(line, /\n/);
  assert.ok(
    lines.filter((l) => l.startsWith("verdict=")).length === 1,
    "no output value may forge a second verdict= line",
  );

  // The SUMMARY is the other surface fed by that capture, and a newline there breaks
  // the markdown table it is interpolated into rather than forging a line — different
  // damage, same value, so it is asserted here beside its sibling.
  //
  // BOTH cells: the provider name comes through `([^"]+)` and the reason through
  // `([\s\S]*)` — the reason being a provider's raw error body, i.e. the cell that is
  // structurally multi-line and the one `displaySafe` was written for. A fixture that
  // forges only the name leaves the reason cell unpinned (measured).
  const summary = renderSummary(
    verdictWith(
      report("tests/a.spec.ts", [
        skipped("a", 'Provider "openai\nverdict=covered" inactive — no credits'),
        skipped("b", 'Provider "google" inactive — quota\n### forged heading'),
      ]),
      { known: true, active: [] },
    ),
  );
  for (const line of summary.split("\n")) {
    if (line.startsWith("|")) assert.match(line, /\|$/, "a table row must stay one line");
  }

  // The account clause is the last interpolation in the block, and its value comes
  // from `providers.json` rather than from a provider's error body — lower risk, same
  // surface.
  const aliveSummary = renderSummary(
    verdictWith(report("tests/a.spec.ts", [skipped("a", OPENAI_DEAD)]), {
      known: true,
      active: ["anthropic\n### forged heading", "google"],
    }),
  );
  assert.doesNotMatch(aliveSummary, /^### forged heading/m);
  assert.ok(
    lines.some((l) => l.startsWith("usable_providers=") && !l.includes("\n")),
    "usable_providers must not be able to forge a line",
  );
});

test("the two account inputs are refused together rather than one being dropped", () => {
  assert.throws(
    () => parseArgs(["--providers", "a.json", "--providers-dir", "d"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseArgs(["--expect-shards", "many"]), /non-negative integer/);
});

test("the heading follows the fail decision on BOTH branches, not only on `uncovered`", () => {
  const degradedRun = report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]);
  const uncoveredRun = report("tests/a.spec.ts", [skipped("a", OPENAI_DEAD)]);

  // degraded + dry: this FAILS, so a ⚠️ heading would sit over an `exit 1` and an
  // `::error::` — the review's own finding, inverted, on the case the daily reaches.
  const degradedDry = renderSummary(verdictWith(degradedRun, DRY));
  assert.match(degradedDry, /^### ❌ Provider-health skip/m);
  assert.doesNotMatch(degradedDry, /covered less than the check status shows/);

  // degraded + alive: green, so the heading stays a warning.
  assert.match(
    renderSummary(verdictWith(degradedRun, ALIVE)),
    /^### ⚠️ Provider-health skip — this run covered less than the check status shows/m,
  );

  // uncovered + alive: green here (an import-graph selection), and the body must not
  // call the run "narrower than the check status shows" — it produced no verdict.
  const uncoveredAlive = renderSummary(verdictWith(uncoveredRun, ALIVE));
  assert.match(uncoveredAlive, /^### ⚠️ This run covered nothing/m);
  assert.doesNotMatch(uncoveredAlive, /not blind/);
  // It used to assert "does not recover by re-running" here. That is a DIAGNOSIS, and
  // #1801's own input falsifies it — see the dedicated test below; what this case
  // still pins is that the line refuses the "narrower, not blind" framing.
  assert.match(uncoveredAlive, /still produced no verdict/);

  // ...and red once the LANE says covering nothing is a suite defect.
  assert.match(
    renderSummary(verdictWith(uncoveredRun, ALIVE, { failOnUncovered: true })),
    /^### ❌ This run covered nothing/m,
  );
});

test("the unread warning stays off an LLM-free run", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  // No provider-health skip: the account axis can decide nothing, so naming an absent
  // providers.json is #1252's `mode=count` in the lane a human actually reads.
  const run = runCli(report("tests/a.spec.ts", [executed("one")]), [
    "--lane",
    "pr-validation",
    "--providers",
    "definitely/not/here.json",
  ]);
  try {
    assert.doesNotMatch(run.stderr, /missing or unreadable/);
    assert.match(run.outputs, /verdict=covered/);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
  }
});

test("drift is reported on a run with NO provider-health skip — the case it exists for", () => {
  // The hoist that took this warning out of the skip gate was itself unpinned: the
  // test below carries a provider-health skip, so it passed under both gatings while
  // the scenario the hoist exists for had no test at all. That scenario is this one —
  // a renamed `status` ALSO defeats `providerSkipGate`'s own `status === "inactive"`,
  // so nothing skips, the verdict is `covered`, and this warning is the only signal
  // that the account axis went unread.
  const dir = makeTempDir("coverage-drift-covered-");
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(
    providers,
    JSON.stringify([{ provider: "openai", model: "gpt", state: "active", error: null }]),
  );

  const run = runCli(report("tests/a.spec.ts", [executed("one")]), [
    "--lane",
    "pr-validation",
    "--providers",
    providers,
    // A second, ABSENT path on the SAME run: without it the "stays silent" assertion
    // below is vacuous, since `unread` is empty and the loop has nothing to iterate
    // whatever its gate says.
    "--providers",
    "definitely/not/here.json",
    "--fail-closed",
  ]);
  try {
    assert.match(run.outputs, /verdict=covered/);
    assert.match(run.stderr, /the producer's shape may have\s+drifted/);
    // ...while the absent one stays silent: #1252's noise argument covers a missing
    // optional input, never a shape that drifted.
    assert.doesNotMatch(run.stderr, /missing or unreadable/);
    assert.equal(run.status, 0);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a providers.json whose record shape drifted is UNKNOWN, never dry", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = makeTempDir("coverage-drift-");
  const providers = path.join(dir, "providers.json");
  // Two HEALTHY providers, under a renamed status field. Read as `dry` this fails the
  // daily and sends triage at the keys and the sweep — for producer drift. The two
  // producers keep this shape in sync BY HAND, so the drift is a live possibility.
  fs.writeFileSync(
    providers,
    JSON.stringify([
      { provider: "openai", model: "gpt", state: "active", error: null },
      { provider: "google", model: "g", state: "active", error: null },
    ]),
  );

  const run = runCli(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), [
    "--lane",
    "daily-stable",
    "--providers",
    providers,
    "--fail-closed",
  ]);
  try {
    assert.match(run.outputs, /account=unknown/);
    assert.match(run.stderr, /the producer's shape may have\s+drifted/);
    // `degraded` + unknown does not fail; only `uncovered` + unknown does.
    assert.match(run.outputs, /fail_recommended=false/);
    assert.equal(run.status, 0);
  } finally {
    fs.rmSync(run.workdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the daily's final gate, executed rather than spelled (#1800 review) ------
//
// Both #1800 edits to that step — reporting `unreadable` FIRST, and dropping the
// completeness claim from the `uncovered` message — were unpinned: mutating either
// left the whole lane green, because the only assertion that reads this step reads its
// `if:` expression. That is #1226's lesson in the guard written to answer #1226, so
// the block is EXTRACTED FROM THE YAML and run under `bash`, and the assertions are on
// what it prints.
//
// The extraction is deliberately brittle in the safe direction: if the step is renamed
// or its `run:` reshaped, the helper throws rather than silently asserting on nothing.
function runDailyGate(env) {
  const daily = readWorkflow("daily-stable.yml");
  const marker =
    "- name: Fail scheduled run on an incomplete, empty, partial, uncovered or under-listed report";
  const start = daily.indexOf(marker);
  assert.ok(start > 0, "the daily's final gate step must exist under its known name");
  const step = daily.slice(start, daily.indexOf("\n      - name:", start + 10));
  const runAt = step.indexOf("run: |");
  assert.ok(runAt > 0, "the gate must still be an inline shell block");
  const body = step
    .slice(step.indexOf("\n", runAt) + 1)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  assert.match(body, /^exit 1$/m, "the gate must still be unconditional-exit-1");

  const run = spawnSync("bash", ["-c", body], {
    encoding: "utf-8",
    // Only what the step declares; anything it reads and the workflow does not export
    // would otherwise be inherited from the developer's shell.
    env: {
      PATH: process.env.PATH,
      COMPLETE: "",
      RUN_EMPTY: "false",
      RUN_UNREADABLE: "false",
      RUN_PARTIAL: "false",
      RUN_ERRORS: "0",
      RUN_TESTS: "600",
      RUN_FIRST_ERROR: "",
      COVERAGE_VERDICT: "",
      COVERAGE_HEADLINE: "H",
      COVERAGE_FAIL: "false",
      COVERAGE_ACCOUNT: "unknown",
      // The listing-completeness axis (#1812). Defaulted to "the matrix contained
      // every declared spec file", so the cases below still model one cause at a
      // time — and so the exhaustiveness test keeps meaning what it says.
      LISTING_VERIFIED: "true",
      LISTING_MISSING: "[]",
      LISTING_UNEXPECTED: "[]",
      ...env,
    },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("the daily's final gate always names a cause, and never two that disagree", () => {
  // The reachable shapes, each with the message it must select.
  const cases = [
    [{ COMPLETE: "false" }, /Merge was incomplete/],
    [{ RUN_UNREADABLE: "true" }, /missing or unparseable/],
    [{ RUN_EMPTY: "true" }, /ZERO tests executed/],
    [{ RUN_PARTIAL: "true" }, /PARTIAL run/],
    [{ RUN_EMPTY: "" }, /reported nothing \(empty output is unset\)/],
    [
      { COVERAGE_VERDICT: "unreadable", COVERAGE_FAIL: "true", COVERAGE_ACCOUNT: "dry" },
      /could not read the merged report/,
    ],
    [
      { COVERAGE_VERDICT: "degraded", COVERAGE_ACCOUNT: "dry", COVERAGE_FAIL: "true" },
      // Scoped to the tests that PRODUCED A RESULT: this line can print under a
      // `PARTIAL` or incomplete report, which the branch above just called
      // under-counted, so an unscoped "every @stable test that needs one" speaks for
      // specs that never ran.
      /every @stable test that needs one AND produced a result was SKIPPED/,
    ],
    [
      { COVERAGE_VERDICT: "uncovered", COVERAGE_ACCOUNT: "alive", COVERAGE_FAIL: "true" },
      /ZERO verdicts about Langflow/,
    ],
    [{ COVERAGE_FAIL: "" }, /for fail_recommended/],
    // Listing completeness (#1812). Unlike the report axes above, the evidence comes
    // from `prep`: a spec file that never entered the matrix leaves no trace in a
    // report built from what ran.
    [{ LISTING_MISSING: '["lost.spec.ts"]' }, /were ABSENT from this run's listing/],
    [{ LISTING_VERIFIED: "false" }, /could not verify that its listing contained/],
    // Fail-CLOSED on an unset output, the same `!= 'true'` idiom the two guards above
    // use: an absent verdict means the derivation never ran, and that must not read
    // as agreement.
    [{ LISTING_VERIFIED: "" }, /could not verify that its listing contained/],
  ];
  for (const [env, expected] of cases) {
    const { status, out } = runDailyGate(env);
    assert.equal(status, 1, `the gate must fail: ${JSON.stringify(env)}`);
    assert.match(out, expected, `wrong message for ${JSON.stringify(env)}`);
  }

  // `unreadable` FIRST: it populates the account axis too, so the dry branch would
  // otherwise claim "every @stable test that needs one was SKIPPED" on a run with no
  // report to read at all.
  const unreadableAndDry = runDailyGate({
    COVERAGE_VERDICT: "unreadable",
    COVERAGE_ACCOUNT: "dry",
    COVERAGE_FAIL: "true",
  });
  // Matched against the SHIPPED wording: an earlier revision of this line still named
  // the pre-scoping sentence, which the workflow no longer contains anywhere — a guard
  // that cannot fail, for the ordering it exists to hold.
  assert.doesNotMatch(unreadableAndDry.out, /NO provider was recorded usable/);

  // And no coverage message may claim the report is complete on a run whose FIRST
  // message said it was not — the pair the review measured.
  //
  // The account matters here: the chain is unreadable → dry → uncovered, so an
  // `uncovered` verdict only REACHES its own branch on a live account. Asserting this
  // with `dry` set — as the first draft did — exercises the dry branch twice and lets
  // the completeness claim back into the uncovered message untouched (measured).
  for (const [verdict, account] of [
    ["uncovered", "alive"],
    ["degraded", "dry"],
  ]) {
    const { out } = runDailyGate({
      COMPLETE: "false",
      COVERAGE_VERDICT: verdict,
      COVERAGE_ACCOUNT: account,
      COVERAGE_FAIL: "true",
    });
    assert.match(out, /Merge was incomplete/);
    assert.match(
      out,
      verdict === "uncovered" ? /ZERO verdicts about Langflow/ : /NO provider was recorded usable/,
      "the case must reach the branch it claims to pin",
    );
    assert.doesNotMatch(out, /report is complete/, `${verdict} must not contradict the line above`);
  }
});

test("the daily's gate QUOTES what was recorded instead of asserting a cause", () => {
  // The gate's `uncovered` line is the third place #1801 had to change, and it is
  // spelled in the WORKFLOW, so no script test reaches it: reverting it to "a provider
  // could not serve a call" left the entire unit suite green (measured). The same
  // `inactive` record is written when a key was never imported as a Langflow global
  // variable (#1058), where the repair is the import and not the account.
  const { out } = runDailyGate({
    COVERAGE_VERDICT: "uncovered",
    COVERAGE_ACCOUNT: "alive",
    COVERAGE_FAIL: "true",
  });
  assert.match(out, /RECORDED INACTIVE/);
  assert.doesNotMatch(out, /could not serve a call/);
  // And it points at BOTH repairs the record cannot choose between, rather than one.
  assert.match(out, /never imported the key as a Langflow global variable/);
  assert.match(out, /drained account/);
});

test("the daily's final gate's branch set is exhaustive over the states that reach it", () => {
  // `exit 1` is unconditional inside this step, so a state that reaches it and prints
  // nothing would fail the day with no cause named — #1176 in the direction that costs
  // the triage. The branches are exhaustive today: `runguard.empty` is a stringified
  // boolean or `""` (all three print), and the coverage chain's last `elif` catches
  // everything that is not `false`. So the combination below is the one that names
  // nothing, and it is also one the step's `if:` cannot select.
  //
  // Asserted as the ABSENCE OF THE KNOWN MESSAGES rather than of `::error::` itself:
  // an earlier version forbade `::error::` outright, which made the test refuse the
  // belt-and-braces catch-all its own comment argued for — an anti-pin, measured.
  const { status, out } = runDailyGate({ COVERAGE_FAIL: "false", RUN_EMPTY: "false" });
  assert.equal(status, 1, "the step is a gate: reaching it fails the run");
  for (const claim of [
    /Merge was incomplete/,
    /missing or unparseable/,
    /ZERO tests executed/,
    /PARTIAL run/,
    /reported nothing/,
    /could not read the merged report/,
    /NO provider was recorded usable/,
    /ZERO verdicts about Langflow/,
    /for fail_recommended/,
    /were ABSENT from this run's listing/,
    /could not verify that its listing contained/,
  ]) {
    assert.doesNotMatch(out, claim, "no branch may claim a cause this state does not have");
  }
  // The allowlist alone would admit a NEW branch making some OTHER specific claim on
  // this state (measured: an `else` naming a drained account survives it). Anything
  // this state prints must therefore be the unclassified catch-all — which is what
  // keeps the door open for the belt-and-braces line while keeping the teeth.
  for (const line of out.split("\n").filter((l) => l.includes("::error::"))) {
    assert.match(line, /no branch named a cause/, `unexpected specific claim: ${line}`);
  }
});

test("the still-usable line makes no claim about what the fallback covered", () => {
  // Four rounds, four formulations, four defects — all in one clause that tried to
  // stop "Still usable: anthropic, google" reading as "so we are fine", and all of
  // them contradicted by the counter line two rows above them. It is gone; what this
  // pins is that it stays gone, in both arms, and that the sentence which does the
  // work is still there.
  //
  // The last formulation is the one worth naming, because it looked like pure data:
  // "every test that produced a result skipped on provider health" is false whenever
  // an ordinary `test.skip` or a `fixme` is in the report, and `UNCOVERED` is
  // `providerSkips > 0 && executed === 0` — it says nothing about the other skips.
  const arms = {
    degraded: renderSummary(
      verdictWith(report("tests/a.spec.ts", [executed("one"), skipped("a", OPENAI_DEAD)]), ALIVE),
    ),
    uncovered: renderSummary(
      verdictWith(report("tests/a.spec.ts", [skipped("a", OPENAI_DEAD)]), ALIVE),
    ),
  };
  for (const [arm, text] of Object.entries(arms)) {
    assert.match(text, /Still usable: \*\*anthropic, google\*\*/, `${arm}: the arm under test is the one with a fallback`);
    assert.doesNotMatch(text, /did not cover for it/, `${arm}: no claim about what the fallback covered`);
    assert.doesNotMatch(text, /hardcode/, `${arm}: no claim about why`);
    assert.doesNotMatch(text, /does not recover by re-running/, `${arm}: no claim about a re-run`);
  }
  // The sentences that carry the meaning are untouched.
  assert.match(arms.uncovered, /still produced no verdict/);
  assert.match(arms.degraded, /narrower than the check status shows, not blind/);
});

test("a MIXED-skip uncovered run is described by counts, not by a claim about them", () => {
  // `generalBugs-shard-3.spec.ts`'s shape today: one provider-gated test and one
  // permanent `test.skip`. The run is `uncovered` with 1 of 2 skips on provider
  // health, and the summary must not say otherwise.
  const mixed = renderSummary(
    verdictWith(
      report("tests/a.spec.ts", [skipped("gated", OPENAI_DEAD), skipped("quarantined", "no backend here")]),
      ALIVE,
    ),
  );
  assert.match(mixed, /provider health: \*\*1\*\*/);
  assert.match(mixed, /skipped in total: \*\*2\*\*/);
  assert.doesNotMatch(mixed, /every test that produced a result/);
});

test("the run summary does not decide whether a re-run helps", () => {
  // The THIRD surface. `renderSummary`'s `alive` arm arrived from #1800 after #1801
  // was filed, so it kept the assertion the headline and the umbrella had lost: "a
  // spec hardcoded to the dead provider does not recover by re-running". On #1801's
  // own motivating input both halves are wrong — a structural degrade only degrades
  // the providers whose keys are missing, so the account reads `alive` with a live
  // key, and a re-run whose `Collect models` completes IS the repair.
  // A structural degrade only degrades the providers whose keys are missing
  // (`providersForEnvKeys`), so the OTHER providers stay active and the account reads
  // `alive` — which is precisely why this surface is reachable on that input.
  const result = verdictWith(
    report("tests/a.spec.ts", [skipped("openai target", NOT_IMPORTED)]),
    ALIVE,
  );
  assert.equal(result.verdict, UNCOVERED);
  const summary = renderSummary(result);
  assert.match(summary, /Still usable: \*\*anthropic, google\*\*/, "the account fact still lands");
  assert.doesNotMatch(summary, /the dead provider/, "a live key is not a dead provider (#1801)");
  assert.doesNotMatch(
    summary,
    /does not recover by re-running/,
    "whether a re-run helps depends on the reason, which this surface has already quoted",
  );
  assert.match(summary, /depends on the reason above/);
});
