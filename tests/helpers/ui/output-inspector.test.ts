// Unit tests for the output-inspector locator (issues #2177, #2210).
// Run with: npm run test:units
//
// Two halves. The selector builder is the whole of the helper's logic, so it is
// pinned directly. The second half is the reason the helper exists: a positional
// `[role="dialog"]` read (`.last()`, `.first()`, `.nth()`) resolves to whichever
// dialog is in that slot, and the assistant onboarding tooltip is a dialog that
// mounts 10 s after the canvas. #2177 took two VM dailies to trace one such read,
// and #2210 found five more. The guard below fails the unit lane when one comes
// back, anywhere under `tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { outputInspectorTitleSelector } from "./output-inspector";

test("selects the inspector of one output by its internal name", () => {
  assert.equal(
    outputInspectorTitleSelector("structured_response"),
    '[data-testid$="-structured_response-output-modal"]',
  );
});

test("selects any open inspector when no output name is given", () => {
  assert.equal(outputInspectorTitleSelector(), '[data-testid$="-output-modal"]');
});

test("refuses a display name or anything that would break the selector", () => {
  // A display name is the commonest mistake ("Structured Response"), and a quote
  // would produce a selector that matches nothing. That would surface as a
  // visibility timeout blamed on the product, so the builder throws at the call site.
  for (const bad of ["Structured Response", 'a"b', "a]b", "", "messages-text"]) {
    assert.throws(() => outputInspectorTitleSelector(bad), /not an internal output name/, bad);
  }
});

/** Strip comments so prose ABOUT the anti-pattern (this file, the helper) is not flagged. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * A `[role="dialog"]` locator picked by position. Whitespace (newlines included) may
 * separate the locator from the positional call, because Prettier breaks chains.
 */
const POSITIONAL_DIALOG =
  /(?:\.locator\(\s*(['"`])\[role=(?:\\?["']|)dialog(?:\\?["']|)\]\1\s*\)|\.getByRole\(\s*['"`]dialog['"`]\s*\))\s*\.(?:last\(\)|first\(\)|nth\()/g;

/** Every positional dialog read in `source`, as 1-based line numbers. */
export function findPositionalDialogReads(source: string): number[] {
  const code = stripComments(source);
  const lines: number[] = [];
  for (const m of code.matchAll(POSITIONAL_DIALOG)) {
    lines.push(code.slice(0, m.index).split("\n").length);
  }
  return lines;
}

test("the guard finds every spelling of a positional dialog read", () => {
  // Each line is one shape the suite has used or Prettier produces. A guard that
  // misses one of them passes the very regression it exists to catch.
  const cases: [string, string][] = [
    ["single-quoted locator", `const d = page.locator('[role="dialog"]').last();`],
    ["double-quoted locator", `const d = page.locator("[role='dialog']").last();`],
    ["unquoted attribute", `const d = page.locator("[role=dialog]").first();`],
    ["getByRole", `const d = page.getByRole("dialog").last();`],
    ["nth", `const d = page.getByRole("dialog").nth(1);`],
    ["Prettier-broken chain", `const d = page\n  .locator('[role="dialog"]')\n  .last();`],
  ];
  for (const [name, source] of cases) {
    assert.equal(findPositionalDialogReads(source).length, 1, name);
  }
});

test("the guard leaves content-scoped dialogs and comments alone", () => {
  const cases: [string, string][] = [
    ["filtered by content", `page.getByRole("dialog").filter({ has: x });`],
    ["scoped then first", `page.locator('[role="dialog"]').getByText(T).first();`],
    ["line comment", `// page.locator('[role="dialog"]').last() was the bug`],
    ["block comment", `/* page.getByRole("dialog").last() */ const x = 1;`],
    ["url before code", `const u = "http://x"; page.getByRole("dialog").filter({ has: y });`],
  ];
  for (const [name, source] of cases) {
    assert.deepEqual(findPositionalDialogReads(source), [], name);
  }
});

/**
 * Every `.ts` file under `dir` that drives a browser: `node_modules` and the unit
 * tests are skipped, since a unit test (this one included) spells the anti-pattern
 * as fixture data.
 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

test("no file under tests/ reads a dialog by position (#2210)", () => {
  const root = join(__dirname, "..", "..");
  const files = tsFiles(root);
  // Floor: a walk that silently found nothing would make the assertion below vacuous.
  assert.ok(files.length > 200, `expected to scan the suite, found ${files.length} file(s)`);

  const offenders = files.flatMap((file) =>
    findPositionalDialogReads(readFileSync(file, "utf8")).map(
      (line) => `${relative(root, file)}:${line}`,
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    "Positional `[role=\"dialog\"]` reads resolve to whichever dialog holds that slot, and the " +
      "assistant onboarding tooltip is a dialog too (#2177, #2210). For the output inspector use " +
      "`outputInspectorDialog` from tests/helpers/ui/output-inspector.ts; for any other modal, " +
      "filter the dialog by its own content.",
  );
});
