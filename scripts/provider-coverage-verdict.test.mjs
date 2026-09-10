import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_INACTIVE_SKIP,
  collectTests,
  exitCodeFor,
  providerCoverageVerdict,
  readReport,
  renderVerdict,
} from "./provider-coverage-verdict.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The exact string `inactiveReason()` produces, and the exact shape Playwright 1.58
// records it in — both measured against a real run (`test.skip(cond, reason)` in the
// body and in a `beforeEach`, then `merge-reports --reporter=json`), so these fixtures
// are the transport, not a guess about it.
const INACTIVE = (provider, detail) => `Provider "${provider}" inactive — ${detail}`;
const DRAINED = INACTIVE("openai", "You have no credits remaining.");

/** One `specs[]` entry with N tests. */
function spec(file, title, tests) {
  return {
    file,
    title,
    tests: tests.map(({ status, skips = [] }) => ({
      status,
      annotations: skips.map((description) => ({ type: "skip", description })),
    })),
  };
}

/** A report whose file-level suites carry the given specs. */
function report(...specs) {
  return {
    stats: {},
    suites: specs.map((s) => ({ title: s.file, file: s.file, specs: [s], suites: [] })),
  };
}

test("a run with no provider-health skip is covered, and says nothing", () => {
  const verdict = providerCoverageVerdict(
    report(spec("a.spec.ts", "t1", [{ status: "expected" }])),
  );
  assert.equal(verdict.level, "covered");
  assert.equal(verdict.unverified.length, 0);
  assert.equal(renderVerdict(verdict).markdown, "");
  assert.equal(renderVerdict(verdict).annotation, "");
});

test("one provider down while its file still ran something is DEGRADED", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "tool selection", [
        { status: "skipped", skips: [DRAINED] },
        { status: "expected" },
        { status: "flaky" },
      ]),
    ),
  );
  assert.equal(verdict.level, "degraded");
  assert.deepEqual(verdict.unverified, [
    { provider: "openai", reason: "You have no credits remaining.", skipped: 1 },
  ]);
  assert.equal(verdict.executed, 2);
  assert.equal(verdict.skipped, 1);
  assert.deepEqual(verdict.gatedFiles, ["agent.spec.ts"]);
});

test("DEGRADED names the provider and the measured reason in the summary", () => {
  const { markdown, annotation } = renderVerdict(
    providerCoverageVerdict(
      report(
        spec("agent.spec.ts", "t", [
          { status: "skipped", skips: [DRAINED] },
          { status: "expected" },
        ]),
      ),
    ),
    { lane: "pr-validation" },
  );
  assert.match(markdown, /DEGRADED/);
  assert.match(markdown, /`openai`/);
  assert.match(markdown, /You have no credits remaining\./);
  assert.match(markdown, /pr-validation/);
  assert.match(annotation, /openai/);
});

test("every test in every gated file skipped is UNCOVERED", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "t", [
        { status: "skipped", skips: [DRAINED] },
        { status: "skipped", skips: [INACTIVE("anthropic", "credit balance is too low")] },
      ]),
    ),
  );
  assert.equal(verdict.level, "uncovered");
  assert.equal(verdict.executed, 0);
  assert.equal(verdict.skipped, 2);
  assert.deepEqual(
    verdict.unverified.map((p) => p.provider),
    ["anthropic", "openai"],
  );
});

test("UNCOVERED explains why the run is red with no test failure", () => {
  const { markdown, annotation } = renderVerdict(
    providerCoverageVerdict(
      report(spec("agent.spec.ts", "t", [{ status: "skipped", skips: [DRAINED] }])),
    ),
  );
  assert.match(markdown, /No provider was verified/i);
  assert.match(markdown, /RED with no test failure/);
  assert.match(annotation, /0 executed/);
});

// The case the whole grading exists for: a file wholly skipped on a dead provider does
// NOT redden the run while another gated file still produced evidence. Reading the
// verdict per file instead of per run would fail this PR over an ops outage.
test("a fully skipped file next to a file that ran is still DEGRADED", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("openai-provider.spec.ts", "hardcoded", [
        { status: "skipped", skips: [DRAINED] },
        { status: "skipped", skips: [DRAINED] },
      ]),
      spec("agent.spec.ts", "parametrized", [
        { status: "skipped", skips: [DRAINED] },
        { status: "expected" },
      ]),
    ),
  );
  assert.equal(verdict.level, "degraded");
  assert.equal(verdict.executed, 1);
  assert.equal(verdict.skipped, 3);
  assert.deepEqual(verdict.gatedFiles, ["agent.spec.ts", "openai-provider.spec.ts"]);
});

