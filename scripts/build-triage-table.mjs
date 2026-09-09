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

const BACKEND_ERROR = "🚨 Backend Error";

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
          list.push({ status: t.status, backendErrors });
          out.set(spec.title, list);
        }
      }
      walk(suite.suites);
    }
  };
  walk(report?.suites);
  return out;
}

export function verdictFor(observations) {
  const n = observations.length;
  if (n === 0) {
    return {
      verdict: "unknown",
      detail: "absent from every report — not measured, and an unmeasured test is not a clean one",
    };
  }
  const green = observations.filter((o) => o.status === "expected").length;
  const skipped = observations.filter((o) => o.status === "skipped").length;
  if (skipped === n) return { verdict: "skipped", detail: `skipped in ${n}/${n} run(s)` };
  if (green === n) return { verdict: "green", detail: `${green}/${n} green` };
  if (green === 0) return { verdict: "hard-failure", detail: `0/${n} green` };
  return { verdict: "flaky", detail: `${green}/${n} green` };
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
 */
export function rowsFor(baseline, byTitle) {
  const rows = [];
  for (const spec of baseline.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const obs = byTitle.get(t.title) ?? [];
      const { verdict, detail } = verdictFor(obs);
      rows.push({
        spec: spec.relativePath,
        tier: spec.tier,
        title: t.title,
        verdict,
        detail,
        backendErrors: obs.reduce((a, o) => a + (o.backendErrors ?? 0), 0),
      });
    }
  }
  return rows;
}

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
    "| | Tier | Spec | Test | Verdict | Backend errors |",
    "|---|---|---|---|---|---|",
  ];
  const tally = {};
  for (const row of rowsFor(baseline, byTitle)) {
    tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
    lines.push(
      `| ${ICON[row.verdict]} | ${row.tier} | \`${row.spec}\` | ${row.title.replace(/\|/g, "\\|")} ` +
        `| ${row.detail} | ${row.backendErrors || ""} |`,
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

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
