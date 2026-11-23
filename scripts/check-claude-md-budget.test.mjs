// Unit tests for the CLAUDE.md size budget (issue #2542).
// Run with: node --test scripts/check-claude-md-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS, checkDocument, fileBudget, findImports, render, splitBlocks, toRepoPath } from "./check-claude-md-budget.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./check-claude-md-budget.mjs", import.meta.url));
const SMALL = { rootFile: 400, areaFile: 200, block: 100 };

test("the root guide and area guides have different file budgets", () => {
  assert.equal(fileBudget("CLAUDE.md"), BUDGETS.rootFile);
  assert.equal(fileBudget("tests/x/CLAUDE.md"), BUDGETS.areaFile);
  assert.notEqual(BUDGETS.rootFile, BUDGETS.areaFile);
});

test("a top-level list item owns its indented and nested lines, across blank lines", () => {
  const text = [
    "- **first** rule",
    "  continuation",
    "  - nested",
    "",
    "    nested paragraph after a blank line",
    "- **second**",
  ].join("\n");
  const blocks = splitBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].line, 1);
  // 5 lines + their newlines + 1 blank line carried into the block.
  const expected = ["- **first** rule", "  continuation", "  - nested", "    nested paragraph after a blank line"]
    .reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) + 1;
  assert.equal(blocks[0].bytes, expected);
  assert.equal(blocks[1].line, 6);
});

test("a heading ends a block; a column-0 paragraph after a blank line starts one", () => {
  const text = ["- item", "## Heading", "- item two", "", "A paragraph", "that wraps."].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => b.line), [1, 3, 5]);
  assert.equal(blocks[0].bytes, Buffer.byteLength("- item\n"));
  assert.equal(blocks[1].bytes, Buffer.byteLength("- item two\n"));
  assert.equal(blocks[2].bytes, Buffer.byteLength("A paragraph\nthat wraps.\n"));
});

test("numbered, `*` and `+` items are blocks like `-` items", () => {
  const blocks = splitBlocks(["1. one", "10) ten", "* star", "+ plus"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 2, 3, 4]);
});

test("each table row is its own block, so narrative in a row is budgeted", () => {
  const row = "| " + "n".repeat(200) + " | y |";
  const blocks = splitBlocks(["- item", "| a | b |", "|---|---|", row].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 2, 3, 4]);
  assert.equal(blocks[0].bytes, Buffer.byteLength("- item\n"));
  assert.equal(blocks[3].bytes, Buffer.byteLength(row) + 1);
});

test("a column-0 fence is one block, and list-like lines inside it start nothing", () => {
  const inner = "- not a bullet " + "x".repeat(500);
  const blocks = splitBlocks(["```bash", inner, "```", "- real"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 4]);
  assert.equal(blocks[0].bytes, Buffer.byteLength(["```bash", inner, "```", ""].join("\n")));
  assert.equal(blocks[1].preview, "- real");
});

test("a tilde fence is a fence too", () => {
  const blocks = splitBlocks(["~~~", "- inside", "~~~", "- after"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.line), [1, 4]);
});

test("a fence closes only on the same character, at least as long", () => {
  const text = ["~~~~", "```", "- inside", "~~~", "- still inside", "~~~~", "- after"].join("\n");
  assert.deepEqual(splitBlocks(text).map((b) => b.line), [1, 7]);
  // Same length, other character: still inside.
  const mixed = ["~~~", "```", "- inside", "~~~", "- after"].join("\n");
  assert.deepEqual(splitBlocks(mixed).map((b) => b.line), [1, 5]);
});

test("a line starting with inline backticks is text, not a fence", () => {
  const text = ["Para", "```foo``` is inline " + "x".repeat(50), "- next"].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => b.line), [1, 3]);
  assert.ok(blocks[0].bytes > 50);
});

test("an unclosed fence runs to the end and is counted, never hidden", () => {
  const tail = "- a " + "x".repeat(400);
  const blocks = splitBlocks(["```", "", tail].join("\n"));
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].bytes > 400);
});

