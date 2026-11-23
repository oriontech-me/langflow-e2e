// Unit tests for the CLAUDE.md size budget (issue #2542).
// Run with: node --test scripts/check-claude-md-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGETS,
  checkDocument,
  fileBudget,
  findImports,
  render,
  importPath,
  isImport,
  splitBlocks,
  toRepoPath,
} from "./check-claude-md-budget.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./check-claude-md-budget.mjs", import.meta.url));
const SMALL = { rootFile: 400, areaFile: 200, block: 100 };
const bytesOf = (...lines) => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
const starts = (text) => splitBlocks(text).map((b) => b.line);

/** A throwaway git repo holding the given files, all tracked. */
function repo(files) {
  const dir = makeTempDir("claude-md-budget-repo-");
  execFileSync("git", ["init", "-q", dir]);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

// --- budgets ---------------------------------------------------------------

test("project-root guides get the root budget; any other guide the area budget", () => {
  assert.equal(fileBudget("CLAUDE.md"), BUDGETS.rootFile);
  assert.equal(fileBudget(".claude/CLAUDE.md"), BUDGETS.rootFile);
  assert.equal(fileBudget("tests/x/CLAUDE.md"), BUDGETS.areaFile);
  assert.notEqual(BUDGETS.rootFile, BUDGETS.areaFile);
});

// --- block boundaries ------------------------------------------------------

test("consecutive column-0 bullets are separate blocks, with no blank line between them", () => {
  assert.deepEqual(starts(["- one", "- two", "* three", "+ four", "1. five", "10) six", "-", "#"].join("\n")), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a column-0 heading starts a block, and so does the line after a blank one", () => {
  const text = ["# Title", "intro line", "", "A paragraph", "that wraps.", "## Next"].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => b.line), [1, 4, 6]);
  assert.equal(blocks[0].bytes, bytesOf("# Title", "intro line"));
  assert.equal(blocks[1].bytes, bytesOf("A paragraph", "that wraps."));
});

test("indented lines stay with their bullet: nested items, tables, headings, fences", () => {
  // Review round 2: an indented table or heading used to cut the bullet, and
  // the narrative after it escaped the block budget.
  const lines = [
    "- **rule** text",
    "  - nested item",
    "  | a | b |",
    "  ## indented heading",
    "  ```bash",
    "  - inside a fence",
    "  ```",
    "  narrative",
  ];
  const blocks = splitBlocks([...lines, "- next"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 9]);
  assert.equal(blocks[0].bytes, bytesOf(...lines));
});

test("a marker glued to text does not start a block: **bold**, ---, #2542", () => {
  assert.deepEqual(starts(["- item", "**bold** wraps", "---", "#2542 continues", "-x", "1.5 too"].join("\n")), [1]);
});

test("a blank or whitespace-only line ends a block", () => {
  assert.deepEqual(starts(["- one", "  ", "  continuation", "\t", "- two"].join("\n")), [1, 3, 5]);
});

test("column-0 table rows continue the block they follow; after a blank line they are one block", () => {
  const rows = ["| a | b |", "|---|---|", "| 1 | 2 |"];
  assert.deepEqual(starts(["- item", ...rows].join("\n")), [1]);
  const blocks = splitBlocks(["- item", "", ...rows].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 3]);
  assert.equal(blocks[1].bytes, bytesOf(...rows));
});

test("CRLF and LF give the same blocks and bytes", () => {
  // Review round 2: CRLF used to make fences invisible to the old splitter.
  const lines = ["- one " + "x".repeat(50), "  more", "", "- two"];
  assert.deepEqual(splitBlocks(lines.join("\r\n")), splitBlocks(lines.join("\n")));
});

test("bytes are UTF-8 bytes, not characters", () => {
  const [block] = splitBlocks("- — →");
  assert.equal(block.bytes, Buffer.byteLength("- — →") + 1);
  assert.ok(block.bytes > "- — →".length + 1);
});

test("the shape of the 171 KB file: oversized bullets, one long line each, no blank lines between", () => {
  const text = ["## CI/CD", "", "- **a** " + "n".repeat(5000), "- **b** short", "- **c** " + "n".repeat(4000)].join("\n");
  assert.deepEqual(checkDocument("CLAUDE.md", text).overBlocks.map((b) => b.line), [3, 5]);
});

// --- imports -----------------------------------------------------------------

