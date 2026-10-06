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
import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

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
  const dir = makeTempDir("payload-");
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

/** Run the builder against an arbitrary report. */
function buildFrom(report) {
  const dir = makeTempDir("payload-");
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(report));
  return JSON.parse(
    execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf-8",
      stdio: "pipe",
      env: { PATH: process.env.PATH, PLAYWRIGHT_JSON: reportPath },
    }),
  );
}

const withTests = (tests) => ({
  config: {},
  suites: [
    {
      title: "a.spec.ts",
      specs: tests.map(([title, t], i) => ({
        title,
        file: "tests/tests-automations/regression/smoke/a.spec.ts",
        line: 10 + i,
        tags: ["@stable"],
        tests: [t],
      })),
    },
  ],
  stats: { duration: 1 },
});

test("#2009 an unexpected pass is a failure with its own signature, not \"unknown\"", () => {
  // The measured shape of a `test.fail()` whose body passed (Playwright 1.58.2).
  const passed = { status: "passed", duration: 5, steps: [] };
  const payload = buildFrom(
    withTests([
      ["declared failing", { status: "unexpected", expectedStatus: "failed", results: [passed, passed, passed] }],
      ["lost error", { status: "unexpected", results: [{ status: "failed", duration: 5 }] }],
    ]),
  );
  assert.deepEqual(payload.totals, { passed: 0, failed: 2, flaky: 0, skipped: 0 });
  assert.equal(payload.failures[0].error_signature, "expected to fail but passed");
  assert.equal(payload.failures[0].attempts, 3);
  assert.equal(payload.failures[1].error_signature, "unknown", "a genuinely lost error is unchanged");
});

// --- #2079: a flake carries its error, so the platform can compare signatures ---
//
// The platform expands its fact table from tests[] and derives `error_signature` from
// `tests[].error`. A flaky entry carried no `error`, so every flake landed with a NULL
// signature and the recurrence rule (same signature within 30 days) had nothing to
// compare. flaky[] had no `error_signature` either, unlike failures[] and the ledger.

const flake = (results) => ({ status: "flaky", results });
const failedWith = (message, stack) => ({
  status: "failed",
  duration: 5,
  steps: [],
  error: { message, ...(stack ? { stack } : {}) },
});
const PASSED = { status: "passed", duration: 5, steps: [] };

test("#2079 a flaky test carries its first failed attempt's error, in tests[] and flaky[]", () => {
  const payload = buildFrom(
    withTests([
      [
        "flaky twice",
        flake([
          failedWith("Error: first attempt\n  at a.spec.ts:10", "at a.spec.ts:10"),
          failedWith("Error: second attempt"),
          PASSED,
        ]),
      ],
    ]),
  );
  assert.deepEqual(payload.totals, { passed: 0, failed: 0, flaky: 1, skipped: 0 });
  assert.equal(
    payload.flaky[0].error_signature,
    "Error: first attempt",
    "the FIRST attempt with a message, as the ledger chooses, not the last failed one",
  );
  const entry = payload.tests[0];
  assert.equal(entry.status, "flaky");
  assert.equal(
    entry.error.split("\n")[0],
    "Error: first attempt",
    "the platform takes line 1 of tests[].error as the signature; it must match flaky[]",
  );
});

test("#2079 a flake never takes a screenshot, even when every attempt has one attached", () => {
  // The attachment has to be there for this to prove anything: without it the
  // builder has nothing to read, and a flake that DID take the budget would pass.
  const SHOT = { name: "screenshot", contentType: "image/png", body: Buffer.from("png").toString("base64") };
  const withShot = (r) => ({ ...r, attachments: [SHOT] });
  const payload = buildFrom(
    withTests([
      ["flaky", flake([withShot(failedWith("Error: a")), withShot(PASSED)])],
      ["fails", { status: "unexpected", results: [withShot(failedWith("Error: b"))] }],
    ]),
  );
  assert.ok(payload.tests[1].screenshot, "control: the same attachment does become a hard failure's screenshot");
  assert.ok(!("screenshot" in payload.tests[0]), "the screenshot budget stays with hard failures");
});

