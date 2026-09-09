import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  reportTotal, collectObservations, verdictFor, renderTable, renderJson,
  unmatchedTitles, UNMATCHED_TITLE_CAP, rowsFor, summarizeSignature,
  SIGNATURE_MAX_CHARS, quarantineCell, signatureCell,
} from "./build-triage-table.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./build-triage-table.mjs", import.meta.url));

const report = (specs, stats) => ({
  stats: stats ?? { expected: specs.length, unexpected: 0, flaky: 0, skipped: 0 },
  suites: [{ title: "file", file: "a/x.spec.ts", specs, suites: [] }],
});
const spec = (title, status, stdout = []) => ({
  title, tests: [{ status, results: [{ status: status === "expected" ? "passed" : "failed", stdout }] }],
});

test("reportTotal reads stats, not the suite walk", () => {
  assert.equal(reportTotal(report([spec("a", "expected")])), 1);
  assert.equal(reportTotal({ stats: {}, suites: [] }), 0);
  assert.equal(reportTotal(null), 0);
});

test("collectObservations keys by test title", () => {
  const obs = collectObservations(report([spec("a", "expected"), spec("b", "unexpected")]));
  assert.deepEqual([...obs.keys()].sort(), ["a", "b"]);
  assert.equal(obs.get("a")[0].status, "expected");
});