test("findImports reads tokens as Claude Code does and keeps only imports", () => {
  const exists = new Set(["docs/infra/x.md", "README", "notes/plain"]);
  const text = [
    "@docs/infra/x.md",
    "See @README for the overview, and @docs/infra/x.md#section for one part.",
    "Tag with @stable, install @axe-core/playwright, pin @1.5.1, mail a@b.c.",
    "Inline `cat @docs/infra/x.md | wc` is code.",
    "- (@docs/infra/x.md and more: no whitespace before @.",
    "\t@~/.claude/notes.md and @/abs/file and @CLAUDE.local.md and @my\\ file.md",
    "@notes/plain",
  ].join("\n");
  const isImp = (p) => p.startsWith("~/") || p.startsWith("/") || p.endsWith(".md") || exists.has(p);
  assert.deepEqual(findImports(text, ".", isImp), [
    { line: 1, token: "@docs/infra/x.md" },
    { line: 2, token: "@README" },
    { line: 2, token: "@docs/infra/x.md" },
    { line: 6, token: "@~/.claude/notes.md" },
    { line: 6, token: "@/abs/file" },
    { line: 6, token: "@CLAUDE.local.md" },
    { line: 6, token: "@my file.md" },
    { line: 7, token: "@notes/plain" },
  ]);
});

test("importPath cuts at # and unescapes spaces; trailing punctuation stays, as in Claude Code", () => {
  assert.equal(importPath("docs/x.md#section"), "docs/x.md");
  assert.equal(importPath("my\\ file.md"), "my file.md");
  assert.equal(importPath("README.md."), "README.md.");
});

test("isImport: ~/ and absolute by syntax, .md by name, anything else only if the file exists", () => {
  const dir = makeTempDir("claude-md-budget-imp-");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "plain"), "");
  // ~/ and absolute never depend on the machine: CI has no such file, a laptop may.
  assert.equal(isImport("~/.claude/missing.md", dir), true);
  assert.equal(isImport("~/bin/tool.sh", dir), true, "~/ fails by syntax, not by the .md rule");
  assert.equal(isImport("/nonexistent/file", dir), true);
  // A .md path is an import even when absent here (an ignored local file).
  assert.equal(isImport("CLAUDE.local.md", dir), true);
  assert.equal(isImport("docs/plain", dir), true);
  assert.equal(isImport("docs", dir), false, "a directory is not an import");
  assert.equal(isImport("stable", dir), false);
  writeFileSync(join(dir, "README.md"), "");
  assert.equal(isImport("README", dir), false, "no .md fallback: Claude Code never appends it");
  assert.equal(isImport("", dir), false);
});

test("an import fails the check even when every budget is met", () => {
  const r = checkDocument("CLAUDE.md", "- ok\n@docs/x.md\n", SMALL, (t) => t === "docs/x.md");
  assert.equal(r.overFile, false);
  assert.equal(r.overBlocks.length, 0);
  assert.match(render([r], SMALL), /^FAIL[\s\S]*import: CLAUDE\.md:2 {2}@docs\/x\.md/m);
});

// --- budgets and report --------------------------------------------------------

test("a block exactly at budget passes; one byte more fails", () => {
  const line = "- " + "q".repeat(97); // 99 bytes + newline = 100
  assert.equal(checkDocument("CLAUDE.md", line, SMALL).overBlocks.length, 0);
  assert.equal(checkDocument("CLAUDE.md", line + "q", SMALL).overBlocks.length, 1);
});

test("a file exactly at budget passes; one byte more fails", () => {
  const budgets = { ...SMALL, block: 1e9 };
  const text = "a".repeat(SMALL.rootFile);
  assert.equal(checkDocument("CLAUDE.md", text, budgets).overFile, false);
  assert.equal(checkDocument("CLAUDE.md", text + "a", budgets).overFile, true);
});

test("a file over budget fails and lists its five largest blocks", () => {
  const text = Array.from({ length: 8 }, (_, i) => `- item ${i} ${"z".repeat(60)}`).join("\n");
  const r = checkDocument("CLAUDE.md", text, { ...SMALL, block: 1e9 });
  assert.equal(r.overFile, true);
  const report = render([r], SMALL);
  assert.match(report, /^FAIL CLAUDE\.md: \d+ \/ 400 bytes/m);
  assert.equal((report.match(/^ {4}CLAUDE\.md:\d+/gm) ?? []).length, 5);
  assert.match(report, /docs\/infra\/<mechanism>\.md/);
});

test("one block over budget fails even when the file is under budget", () => {
  const r = checkDocument("CLAUDE.md", `- short\n- **long** ${"w".repeat(120)}\n`, SMALL);
  assert.equal(r.overFile, false);
  assert.match(render([r], SMALL), /block over 100 bytes: CLAUDE\.md:2/);
});

test("a clean report carries no fix instructions", () => {
  const report = render([checkDocument("CLAUDE.md", "- ok\n", SMALL)], SMALL);
  assert.match(report, /^ok {3}CLAUDE\.md/);
  assert.doesNotMatch(report, /docs\/infra/);
});

// --- paths -----------------------------------------------------------------------

