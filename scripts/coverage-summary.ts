/**
 * Regenerates three auto-generated blocks in QA-CHECKLIST.md:
 *   1. The Coverage Summary table (counts per module from `[x]`/`[-]`/`[ ]`/`[~]`/`[!]` bullets in Part II).
 *   2. The Phase 1 / Phase 2 delivery tables (per-module `[-]` and `[ ]` counts; phase membership read from the file).
 *   3. The `> **Last updated:**` date stamp in the document header.
 *
 * Run: `npx ts-node scripts/coverage-summary.ts`
 *
 * Idempotent within the same UTC day: a second run produces no diff when the
 * file is already in sync with the bullets above and the date hasn't changed.
 */

import * as fs from "fs";
import * as path from "path";

interface ModuleConfig {
  /** Label as it appears in the first column of the table. */
  label: string;
  /** Prefix of the markdown header line where the section starts. */
  sectionStart: string;
}

/**
 * Ordered top-down by appearance in the document. Each module owns the
 * bullets between its `sectionStart` line and the next module's start.
 *
 * If you restructure Part II in QA-CHECKLIST.md, update this list — the
 * script throws if any prefix is not found.
 */
const MODULES: ModuleConfig[] = [
  { label: "`api/flows/` — REST API",                        sectionStart: "### api/flows/" },
  { label: "`core-components/` — Component Config",          sectionStart: "### 2." },
  { label: "`core-components/` — Core Components",           sectionStart: "### 3." },
  { label: "`core-functionality/auth/`",                     sectionStart: "### core-functionality/auth/" },
  { label: "`core-functionality/knowledge-ingestion/`",      sectionStart: "### core-functionality/knowledge-ingestion-management/" },
  { label: "`core-functionality/llm-agents/`",               sectionStart: "### core-functionality/llm-agents/" },
  { label: "`core-functionality/model-provider/`",           sectionStart: "### core-functionality/model-provider/" },
  { label: "`core-functionality/observability-monitoring/`", sectionStart: "### core-functionality/observability-monitoring/" },
  { label: "`core-functionality/playground/`",               sectionStart: "### core-functionality/playground/" },
  { label: "`core-functionality/project-management/`",       sectionStart: "### core-functionality/project-management/" },
  { label: "`core-functionality/templates/`",                sectionStart: "### core-functionality/templates/" },
  { label: "`core-functionality/a2a/`",                      sectionStart: "### core-functionality/a2a/" },
  { label: "`flow-functionality/`",                          sectionStart: "## flow-functionality/" },
  { label: "`mcp/client/`",                                  sectionStart: "### mcp/client/" },
  { label: "`mcp/server/`",                                  sectionStart: "### mcp/server/" },
  { label: "`ui-ux/` — Canvas",                              sectionStart: "## ui-ux/" },
  { label: "`ui-ux/` — Settings",                            sectionStart: "#### 15.10" },
  { label: "`security/` — Validation, SSRF, Secrets",        sectionStart: "## security/" },
  { label: "`i18n/` — Language and Localization",            sectionStart: "## i18n/" },
  { label: "`deployments/` — Deploy Page and Stepper",       sectionStart: "## deployments/" },
  { label: "`memory/` — Memory Base Registration",           sectionStart: "## memory/" },
];

const PART_II_HEADER = "# PART II — TEST AUTOMATION COVERAGE";
const COVERAGE_SUMMARY_HEADER_PREFIX = "## Coverage Summary";
const TABLE_HEADER_PREFIX = "| Module | Total |";

const TABLE_HEADER =
  "| Module | Total | Validated `[x]` | Needs validation `[-]` | Partial `[~]`/`[!]` | Not automated `[ ]` |";
const TABLE_SEPARATOR =
  "|--------|-------|-----------------|------------------------|---------------------|---------------------|";

const PHASE_HEADERS = [
  "### 🔵 Phase 1 — Next Delivery",
  "### 🟡 Phase 2 — Next Delivery",
] as const;

const PHASE_TABLE_HEADER_PREFIX = "| Module | Validate";

const PHASE_TABLE_HEADER =
  "| Module | Validate (`[-]`) | Create (`[ ]`) |";
const PHASE_TABLE_SEPARATOR =
  "|--------|-----------------|---------------|";

const LAST_UPDATED_PREFIX = "> **Last updated:**";

const BULLET_RE = /^- \[([x\- ~!])\] /;

interface Counts {
  validated: number;       // [x]
  needsValidation: number; // [-]
  partial: number;         // [~] + [!]
  notAutomated: number;    // [ ]
}