test("collectObservations finds a backend error in stdout", () => {
  // The fixture logs it on stdout, which is where it goes -- a grep of stderr
  // under a JSON reporter returns a false zero.
  const obs = collectObservations(report([
    spec("a", "expected", [{ text: "🚨 Backend Error: 500 POST /api/v1/flows/\n" }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 1);
});

// P4: `JSONReportSTDIOEntry` (node_modules/playwright/types/testReporter.d.ts)
// is `{ text: string } | { buffer: string }` -- an object either way, never a
// bare string. A naive `String(chunk?.text ?? chunk)` reads the text variant
// above fine but stringifies the OBJECT for a buffer chunk to the literal
// "[object Object]", so a backend error Playwright encoded as base64 would
// silently not be counted. This is the one shape verified against the
// installed Playwright's own type declarations rather than a guess.
test("collectObservations decodes a base64 buffer stdout chunk, not just the text variant", () => {
  const encoded = Buffer.from("🚨 Backend Error: 500 POST /api/v1/flows/\n", "utf8").toString("base64");
  const obs = collectObservations(report([
    spec("a", "expected", [{ buffer: encoded }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 1);
});

test("collectObservations treats an unrecognized stdout chunk shape as empty, not a crash", () => {
  const obs = collectObservations(report([
    spec("a", "expected", [{ somethingElse: true }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 0);
});

// The recursive `walk` in collectObservations, on the shape it actually meets:
// the real suite nests `test.describe` inside `test.describe`, so a spec can
// sit two suite levels below the file. Reviewed as "the one production-critical
// path exercised only by hand" — 4 lines of fixture closes that.
test("collectObservations descends through multi-level nested suites", () => {
  const obs = collectObservations({
    stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{
      title: "file", file: "a/x.spec.ts",
      specs: [spec("top level", "expected")],
      suites: [{
        title: "outer describe",
        specs: [spec("one level down", "expected")],
        suites: [{ title: "inner describe", specs: [spec("two levels down", "unexpected")], suites: [] }],
      }],
    }],
  });
  assert.deepEqual([...obs.keys()].sort(), ["one level down", "top level", "two levels down"]);
  assert.equal(obs.get("two levels down")[0].status, "unexpected");
});

test("verdictFor: all green over three observations", () => {
  const v = verdictFor([{ status: "expected" }, { status: "expected" }, { status: "expected" }]);
  assert.equal(v.verdict, "green");
  assert.match(v.detail, /3\/3/);
});

test("verdictFor: mixed is flaky with the rate", () => {
  const v = verdictFor([{ status: "expected" }, { status: "unexpected" }, { status: "expected" }]);
  assert.equal(v.verdict, "flaky");
  assert.match(v.detail, /2\/3/);
});

test("verdictFor: never passing is a hard failure", () => {
  assert.equal(verdictFor([{ status: "unexpected" }, { status: "unexpected" }]).verdict, "hard-failure");
});

test("verdictFor: only skipped is 'skipped', not green", () => {
  assert.equal(verdictFor([{ status: "skipped" }, { status: "skipped" }]).verdict, "skipped");
});

test("verdictFor: no observation is UNKNOWN, never clean", () => {
  const v = verdictFor([]);
  assert.equal(v.verdict, "unknown");
  assert.match(v.detail, /absent from every report/i);
});

// ── A1: all FOUR of Playwright's statuses ────────────────────────────────────
//
// `JSONReportTest.status` is exactly `'skipped' | 'expected' | 'unexpected' |
// 'flaky'` (node_modules/playwright/types/testReporter.d.ts). Three were
// handled; both gaps landed on the expensive side, because `hard-failure` is
// the verdict the design's §3 routes to PARK — "file a product bug".

test("verdictFor: a flaky observation is a retry, not a failure — measured 0/3 green -> hard-failure", () => {
  // Before the fix: {verdict:"hard-failure", detail:"0/3 green"} — a test that
  // passed every time it was retried, recorded as never having passed.
  const v = verdictFor([{ status: "flaky" }, { status: "flaky" }, { status: "flaky" }]);
  assert.equal(v.verdict, "flaky", "a retried pass is flaky, never a hard failure");
  assert.match(v.detail, /passed on retry/, "the retry must be visible, not silently read as a failure");
  assert.match(v.detail, /3 passed on retry/);
});

test("verdictFor: a flaky observation alongside a green one stays flaky and names the retry", () => {
  const v = verdictFor([{ status: "expected" }, { status: "flaky" }, { status: "expected" }]);
  assert.equal(v.verdict, "flaky", "a retry anywhere in the set disqualifies the green verdict");
  assert.match(v.detail, /2\/3 green, 1 passed on retry/);
});

test("verdictFor: a skipped observation does not dilute the green ratio — measured 2/3 green -> flaky", () => {
  // Before the fix: {verdict:"flaky", detail:"2/3 green"} — an investigation
  // opened for a test that never once failed. A skip is the ABSENCE of an
  // observation, so it leaves the ratio and is reported alongside it.
  const v = verdictFor([{ status: "skipped" }, { status: "expected" }, { status: "expected" }]);
  assert.equal(v.verdict, "green");
  assert.equal(v.detail, "2/2 green, 1 skipped");
});

test("verdictFor: a skip alongside a real failure is still counted out of the ratio", () => {
  const v = verdictFor([{ status: "skipped" }, { status: "unexpected" }, { status: "unexpected" }]);
  assert.equal(v.verdict, "hard-failure");
  assert.equal(v.detail, "0/2 green, 1 skipped");
});

test("verdictFor: a status outside Playwright's four is UNKNOWN with the value named", () => {
  // The likeliest cause is reading `results[].status` (TestStatus: passed /
  // failed / timedOut / skipped / interrupted) instead of `tests[].status`, so
  // the offending value IS the diagnosis. Never a decided failure: an
  // unmeasured thing is never clean, and equally never failed.
  const v = verdictFor([{ status: "passed" }, { status: "passed" }, { status: "passed" }]);
  assert.equal(v.verdict, "unknown");
  assert.match(v.detail, /"passed"/, "the message must name the value it could not read");
  assert.match(v.detail, /not decided either way/);
});

test("verdictFor: one unrecognised status among greens is undecided, not 2/3 green", () => {
  const v = verdictFor([{ status: "expected" }, { status: "expected" }, { status: "interrupted" }]);
  assert.equal(v.verdict, "unknown");
  assert.match(v.detail, /"interrupted"/);
  assert.match(v.detail, /1 of 3 observation\(s\)/);
});

// ── A2: the failure signature, and its stated truncation ─────────────────────

test("summarizeSignature keeps the first line, strips ANSI, and caps the length", () => {
  assert.equal(
    summarizeSignature("[31mError: expect(locator).toBeVisible() failed[39m\n\nLocator: …\n  at foo"),
    "Error: expect(locator).toBeVisible() failed",
  );
  // The bare `[2m` form, whose escape byte goes missing between the reporter
  // and an artifact — shared stripAnsi handles both (infra-signatures.ts).
  assert.equal(summarizeSignature("Error: [2mexpect([22mfoo)"), "Error: expect(foo)");
  assert.equal(summarizeSignature(""), "");
  assert.equal(summarizeSignature(undefined), "");
  // An embedded newline would end the markdown row, so it can never survive.
  assert.doesNotMatch(summarizeSignature("a\nb"), /\n/);

  const long = summarizeSignature("x".repeat(SIGNATURE_MAX_CHARS + 50));
  assert.equal(long.length, SIGNATURE_MAX_CHARS + 1, "capped, plus the ellipsis");
  assert.ok(long.endsWith("…"), "a truncated signature must be distinguishable from a short one");
});

test("collectObservations reads the FIRST failing attempt's error, so a retried failure keeps its signature", () => {
  // A `flaky` test's error lives on attempt 1; the retry that passed carries
  // none, so reading the last result would blank the one verdict most in need
  // of a signature.
  const obs = collectObservations({
    stats: { expected: 0, unexpected: 0, flaky: 1, skipped: 0 },
    suites: [{
      title: "file", file: "a/x.spec.ts", suites: [],
      specs: [{
        title: "a",
        tests: [{
          status: "flaky",
          results: [
            { status: "failed", error: { message: "Error: locator resolved to 2 elements\n  at line 3" }, stdout: [] },
            { status: "passed", stdout: [] },
          ],
        }],
      }],
    }],
  });
  assert.equal(obs.get("a")[0].signature, "Error: locator resolved to 2 elements");
});

test("collectObservations falls back to errors[0] when the singular error is absent", () => {
  const obs = collectObservations({
    stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{
      title: "file", file: "a/x.spec.ts", suites: [],
      specs: [{
        title: "a",
        tests: [{ status: "unexpected", results: [{ status: "failed", errors: [{ message: "Timeout 300000ms exceeded." }], stdout: [] }] }],
      }],
    }],
  });
  assert.equal(obs.get("a")[0].signature, "Timeout 300000ms exceeded.");
});

test("rowsFor carries the quarantine marker off the baseline and the failure signature off the report", () => {
  // The most misleading row this table can produce is `3/3 green` for a test
  // that is `test.fixme` on main — the measurement unmutes the 7 quarantined
  // declarations on a throwaway branch (design §2), so the verdict is real but
  // the test runs nowhere until the modifier is removed for good.
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T1", tests: [
    { title: "muted but green", modifier: "fixme" },
    { title: "plain and red", modifier: "" },
  ] }] };
  const byTitle = collectObservations({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{
      title: "file", file: "a/x.spec.ts", suites: [],
      specs: [
        { title: "muted but green", tests: [{ status: "expected", results: [{ status: "passed", stdout: [] }] }] },
        { title: "plain and red", tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "Error: nope" }, stdout: [] }] }] },
      ],
    }],
  });

  const rows = rowsFor(baseline, byTitle);
  assert.deepEqual(rows.map((r) => [r.title, r.modifier, r.signature, r.signatureCount]), [
    ["muted but green", "fixme", "", 0],
    ["plain and red", "", "Error: nope", 1],
  ]);

  const md = renderTable(baseline, byTitle);
  assert.match(md, /\| Quarantine \|/, "the rendered table must have the column, not just the row data");
  assert.match(md, /\| `test\.fixme` \|/, "a quarantined test's row must say so");
  assert.match(md, /Error: nope/, "the signature must reach the rendered table");
  assert.deepEqual(renderJson(baseline, byTitle).rows, rows, "the sidecar carries both fields too");
});

