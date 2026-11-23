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
//     have different budgets). This is the bound that holds.
//   * per block — what follows a blank line or a column-0 list marker or
//     heading, up to the next one. It exists to name, early, the one bullet
//     that is absorbing a narrative.
// A block is deliberately NOT a full Markdown construct: no fences, tables or
// indentation rules. Two review rounds on a
// hand-written CommonMark splitter (#2542) each found new ways a nested table,
// a CRLF fence or an indented heading moved a boundary; the guard grew to ~280
// lines to watch 33 KB of text. Two line-level boundaries have no such cases.
// Their known blind spots — narrative broken up by blank lines, or a column-0
// `- ` inside a fenced block splitting it — make blocks smaller, never hide a
// file's growth: the file budget still bounds them, and the first is a
// deliberate evasion, not the gradual growth this guards against.
//
// And one prohibition: an `@path` import. Claude Code inlines the imported file
// into every session, so one short line can load 20 KB the budget never sees.
// An `@token` counts as an import when it names a file that exists (relative to
// the guide, absolute, or under `~/`), so `@stable` and `@axe-core/playwright`
// are not imports and `@README` is. Inline code spans are skipped; fenced code is
// not (conservative: rephrase a fenced example rather than parse fences here).
//
// Raising a budget is an edit to BUDGETS below, so it shows up in review.
//
// Usage: node scripts/check-claude-md-budget.mjs [file ...]
//   With no arguments, checks every CLAUDE.md tracked by git, from any
//   directory of the checkout. Paths are reported relative to the repo root;
//   a path outside the repository is refused.
// Exits 1 when any file or block is over budget or a guide imports a file,
// 2 when it cannot run.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const normalise = (text) => text.replace(/\r\n?/g, "\n");

/** A line at column 0 that opens a list item or a heading starts a new block. */
const BLOCK_START = /^([-*+]|\d{1,9}[.)]|#{1,6})(\s|$)/;

/**
 * Split a document into blocks. A block starts after a blank line
 * (whitespace-only counts as blank) or at a column-0 list marker or heading, and
 * runs until the next such boundary; everything indented stays with it. Returns
 * [{ line, bytes, preview }], with 1-based start lines and bytes counted with
 * one newline per line.
 */
export function splitBlocks(text) {
  const blocks = [];
  let current = null;
  normalise(text)
    .split("\n")
    .forEach((raw, i) => {
      if (raw.trim() === "") {
        current = null;
        return;
      }
      if (!current || BLOCK_START.test(raw)) {
        current = { line: i + 1, bytes: 0, preview: raw.trim().slice(0, 80) };
        blocks.push(current);
      }
      current.bytes += byteLength(raw) + 1;
    });
  return blocks;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Where `@token` would resolve, per Claude Code's import rules: `~/` from the
 * home directory, an absolute path as is, anything else relative to the guide.
 * Returns the first existing file among the token and the token plus `.md`.
 */
export function resolveImport(token, guideDir, home = homedir()) {
  const base = token.startsWith("~/") ? join(home, token.slice(2)) : isAbsolute(token) ? token : resolve(guideDir, token);
  return [base, `${base}.md`].find(isFile) ?? null;
}

/**
 * `@path` imports in a guide: an `@` at the start of a line or after whitespace,
 * outside an inline code span, naming a file that exists.
 * Returns [{ line, token }].
 */
export function findImports(text, guideDir, exists = (t) => resolveImport(t, guideDir) !== null) {
  const found = [];
  normalise(text)
    .split("\n")
    .forEach((raw, i) => {
      const prose = raw.replace(/(`+)[^`][\s\S]*?\1/g, " ");
      for (const m of prose.matchAll(/(?:^|\s)@(\S+)/g)) {
        const token = m[1].replace(/[.,;:!?)\]'"]+$/, "");
        if (token && exists(token)) found.push({ line: i + 1, token: `@${token}` });
      }
    });
  return found;
}

/** Check one document. `path` is relative to the repository root. */
export function checkDocument(path, text, budgets = BUDGETS, exists) {
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
    imports: exists ? findImports(text, ".", exists) : [],
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

/**
 * A path given on the command line, made relative to the repository root.
 * Returns null for a path outside the repository.
 */
export function toRepoPath(arg, root, cwd = process.cwd()) {
  const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
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
  const outside = argv.filter((_, i) => paths[i] === null);
  if (argv.length && outside.length) {
    console.error(`check-claude-md-budget: outside the repository: ${outside.join(", ")}`);
    return 2;
  }
  if (paths.length === 0) {
    // An empty listing is a broken checkout, never "all clean".
    console.error("check-claude-md-budget: no CLAUDE.md found — refusing to report clean.");
    return 2;
  }
  const results = [];
  for (const p of paths) {
    const abs = resolve(root, p);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (e) {
      console.error(`check-claude-md-budget: cannot read ${p}: ${e.message}`);
      return 2;
    }
    const guideDir = dirname(abs);
    results.push(checkDocument(p, text, BUDGETS, (t) => resolveImport(t, guideDir) !== null));
  }
  console.log(render(results));
  return results.some(failed) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
