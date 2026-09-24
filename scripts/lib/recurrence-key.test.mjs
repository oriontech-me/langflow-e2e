// Unit tests for the recurrence key (#1626).
// Run with: node --test scripts/lib/recurrence-key.test.mjs
//
// The end-to-end half drives the REAL appender over reports rebuilt from real
// failed attempts (`scripts/fixtures/recurrence-key/real-attempts.json`, copied
// from the daily JSON reports named by run id) and hands the rows it writes to the
// REAL `computeRecurrence()`. A hand-written key would test the comparison against
// the shape its author expected, which is the gap every one of the four measured
// cases below slipped through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./tmp-dir.mjs";
import {
  RECURRENCE_KEY_VERSION,
  compareRecurrence,
  recurrenceFile,
  recurrenceHead,
  recurrenceKey,
  recurrenceKeysForTest,
  recurrenceLocator,
  recurrenceSource,
} from "./recurrence-key.mjs";
import { computeRecurrence } from "../../.claude/skills/langflow-e2e-triage/scripts/lib/triage-core.mjs";

const APPENDER = fileURLToPath(new URL("../append-weekly-history.mjs", import.meta.url));
const { cases: REAL } = JSON.parse(
  readFileSync(new URL("../fixtures/recurrence-key/real-attempts.json", import.meta.url), "utf8"),
);
const ROOT = "/__w/langflow-e2e/langflow-e2e";

// ---------------------------------------------------------------- head

test("a marker assertion's head is the marker alone, whatever it interpolates", () => {
  // #1649/#1665: the model name is interpolated, so the raw strings never matched.
  const a = 'Error: MODEL_PICKER_DEFECT: "gpt-4o-mini" is ENABLED in the provider panel (llm-toggle-gpt-4o-min…';
  const b = 'Error: MODEL_PICKER_DEFECT: "gemini-3.5-flash" is ENABLED in the provider panel (llm-toggle-gem…';
  assert.equal(recurrenceHead(a), "MODEL_PICKER_DEFECT");
  assert.equal(recurrenceHead(a), recurrenceHead(b));
  // #1679: the counters are interpolated too.
  assert.equal(
    recurrenceHead("Error: MODEL_TOGGLE_WRITE_STALLED: … — 29 toggle(s) clicked, 1 write(s) started"),
    recurrenceHead("Error: MODEL_TOGGLE_WRITE_STALLED: … — 30 toggle(s) clicked, 1 write(s) started"),
  );
});

test("a marker needs an underscore, so a bare upper-case word is not one", () => {
  assert.equal(recurrenceHead("Error: ECONNREFUSED 127.0.0.1:7860"), "error: econnrefused #.#.#.#:#");
  assert.equal(recurrenceHead("HTTP 500"), "http #");
});

test("a measured latency in the head no longer makes one cause unequal to itself", () => {
  const at = (ms) =>
    `Error: page-entry barrier "[data-testid="mainpage_title"]" did not render within 30000ms — the backend answered GET /api/v1/version with HTTP 200 in ${ms}ms`;
  assert.equal(recurrenceHead(at(1023)), recurrenceHead(at(87)));
});

test("the head strips ANSI with its ESC byte and collapses whitespace", () => {
  const ESC = String.fromCharCode(27);
  assert.equal(recurrenceHead(`${ESC}[31mError:   x${ESC}[39m`), "error: x");
  assert.equal(recurrenceHead(""), "");
  assert.equal(recurrenceHead(null), "");
});

// ---------------------------------------------------------------- locator

test("the locator is read from an assertion's Locator line", () => {
  const msg = [
    "Error: expect(locator).toBeVisible() failed",
    "",
    "Locator: getByTestId('node_duration_tail')",
    "Expected: visible",
    "Call log:",
    "  - waiting for getByTestId('something-else')",
  ].join("\n");
  assert.equal(recurrenceLocator(msg), "getByTestId('node_duration_tail')");
});

test("the locator is read from an action's call log, without the state tail", () => {
  const msg =
    "TimeoutError: page.waitForSelector: Timeout 3000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"x\"]') to be visible\n    10 × locator resolved to hidden <input>";
  assert.equal(recurrenceLocator(msg), "locator('[data-testid=\"x\"]')");
});

test("a request's target loses its origin and its generated ids", () => {
  const msg = (port, id) =>
    `TimeoutError: apiRequestContext.post: Timeout 20000ms exceeded.\nCall log:\n  - → POST http://localhost:${port}/api/v1/run/${id}\n    - user-agent: x`;
  const a = recurrenceLocator(msg(7860, "418b39fc-7d25-4133-b694-d1cc1d9ef61a"));
  assert.equal(a, "POST /api/v1/run/<uuid>");
  assert.equal(a, recurrenceLocator(msg(7861, "28876d01-edb4-44c6-84f9-3d49e59fc6ee")));
});

