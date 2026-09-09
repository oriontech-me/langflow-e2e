#!/usr/bin/env node
/**
 * Renders `docs/triage/inherited-spec-triage.md` from the measurement's
 * `results.json` reports. Design: §2.
 *
 *   node scripts/build-triage-table.mjs --report s1.json --report s2.json \
 *     --report s3.json --out docs/triage/inherited-spec-triage.md
 *
 * Keyed on test TITLE, which the baseline records as collision-free and which
 * survives the path differences between a sharded and an unsharded report.
 */
import fs from "fs";
import { stripAnsi } from "./lib/infra-signatures.mjs";

const BACKEND_ERROR = "🚨 Backend Error";

/**
 * Every value `JSONReportTest.status` can hold — exactly these four, per
 * `node_modules/playwright/types/testReporter.d.ts`:
 *
 *   status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
 *
 * Named as a constant because `verdictFor` below must decide about all four AND
 * refuse anything else. The likeliest source of a fifth value is a caller
 * reading `results[].status` instead of `tests[].status` — that field is
 * `TestStatus`, i.e. `'passed' | 'failed' | 'timedOut' | 'skipped' |
 * 'interrupted'`, which overlaps on exactly one word. So the refusal names the
 * value it saw: `"passed"` in that message is the whole diagnosis.
 */
export const TEST_STATUSES = ["skipped", "expected", "unexpected", "flaky"];

/** How many characters of a failure signature survive into a table cell. */
export const SIGNATURE_MAX_CHARS = 160;

/**
 * One table-safe line summarising a failing result's error, for the cause
 * clustering the design's §4 does off this table.
 *
 * **The truncation, stated explicitly** (three cuts, each for a reason):
 *  1. ANSI escapes are stripped — Playwright colourises error messages, and the
 *     shared `stripAnsi` also removes the bare `[2m` form whose escape byte
 *     goes missing somewhere between the reporter and an artifact (measured on
 *     `reports/daily-history.jsonl`, see `scripts/lib/infra-signatures.ts`);
 *  2. the FIRST non-empty line only — a Playwright error message leads with the
 *     assertion summary (`expect(locator).toBeVisible() failed`) and then
 *     carries a locator dump, a code snippet and a call log over dozens of
 *     lines. The first line is the clustering key; the rest is a screenful. It
 *     is also what makes the value table-safe at all: an embedded newline ends
 *     the markdown row;
 *  3. `SIGNATURE_MAX_CHARS`, with a trailing `…` so a reader can tell a
 *     truncated signature from a short one.
 *
 * Pipes are NOT escaped here: the row data is also the JSON sidecar's, and
 * markdown escaping belongs to `renderTable`. The full message stays in the
 * HTML report — this column exists so nobody has to open it once per red.
 */
export function summarizeSignature(message) {
  const firstLine =
    stripAnsi(String(message ?? ""))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine.length > SIGNATURE_MAX_CHARS
    ? `${firstLine.slice(0, SIGNATURE_MAX_CHARS)}…`
    : firstLine;
}

/**
 * The error message of this test's first failing attempt, summarised.
 *
 * `JSONReportTestResult` carries both `error` (a `TestError`) and `errors` (a
 * list); a failing result normally has both, and the singular is the same
 * object as `errors[0]`, so either answers. Reading the FIRST failing attempt
 * rather than the last is deliberate: on a `flaky` test the failure is attempt
 * 1 and the pass is the retry, so the last result carries no error at all and
 * the row would show a blank signature for the one verdict that most needs it.
 */
function firstErrorMessage(test) {
  for (const r of test?.results ?? []) {
    const message = r?.error?.message ?? r?.errors?.[0]?.message;
    if (typeof message === "string" && message.trim()) return summarizeSignature(message);
  }
  return "";
}

/**
 * A JSON reporter's `JSONReportSTDIOEntry` is `{ text: string } | { buffer:
 * string }` (`node_modules/playwright/types/testReporter.d.ts`) -- an object
 * either way, never a bare string. Naively reading `String(chunk?.text ??
 * chunk)` handles the text variant fine but stringifies a buffer chunk's
 * OBJECT to the literal text `"[object Object]"`, so a `🚨 Backend Error` that
 * Playwright's own reporter happened to encode as base64 would silently not be
 * counted. Undercounting reads as clean, which this table exists to rule out,
 * so both variants are decoded; anything else is treated as empty text rather
 * than guessed at.
 */