test("rowsFor counts DISTINCT signatures, so a test failing two ways does not hide one", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "a", modifier: "" }] }] };
  const mk = (message) => ({
    stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{ title: "f", file: "a/x.spec.ts", suites: [], specs: [
      { title: "a", tests: [{ status: "unexpected", results: [{ status: "failed", error: { message }, stdout: [] }] }] },
    ] }],
  });
  const byTitle = collectObservations(mk("Error: first way"));
  for (const [t, obs] of collectObservations(mk("Error: second way"))) {
    byTitle.set(t, [...(byTitle.get(t) ?? []), ...obs]);
  }
  const [row] = rowsFor(baseline, byTitle);
  assert.equal(row.signature, "Error: first way");
  assert.equal(row.signatureCount, 2);
  assert.equal(signatureCell(row), "Error: first way (+1 more distinct)");
  assert.match(renderTable(baseline, byTitle), /\(\+1 more distinct\)/);
});

test("a pipe in a title or a signature is escaped, so the row cannot shift its columns", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "a|b", modifier: "" }] }] };
  const byTitle = collectObservations({
    stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{ title: "f", file: "a/x.spec.ts", suites: [], specs: [
      { title: "a|b", tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "Error: got x|y" }, stdout: [] }] }] },
    ] }],
  });
  const md = renderTable(baseline, byTitle);
  assert.match(md, /a\\\|b/);
  assert.match(md, /Error: got x\\\|y/);
  // The DATA stays raw: the sidecar is read by a script, not by markdown.
  assert.equal(rowsFor(baseline, byTitle)[0].signature, "Error: got x|y");
  assert.equal(quarantineCell(""), "");
  assert.equal(quarantineCell("skip"), "`test.skip`");
});