test("a message with no locator says so rather than guessing", () => {
  assert.equal(recurrenceLocator("Error: expect(received).toBe(expected)\n\nExpected: 1"), null);
});

// ---------------------------------------------------------------- site

test("the file is repo-relative under the report's root, and anchored on tests/ elsewhere", () => {
  const loc = { file: `${ROOT}/tests/helpers/ui/go-to-settings.ts`, line: 9 };
  assert.equal(recurrenceFile(loc, ROOT), "helpers/ui/go-to-settings.ts");
  // A report merged on another machine (the VM lane) still spells it alike.
  assert.equal(recurrenceFile(loc, "/home/qa/langflow-e2e"), "helpers/ui/go-to-settings.ts");
  assert.equal(recurrenceFile(undefined, ROOT), null);
});

test("the source comes from the snippet, or from the frame inside the message", () => {
  const frame = "  54 |\n> 56 |     await page.waitForSelector('[data-testid=\"a\"]', {\n     |                ^";
  assert.equal(recurrenceSource({ snippet: frame }), "await page.waitForSelector('[data-testid=\"a\"]', {");
  assert.equal(recurrenceSource({ snippet: "", message: `TimeoutError: x\n\n${frame}` }), recurrenceSource({ snippet: frame }));
  assert.equal(recurrenceSource({ message: "Error: no frame" }), null);
});

test("the source is the line's TEXT, so an edit above it does not change the key", () => {
  // #1694 recorded 251 -> 256 for an unrelated edit to the file; a line number
  // in the key would have reset the window on it.
  const at = (n) => ({
    message: `TimeoutError: locator.click: Timeout 20000ms exceeded.\nCall log:\n  - waiting for getByTestId('a')\n\n> ${n} |   await page.getByTestId("a").click();`,
    location: { file: `${ROOT}/tests/x.spec.ts`, line: n },
  });
  assert.deepEqual(recurrenceKey(at(251), ROOT), recurrenceKey(at(256), ROOT));
});

// ---------------------------------------------------------------- per test

test("every failed attempt contributes a key, passed and skipped ones none", () => {
  const err = (loc) => ({
    message: `TimeoutError: locator.click: Timeout 20000ms exceeded.\nCall log:\n  - waiting for getByTestId('${loc}')`,
  });
  const keys = recurrenceKeysForTest({
    results: [
      { status: "failed", error: err("a") },
      { status: "timedOut", errors: [err("b")] },
      { status: "failed", error: err("a") }, // duplicate of attempt 0
      { status: "skipped" },
      { status: "passed" },
    ],
  });
  assert.deepEqual(keys.map((k) => k.locator), ["getByTestId('a')", "getByTestId('b')"]);
});

// ---------------------------------------------------------------- comparison

const entry = (sig, keys) => ({
  test: "t",
  error_signature: sig,
  ...(keys ? { recurrence_keys: keys, recurrence_key_version: RECURRENCE_KEY_VERSION } : {}),
});
const key = (over = {}) => ({ head: "h", locator: "l", file: "f", source: "s", ...over });

test("two current-form entries match only when some attempt agrees on all four fields", () => {
  assert.equal(compareRecurrence(entry("x", [key()]), entry("x", [key()])), "match");
  for (const field of ["head", "locator", "file", "source"]) {
    assert.equal(
      compareRecurrence(entry("x", [key()]), entry("x", [key({ [field]: "other" })])),
      "none",
      `a different ${field} must not match`,
    );
  }
  assert.equal(compareRecurrence(entry("x", [key({ locator: "z" }), key()]), entry("x", [key()])), "match");
});

test("a legacy row is compared on the head and reported unverified, never as no recurrence", () => {
  const legacy = entry("TimeoutError: page.waitForSelector: Timeout 3000ms exceeded.");
  const current = entry("TimeoutError: page.waitForSelector: Timeout 3000ms exceeded.", [
    key({ head: recurrenceHead("TimeoutError: page.waitForSelector: Timeout 3000ms exceeded.") }),
  ]);
  assert.equal(compareRecurrence(current, legacy), "unverified");
  assert.equal(compareRecurrence(legacy, current), "unverified");
  assert.equal(compareRecurrence(legacy, legacy), "unverified");
  assert.equal(compareRecurrence(current, entry("Error: something else")), "none");
});

