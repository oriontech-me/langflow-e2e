// Unit tests for the shared comment scanner (#1222).
// Run with: npm run test:units
//
// The cases below are the ones the two regexes this replaced got wrong, plus the
// two properties every caller depends on: offsets do not move, and strings are
// left alone. Each was measured against the real tree before it was written here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments";

const FLOWS_DIR = __dirname;

/** The invariant every `lineOf` caller leans on. */
function assertSameShape(source: string): void {
  const stripped = stripComments(source);
  assert.equal(stripped.length, source.length, "length moved");
  assert.equal(
    stripped.split("\n").length,
    source.split("\n").length,
    "line count moved",
  );
}

test("a comment is blanked in place, so nothing below it shifts", () => {
  const source = `const a = 1;\n/* two\n   lines */\nconst b = 2;`;
  const stripped = stripComments(source);
  assertSameShape(source);
  assert.equal(stripped.split("\n")[3], "const b = 2;");
  assert.match(stripped, /^const a = 1;\n {6}\n {11}\nconst b = 2;$/);
});

test("a removed comment cannot join the tokens either side of it", () => {
  const joined = stripComments("foo/* c */bar");
  assert.equal(joined, `foo${" ".repeat("/* c */".length)}bar`);
  assert.doesNotMatch(joined, /foobar/);
});

test("`/*` inside a string does not open a comment", () => {
  // The xpath idiom, 49 occurrences under `tests/`. The old regex opened a span
  // here that ran to the next `*/` anywhere in the file.
  const source = `const CANVAS = '//*[@id="react-flow-id"]';\nconst gate = "kept";`;
  assert.equal(stripComments(source), source);
});

test("`//` inside a string does not open a comment", () => {
  const source = `await page.goto("http://localhost:7860/");\nconst after = 1;`;
  assert.equal(stripComments(source), source);
  // Not just the colon case the old pattern special-cased: a protocol-relative
  // URL has no colon in front of the slashes at all.
  const relative = `await page.goto("//x");\nconst after = 1;`;
  assert.equal(stripComments(relative), relative);
});

test("`/*` inside a LINE comment does not open a block comment", () => {
  // `open-flow-by-id.ts:20` writes the glob `tests/fixtures/**` in prose. The old
  // regex ran the block pass first, so that `/*` opened a span closing at the
  // next JSDoc's `*/` and blanked the real code in between.
  const source = `// see \`tests/fixtures/**\` for this\nconst kept = 1;\n/** a doc */\nconst alsoKept = 2;`;
  const stripped = stripComments(source);
  assert.equal(stripped.split("\n")[1], "const kept = 1;");
  assert.equal(stripped.split("\n")[3], "const alsoKept = 2;");
});

test("string contents are preserved — the guards match on locator arguments", () => {
  // A neutral testid on purpose: `permissions-gate.test.ts` sweeps every `.ts`
  // under `tests/` for gates on `menu_bar_display`, and it cannot tell a fixture
  // from a call site. Spelling one here would make this file an offender in that
  // guard — which is exactly the behaviour it should have, so the fixture moves
  // rather than the guard's exclusion list growing to cover it.
  const source = `await expect(page.getByTestId("some_button")).toBeEnabled();`;
  assert.equal(stripComments(source), source);
});

test("an unterminated quote in prose does not swallow the rest of the file", () => {
  const source = `// it's a comment\nconst kept = 1;`;
  assert.equal(stripComments(source).split("\n")[1], "const kept = 1;");
});

test("a template literal is string content, backticks and escapes included", () => {
  const source = "const raw = `a \\` b // c /* d */`;\nconst kept = 1;";
  const stripped = stripComments(source);
  assert.equal(stripped.split("\n")[0], source.split("\n")[0]);
  assert.equal(stripped.split("\n")[1], "const kept = 1;");
});

test("an unclosed block comment blanks to end of file rather than throwing", () => {
  const source = `const a = 1;\n/* never closed\nstill inside`;
  assertSameShape(source);
  assert.equal(stripComments(source).split("\n")[0], "const a = 1;");
});

test("the real files that broke the old scanner keep all of their code", () => {
  // Regression, not a fixture: these are the two files measured losing code.
  // `open-flow-by-id.ts` lost 10 lines including its own
  // `PERMISSIONS_GATE_TIMEOUT_MS` import; `run-flow.spec.ts` lost 37.
  for (const [file, needles] of [
    [
      join(FLOWS_DIR, "open-flow-by-id.ts"),
      [`import { PERMISSIONS_GATE_TIMEOUT_MS } from "./permissions-gate";`],
    ],
    [
      join(
        FLOWS_DIR,
        "..",
        "..",
        "tests-automations",
        "regression",
        "flow-functionality",
        "run-flow.spec.ts",
      ),
      [`.getByTestId("handle-chatinput-noshownode-chat message-source")`],
    ],
  ] as [string, string[]][]) {
    const source = readFileSync(file, "utf8");
    assertSameShape(source);
    const stripped = stripComments(source);
    for (const needle of needles) {
      assert.ok(
        source.includes(needle),
        `fixture drift: ${needle} is no longer in ${file}`,
      );
      assert.ok(
        stripped.includes(needle),
        `${file}: the scanner blanked real code — ${needle}`,
      );
    }
  }
});
