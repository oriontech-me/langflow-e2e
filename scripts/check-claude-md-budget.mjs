#!/usr/bin/env node
// Size budget for every tracked CLAUDE.md (issue #2542).
//
// CLAUDE.md loads into every agent session. The root file grew from 20 KB at the
// end of July 2026 to 171 KB in November, one infra fix at a time: each fix wrote
// its whole mechanism (measurements, traps, history) into a bullet, and each
// review round lengthened that bullet again. No single PR looked alarming. #2532
// moved the narratives into docs/infra/ and kept the standing rules; this guard
// keeps it that way.
//
// Two budgets, both in UTF-8 bytes:
//   * per file — the whole guide (root and area guides have different budgets);
//   * per block — one top-level list item with its nested and continuation
//     lines, or one paragraph. This is the unit that grew: a file budget alone
//     lets one bullet absorb the headroom left by trimming the others.
// Fenced code blocks and tables are not blocks (they count toward the file
// budget only): their size reflects commands and rows, not narrative.
//
// Raising a budget is an edit to BUDGETS below, so it shows up in review.
//
// Usage: node scripts/check-claude-md-budget.mjs [file ...]
//   With no arguments, checks every CLAUDE.md tracked by git.
// Exits 1 when any file or block is over budget, 2 when it cannot run.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BUDGETS = Object.freeze({
  rootFile: 40_000,
  areaFile: 20_000,
  block: 3_000,
});

const byteLength = (s) => Buffer.byteLength(s, "utf8");

/** Budget for a file, by its repo-relative path. */
export function fileBudget(path, budgets = BUDGETS) {
  return path === "CLAUDE.md" ? budgets.rootFile : budgets.areaFile;
}

/**
 * Split a Markdown document into narrative blocks.
 * A block is a top-level list item (a line starting with `-`, `*`, `+` or `N.`
 * at column 0) plus every following line that is indented or blank-then-indented,
 * or a paragraph of consecutive non-blank column-0 lines. Headings, fences and
 * tables end the current block and are not blocks themselves.
 * Returns [{ line, bytes, preview }] with 1-based start lines.
 */
export function splitBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let inFence = false;
  let pendingBlank = 0;

  const close = () => {
    if (current) blocks.push(current);
    current = null;
    pendingBlank = 0;
  };
  const start = (i, raw) => {
    current = { line: i + 1, bytes: byteLength(raw) + 1, preview: raw.trim().slice(0, 80) };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMarker = /^\s*(```|~~~)/.test(raw);

    if (inFence) {
      if (fenceMarker) inFence = false;
      // A fence opened inside a list item (indented) belongs to that item.
      if (current) current.bytes += byteLength(raw) + 1;
      continue;
    }
    if (fenceMarker) {
      const indented = /^\s+/.test(raw);
      if (!(indented && current)) close();
      else current.bytes += byteLength(raw) + 1 + pendingBlank;
      pendingBlank = 0;
      inFence = true;
      continue;
    }

    if (raw.trim() === "") {
      if (current) pendingBlank += 1;
      continue;
    }

    const indented = /^\s/.test(raw);
    const listItem = /^([-*+]|\d+[.)])\s/.test(raw);
    const heading = /^#{1,6}\s/.test(raw);
    const table = /^\|/.test(raw);

    if (heading || table) {
      close();
      continue;
    }
    if (indented && current) {
      current.bytes += byteLength(raw) + 1 + pendingBlank;
      pendingBlank = 0;
      continue;
    }
    if (listItem) {
      close();
      start(i, raw);
      continue;
    }
    // Column-0 text right after a non-blank line continues that block (a
    // paragraph, or a list item's lazy continuation); after a blank line it
    // starts a new paragraph.
    if (current && pendingBlank === 0) {
      current.bytes += byteLength(raw) + 1;
      continue;
    }
    close();
    start(i, raw);
  }
  close();
  return blocks;
}

/** Check one document. Returns { bytes, budget, overFile, overBlocks, largest }. */
export function checkDocument(path, text, budgets = BUDGETS) {
  const bytes = byteLength(text);
  const budget = fileBudget(path, budgets);
  const blocks = splitBlocks(text);
  const largest = [...blocks].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  return {
    path,
    bytes,
    budget,
    overFile: bytes > budget,
    overBlocks: blocks.filter((b) => b.bytes > budgets.block),
    largest,
  };
}

const HOW_TO_FIX =
  "CLAUDE.md holds standing rules and pointers. Move the mechanism's narrative " +
  "(measurements, traps, history, why) into docs/infra/<mechanism>.md and keep " +
  "here the rule an agent must follow plus a link to that doc.";

/** Render a human report for a list of results. */
export function render(results, budgets = BUDGETS) {
  const out = [];
  for (const r of results) {
    const failed = r.overFile || r.overBlocks.length > 0;
    out.push(`${failed ? "FAIL" : "ok  "} ${r.path}: ${r.bytes} / ${r.budget} bytes`);
    if (r.overFile) {
      out.push(`  over the file budget by ${r.bytes - r.budget} bytes. Largest blocks:`);
      for (const b of r.largest) out.push(`    ${r.path}:${b.line}  ${b.bytes} bytes  ${b.preview}`);
    }
    for (const b of r.overBlocks) {
      out.push(`  block over ${budgets.block} bytes: ${r.path}:${b.line}  ${b.bytes} bytes  ${b.preview}`);
    }
  }
  if (results.some((r) => r.overFile || r.overBlocks.length > 0)) {
    out.push("", HOW_TO_FIX, "Budgets live in scripts/check-claude-md-budget.mjs (BUDGETS); raising one is a reviewed edit.");
  }
  return out.join("\n");
}

function trackedGuides() {
  const listed = execFileSync("git", ["ls-files", "--", "CLAUDE.md", "**/CLAUDE.md"], { encoding: "utf8" });
  return listed.split("\n").filter(Boolean);
}

function main(argv) {
  let paths;
  try {
    paths = argv.length ? argv : trackedGuides();
  } catch (e) {
    console.error(`check-claude-md-budget: cannot list tracked CLAUDE.md files: ${e.message}`);
    return 2;
  }
  if (paths.length === 0) {
    // An empty listing is a broken checkout or a wrong cwd, never "all clean".
    console.error("check-claude-md-budget: no CLAUDE.md found — refusing to report clean.");
    return 2;
  }
  const results = [];
  for (const p of paths) {
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch (e) {
      console.error(`check-claude-md-budget: cannot read ${p}: ${e.message}`);
      return 2;
    }
    results.push(checkDocument(p, text));
  }
  console.log(render(results));
  return results.some((r) => r.overFile || r.overBlocks.length > 0) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
