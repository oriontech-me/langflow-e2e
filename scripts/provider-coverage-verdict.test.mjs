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
  providerUsability,
  readProviderFiles,
  readReport,
  renderVerdict,
} from "./provider-coverage-verdict.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The exact string `inactiveReason()` produces, and the exact shape Playwright 1.58
// records it in — both measured against a real run (`test.skip(cond, reason)` in a
// body, a `beforeEach`, a `describe` and at file level, then `merge-reports
// --reporter=json`), so these fixtures are the transport, not a guess about it.
const INACTIVE = (provider, detail) => `Provider "${provider}" inactive — ${detail}`;
const DRAINED = INACTIVE("openai", "You have no credits remaining.");

const SOME_USABLE = { known: true, active: ["anthropic", "google"] };
const NONE_USABLE = { known: true, active: [] };
const UNKNOWN_USABILITY = { known: false, active: [] };

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
    NONE_USABLE,
  );
  // Even with nothing usable: no spec asked for a provider, so nothing was lost.
  assert.equal(verdict.level, "covered");
  assert.equal(verdict.unverified.length, 0);
  assert.equal(renderVerdict(verdict).markdown, "");
  assert.equal(renderVerdict(verdict).annotation, "");
});

test("one provider down while another is usable is DEGRADED", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "tool selection", [
        { status: "skipped", skips: [DRAINED] },
        { status: "expected" },
        { status: "flaky" },
      ]),
    ),
    SOME_USABLE,
  );
  assert.equal(verdict.level, "degraded");
  assert.deepEqual(verdict.unverified, [
    { provider: "openai", reason: "You have no credits remaining.", skipped: 1 },
  ]);
  assert.equal(verdict.executed, 2);
  assert.equal(verdict.skipped, 1);
  assert.deepEqual(verdict.gatedFiles, ["agent.spec.ts"]);
});

// THE REVIEW DEFECT, pinned. The first version scoped the denominator to the files
// that produced a skip, so a provider that ran perfectly contributed nothing: this
// exact report — `rag-pipeline.spec.ts` wholly gated on google, `openai-provider.spec.ts`
// passing — scored `uncovered`, printed "no evidence about `google` or any other
// provider" with two openai tests green in the same report, and exited 1. Twelve spec
// files are wholly gated on one provider, so a PR editing any of them during a drain
// went red for a reason its author cannot fix.
test("a wholly skipped file cannot fail a run where another provider was verified", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("rag-pipeline.spec.ts", "ingest", [
        { status: "skipped", skips: [INACTIVE("google", "spending cap")] },
      ]),
      spec("openai-provider.spec.ts", "provider contract", [
        { status: "expected" },
        { status: "expected" },
      ]),
    ),
    { known: true, active: ["openai"] },
  );

  assert.equal(verdict.level, "degraded");
  assert.equal(verdict.executed, 0, "the executed count is context, not the verdict");
  assert.equal(exitCodeFor(verdict.level, "success"), 0);

  const { markdown } = renderVerdict(verdict);
  assert.match(markdown, /`google`/);
  assert.doesNotMatch(
    markdown,
    /or any other provider/,
    "the headline must not deny coverage the same report contains",
  );
  assert.match(markdown, /`openai`.*still usable/s);
});

test("a provider down with NOTHING usable is UNCOVERED", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "t", [
        { status: "skipped", skips: [DRAINED] },
        { status: "skipped", skips: [INACTIVE("anthropic", "credit balance is too low")] },
      ]),
    ),
    NONE_USABLE,
  );
  assert.equal(verdict.level, "uncovered");
  assert.equal(verdict.skipped, 2);
  assert.deepEqual(
    verdict.unverified.map((p) => p.provider),
    ["anthropic", "openai"],
  );
  assert.equal(exitCodeFor(verdict.level, "success"), 1);
});

// The daily's own hedge, and the false GREEN the first version had. Each
// `*-provider.spec.ts` deliberately leaves its FIRST test on the env-presence gate so
// it still runs on a dry day — an executed test inside a gated file. Under the old
// rule that alone made `uncovered` unreachable on the lane the issue asked about.
test("an executed test inside a gated file does not rescue a dead account", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("openai-provider.spec.ts", "provider contract", [
        { status: "expected" },
        { status: "skipped", skips: [DRAINED] },
      ]),
    ),
    NONE_USABLE,
  );
  assert.equal(verdict.level, "uncovered");
  assert.equal(verdict.executed, 1);
});

test("UNCOVERED explains why the run is red with no test failure", () => {
  const { markdown, annotation } = renderVerdict(
    providerCoverageVerdict(
      report(spec("agent.spec.ts", "t", [{ status: "skipped", skips: [DRAINED] }])),
      NONE_USABLE,
    ),
  );
  assert.match(markdown, /No provider was usable/i);
  assert.match(markdown, /RED with no test failure/);
  assert.match(markdown, /re-running changes nothing/);
  assert.match(annotation, /none active/);
});

// Usability is an OPTIONAL input and the one place this guard does not fail closed:
// `uncovered` fails a lane, and failing it because a legitimately-absent file was
// absent would redden runs for a missing optional input. Never silent, though.
test("unknown usability degrades rather than failing, and says the gap out loud", () => {
  const verdict = providerCoverageVerdict(
    report(spec("agent.spec.ts", "t", [{ status: "skipped", skips: [DRAINED] }])),
    UNKNOWN_USABILITY,
  );
  assert.equal(verdict.level, "degraded");
  assert.equal(verdict.usabilityKnown, false);
  const { markdown } = renderVerdict(verdict);
  assert.match(markdown, /could not be read/);
  // And it must not close by asserting the very thing it just said it cannot know.
  assert.doesNotMatch(markdown, /the account was not down/);
});

