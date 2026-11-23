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
//   * per file — the whole guide (the project-root guides and the area guides
//     have different budgets);
//   * per block — the unit that grew. A file budget alone lets one bullet absorb
//     the headroom left by trimming the others. A block is one top-level list
//     item with its nested and continuation lines, one paragraph, one top-level
//     fenced code block, or one table row. Fences and rows are blocks too, so
//     narrative cannot be parked in them out of the block budget's sight.
// And one prohibition: an `@path` import. Claude Code inlines the imported file
// into every session, so a 30-byte line can load 20 KB the budget never sees.
//
// Raising a budget is an edit to BUDGETS below, so it shows up in review.
//
// Usage: node scripts/check-claude-md-budget.mjs [file ...]
//   With no arguments, checks every CLAUDE.md tracked by git, from any
//   directory of the checkout. Paths are reported relative to the repo root.
// Exits 1 when any file or block is over budget or a guide imports a file,
// 2 when it cannot run.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGETS = Object.freeze({
  rootFile: 40_000,
  areaFile: 20_000,
  block: 3_000,
});

/** Guides Claude Code loads as the project's own, whatever directory is open. */
const ROOT_GUIDES = new Set(["CLAUDE.md", ".claude/CLAUDE.md"]);

const byteLength = (s) => Buffer.byteLength(s, "utf8");

/** Budget for a file, by its path relative to the repository root. */
export function fileBudget(repoPath, budgets = BUDGETS) {
  return ROOT_GUIDES.has(repoPath) ? budgets.rootFile : budgets.areaFile;
}

/**
 * A fence opener per CommonMark: three or more backticks or tildes, indented at
 * most three spaces past `baseIndent`, and — for backticks — an info string with
 * no backtick (so "```foo``` is inline" is text, not a fence).
 */
function fenceOpener(raw, baseIndent) {
  const m = /^( *)(`{3,}|~{3,})(.*)$/.exec(raw);
  if (!m) return null;
  if (m[1].length - baseIndent > 3 || m[1].length < baseIndent) return null;
  if (m[2][0] === "`" && m[3].includes("`")) return null;
  return { char: m[2][0], len: m[2].length };
}

/** A closer: the same character, at least as long, nothing after but spaces. */
function closesFence(raw, fence) {
  const m = /^ *(`{3,}|~{3,}) *$/.exec(raw);
  return Boolean(m && m[1][0] === fence.char && m[1].length >= fence.len);
}

/**
 * Split a Markdown document into budgeted blocks.
 * Returns [{ line, bytes, preview }] with 1-based start lines. Headings are not
 * blocks (they only end one). An unclosed fence runs to the end of the file, as
 * in CommonMark, and is counted as part of the block that opened it.
 */
export function splitBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let currentKind = null; // "item" | "para" | "fence" | "row"
  let fence = null;
  let pendingBlank = 0;

  const close = () => {
    if (current) blocks.push(current);
    current = null;
    currentKind = null;
    pendingBlank = 0;
  };
  const start = (i, raw, kind) => {
    close();
    current = { line: i + 1, bytes: byteLength(raw) + 1, preview: raw.trim().slice(0, 80) };
    currentKind = kind;
  };
  const add = (raw) => {
    current.bytes += byteLength(raw) + 1 + pendingBlank;
    pendingBlank = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (fence) {
      add(raw);
      if (closesFence(raw, fence)) {
        fence = null;
        if (currentKind === "fence") close();
      }
      continue;
    }

    if (raw.trim() === "") {
      if (current) pendingBlank += 1;
      continue;
    }

    const indented = /^\s/.test(raw);

    // A fence inside a list item belongs to the item; one at the top level is a
    // block of its own.
    const nested = indented && currentKind === "item" ? fenceOpener(raw, 2) ?? fenceOpener(raw, 4) : null;
    if (nested) {
      add(raw);
      fence = nested;
      continue;
    }
    const top = fenceOpener(raw, 0);
    if (top && !(indented && currentKind === "item")) {
      start(i, raw, "fence");
      fence = top;
      continue;
    }

    if (/^ {0,3}#{1,6}(\s|$)/.test(raw)) {
      close();
      continue;
    }
    if (/^ {0,3}\|/.test(raw)) {
      start(i, raw, "row");
      continue;
    }
    if (indented && current && currentKind === "item") {
      add(raw);
      continue;
    }
    if (/^([-*+]|\d{1,9}[.)])(\s|$)/.test(raw)) {
      start(i, raw, "item");
      continue;
    }
    // Text right after a non-blank line continues that paragraph or item (lazy
    // continuation); after a blank line, a row or a fence it starts a paragraph.
    if (current && pendingBlank === 0 && (currentKind === "item" || currentKind === "para")) {
      add(raw);
      continue;
    }
    start(i, raw, "para");
  }
  close();
  return blocks;
}

