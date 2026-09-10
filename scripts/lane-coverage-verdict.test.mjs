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
  parseArgs,
  renderSummary,
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
  assert.throws(() => parseArgs(["--fail-on-uncovered"]), /unknown flag/);
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

test("--fail-closed exits 1 on `uncovered` and 0 on `degraded`", () => {
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