function emptyCounts(): Counts {
  return { validated: 0, needsValidation: 0, partial: 0, notAutomated: 0 };
}

function totalOf(c: Counts): number {
  return c.validated + c.needsValidation + c.partial + c.notAutomated;
}

function classify(marker: string): keyof Counts | null {
  switch (marker) {
    case "x": return "validated";
    case "-": return "needsValidation";
    case " ": return "notAutomated";
    case "~":
    case "!": return "partial";
    default:  return null;
  }
}

function findLineIndex(
  lines: string[],
  predicate: (line: string) => boolean,
  from = 0,
  to = lines.length
): number {
  for (let i = from; i < to; i++) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

function fmtPercent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function computeCounts(lines: string[]): Counts[] {
  const partIIStart = findLineIndex(lines, (l) => l.trim() === PART_II_HEADER);
  if (partIIStart === -1) {
    throw new Error(`Part II header not found: "${PART_II_HEADER}"`);
  }

  const coverageHeader = findLineIndex(
    lines,
    (l) => l.startsWith(COVERAGE_SUMMARY_HEADER_PREFIX),
    partIIStart
  );
  if (coverageHeader === -1) {
    throw new Error(`Coverage Summary header not found: "${COVERAGE_SUMMARY_HEADER_PREFIX}"`);
  }

  const moduleStarts: number[] = MODULES.map((m) => {
    const idx = findLineIndex(
      lines,
      (l) => l.startsWith(m.sectionStart),
      partIIStart,
      coverageHeader
    );
    if (idx === -1) {
      throw new Error(
        `Section start not found for module "${m.label}" (prefix: "${m.sectionStart}")`
      );
    }
    return idx;
  });

  for (let i = 1; i < moduleStarts.length; i++) {
    if (moduleStarts[i] <= moduleStarts[i - 1]) {
      throw new Error(
        `MODULES is misordered: "${MODULES[i].label}" appears before "${MODULES[i - 1].label}" in the document`
      );
    }
  }

  const counts: Counts[] = MODULES.map(() => emptyCounts());
  for (let m = 0; m < MODULES.length; m++) {
    const start = moduleStarts[m] + 1;
    const end = m + 1 < MODULES.length ? moduleStarts[m + 1] : coverageHeader;
    for (let i = start; i < end; i++) {
      const match = lines[i].match(BULLET_RE);
      if (!match) continue;
      const cat = classify(match[1]);
      if (cat) counts[m][cat]++;
    }
  }

  return counts;
}

function regenerateCoverageTable(
  lines: string[],
  counts: Counts[]
): string[] {
  const partIIStart = findLineIndex(lines, (l) => l.trim() === PART_II_HEADER);
  if (partIIStart === -1) {
    throw new Error(`Part II header not found: "${PART_II_HEADER}"`);
  }

  const coverageHeader = findLineIndex(
    lines,
    (l) => l.startsWith(COVERAGE_SUMMARY_HEADER_PREFIX),
    partIIStart
  );
  if (coverageHeader === -1) {
    throw new Error(`Coverage Summary header not found: "${COVERAGE_SUMMARY_HEADER_PREFIX}"`);
  }

  const tot = emptyCounts();
  for (const c of counts) {
    tot.validated += c.validated;
    tot.needsValidation += c.needsValidation;
    tot.partial += c.partial;
    tot.notAutomated += c.notAutomated;
  }
  const totSum = totalOf(tot);

  const dataRows = MODULES.map((m, i) => {
    const c = counts[i];
    return `| ${m.label} | ${totalOf(c)} | ${c.validated} | ${c.needsValidation} | ${c.partial} | ${c.notAutomated} |`;
  });
  const totalRow =
    `| **TOTAL** | **${totSum}** | ` +
    `**${tot.validated} (${fmtPercent(tot.validated, totSum)})** | ` +
    `**${tot.needsValidation} (${fmtPercent(tot.needsValidation, totSum)})** | ` +
    `**${tot.partial} (${fmtPercent(tot.partial, totSum)})** | ` +
    `**${tot.notAutomated} (${fmtPercent(tot.notAutomated, totSum)})** |`;

  const newTable = [TABLE_HEADER, TABLE_SEPARATOR, ...dataRows, totalRow];

  const tableHeaderIdx = findLineIndex(
    lines,
    (l) => l.startsWith(TABLE_HEADER_PREFIX),
    coverageHeader
  );
  if (tableHeaderIdx === -1) {
    throw new Error(`Table header line not found ("${TABLE_HEADER_PREFIX}")`);
  }

  let tableEndIdx = tableHeaderIdx;
  while (tableEndIdx + 1 < lines.length && lines[tableEndIdx + 1].startsWith("|")) {
    tableEndIdx++;
  }

  const before = lines.slice(0, tableHeaderIdx);
  const after = lines.slice(tableEndIdx + 1);
  return [...before, ...newTable, ...after];
}

function regeneratePhaseTables(lines: string[], counts: Counts[]): string[] {
  const labelToIndex = new Map<string, number>();
  MODULES.forEach((m, i) => labelToIndex.set(m.label, i));

  let working = lines.slice();

  for (let phaseIdx = 0; phaseIdx < PHASE_HEADERS.length; phaseIdx++) {
    const phaseNumber = phaseIdx + 1;
    const phaseHeader = PHASE_HEADERS[phaseIdx];

    const headerLine = findLineIndex(working, (l) => l.trim() === phaseHeader);
    if (headerLine === -1) {
      throw new Error(`Phase ${phaseNumber} header not found: "${phaseHeader}"`);
    }

    // Bound the search to before the next phase header (if any) so a missing
    // table header in this phase fails loudly instead of silently borrowing
    // the next phase's header.
    const nextPhaseHeader = PHASE_HEADERS[phaseIdx + 1];
    const upperBound =
      nextPhaseHeader !== undefined
        ? findLineIndex(working, (l) => l.trim() === nextPhaseHeader, headerLine + 1)
        : working.length;
    const searchEnd = upperBound === -1 ? working.length : upperBound;

    const tableHeaderIdx = findLineIndex(
      working,
      (l) => l.startsWith(PHASE_TABLE_HEADER_PREFIX),
      headerLine,
      searchEnd
    );
    if (tableHeaderIdx === -1) {
      throw new Error(
        `Phase ${phaseNumber} table header not found after "${phaseHeader}" (expected line starting with "${PHASE_TABLE_HEADER_PREFIX}")`
      );
    }

    let tableEndIdx = tableHeaderIdx;
    while (tableEndIdx + 1 < working.length && working[tableEndIdx + 1].startsWith("|")) {
      tableEndIdx++;
    }

    // Data rows are everything between the separator (tableHeaderIdx + 2) and tableEndIdx, inclusive.
    const dataStart = tableHeaderIdx + 2;
    const dataLines = working.slice(dataStart, tableEndIdx + 1);

    if (dataLines.length === 0) {
      throw new Error(`Phase ${phaseNumber} table is empty — at least one module required`);
    }

    const newRows: string[] = [];
    for (const row of dataLines) {
      // Strip leading/trailing pipes, take first cell, trim.
      const cells = row.split("|");
      // First element is "" (before leading pipe), second is the label cell.
      const label = (cells[1] ?? "").trim();
      const moduleIdx = labelToIndex.get(label);
      if (moduleIdx === undefined) {
        throw new Error(
          `Phase ${phaseNumber} row "${label}" does not match any module in MODULES — rename or remove the row`
        );
      }
      const c = counts[moduleIdx];
      newRows.push(`| ${label} | ${c.needsValidation} | ${c.notAutomated} |`);
    }

    const newBlock = [PHASE_TABLE_HEADER, PHASE_TABLE_SEPARATOR, ...newRows];
    const before = working.slice(0, tableHeaderIdx);
    const after = working.slice(tableEndIdx + 1);
    working = [...before, ...newBlock, ...after];
  }

  return working;
}

function regenerateLastUpdated(lines: string[]): string[] {
  const idx = findLineIndex(lines, (l) => l.startsWith(LAST_UPDATED_PREFIX));
  if (idx === -1) {
    throw new Error(
      `"Last updated:" line not found — expected a line starting with "${LAST_UPDATED_PREFIX}"`
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const next = lines.slice();
  next[idx] = `${LAST_UPDATED_PREFIX} ${today}`;
  return next;
}

function main(): void {
  const filePath = path.resolve(__dirname, "..", "QA-CHECKLIST.md");
  const original = fs.readFileSync(filePath, "utf-8");
  const trailingNewline = original.endsWith("\n");

  const lines = original.split("\n");
  if (trailingNewline) lines.pop();

  const counts = computeCounts(lines);
  let updated = regenerateCoverageTable(lines, counts);
  updated = regeneratePhaseTables(updated, counts);
  updated = regenerateLastUpdated(updated);

  let output = updated.join("\n");
  if (trailingNewline) output += "\n";

  if (output === original) {
    console.log("QA-CHECKLIST.md is already up to date — no changes.");
    return;
  }

  fs.writeFileSync(filePath, output, "utf-8");
  console.log("QA-CHECKLIST.md updated (Coverage Summary, Phase tables, and/or Last updated).");
}

main();
