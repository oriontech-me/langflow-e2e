// Unit tests for the run payload builder (issue #1255 item 4).
// Run with: node --test scripts/build-run-payload.test.mjs
//
// WHY A SUBPROCESS AND NOT AN IMPORT. build-run-payload.mjs is a top-level script:
// it reads env, reads PLAYWRIGHT_JSON and writes the payload to stdout the moment it
// is loaded, with nothing exported. Importing it to test it would run it. Driving it
// as the workflow drives it — one process, one env, one report file — also tests the
// thing the workflow actually depends on (the stdout document), which an extracted
// pure function would not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./build-run-payload.mjs", import.meta.url));

/** The trimmed shape of a Playwright JSON report: one file, one passing test. */
const REPORT = {
  config: {},
  suites: [
    {
      title: "a.spec.ts",
      specs: [
        {
          title: "does a thing",
          file: "tests/tests-automations/regression/smoke/a.spec.ts",
          line: 7,
          tags: ["@stable"],
          tests: [{ status: "expected", results: [{ status: "passed", duration: 1200, steps: [] }] }],
        },
      ],
    },
  ],
  stats: { duration: 1200 },
};

/** Run the builder against REPORT with `env` layered on the minimum it requires. */
function build(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "payload-"));
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(REPORT));
  const stdout = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      PLAYWRIGHT_JSON: reportPath,
      GITHUB_RUN_ID: "42",
      RUN_URL: "https://github.com/oriontech-me/langflow-e2e/actions/runs/42",
      LANGFLOW_IMAGE: "langflowai/langflow-nightly:latest",
      ...env,
    },
  });
  return JSON.parse(stdout);
}

// --- #1255 item 4: run_attempt, so a re-run supersedes instead of overwriting ---
//
// `github.run_id` is stable across re-runs and only `run_attempt` increments, so
// without this field the platform cannot tell attempt 2 from attempt 1: e2e_ingest_run
// replaces a run's rows only on a HIGHER attempt, and e2e_ingest_run_tokens supersedes
// the prior attempt's token rows only when the run's stored attempt has moved.

test("run_attempt is emitted from GITHUB_RUN_ATTEMPT", () => {
  assert.equal(build({ GITHUB_RUN_ATTEMPT: "2" }).run_attempt, 2);
});

test("attempt 1 is emitted explicitly, not omitted as a default", () => {
  // Omitting it would be indistinguishable from the pre-#1255 payload, and the
  // supersede path would then depend on a field the first attempt never established.
  assert.equal(build({ GITHUB_RUN_ATTEMPT: "1" }).run_attempt, 1);
});

test("an absent GITHUB_RUN_ATTEMPT omits the field entirely — the pre-#1255 behaviour", () => {
  // Local runs and any lane that does not export it. Both the edge function and the
  // RPC read an absent field as attempt 1, so omitting it changes nothing there.
  const payload = build();
  assert.ok(!("run_attempt" in payload), `run_attempt must be absent: ${JSON.stringify(payload)}`);
});

test("a junk or out-of-range attempt sends NOTHING rather than a stand-in", () => {
  // The edge function validates `run_attempt >= 1` and answers 400 otherwise. The POST
  // step is continue-on-error, so a 400 would silently cost the whole run's record —
  // strictly worse than falling back to the absent-field behaviour.
  for (const value of ["", "0", "-1", "not-a-number"]) {
    const payload = build({ GITHUB_RUN_ATTEMPT: value });
    assert.ok(
      !("run_attempt" in payload),
      `GITHUB_RUN_ATTEMPT=${JSON.stringify(value)} must not reach the payload: ${JSON.stringify(payload)}`,
    );
  }
});

test("adding run_attempt leaves the rest of the payload contract intact", () => {
  const payload = build({ GITHUB_RUN_ATTEMPT: "3" });
  assert.equal(payload.version, 1, "the edge function accepts run_attempt on version 1");
  assert.equal(payload.run_id, "42");
  assert.deepEqual(payload.totals, { passed: 1, failed: 0, flaky: 0, skipped: 0 });
  assert.equal(payload.tests.length, 1);
  assert.equal(payload.tests[0].status, "passed");
});