test("#2079 a message-less attempt before the real failure is skipped, as in the ledger", () => {
  const payload = buildFrom(
    withTests([
      ["interrupted first", flake([{ status: "interrupted", duration: 5 }, failedWith("Error: the real one"), PASSED])],
    ]),
  );
  assert.equal(payload.flaky[0].error_signature, "Error: the real one");
  assert.equal(payload.tests[0].error.split("\n")[0], "Error: the real one");
});

test("#2079 a flake whose error was lost says \"unknown\" in flaky[] and adds no error to tests[]", () => {
  const payload = buildFrom(withTests([["no message", flake([{ status: "failed", duration: 5 }, PASSED])]]));
  assert.equal(payload.flaky[0].error_signature, "unknown", "the same fallback failures[] uses");
  assert.ok(
    !("error" in payload.tests[0]),
    "no invented error text: the platform must store NULL, not a signature that was never observed",
  );
});

test("#2079 passed and hard-failed entries are unchanged by the flaky path", () => {
  const payload = buildFrom(
    withTests([
      ["passes", { status: "expected", results: [PASSED] }],
      ["fails", { status: "unexpected", results: [failedWith("Error: a"), failedWith("Error: b")] }],
    ]),
  );
  assert.ok(!("error" in payload.tests[0]), "a passing test carries no error");
  assert.equal(payload.failures[0].error_signature, "Error: b", "a hard failure still reads its LAST failed attempt");
  assert.equal(payload.tests[1].error.split("\n")[0], "Error: b");
  assert.deepEqual(payload.flaky, []);
});

// --- #2203: the suite commit, so the platform can pair an on-demand run with the daily ---
//
// The platform matches an on-demand run against the daily that ran the same suite
// commit. A malformed value would match nothing and look exactly like a real "different
// suite", so it is dropped; an absent one says "not known", which is what it is.

const SUITE = "6ff9754178014cf3342b404e59159d13dae4b42f";

test("suite_sha is emitted from SUITE_SHA", () => {
  assert.equal(build({ SUITE_SHA: SUITE }).suite_sha, SUITE);
});

test("an absent or blank SUITE_SHA omits the field, and the payload still builds", () => {
  for (const env of [{}, { SUITE_SHA: "" }, { SUITE_SHA: "   " }]) {
    const payload = build(env);
    assert.ok(!("suite_sha" in payload), `suite_sha must be absent for ${JSON.stringify(env)}: ${JSON.stringify(payload)}`);
    assert.equal(payload.run_id, "42", "the rest of the payload is unaffected");
  }
});

test("a value that is not a full lowercase 40-hex commit is dropped, never forwarded", () => {
  for (const value of [SUITE.slice(0, 7), SUITE.toUpperCase(), `${SUITE}0`, "HEAD", "not-a-sha"]) {
    const payload = build({ SUITE_SHA: value });
    assert.ok(!("suite_sha" in payload), `suite_sha must be absent for ${JSON.stringify(value)}: got ${payload.suite_sha}`);
  }
});

test("surrounding whitespace is trimmed rather than costing the field", () => {
  assert.equal(build({ SUITE_SHA: `${SUITE}\n` }).suite_sha, SUITE);
});

test("the daily's payload step passes the same suite commit as its history step", () => {
  // The payload and the history row must not disagree about which suite ran. Each step
  // is read on its own: a match anywhere in the 1700-line workflow proves nothing about
  // the step that has to carry it.
  const daily = readFileSync(fileURLToPath(new URL("../.github/workflows/daily-stable.yml", import.meta.url)), "utf8");
  const step = (name) => {
    const at = daily.indexOf(`- name: ${name}`);
    assert.ok(at > 0, `the daily no longer has a "${name}" step`);
    const next = daily.indexOf("      - name:", at + 10);
    return daily.slice(at, next > 0 ? next : daily.length);
  };
  const shaOf = (body) => body.match(/^\s+SUITE_SHA:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(shaOf(step("Build run payload")), "${{ github.sha }}");
  assert.equal(shaOf(step("Build run payload")), shaOf(step("Append daily history")));
});