/**
 * `@path` imports outside code. Claude Code reads `@` followed by a path; a
 * bare `@stable` tag is not one, so a token must contain `/` or end in a file
 * extension. Inline code spans and fenced blocks are skipped.
 * Returns [{ line, token }].
 */
export function findImports(text) {
  const found = [];
  let fence = null;
  text.split("\n").forEach((raw, i) => {
    if (fence) {
      if (closesFence(raw, fence)) fence = null;
      return;
    }
    const opener = fenceOpener(raw.replace(/^\s+/, ""), 0);
    if (opener) {
      fence = opener;
      return;
    }
    const prose = raw.replace(/(`+)[\s\S]*?\1/g, "");
    for (const m of prose.matchAll(/(?:^|[\s(])@([~.\w/-]+)/g)) {
      const token = m[1].replace(/[.,;:)]+$/, "");
      if (token.includes("/") || /\.\w{1,5}$/.test(token)) found.push({ line: i + 1, token: `@${token}` });
    }
  });
  return found;
}

/** Check one document. `path` is relative to the repository root. */
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
    imports: findImports(text),
    largest,
  };
}

const failed = (r) => r.overFile || r.overBlocks.length > 0 || r.imports.length > 0;

const HOW_TO_FIX =
  "CLAUDE.md holds standing rules and pointers. Move the mechanism's narrative " +
  "(measurements, traps, history, why) into docs/infra/<mechanism>.md and keep " +
  "here the rule an agent must follow plus a plain link to that doc (a link, " +
  "never an @import, which loads the whole file into every session).";

/** Render a human report for a list of results. */
export function render(results, budgets = BUDGETS) {
  const out = [];
  for (const r of results) {
    out.push(`${failed(r) ? "FAIL" : "ok  "} ${r.path}: ${r.bytes} / ${r.budget} bytes`);
    if (r.overFile) {
      out.push(`  over the file budget by ${r.bytes - r.budget} bytes. Largest blocks:`);
      for (const b of r.largest) out.push(`    ${r.path}:${b.line}  ${b.bytes} bytes  ${b.preview}`);
    }
    for (const b of r.overBlocks) {
      out.push(`  block over ${budgets.block} bytes: ${r.path}:${b.line}  ${b.bytes} bytes  ${b.preview}`);
    }
    for (const imp of r.imports) {
      out.push(`  import: ${r.path}:${imp.line}  ${imp.token} — inlines that file into every session`);
    }
  }
  if (results.some(failed)) {
    out.push("", HOW_TO_FIX, "Budgets live in scripts/check-claude-md-budget.mjs (BUDGETS); raising one is a reviewed edit.");
  }
  return out.join("\n");
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** Every tracked guide, as paths relative to the repository root. */
function trackedGuides() {
  const listed = execFileSync(
    "git",
    ["ls-files", "--full-name", "--", ":(top)CLAUDE.md", ":(top)**/CLAUDE.md"],
    { encoding: "utf8" },
  );
  return listed.split("\n").filter(Boolean);
}

/** A path given on the command line, made relative to the repository root. */
export function toRepoPath(arg, root, cwd = process.cwd()) {
  const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
  const rel = relative(root, abs);
  return rel.split(sep).join("/");
}

function main(argv) {
  let root;
  let paths;
  try {
    root = repoRoot();
    paths = argv.length ? argv.map((a) => toRepoPath(a, root)) : trackedGuides();
  } catch (e) {
    console.error(`check-claude-md-budget: cannot list tracked CLAUDE.md files: ${e.message}`);
    return 2;
  }
  if (paths.length === 0) {
    // An empty listing is a broken checkout, never "all clean".
    console.error("check-claude-md-budget: no CLAUDE.md found — refusing to report clean.");
    return 2;
  }
  const results = [];
  for (const p of paths) {
    let text;
    try {
      text = readFileSync(resolve(root, p), "utf8");
    } catch (e) {
      console.error(`check-claude-md-budget: cannot read ${p}: ${e.message}`);
      return 2;
    }
    results.push(checkDocument(p, text));
  }
  console.log(render(results));
  return results.some(failed) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