test("toRepoPath normalises ./, absolute and subdirectory paths, and refuses outside ones", () => {
  assert.equal(toRepoPath("./CLAUDE.md", "/r", "/r"), "CLAUDE.md");
  assert.equal(toRepoPath("/r/CLAUDE.md", "/r", "/anywhere"), "CLAUDE.md");
  assert.equal(toRepoPath("CLAUDE.md", "/r", "/r/a/b"), "a/b/CLAUDE.md");
  assert.equal(toRepoPath("../../CLAUDE.md", "/r", "/r/a/b"), "CLAUDE.md");
  assert.equal(toRepoPath("/elsewhere/CLAUDE.md", "/r", "/r"), null);
  assert.equal(toRepoPath("../CLAUDE.md", "/r", "/r"), null);
});

// --- CLI ---------------------------------------------------------------------------

test("CLI: exits 0 on clean guides and 1 on an over-budget one", () => {
  const dir = repo({ "CLAUDE.md": "- ok\n", "a/CLAUDE.md": `- ${"f".repeat(BUDGETS.block + 10)}\n` });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /^ok {3}CLAUDE\.md/m);
  assert.match(res.stdout, /^FAIL a\/CLAUDE\.md[\s\S]*block over/m);
  assert.equal(spawnSync("node", [SCRIPT, "CLAUDE.md"], { cwd: dir }).status, 0);
});

test("CLI: an import of a file next to the guide fails; an @tag does not", () => {
  const dir = repo({ "CLAUDE.md": "- tag with @stable\n- see @docs/x.md\n", "docs/x.md": "big\n" });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /import: CLAUDE\.md:2 {2}@docs\/x\.md/);
  assert.doesNotMatch(res.stdout, /@stable/);
});

test("CLI: an area guide's import resolves next to that guide, not at the repo root", () => {
  const dir = repo({ "CLAUDE.md": "- root\n", "a/CLAUDE.md": "- see @notes\n", "a/notes": "x\n" });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /import: a\/CLAUDE\.md:1 {2}@notes/);
});

test("CLI: a #fragment import and a ~/ import fail, whatever this machine holds", () => {
  const dir = repo({ "CLAUDE.md": "- see @docs/x#part\n- mine: @~/.claude/never-there-2542.md\n", "docs/x": "x\n" });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: "/nonexistent" } });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /import: CLAUDE\.md:1 {2}@docs\/x —/);
  assert.match(res.stdout, /import: CLAUDE\.md:2 {2}@~\/\.claude\/never-there-2542\.md/);
});

test("CLI: only files named exactly CLAUDE.md are guides", () => {
  const dir = repo({ "CLAUDE.md": "- root\n", "NOT-CLAUDE.md": `- ${"f".repeat(BUDGETS.block + 10)}\n` });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.stdout, /NOT-CLAUDE/);
});

test("CLI: from a subdirectory it checks every guide, with root-relative paths and budgets", () => {
  const dir = repo({ "CLAUDE.md": "- root\n", "a/b/CLAUDE.md": "- area\n" });
  const cwd = join(dir, "a", "b");
  const res = spawnSync("node", [SCRIPT], { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^ok {3}CLAUDE\.md: \d+ \/ 40000/m);
  assert.match(res.stdout, /^ok {3}a\/b\/CLAUDE\.md: \d+ \/ 20000/m);
  const explicit = spawnSync("node", [SCRIPT, "CLAUDE.md", "../../CLAUDE.md"], { cwd, encoding: "utf8" });
  assert.match(explicit.stdout, /^ok {3}a\/b\/CLAUDE\.md: \d+ \/ 20000/m);
  assert.match(explicit.stdout, /^ok {3}CLAUDE\.md: \d+ \/ 40000/m);
});

test("CLI: untracked guides are not discovered", () => {
  const dir = repo({ "CLAUDE.md": "- root\n" });
  mkdirSync(join(dir, "u"));
  writeFileSync(join(dir, "u", "CLAUDE.md"), `- ${"f".repeat(BUDGETS.block + 10)}\n`);
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.stdout, /u\/CLAUDE/);
});

test("CLI: a path outside the repository exits 2", () => {
  const dir = repo({ "CLAUDE.md": "- root\n" });
  const outside = join(makeTempDir("claude-md-budget-out-"), "CLAUDE.md");
  writeFileSync(outside, "- x\n");
  const res = spawnSync("node", [SCRIPT, outside], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /outside the repository/);
});

test("CLI: an unreadable path exits 2, never clean", () => {
  const dir = repo({ "CLAUDE.md": "- root\n" });
  const res = spawnSync("node", [SCRIPT, "missing/CLAUDE.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot read/);
});

test("CLI: a repository with no tracked CLAUDE.md exits 2, never clean", () => {
  const dir = repo({ "README.md": "x\n" });
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /refusing to report clean/);
});