test("a different key version is compared like a legacy row", () => {
  const a = { ...entry("x", [key()]), recurrence_key_version: RECURRENCE_KEY_VERSION + 1 };
  assert.equal(compareRecurrence(a, entry("x", [key()])), "unverified");
});

test("current-form entries with no keys stand on their head, and still match", () => {
  // An unexpected pass (#2009) or a failure whose error was lost has no attempt key.
  assert.equal(compareRecurrence(entry("unknown", []), entry("unknown", [])), "match");
  assert.equal(compareRecurrence(entry("unknown", []), entry("Error: x", [])), "none");
});

// ------------------------------------------------- end to end, on real attempts

/** Run the real appender over one real case and return the entry it wrote. */
function appendReal(c) {
  const dir = makeTempDir("recurrence-key-");
  const reportPath = join(dir, "results.json");
  const historyPath = join(dir, "history.jsonl");
  writeFileSync(
    reportPath,
    JSON.stringify({
      config: {},
      suites: [
        {
          title: "x",
          specs: [{ title: c.title, file: c.file, line: c.line, tags: ["@stable"], tests: [{ status: c.status, results: c.results }] }],
        },
      ],
      stats: { duration: 1 },
    }),
  );
  execFileSync(process.execPath, [APPENDER], {
    cwd: dir, // not the report's root: the tests/ anchor must spell the paths alike
    env: {
      ...process.env,
      PLAYWRIGHT_JSON: reportPath,
      HISTORY_FILE: historyPath,
      WORKFLOW: "unit",
      GITHUB_RUN_ID: c.run_id,
      GITHUB_REPOSITORY: "o/r",
      LANGFLOW_IMAGE: "img:tag",
      LIVENESS_DIR: "",
      OUTAGE_ATTEMPTS: "",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const row = JSON.parse(readFileSync(historyPath, "utf8").trim());
  return { ...row, date: c.date };
}

/** Recurrence of the latest case of `group`, over every case of it. */
function recurrenceOf(group) {
  const rows = REAL.filter((c) => c.group === group).map(appendReal);
  const latest = rows[rows.length - 1];
  const item = [...(latest.failures || []), ...(latest.flaky || [])][0];
  return { item, rows, r: computeRecurrence(item, rows) };
}

test("#1694: two locator.click stalls on different targets no longer compare equal", () => {
  const { rows, r } = recurrenceOf("issue-1694");
  // The pre-#1626 signature was byte-identical on both days — the collision.
  const sigs = rows.map((row) => [...row.failures, ...row.flaky][0].error_signature);
  assert.equal(sigs[0], sigs[1]);
  assert.equal(r.count, 1);
  assert.equal(r.same_signature, false);
  assert.deepEqual(r.total_dates, ["2026-08-31", "2026-09-03"]);
});

test("#1623: the :56 wait and the :73 wait are different keys", () => {
  const [aug27] = REAL.filter((c) => c.group === "issue-1623" && c.date === "2026-08-27");
  const [sidebar, handle] = recurrenceKeysForTest(aug27, ROOT);
  assert.match(sidebar.locator, /sidebar-search-input/);
  assert.match(handle.locator, /handle-apirequest-shownode-url-left/);
  assert.equal(
    compareRecurrence(entry("x", [sidebar]), entry("x", [handle])),
    "none",
  );
});

test("#1623: but 08-27's retries hit the very wait 08-25 flaked on, so the days DO recur", () => {
  // Measured, and it corrects the record: #1623 compared 08-27's attempt 0
  // (`:56`) with 08-25, while attempts 1 and 2 of 08-27 timed out on the same
  // `:73` wait as 08-25's attempts 0 and 1. The recorded `error_signature` of
  // both rows is that `:73` wait (a flake records its first failed attempt, a
  // hard failure its last), so the dataset's 2x was a real same-call-site
  // recurrence and not the self-collision it was refuted as.
  const { r } = recurrenceOf("issue-1623");
  assert.equal(r.count, 2);
  assert.equal(r.same_signature, true);
  assert.deepEqual(r.unverified_dates, []);
});

test("#1665: a marker that interpolates the model recurs across days", () => {
  const { rows, r } = recurrenceOf("comment-1665");
  const sigs = rows.map((row) => [...row.failures, ...row.flaky][0].error_signature);
  assert.notEqual(sigs[0], sigs[1], "the raw signatures differ — the over-specification");
  assert.equal(r.count, 2);
  assert.equal(r.same_signature, true);
});

test("#1676: a cause on attempt 0 of a hard failure matches a flake of the same cause", () => {
  const { rows, r } = recurrenceOf("comment-1676");
  const sigs = rows.map((row) => [...row.failures, ...row.flaky][0].error_signature);
  assert.notEqual(sigs[0], sigs[1], "the hard failure records its LAST attempt, a different error");
  assert.equal(r.count, 2);
  assert.equal(r.same_signature, true);
});

test("the appender records the keys beside an unchanged error_signature", () => {
  const [c] = REAL.filter((x) => x.group === "comment-1676" && x.date === "2026-09-02");
  const f = appendReal(c).failures[0];
  assert.equal(f.recurrence_key_version, RECURRENCE_KEY_VERSION);
  assert.equal(f.recurrence_keys.length, 2);
  assert.match(f.error_signature, /^Error: expect\(received\)\.toBe\(expected\)/);
  // The stored signature's head is one of the keys' heads, so a later reader
  // comparing it against a legacy row compares like with like.
  assert.ok(f.recurrence_keys.some((k) => k.head === recurrenceHead(f.error_signature)));
});

test("a legacy row in the window is counted and named, not dropped", () => {
  const { item, rows } = recurrenceOf("issue-1694");
  const [older] = rows;
  const legacy = {
    ...older,
    flaky: older.flaky.map((e) => {
      const legacyEntry = { ...e };
      delete legacyEntry.recurrence_keys;
      delete legacyEntry.recurrence_key_version;
      return legacyEntry;
    }),
  };
  const r = computeRecurrence(item, [legacy, rows[1]]);
  // Head-only, the #1694 pair is the collision again — which is why it is named.
  assert.equal(r.count, 2);
  assert.deepEqual(r.unverified_dates, ["2026-08-31"]);
});

// ------------------------------------------------- review round 1 (#1626)

test("two multi-line value assertions in one spec are different keys", () => {
  // A value assertion has no locator, and both statements open with `await expect`
  // alone on their first line — the #1623 collision for the second commonest head.
  const at = (line, rows) => ({
    message: ["Error: expect(received).toBe(expected) // Object.is equality", "", ...rows].join("\n"),
    location: { file: `${ROOT}/tests/x.spec.ts`, line },
  });
  const a = at(131, [
    "> 131 |       await expect",
    "      |       ^",
    "  132 |         .poll(() => projectFlowNames(request, projectId!), {",
    "  133 |           timeout: 15000,",
  ]);
  const b = at(212, [
    "> 212 |       await expect",
    "      |       ^",
    "  213 |         .poll(() => parked, { timeout: 20000 })",
    "  214 |         .toBe(true);",
  ]);
  assert.equal(recurrenceSource(a), "await expect .poll(() => projectFlowNames(request, projectId!), { timeout: 15000,");
  assert.equal(recurrenceSource(b), "await expect .poll(() => parked, { timeout: 20000 }) .toBe(true);");
  assert.notDeepEqual(recurrenceKey(a, ROOT), recurrenceKey(b, ROOT));
});

test("a complete one-line statement does not swallow the next line", () => {
  const frame = [
    "> 145 |       await expect(page.getByTestId(\"t\")).toBeVisible({ timeout: 8000 });",
    "      |                                              ^",
    "  146 |       await page.close();",
  ].join("\n");
  assert.equal(recurrenceSource({ snippet: frame }), 'await expect(page.getByTestId("t")).toBeVisible({ timeout: 8000 });');
});

test("a test timeout takes its site from the action that was in flight", () => {
  // Measured shape (run 32827671203): errors[0] is the timeout, errors[1] the action.
  const waiting = (id) => ({
    status: "timedOut",
    errors: [
      { message: "Test timeout of 300000ms exceeded." },
      {
        message: `Error: locator.click: Test timeout of 300000ms exceeded.\nCall log:\n  - waiting for getByTestId('${id}')`,
        location: { file: `${ROOT}/tests/x.spec.ts`, line: 9 },
      },
    ],
  });
  const [a] = recurrenceKeysForTest({ results: [waiting("a")] }, ROOT);
  const [b] = recurrenceKeysForTest({ results: [waiting("b")] }, ROOT);
  assert.equal(a.head, "test timeout of #ms exceeded.");
  assert.equal(a.locator, "getByTestId('a')");
  assert.equal(a.file, "x.spec.ts");
  assert.notDeepEqual(a, b);
});

test("a generated id inside a locator is masked, a named one is kept", () => {
  assert.equal(
    recurrenceLocator("Locator: getByTestId('connection-row-page_row_mue51qw0_83sqzi')"),
    "getByTestId('connection-row-page_row_<id>_<id>')",
  );
  assert.equal(recurrenceLocator("Locator: getByTestId('a2a-target-9bbd49b7-0-option')"), "getByTestId('a2a-target-<id>-0-option')");
  assert.equal(recurrenceLocator("Locator: getByTestId('llm-toggle-gpt-4o-mini')"), "getByTestId('llm-toggle-gpt-4o-mini')");
});

test("locator and source are capped like the signature", () => {
  const long = "x".repeat(500);
  const k = recurrenceKey({ message: `Error: e\nLocator: getByTestId('${long}')\n\n> 1 | ${long}` });
  assert.equal(k.locator.length, 240);
  assert.equal(k.source.length, 240);
});

test("a line 1 over 240 characters gives the same head the stored signature does", () => {
  // The `[backend-unreachable]` barrier family: line 1 runs past 240 characters,
  // and `error_signature` stores it cut there — so the key must cut it the same.
  const line1 = `Error: page-entry barrier did not render — ${"and the backend did not answer ".repeat(10)}END`;
  assert.ok(line1.length > 240);
  const k = recurrenceKey({ message: `${line1}\nmore` });
  assert.equal(k.head, recurrenceHead(line1.slice(0, 240)));
  assert.notEqual(k.head, recurrenceHead(line1));
});

test("a skipped attempt contributes no key even when it carries an error", () => {
  const keys = recurrenceKeysForTest({
    results: [
      { status: "failed", error: { message: "Error: real" } },
      { status: "skipped", error: { message: "Error: never ran" } },
    ],
  });
  assert.deepEqual(keys.map((k) => k.head), ["error: real"]);
});

// ------------------------------------------------- review round 2 (#1626)

const frameOf = (...rows) => ({ snippet: rows.join("\n") });

test("a statement left open only by a bracket continues onto the next row", () => {
  // No trailing `(`, `,` or `{` — only the unbalanced `(` of `toBeVisible(` keeps it open.
  const src = recurrenceSource(
    frameOf("> 10 |   await expect(page.getByTestId(\"a\")).toBeVisible({ timeout: 1 }", "     |   ^", "  11 |   );", "  12 |   await next();"),
  );
  assert.equal(src, 'await expect(page.getByTestId("a")).toBeVisible({ timeout: 1 } );');
});

test("a bracket inside a string literal does not hold the statement open", () => {
  const src = recurrenceSource(
    frameOf("> 10 |   await page.getByText(\"Save (draft)\").click();", "     |   ^", "  11 |   await next();"),
  );
  assert.equal(src, 'await page.getByText("Save (draft)").click();');
  const unbalanced = recurrenceSource(
    frameOf("> 10 |   await page.getByText(\"open (\").click();", "     |   ^", "  11 |   await next();"),
  );
  assert.equal(unbalanced, 'await page.getByText("open (").click();');
});

test("a trailing comment ending in a comma does not pull the next statement in", () => {
  const src = recurrenceSource(
    frameOf("> 10 |   await step(); // first the step,", "     |   ^", "  11 |   await next();"),
  );
  assert.equal(src, "await step(); // first the step,");
});

test("a test timeout whose next error points at no code keeps its own site", () => {
  const [k] = recurrenceKeysForTest({
    results: [
      {
        status: "timedOut",
        errors: [
          { message: "Test timeout of 300000ms exceeded.", location: { file: `${ROOT}/tests/x.spec.ts`, line: 3 } },
          { message: "Error: 1 flow error(s) during teardown" },
        ],
      },
    ],
  }, ROOT);
  assert.equal(k.file, "x.spec.ts");
  assert.equal(k.locator, null);
});

// ------------------------------------------------- review round 3 (#1626)

test("the // of a URL string is not read as a comment", () => {
  const closed = recurrenceSource(
    frameOf('> 10 |   await page.goto("http://x/a");', "     |   ^", "  11 |   await next();"),
  );
  assert.equal(closed, 'await page.goto("http://x/a");');
  const open = recurrenceSource(
    frameOf('> 10 |   const u = "http://" + path.join(', "     |   ^", "  11 |     base, id);"),
  );
  assert.equal(open, 'const u = "http://" + path.join( base, id);');
});

test("a comment's full stop does not pull the next statement in, a chain's dot does", () => {
  const src = recurrenceSource(frameOf("> 10 |   await step(); // done.", "     |   ^", "  11 |   await next();"));
  assert.equal(src, "await step(); // done.");
  const chain = recurrenceSource(frameOf("> 10 |   await page.", "     |   ^", "  11 |     getByTestId(\"a\").click();"));
  assert.equal(chain, 'await page. getByTestId("a").click();');
});