function chunkText(chunk) {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.buffer === "string") {
    try {
      return Buffer.from(chunk.buffer, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

export function reportTotal(report) {
  const s = report?.stats ?? {};
  return (s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0) + (s.skipped ?? 0);
}

/**
 * `signature` is the one field added after the original review (finding A2).
 * It has to live on the observation because `rowsFor` — the single shared row
 * computation both renderers consume — receives nothing but this map, and the
 * design's Output section mandates the failure signature per row. Purely
 * additive: no existing key or value changes.
 */
export function collectObservations(report) {
  const out = new Map();
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const backendErrors = (t.results ?? [])
            .flatMap((r) => r.stdout ?? [])
            .filter((chunk) => chunkText(chunk).includes(BACKEND_ERROR)).length;
          const list = out.get(spec.title) ?? [];
          list.push({ status: t.status, backendErrors, signature: firstErrorMessage(t) });
          out.set(spec.title, list);
        }
      }
      walk(suite.suites);
    }
  };
  walk(report?.suites);
  return out;
}

/**
 * The verdict for one baseline test, over however many observations exist.
 *
 * All four of `TEST_STATUSES` are decided about here, and anything else is
 * refused. Three of them used to be handled, and the two gaps both landed on
 * the expensive side — `hard-failure` is what the design's §3 routes to PARK,
 * i.e. "file a product bug against Langflow":
 *
 *  - **`flaky`.** Playwright reports a test as `flaky` when it failed and then
 *    passed on a retry. Read as "not `expected`, not `skipped`", three flaky
 *    observations scored `0/3 green` → `hard-failure`: a test that passed every
 *    single time it was retried, recorded as never having passed. It is folded
 *    into the `flaky` VERDICT (which is what it is), but the retry is named in
 *    the detail rather than left to look like a failure.
 *  - **`skipped`, partially.** A skip is not an observation of the test; it is
 *    the absence of one. Counting it in the denominator turned `skipped + 2
 *    green` into `2/3 green` → `flaky`, i.e. an investigation for a test that
 *    never once failed. Skips leave the ratio and are reported alongside it.
 *
 * A partially-skipped test whose measured runs are all green is reported
 * `green` **with the skip count in the detail** (`2/2 green, 1 skipped`), not
 * as a fourth state. That is deliberate and it is where the reader has to look:
 * §3's PROMOTE gate demands "3/3 green, no exceptions", and `2/2 green, 1
 * skipped` fails that gate on its face — the detail is the rendered cell, so
 * the shortfall is on the page, not buried in the icon.
 *
 * An unrecognised status is `unknown` **with the value named** — never a
 * decided failure. This repo's rule is that an unmeasured thing is never a
 * clean thing; it is equally never a failed one (#1012).
 */
export function verdictFor(observations) {
  const n = observations.length;
  if (n === 0) {
    return {
      verdict: "unknown",
      detail: "absent from every report — not measured, and an unmeasured test is not a clean one",
    };
  }

  // Checked before anything is counted: a status this function does not
  // understand makes every count over that list unreliable, so the verdict is
  // undecided rather than derived from a partial read.
  const strange = observations.filter((o) => !TEST_STATUSES.includes(o.status));
  if (strange.length) {
    const values = [...new Set(strange.map((o) => JSON.stringify(o.status)))].sort();
    return {
      verdict: "unknown",
      detail:
        `unrecognised status ${values.join(", ")} in ${strange.length} of ${n} observation(s) — ` +
        `Playwright reports ${TEST_STATUSES.join("/")}; not decided either way`,
    };
  }

  const green = observations.filter((o) => o.status === "expected").length;
  const retried = observations.filter((o) => o.status === "flaky").length;
  const skipped = observations.filter((o) => o.status === "skipped").length;
  const measured = n - skipped;

  if (measured === 0) return { verdict: "skipped", detail: `skipped in ${n}/${n} run(s)` };

  const parts = [`${green}/${measured} green`];
  if (retried) parts.push(`${retried} passed on retry`);
  if (skipped) parts.push(`${skipped} skipped`);
  const detail = parts.join(", ");

  if (green === measured && retried === 0) return { verdict: "green", detail };
  if (green === 0 && retried === 0) return { verdict: "hard-failure", detail };
  return { verdict: "flaky", detail };
}

const ICON = {
  green: "✅", flaky: "🟡", "hard-failure": "❌", skipped: "⏭️", unknown: "❔",
};

/**
 * How many stray titles to name before eliding the rest -- same convention as
 * `partition-shards.mjs`'s unmeasured-file list: never silently truncate a
 * list of names, always print how many were left out.
 */
export const UNMATCHED_TITLE_CAP = 30;