test("an indented fence inside a list item, after a blank line, counts toward the item", () => {
  const body = "  echo " + "y".repeat(300);
  const text = ["- item", "", "  ```bash", body, "  - not an item", "  ```", "- next"].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => b.line), [1, 7]);
  const expected = ["- item", "  ```bash", body, "  - not an item", "  ```"]
    .reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) + 1;
  assert.equal(blocks[0].bytes, expected);
});

test("@path imports are found outside code; @tags and code spans are not", () => {
  const text = [
    "@docs/infra/pr-validation.md",
    "See @README.md and `cat @not/this.md`.",
    "Tag with @stable or @release.",
    "```",
    "@inside/fence.md",
    "```",
    "- (@~/notes/x.md)",
  ].join("\n");
  assert.deepEqual(findImports(text), [
    { line: 1, token: "@docs/infra/pr-validation.md" },
    { line: 2, token: "@README.md" },
    { line: 7, token: "@~/notes/x.md" },
  ]);
});

test("an import fails the check even when every budget is met", () => {
  const r = checkDocument("CLAUDE.md", "- ok\n@docs/infra/x.md\n", SMALL);
  assert.equal(r.overFile, false);
  assert.equal(r.overBlocks.length, 0);
  assert.match(render([r], SMALL), /^FAIL[\s\S]*import: CLAUDE\.md:2 {2}@docs\/infra\/x\.md/m);
});

test("a file exactly at budget passes; one byte more fails", () => {
  const text = "a".repeat(SMALL.rootFile);
  assert.equal(checkDocument("CLAUDE.md", text, { ...SMALL, block: 1e9 }).overFile, false);
  assert.equal(checkDocument("CLAUDE.md", text + "a", { ...SMALL, block: 1e9 }).overFile, true);
});

test(".claude/CLAUDE.md is a project-root guide and gets the root budget", () => {
  assert.equal(fileBudget(".claude/CLAUDE.md"), BUDGETS.rootFile);
});

test("toRepoPath normalises ./, absolute and subdirectory-relative paths", () => {
  assert.equal(toRepoPath("./CLAUDE.md", "/r", "/r"), "CLAUDE.md");
  assert.equal(toRepoPath("/r/CLAUDE.md", "/r", "/anywhere"), "CLAUDE.md");
  assert.equal(toRepoPath("CLAUDE.md", "/r", "/r/a/b"), "a/b/CLAUDE.md");
  assert.equal(toRepoPath("../../CLAUDE.md", "/r", "/r/a/b"), "CLAUDE.md");
});

test("the over-budget report lists up to five largest blocks", () => {
  const text = Array.from({ length: 8 }, (_, i) => `- item ${i} ${"z".repeat(60)}`).join("\n");
  const report = render([checkDocument("CLAUDE.md", text, { ...SMALL, block: 1e9 })], SMALL);
  assert.equal((report.match(/^ {4}CLAUDE\.md:\d+/gm) ?? []).length, 5);
});

test("bytes are UTF-8 bytes, not characters", () => {
  const [block] = splitBlocks("- — →");
  assert.equal(block.bytes, Buffer.byteLength("- — →") + 1);
  assert.ok(block.bytes > "- — →".length + 1);
});

test("a file over budget fails and names its largest blocks", () => {
  const text = Array.from({ length: 10 }, (_, i) => `- item ${i} ${"z".repeat(40)}`).join("\n");
  const r = checkDocument("CLAUDE.md", text, SMALL);
  assert.equal(r.overFile, true);
  assert.equal(r.overBlocks.length, 0);
  const report = render([r], SMALL);
  assert.match(report, /^FAIL CLAUDE\.md: \d+ \/ 400 bytes/m);
  assert.match(report, /CLAUDE\.md:1 {2}\d+ bytes {2}- item 0/);
  assert.match(report, /docs\/infra\/<mechanism>\.md/);
});