// A key that is not configured at all is a DIFFERENT hole (#570's). Counting it would
// make every PR touching composio.spec.ts — whose key no workflow sets — read as
// `uncovered` and go red.
test("an unconfigured-key skip is not a provider-health skip", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("composio.spec.ts", "t", [
        { status: "skipped", skips: ["COMPOSIO_API_KEY required to run this test"] },
      ]),
    ),
  );
  assert.equal(verdict.level, "covered");
  assert.equal(verdict.skipped, 0);
});

test("a test carrying several skip annotations counts once", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "t", [
        { status: "skipped", skips: [DRAINED, DRAINED] },
        { status: "expected" },
      ]),
    ),
  );
  assert.equal(verdict.skipped, 1);
});

test("the reason is tolerated when collect-models recorded none", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "t", [
        { status: "skipped", skips: ['Provider "google" inactive — '] },
        { status: "expected" },
      ]),
    ),
  );
  assert.equal(verdict.unverified[0].reason, "no reason recorded by collect-models");
});

test("the marker matches the producer's em dash and a plain hyphen", () => {
  assert.ok(PROVIDER_INACTIVE_SKIP.test('Provider "openai" inactive — dry'));
  assert.ok(PROVIDER_INACTIVE_SKIP.test('Provider "openai" inactive - dry'));
  assert.ok(!PROVIDER_INACTIVE_SKIP.test("OPENAI_API_KEY required to run this test"));
  assert.ok(!PROVIDER_INACTIVE_SKIP.test('Provider "openai" is inactive — dry'));
});

test("collectTests walks nested suites and tolerates a malformed shape", () => {
  const nested = {
    suites: [
      {
        file: "a.spec.ts",
        specs: [spec("a.spec.ts", "outer", [{ status: "expected" }])],
        suites: [
          { file: "a.spec.ts", specs: [spec("a.spec.ts", "inner", [{ status: "skipped" }])] },
          null,
        ],
      },
      { specs: [null], suites: null },
    ],
  };
  assert.equal(collectTests(nested).length, 2);
  assert.deepEqual(collectTests(null), []);
  assert.deepEqual(collectTests({ suites: "nope" }), []);
});

test("a report with no test at all is UNKNOWN, never covered", () => {
  const verdict = providerCoverageVerdict({ suites: [] });
  assert.equal(verdict.level, "unknown");
  const { markdown } = renderVerdict({ ...verdict, reason: "results.json does not exist" });
  assert.match(markdown, /UNKNOWN/);
  assert.match(markdown, /not clean/);
});

test("readReport reports an absent and an unparseable file instead of throwing", () => {
  const absent = readReport("nope.json", { exists: () => false });
  assert.equal(absent.report, null);
  assert.match(absent.reason, /does not exist/);

  const broken = readReport("bad.json", { exists: () => true, readFile: () => "{" });
  assert.equal(broken.report, null);
  assert.match(broken.reason, /unreadable/);
});

// The graded policy, as an exit code: only the empty verdict fails, and an undecidable
// one fails only where its silence would read as a pass (#1035).
test("exitCodeFor encodes the graded policy", () => {
  assert.equal(exitCodeFor("covered", "success"), 0);
  assert.equal(exitCodeFor("degraded", "success"), 0);
  assert.equal(exitCodeFor("uncovered", "success"), 1);
  assert.equal(exitCodeFor("uncovered", "failure"), 1);
  assert.equal(exitCodeFor("unknown", "success"), 2);
  assert.equal(exitCodeFor("unknown", "failure"), 0);
  assert.equal(exitCodeFor("unknown", "skipped"), 0);
});

// Wiring guards. These pin an ABSENCE that would make the verdict permanently silent
// rather than a spelling that would make it pretty: without a JSON report on the PR
// lane the verdict can only ever answer `unknown`, and a lane that never calls the
// script cannot answer at all.
test("both lanes run the verdict, and the PR lane writes the report it reads", () => {
  const pr = fs.readFileSync(path.join(REPO, ".github/workflows/pr-validation.yml"), "utf-8");
  const daily = fs.readFileSync(path.join(REPO, ".github/workflows/daily-stable.yml"), "utf-8");

  assert.match(pr, /provider-coverage-verdict\.mjs/);
  assert.match(daily, /provider-coverage-verdict\.mjs/);
  assert.match(pr, /PLAYWRIGHT_JSON_OUTPUT_NAME/);
  assert.match(pr, /--reporter=github,json/);
});