/**
 * Titles present in the observed reports but absent from the baseline.
 *
 * `renderTable` and `renderJson` both iterate the BASELINE and look each of
 * its tests up in the observations -- a report row whose title has no
 * baseline entry is simply never visited by that walk, so it is silently
 * discarded. That is the wrong direction of silence: it means the `--grep`
 * fragment that produced the report matched something outside the
 * 92-test population, the exact failure mode Task 4's anchoring (whitespace
 * boundaries plus a tag-only tail) exists to rule out. This is surfaced
 * separately from the per-baseline-test UNKNOWN rows, which cover the
 * opposite direction -- a baseline test absent from every report.
 */
export function unmatchedTitles(baseline, byTitle) {
  const known = new Set();
  for (const spec of baseline?.specs ?? []) {
    for (const t of spec.tests ?? []) known.add(t.title);
  }
  return [...byTitle.keys()].filter((title) => !known.has(title)).sort();
}

/** Lines describing `unmatched`, capped and with the elided count printed. */
function unmatchedWarningLines(unmatched) {
  const lines = [
    `${unmatched.length} observed test title(s) are not in the baseline -- the ` +
      "`--grep` fragment that produced a report matched something outside the " +
      "92-test population (Task 4's anchoring exists to rule this out; re-check " +
      "the fragment before trusting the rows above):",
    ...unmatched.slice(0, UNMATCHED_TITLE_CAP).map((title) => `  - ${title}`),
  ];
  if (unmatched.length > UNMATCHED_TITLE_CAP) {
    lines.push(`  - … and ${unmatched.length - UNMATCHED_TITLE_CAP} more not listed here`);
  }
  return lines;
}

/**
 * One row per baseline test -- the verdict, its detail and its backend-error
 * count against whichever reports are currently loaded. `renderTable` and
 * `renderJson` both consume this rather than each re-deriving a row, because
 * the JSON sidecar's whole reason to exist is that the re-dispatch of the
 * non-green tests reads DATA, not a re-parse of our own rendered markdown --
 * a guarantee that only holds if the two outputs cannot independently drift
 * on how a row is computed.
 *
 * Two fields the design mandates and the first version dropped (finding A2):
 *
 *  - **`modifier`** — the quarantine marker, read straight off the baseline.
 *    Seven of the 92 are `test.skip` / `test.fixme` declarations that the
 *    measurement unmutes on a throwaway branch (design §2), so a row reading
 *    `3/3 green` for a test that is quarantined on `main` is the single most
 *    misleading row this table can produce. The marker survives the unmute
 *    because the table is rendered from the ISSUE branch's committed baseline
 *    (plan Task 7 checks the branch back out before rendering), which records
 *    `main`'s declaration, not the measurement branch's.
 *  - **`signature` / `signatureCount`** — the failure signature. §4 clusters
 *    the follow-up issues by root cause read off this table; without it
 *    whoever files them reopens the HTML report once per red, which is the
 *    cost this instrument exists to remove. `signatureCount` is the number of
 *    DISTINCT signatures seen across the observations, because a test failing
 *    two different ways is two clusters, and naming only the first would hide
 *    the second silently (#1012).
 */
export function rowsFor(baseline, byTitle) {
  const rows = [];
  for (const spec of baseline.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const obs = byTitle.get(t.title) ?? [];
      const { verdict, detail } = verdictFor(obs);
      const signatures = [...new Set(obs.map((o) => o.signature).filter((s) => s))];
      rows.push({
        spec: spec.relativePath,
        tier: spec.tier,
        title: t.title,
        modifier: t.modifier ?? "",
        verdict,
        detail,
        backendErrors: obs.reduce((a, o) => a + (o.backendErrors ?? 0), 0),
        signature: signatures[0] ?? "",
        signatureCount: signatures.length,
      });
    }
  }
  return rows;
}

/** Markdown-safe cell text: an unescaped `|` ends the cell and shifts the row. */
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|");

/** The quarantine marker as rendered — empty for a plain `test(...)`. */
export const quarantineCell = (modifier) => (modifier ? `\`test.${modifier}\`` : "");

/** The signature cell, naming how many further distinct signatures were seen. */
export const signatureCell = (row) =>
  row.signatureCount > 1
    ? `${cell(row.signature)} (+${row.signatureCount - 1} more distinct)`
    : cell(row.signature);

