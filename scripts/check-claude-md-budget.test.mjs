// Unit tests for the CLAUDE.md size budget (issue #2542).
// Run with: node --test scripts/check-claude-md-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS, checkDocument, fileBudget, render, splitBlocks } from "./check-claude-md-budget.mjs";
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

test("a heading, a table or a column-0 paragraph after a blank line ends the block", () => {
  const text = [
    "- item",
    "## Heading",
    "- item two",
    "| a | b |",
    "- item three",
    "",
    "A paragraph",
    "that wraps.",
  ].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => b.line), [1, 3, 5, 7]);
  // The table row is not folded into the item before it.
  assert.equal(blocks[1].bytes, Buffer.byteLength("- item two\n"));
  assert.equal(blocks[3].bytes, Buffer.byteLength("A paragraph\nthat wraps.\n"));
});

test("a column-0 fenced block is not a block and its list-like lines are ignored", () => {
  const text = ["```bash", "- not a bullet " + "x".repeat(500), "```", "- real"].join("\n");
  const blocks = splitBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].preview, "- real");
});

test("an indented fence inside a list item counts toward that item", () => {
  const body = "  echo " + "y".repeat(300);
  const text = ["- item", "  ```bash", body, "  ```"].join("\n");
  const [block] = splitBlocks(text);
  assert.ok(block.bytes > 300, `fence content must count, got ${block.bytes}`);
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