test("renderJson carries one machine-readable row per baseline test", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const j = renderJson(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.equal(j.version, 1);
  assert.deepEqual(j.rows.map((r) => [r.title, r.verdict]), [["seen", "green"], ["never ran", "unknown"]]);
  assert.equal(j.rows[0].spec, "a/x.spec.ts");
});

test("renderTable lists every baseline test, including the unobserved ones", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const md = renderTable(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.match(md, /seen/);
  assert.match(md, /never ran/);
  assert.match(md, /unknown/i);
});

// P10: the opposite direction of silence. `renderTable`/`renderJson` iterate
// the BASELINE and look each of its titles up in the observations, so a
// report row whose title is NOT in the baseline is invisible to that walk --
// it means the `--grep` fragment reached outside the 92-test population
// (the exact failure mode Task 4's anchoring exists to rule out), and that
// must not be silently dropped.
test("unmatchedTitles finds an observed title absent from the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const byTitle = collectObservations(report([spec("known", "expected"), spec("mystery", "expected")]));
  assert.deepEqual(unmatchedTitles(baseline, byTitle), ["mystery"]);
});

test("unmatchedTitles is empty when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const byTitle = collectObservations(report([spec("known", "expected")]));
  assert.deepEqual(unmatchedTitles(baseline, byTitle), []);
});

test("renderTable warns about, and names, an observed title outside the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const md = renderTable(
    baseline,
    collectObservations(report([spec("known", "expected"), spec("mystery", "expected")])),
  );
  assert.match(md, /## Warnings/);
  assert.match(md, /not in the baseline/i);
  assert.match(md, /mystery/);
});

test("renderTable has no Warnings section when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const md = renderTable(baseline, collectObservations(report([spec("known", "expected")])));
  assert.doesNotMatch(md, /## Warnings/);
});

test("renderJson carries a structured warning for an observed title outside the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const j = renderJson(
    baseline,
    collectObservations(report([spec("known", "expected"), spec("mystery", "expected")])),
  );
  assert.equal(j.warnings.length, 1);
  assert.equal(j.warnings[0].type, "observed-not-in-baseline");
  assert.equal(j.warnings[0].count, 1);
  assert.deepEqual(j.warnings[0].titles, ["mystery"]);
  assert.equal(j.warnings[0].elided, 0);
});

test("renderJson.warnings is empty when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const j = renderJson(baseline, collectObservations(report([spec("known", "expected")])));
  assert.deepEqual(j.warnings, []);
});

test("the unmatched-title warning is capped and names how many it elided", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const strays = Array.from({ length: UNMATCHED_TITLE_CAP + 5 }, (_, i) => spec(`mystery-${i}`, "expected"));
  const byTitle = collectObservations(report([spec("known", "expected"), ...strays]));

  const j = renderJson(baseline, byTitle);
  assert.equal(j.warnings[0].count, UNMATCHED_TITLE_CAP + 5);
  assert.equal(j.warnings[0].titles.length, UNMATCHED_TITLE_CAP);
  assert.equal(j.warnings[0].elided, 5);

  const md = renderTable(baseline, byTitle);
  assert.match(md, /5 more not listed here/);
});