export function renderTable(baseline, byTitle) {
  const lines = [
    "<!-- Generated by scripts/build-triage-table.mjs. Do not hand-edit. -->",
    "",
    "# Inherited spec triage — measured verdicts",
    "",
    "One row per test in `tests/assets/triage/inherited-backlog-baseline.json`.",
    "A verdict is an input to the decision rules in",
    "`docs/triage/inherited-spec-triage-design.md` §3, never a conclusion.",
    "",
    "`Quarantine` names the declaration as committed on `main`: such a test is",
    "unmuted on the throwaway measurement branch, so its verdict is real, but it",
    "runs nowhere until the modifier is removed for good.",
    "",
    "Two of the facts design §2 lists per row are **not** derivable from a",
    "Playwright report and are deliberately absent here: whether the spec leaked",
    "a flow, and the duplicate candidate. They are read by a human during triage",
    "and recorded in the cause-cluster issue (§4), never in this generated file —",
    "a hand-added column would be destroyed by the next render.",
    "",
    "| | Tier | Spec | Test | Quarantine | Verdict | Backend errors | Failure signature |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const tally = {};
  for (const row of rowsFor(baseline, byTitle)) {
    tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
    lines.push(
      `| ${ICON[row.verdict]} | ${row.tier} | \`${row.spec}\` | ${cell(row.title)} ` +
        `| ${quarantineCell(row.modifier)} | ${row.detail} | ${row.backendErrors || ""} ` +
        `| ${signatureCell(row)} |`,
    );
  }
  lines.push("", "## Tally", "");
  for (const [k, v] of Object.entries(tally).sort()) lines.push(`- ${ICON[k]} ${k}: ${v}`);

  // The opposite direction of silence (see `unmatchedTitles`): named here, next
  // to the tally, so a reader of the table itself -- not just the job log --
  // sees that a report reached outside the population it was supposed to measure.
  const unmatched = unmatchedTitles(baseline, byTitle);
  if (unmatched.length) {
    const [header, ...rest] = unmatchedWarningLines(unmatched);
    lines.push("", "## Warnings", "", `- ⚠️ ${header}`, ...rest);
  }
  lines.push("");
  return lines.join("\n");
}

/** The same verdicts as the table, in a shape the re-dispatch can read back. */
export function renderJson(baseline, byTitle) {
  const rows = rowsFor(baseline, byTitle);
  const unmatched = unmatchedTitles(baseline, byTitle);
  const warnings = unmatched.length
    ? [{
        type: "observed-not-in-baseline",
        count: unmatched.length,
        titles: unmatched.slice(0, UNMATCHED_TITLE_CAP),
        elided: Math.max(0, unmatched.length - UNMATCHED_TITLE_CAP),
      }]
    : [];
  return { version: 1, rows, warnings };
}

function args(argv, name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
    if (a.startsWith(`--${name}=`)) out.push(a.split("=").slice(1).join("="));
  });
  return out;
}

function main(argv) {
  const baselinePath = args(argv, "baseline")[0] ?? "tests/assets/triage/inherited-backlog-baseline.json";
  const reportPaths = args(argv, "report");
  const outPath = args(argv, "out")[0] ?? "docs/triage/inherited-spec-triage.md";
  if (!reportPaths.length) {
    console.error("[triage-table] no --report given: nothing to measure");
    return 1;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const byTitle = new Map();
  for (const p of reportPaths) {
    const report = JSON.parse(fs.readFileSync(p, "utf8"));
    const total = reportTotal(report);
    if (total === 0) {
      console.error(
        `[triage-table] ABORT: ${p} executed zero tests. A dispatch whose --grep matched ` +
          "nothing is green and measures nothing; treating it as data would record every " +
          "test in that shard as unmeasured while implying the run covered them.",
      );
      return 2;
    }
    console.log(`[triage-table] ${p}: ${total} test result(s)`);
    for (const [title, obs] of collectObservations(report)) {
      byTitle.set(title, [...(byTitle.get(title) ?? []), ...obs]);
    }
  }

  // Same information as the "## Warnings" section, printed to the job log too --
  // a reader should not have to open the generated doc to learn a report reached
  // outside the population (#1012's rule: never silently, and never in only one
  // of the two places someone might look).
  const unmatched = unmatchedTitles(baseline, byTitle);
  if (unmatched.length) {
    console.warn(["[triage-table] WARNING:", ...unmatchedWarningLines(unmatched)].join("\n"));
  }

  fs.writeFileSync(outPath, renderTable(baseline, byTitle));
  console.log(`[triage-table] wrote ${outPath}`);
  const jsonPath = args(argv, "out-json")[0];
  if (jsonPath) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(renderJson(baseline, byTitle), null, 2)}\n`);
    console.log(`[triage-table] wrote ${jsonPath}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Mirrors `build-triage-grep.mjs`: an I/O failure is a NAMED refusal, not a
  // raw stack. This is the likeliest first-dispatch failure of the whole
  // instrument — the runbook globs `/tmp/triage/*/results.json`, and under bash
  // an unmatched glob stays LITERAL, so a failed `gh run download` hands the
  // pattern itself to `--report` and the operator needs to read "no such file",
  // not eight frames of node internals.
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[triage-table] ${err.message}`);
    process.exit(1);
  }
}
