/**
 * Regenerates the indicator block in REGRESSIONS.md between the markers
 *   <!-- REGRESSIONS:START --> ... <!-- REGRESSIONS:END -->
 * from the hand-curated table in the `## Ledger` section.
 *
 * Run: `npx ts-node scripts/regressions-summary.ts` (or `npm run regressions:summary`).
 *
 * Lean metrics only: total caught, open/fixed, by severity, by area.
 * Idempotent: a second run with no table change produces no diff.
 * Fails loudly on a malformed row or a missing/duplicate marker/section —
 * never emits wrong counts.
 */

import * as fs from "fs";
import * as path from "path";

const FILE = path.join(__dirname, "..", "REGRESSIONS.md");
const START = "<!-- REGRESSIONS:START -->";
const END = "<!-- REGRESSIONS:END -->";
const LEDGER_HEADER = "## Ledger";
const SEVERITIES = ["High", "Medium", "Low"] as const;
const STATUSES = ["Open", "Fixed"] as const;

type Severity = (typeof SEVERITIES)[number];
type Status = (typeof STATUSES)[number];

interface Row {
  areaTest: string;
  severity: Severity;
  status: Status;
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
    const [, areaTest, , severity, , , status] = c;
    if (!SEVERITIES.includes(severity as Severity)) {
      throw new Error(`Invalid Severity "${severity}" (must be High/Medium/Low): ${line}`);
    }
    if (!STATUSES.includes(status as Status)) {
      throw new Error(`Invalid Status "${status}" (must be Open/Fixed): ${line}`);
    }
    rows.push({ areaTest, severity: severity as Severity, status: status as Status });
  }
  return rows;
}

/** Area = the token before " · " in the "Area / Test" cell. */
function areaOf(areaTest: string): string {
  const idx = areaTest.indexOf("·");
  return (idx === -1 ? areaTest : areaTest.slice(0, idx)).trim();
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
  const md = fs.readFileSync(FILE, "utf8");

  const startCount = (md.match(new RegExp(START.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  const endCount = (md.match(new RegExp(END.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Expected exactly one ${START} and one ${END} (found ${startCount}/${endCount})`);
  }

  const rows = parseLedger(md);
  const block = buildBlock(rows);

  const before = md.slice(0, md.indexOf(START));
  const after = md.slice(md.indexOf(END) + END.length);
  const next = before + block + after;

  if (next === md) {
    console.log("REGRESSIONS.md indicator already up to date.");
    return;
  }
  fs.writeFileSync(FILE, next);
  console.log(`REGRESSIONS.md indicator regenerated: ${rows.length} regression(s).`);
}

main();