// Finding 2 (review of this task): renderTable and renderJson each used to
// independently recompute a row from the baseline + observations. Extracted
// into rowsFor() so both renderers consume the same computation -- the JSON
// sidecar's whole reason to exist is that the re-dispatch of the non-green
// tests reads DATA, not a re-parse of our own rendered markdown, and that only
// holds if the two outputs cannot drift apart on how a row is computed.
test("rowsFor: the markdown and the JSON sidecar describe the same verdicts for the same titles", () => {
  const baseline = {
    specs: [
      { relativePath: "a/x.spec.ts", tier: "T2", tests: [
        { title: "always green" }, { title: "sometimes green" }, { title: "never green" },
      ] },
      { relativePath: "b/y.spec.ts", tier: "T1", tests: [{ title: "only skipped" }, { title: "not run" }] },
    ],
  };
  const byTitle = collectObservations(report([
    spec("always green", "expected"),
    spec("sometimes green", "expected"),
    spec("never green", "unexpected", [{ text: "🚨 Backend Error: 500 POST /api/v1/flows/\n" }]),
    spec("only skipped", "skipped"),
  ]));
  // A second "run" folded into the same map, the way main()'s multi-report
  // loop does -- flips "sometimes green" to flaky.
  for (const [title, obs] of collectObservations(report([spec("sometimes green", "unexpected")]))) {
    byTitle.set(title, [...(byTitle.get(title) ?? []), ...obs]);
  }

  const rows = rowsFor(baseline, byTitle);
  const json = renderJson(baseline, byTitle);
  const md = renderTable(baseline, byTitle);

  // Covers every verdict rowsFor can produce, so the agreement check below is
  // not vacuously true over a single verdict kind.
  assert.deepEqual(
    rows.map((r) => [r.title, r.verdict]),
    [
      ["always green", "green"],
      ["sometimes green", "flaky"],
      ["never green", "hard-failure"],
      ["only skipped", "skipped"],
      ["not run", "unknown"],
    ],
  );

  // The sidecar's rows must BE what rowsFor computed, not a re-derivation
  // that merely happens to agree today.
  assert.deepEqual(json.rows, rows);

  // Every row rowsFor produced must appear in the rendered table -- spec,
  // tier, title, verdict detail and backend-error count together -- proving
  // renderTable consumed the SAME rows rather than recomputing verdictFor()
  // (or the backendErrors reduce) on its own.
  for (const row of rows) {
    const expectedFragment =
      `| ${row.tier} | \`${row.spec}\` | ${row.title.replace(/\|/g, "\\|")} ` +
      `| ${quarantineCell(row.modifier)} | ${row.detail} | ${row.backendErrors || ""} ` +
      `| ${signatureCell(row)} |`;
    assert.ok(
      md.includes(expectedFragment),
      `expected the table to contain a row for "${row.title}": ${expectedFragment}\n---\n${md}`,
    );
  }
});

// ── CLI-level tests: the three exit-code outcomes main() decides between ──
//
// Every temp file below lives under makeTempDir() -- never in the repo -- so
// this file cannot create or modify docs/triage/inherited-spec-triage.md.

const smallBaseline = {
  specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "alpha" }, { title: "beta" }] }],
};

test("CLI: no --report given exits 1 and writes no output file", () => {
  const dir = makeTempDir("triage-table-cli-");
  const baselinePath = join(dir, "baseline.json");
  const outPath = join(dir, "out.md");
  writeFileSync(baselinePath, JSON.stringify(smallBaseline));

  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, "--baseline", baselinePath, "--out", outPath], {
        encoding: "utf-8",
        stdio: "pipe",
      }),
    (error) => error.status === 1,
    "no --report is a usage error, not a run with nothing to show",
  );
  assert.equal(existsSync(outPath), false, "an aborted run must not leave an output file behind");
});

test("CLI: a report whose stats total is zero exits 2 and writes no output file", () => {
  // The state this task exists to enforce: a --grep that matched nothing is a
  // GREEN Playwright run that measured nothing. Treating it as data would
  // record every baseline test in that shard as unmeasured while implying the
  // shard covered them -- so this is an abort, not a data point.
  const dir = makeTempDir("triage-table-cli-");
  const baselinePath = join(dir, "baseline.json");
  const reportPath = join(dir, "results.json");
  const outPath = join(dir, "out.md");
  const outJsonPath = join(dir, "out.json");
  writeFileSync(baselinePath, JSON.stringify(smallBaseline));
  writeFileSync(reportPath, JSON.stringify(report([], { expected: 0, unexpected: 0, flaky: 0, skipped: 0 })));

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--baseline", baselinePath, "--report", reportPath, "--out", outPath, "--out-json", outJsonPath],
        { encoding: "utf-8", stdio: "pipe" },
      ),
    (error) => error.status === 2,
    "a zero-stats report is an abort, not a data point",
  );
  assert.equal(existsSync(outPath), false, "an aborted run must not leave a markdown table behind");
  assert.equal(existsSync(outJsonPath), false, "an aborted run must not leave a JSON sidecar behind");
});

