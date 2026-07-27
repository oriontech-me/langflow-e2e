/**
 * Regenerates the indicator block in REGRESSIONS.md between the markers
 *   <!-- REGRESSIONS:START --> ... <!-- REGRESSIONS:END -->
 * from the hand-curated table in the `## Ledger` section.
 *
 * Run: `npx ts-node scripts/regressions-summary.ts` (or `npm run regressions:summary`).
 * Pass `--check` (or `npm run regressions:check`) to verify without writing:
 * exits 1 when the committed block disagrees with the table, which is how CI
 * catches a row added without regenerating.
 *
 * Lean metrics only: total caught, open/fixed, by severity, by area.
 * Idempotent: a second run with no table change produces no diff.
 * Fails loudly rather than emitting a wrong count — a wrong headline number is
 * the one outcome the ledger cannot afford. Aborts on: a missing, duplicated or
 * out-of-order marker; a missing or empty `## Ledger` section; a row without
 * exactly 9 columns; a `Severity` / `Status` outside its allowed set; an
 * `Area / Test` cell missing the `area · spec-file` separator; and two rows
 * carrying the same `Upstream` ticket.
 */

import * as fs from "fs";
import * as path from "path";

const FILE = path.join(__dirname, "..", "REGRESSIONS.md");
const START = "<!-- REGRESSIONS:START -->";
const END = "<!-- REGRESSIONS:END -->";
const LEDGER_HEADER = "## Ledger";
const AREA_SEPARATOR = "·";
const SEVERITIES = ["High", "Medium", "Low"] as const;
const STATUSES = ["Open", "Fixed"] as const;

type Severity = (typeof SEVERITIES)[number];
type Status = (typeof STATUSES)[number];

interface Row {
  areaTest: string;
  severity: Severity;
  status: Status;
  upstream: string;
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(literal: string): string {
  return literal.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Count non-overlapping occurrences of a literal. */
function countOccurrences(haystack: string, literal: string): number {
  return (haystack.match(new RegExp(escapeRe(literal), "g")) ?? []).length;
}

/** Split a markdown table row `| a | b |` into trimmed cell values. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Extract data rows of the table inside the `## Ledger` section. */
function parseLedger(md: string): Row[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === LEDGER_HEADER);
  if (start === -1) throw new Error(`Missing "${LEDGER_HEADER}" section in REGRESSIONS.md`);

  // Section runs until the next "## " header or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start + 1, end);
  const rows: Row[] = [];
  let seenSeparator = false;
  for (const line of section) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\s*\|[-\s|]+\|\s*$/.test(line)) {
      seenSeparator = true;
      continue;
    }
    const c = cells(line);
    // Header row: | Found | Area / Test | ... | — skip until after the separator.
    if (!seenSeparator) continue;
    // Schema: [Found, Area/Test, Regression, Severity, Detected by, Upstream, Status, Fixed in, Report]
    // Exact 9 columns — a stray pipe in any cell (even trailing ones) must fail
    // loudly rather than pass with a shifted row.
    if (c.length !== 9) {
      throw new Error(`Malformed ledger row (expected exactly 9 columns, got ${c.length}): ${line}`);
    }
    const [, areaTest, , severity, , upstream, status] = c;
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error(`Invalid Severity "${severity}" (must be High/Medium/Low): ${line}`);
    }
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Invalid Status "${status}" (must be Open/Fixed): ${line}`);
    }
    // The schema is `area · spec-file`; without the separator the whole cell
    // becomes the area and the by-area breakdown silently reports a spec path.
    if (!areaTest.includes(AREA_SEPARATOR)) {
      throw new Error(
        `Malformed "Area / Test" cell "${areaTest}" (expected "area ${AREA_SEPARATOR} spec-file"): ${line}`
      );
    }
    rows.push({ areaTest, severity: severity as Severity, status: status as Status, upstream });
  }

  if (rows.length === 0) {
    throw new Error(
      `"${LEDGER_HEADER}" section has no rows — refusing to publish a zero count. ` +
        `The ledger is append-only; an empty table means the file was damaged.`
    );
  }

  // A pasted row inflates the headline number, which is exactly the failure the
  // indicator must never have. One ticket, one row.
  const seen = new Map<string, string>();
  for (const row of rows) {
    const previous = seen.get(row.upstream);
    if (previous) {
      throw new Error(
        `Duplicate Upstream "${row.upstream}" in the ledger (rows "${previous}" and "${row.areaTest}") — one ticket, one row.`
      );
    }
    seen.set(row.upstream, row.areaTest);
  }

  return rows;
}

/** Area = the token before the `·` in the "Area / Test" cell. */
function areaOf(areaTest: string): string {
  return areaTest.slice(0, areaTest.indexOf(AREA_SEPARATOR)).trim();
}

function buildBlock(rows: Row[]): string {
  const total = rows.length;
  const open = rows.filter((r) => r.status === "Open").length;
  const fixed = rows.filter((r) => r.status === "Fixed").length;

  const bySev = SEVERITIES.map(
    (s) => `${s} ${rows.filter((r) => r.severity === s).length}`
  ).join(" · ");

  const areaCounts = new Map<string, number>();
  for (const r of rows) {
    const a = areaOf(r.areaTest);
    areaCounts.set(a, (areaCounts.get(a) ?? 0) + 1);
  }
  const byArea =
    [...areaCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([a, n]) => `${a} ${n}`)
      .join(" · ") || "—";

  return [
    START,
    `**Regressions caught:** ${total} — **Open:** ${open} · **Fixed:** ${fixed}`,
    "",
    `**By severity:** ${bySev}`,
    "",
    `**By area:** ${byArea}`,
    END,
  ].join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const md = fs.readFileSync(FILE, "utf8");

  const startCount = countOccurrences(md, START);
  const endCount = countOccurrences(md, END);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Expected exactly one ${START} and one ${END} (found ${startCount}/${endCount})`);
  }
  // Reversed markers would otherwise slice the file inside out: the block gets
  // duplicated and the prose between the markers is dropped, silently.
  if (md.indexOf(END) < md.indexOf(START)) {
    throw new Error(`${END} appears before ${START} in REGRESSIONS.md — markers are out of order.`);
  }

  const rows = parseLedger(md);
  const block = buildBlock(rows);

  const before = md.slice(0, md.indexOf(START));
  const after = md.slice(md.indexOf(END) + END.length);
  const next = before + block + after;

  if (next === md) {
    console.log(
      check
        ? `REGRESSIONS.md indicator is in sync with the table (${rows.length} regression(s)).`
        : "REGRESSIONS.md indicator already up to date."
    );
    return;
  }

  if (check) {
    console.error(
      "REGRESSIONS.md indicator is stale — the committed block disagrees with the Ledger table.\n" +
        "Run `npm run regressions:summary` and commit the result.\n\n" +
        `Expected block:\n${block}`
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(FILE, next);
  console.log(`REGRESSIONS.md indicator regenerated: ${rows.length} regression(s).`);
}

main();