test("providerUsability unions the shards and fails open on an unreadable payload", () => {
  const shard1 = [
    { provider: "openai", status: "inactive" },
    { provider: "google", status: "active" },
  ];
  const shard2 = [
    { provider: "openai", status: "active" },
    { provider: "google", status: "inactive" },
  ];
  // One shard reaching a provider proves the ACCOUNT could — the union, not the
  // intersection, and not an arbitrary "first shard wins".
  assert.deepEqual(providerUsability([shard1, shard2]), {
    known: true,
    active: ["google", "openai"],
  });
  assert.deepEqual(providerUsability([shard1]), { known: true, active: ["google"] });
  assert.deepEqual(providerUsability([]), { known: false, active: [] });
  assert.deepEqual(providerUsability([null, "nope", 42]), { known: false, active: [] });
  // A readable file listing nothing active is a real answer, not an absent one.
  assert.deepEqual(providerUsability([[]]), { known: true, active: [] });
});

test("readProviderFiles skips what it cannot read and names it", () => {
  const exists = (p) => p !== "gone.json";
  const readFile = (p) => (p === "bad.json" ? "{" : "[]");
  const { payloads, unread } = readProviderFiles(
    ["gone.json", "bad.json", "ok.json"],
    { exists, readFile },
  );
  assert.deepEqual(payloads, [[]]);
  assert.deepEqual(unread, ["gone.json", "bad.json"]);
});

// A key that is not configured at all is a DIFFERENT hole (#570's). Counting it would
// make every PR touching composio.spec.ts — whose key no workflow sets — read as a
// coverage loss.
test("an unconfigured-key skip is not a provider-health skip", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("composio.spec.ts", "t", [
        { status: "skipped", skips: ["COMPOSIO_API_KEY required to run this test"] },
      ]),
    ),
    NONE_USABLE,
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
    SOME_USABLE,
  );
  assert.equal(verdict.skipped, 1);
});

test("the reason is tolerated when collect-models recorded none", () => {
  const verdict = providerCoverageVerdict(
    report(
      spec("agent.spec.ts", "t", [
        { status: "skipped", skips: ['Provider "google" inactive — '] },
      ]),
    ),
    SOME_USABLE,
  );
  assert.equal(verdict.unverified[0].reason, "no reason recorded by collect-models");
});

// Provider errors are unbounded provider output — Google's spend-cap message carries a
// documentation URL — and a `|` or a newline ends a markdown row early, eating the rest
// of the table this block exists to show.
test("a provider error cannot break the summary table it is rendered into", () => {
  const nasty = `line one | with a pipe\nand a newline${"x".repeat(400)}`;
  const { markdown } = renderVerdict(
    providerCoverageVerdict(
      report(
        spec("agent.spec.ts", "t", [
          { status: "skipped", skips: [INACTIVE("openai", nasty)] },
        ]),
      ),
      SOME_USABLE,
    ),
  );
  const row = markdown.split("\n").find((l) => l.startsWith("| `openai`"));
  assert.ok(row, "the provider row is rendered");
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 4, "exactly four unescaped cell bars");
  assert.ok(row.length < 320, `the row is capped, got ${row.length}`);
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

// Measured: `test.skip()` with no argument records an annotation with NO `description`
// key, as does `test.describe.skip`. Neither is a provider verdict.
test("a skip carrying no description is ignored", () => {
  const verdict = providerCoverageVerdict(
    {
      suites: [
        {
          file: "a.spec.ts",
          specs: [
            {
              file: "a.spec.ts",
              title: "t",
              tests: [{ status: "skipped", annotations: [{ type: "skip" }] }],
            },
          ],
        },
      ],
    },
    NONE_USABLE,
  );
  assert.equal(verdict.level, "covered");
});

test("a report with no test at all is UNKNOWN, never covered", () => {
  const verdict = providerCoverageVerdict({ suites: [] }, SOME_USABLE);
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
// or permanently non-failing, rather than a spelling that would make it pretty:
// without a JSON report on the PR lane the verdict can only answer `unknown`, and
// without a providers.json it can never answer `uncovered` on either lane.
test("both lanes run the verdict, with the report and the usability input it needs", () => {
  const pr = fs.readFileSync(path.join(REPO, ".github/workflows/pr-validation.yml"), "utf-8");
  const daily = fs.readFileSync(path.join(REPO, ".github/workflows/daily-stable.yml"), "utf-8");

  assert.match(pr, /provider-coverage-verdict\.mjs/);
  assert.match(daily, /provider-coverage-verdict\.mjs/);
  assert.match(pr, /PLAYWRIGHT_JSON_OUTPUT_NAME/);
  assert.match(pr, /--reporter=github,json/);
  assert.match(pr, /--providers /);
  assert.match(daily, /--providers/);
  // The daily's shards write per-shard copies into the artifact the merge job already
  // downloads; without that the merge job has no usability signal at all.
  assert.match(daily, /tokens\/providers-\$\{\{ matrix\.shard \}\}\.json/);
});