// A5: the likeliest first-dispatch failure. The runbook globs
// `/tmp/triage/*/results.json`; under bash an unmatched glob stays LITERAL, so
// a failed `gh run download` hands the pattern itself to `--report`. The
// sibling `build-triage-grep.mjs --baseline missing.json` prints
// `[triage-grep] ENOENT: no such file …`; this one printed a node stack.
//
// Asserting the exit code alone would be VACUOUS — node exits 1 on an uncaught
// throw too — so this asserts the SHAPE: a named one-liner, and no stack frames.
test("CLI: an unreadable --report is a named refusal, not a stack trace", () => {
  const dir = makeTempDir("triage-table-cli-");
  const baselinePath = join(dir, "baseline.json");
  const outPath = join(dir, "out.md");
  writeFileSync(baselinePath, JSON.stringify(smallBaseline));

  let stderr = "";
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--baseline", baselinePath, "--report", join(dir, "*", "results.json"), "--out", outPath],
        { encoding: "utf-8", stdio: "pipe" },
      ),
    (error) => {
      stderr = String(error.stderr ?? "");
      return error.status === 1;
    },
  );
  assert.match(stderr, /^\[triage-table\] ENOENT/m, "must name itself and the refusal, like the sibling does");
  assert.doesNotMatch(stderr, /\n\s+at /, "a stack trace is what this replaces");
  assert.equal(existsSync(outPath), false);
});

test("CLI: an unreadable --baseline is the same named refusal", () => {
  const dir = makeTempDir("triage-table-cli-");
  const reportPath = join(dir, "results.json");
  writeFileSync(reportPath, JSON.stringify(report([spec("alpha", "expected")])));

  let stderr = "";
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--baseline", join(dir, "nope.json"), "--report", reportPath, "--out", join(dir, "out.md")],
        { encoding: "utf-8", stdio: "pipe" },
      ),
    (error) => {
      stderr = String(error.stderr ?? "");
      return error.status === 1;
    },
  );
  assert.match(stderr, /^\[triage-table\] ENOENT/m);
  assert.doesNotMatch(stderr, /\n\s+at /);
});

test("CLI: a healthy run over more than one report exits 0 and writes both outputs", () => {
  const dir = makeTempDir("triage-table-cli-");
  const baselinePath = join(dir, "baseline.json");
  const report1Path = join(dir, "shard-1.json");
  const report2Path = join(dir, "shard-2.json");
  const outPath = join(dir, "out.md");
  const outJsonPath = join(dir, "out.json");
  writeFileSync(baselinePath, JSON.stringify(smallBaseline));
  // "alpha" is observed in both shards (green, then unexpected -> flaky);
  // "beta" is observed only in the second shard -- proves the CLI's loop
  // actually unions observations across every --report given, not just the
  // last one.
  writeFileSync(report1Path, JSON.stringify(report([spec("alpha", "expected")])));
  writeFileSync(
    report2Path,
    JSON.stringify(report([spec("alpha", "unexpected"), spec("beta", "expected")])),
  );

  const stdout = execFileSync(
    process.execPath,
    [
      SCRIPT, "--baseline", baselinePath,
      "--report", report1Path, "--report", report2Path,
      "--out", outPath, "--out-json", outJsonPath,
    ],
    { encoding: "utf-8", stdio: "pipe" },
  );
  assert.match(stdout, /wrote/);

  assert.equal(existsSync(outPath), true);
  const md = readFileSync(outPath, "utf-8");
  assert.match(md, /alpha/);
  assert.match(md, /flaky/);
  assert.match(md, /1\/2/);
  assert.match(md, /beta/);

  assert.equal(existsSync(outJsonPath), true);
  const json = JSON.parse(readFileSync(outJsonPath, "utf-8"));
  assert.equal(json.version, 1);
  assert.deepEqual(
    json.rows.map((r) => [r.title, r.verdict]),
    [["alpha", "flaky"], ["beta", "green"]],
  );
});