test("one block over budget fails even when the file is under budget", () => {
  const text = `- short\n- **long** ${"w".repeat(120)}\n`;
  const r = checkDocument("CLAUDE.md", text, SMALL);
  assert.equal(r.overFile, false);
  assert.deepEqual(r.overBlocks.map((b) => b.line), [2]);
  assert.match(render([r], SMALL), /block over 100 bytes: CLAUDE\.md:2/);
});

test("a block exactly at budget passes", () => {
  const line = "- " + "q".repeat(97); // 99 bytes + newline = 100
  const r = checkDocument("CLAUDE.md", line, SMALL);
  assert.equal(r.overBlocks.length, 0);
  const over = checkDocument("CLAUDE.md", line + "q", SMALL);
  assert.equal(over.overBlocks.length, 1);
});

test("a clean report carries no fix instructions", () => {
  const r = checkDocument("CLAUDE.md", "- ok\n", SMALL);
  const report = render([r], SMALL);
  assert.match(report, /^ok {3}CLAUDE\.md/);
  assert.doesNotMatch(report, /docs\/infra/);
});

test("CLI: exits 0 on a clean file and 1 on an over-budget one", () => {
  const dir = makeTempDir("claude-md-budget-");
  const clean = join(dir, "clean.md");
  const fat = join(dir, "CLAUDE.md");
  writeFileSync(clean, "- ok\n");
  writeFileSync(fat, `- ${"f".repeat(BUDGETS.block + 10)}\n`);
  assert.equal(spawnSync("node", [SCRIPT, clean]).status, 0);
  const res = spawnSync("node", [SCRIPT, fat], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /block over/);
});

test("CLI: an unreadable path exits 2, never clean", () => {
  const res = spawnSync("node", [SCRIPT, "/nonexistent/CLAUDE.md"], { encoding: "utf8" });
  assert.equal(res.status, 2);
});

test("CLI: a repository with no tracked CLAUDE.md exits 2, never clean", () => {
  const dir = makeTempDir("claude-md-budget-empty-");
  execFileSync("git", ["init", "-q", dir]);
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /refusing to report clean/);
});

test("CLI: with no arguments it discovers root and nested tracked guides", () => {
  const dir = makeTempDir("claude-md-budget-repo-");
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "- root\n");
  writeFileSync(join(dir, "a", "b", "CLAUDE.md"), "- area\n");
  writeFileSync(join(dir, "untracked-CLAUDE.md"), "- no\n");
  execFileSync("git", ["-C", dir, "add", "CLAUDE.md", "a/b/CLAUDE.md"]);
  const res = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^ok {3}CLAUDE\.md: \d+ \/ 40000/m);
  assert.match(res.stdout, /^ok {3}a\/b\/CLAUDE\.md: \d+ \/ 20000/m);
  assert.doesNotMatch(res.stdout, /untracked/);
});

test("CLI: run from a subdirectory it still checks every guide, with root-relative paths", () => {
  const dir = makeTempDir("claude-md-budget-subdir-");
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "- root\n");
  writeFileSync(join(dir, "a", "b", "CLAUDE.md"), "- area\n");
  execFileSync("git", ["-C", dir, "add", "CLAUDE.md", "a/b/CLAUDE.md"]);
  const res = spawnSync("node", [SCRIPT], { cwd: join(dir, "a", "b"), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^ok {3}CLAUDE\.md: \d+ \/ 40000/m);
  assert.match(res.stdout, /^ok {3}a\/b\/CLAUDE\.md: \d+ \/ 20000/m);
  const explicit = spawnSync("node", [SCRIPT, "CLAUDE.md", "../../CLAUDE.md"], { cwd: join(dir, "a", "b"), encoding: "utf8" });
  assert.match(explicit.stdout, /^ok {3}a\/b\/CLAUDE\.md: \d+ \/ 20000/m);
  assert.match(explicit.stdout, /^ok {3}CLAUDE\.md: \d+ \/ 40000/m);
});
