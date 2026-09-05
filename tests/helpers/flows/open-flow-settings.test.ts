// Structural guard for the flow-settings open (issue #1215).
// Run with: npm run test:units
//
// Why a structural test and not a behavioural one: the defect this helper exists
// to prevent is INVISIBLE at runtime. Clicking the `aria-hidden` `flow_name` span
// while upstream has the enclosing button `disabled` is swallowed by the browser
// with no error — Playwright's actionability check does not cover a `<span>`,
// because a span is not a form control. So there is nothing to assert on: the
// wrong code passes on a fast machine and fails, elsewhere, on a loaded one.
//
// What CAN be pinned is that the pattern does not come back. It was written six
// times across three files before this helper existed, and every copy looked
// perfectly reasonable in review. This is the same shape as the workflow-shape
// guard in `scripts/wait-for-backend.test.mjs`: assert the SOURCE, because the
// behaviour cannot be observed from a green run.
//
// The guard covers several spellings, because the narrow one is not the likely
// regression. `rename-flow.ts` ALREADY holds `const header =
// page.getByTestId("flow_name")` for its read-back assertions, so
// `header.click()` two lines later is the most probable way this comes back — and
// a guard that only matched the inline form would have blessed it.
//
// What it must NOT do is fire on a read. Those same files read the span
// legitimately, and a guard that fails a correct PR gets deleted rather than
// fixed — so the negative cases carry as much weight here as the positive ones,
// and are asserted with the same care.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HEADER_PRESENT_TIMEOUT_MS } from "./open-flow-settings";
import { stripComments } from "./strip-comments";

/** The suite root, resolved from this file rather than from `process.cwd()`. */
const TESTS_ROOT = join(__dirname, "..", "..");

/** Interactions that a disabled ancestor swallows. Reads are fine and not matched. */
const SWALLOWED = String.raw`click|hover|dblclick|tap`;

/** Any locator spelling that resolves the `flow_name` span. */
const FLOW_NAME_LOCATOR = String.raw`(?:getByTestId\(\s*["'\`]flow_name["'\`]\s*\)|locator\(\s*["'\`]\[data-testid=["'\\]*flow_name["'\\]*\]["'\`]\s*\))`;

/**
 * Zero or more intermediate calls between the locator and the action —
 * `.first()`, `.nth(0)`, `.filter({ hasText: "x" })`.
 *
 * This is what makes an offender an offender: the action is chained ONTO the
 * locator. The first version of this guard used a proximity window instead
 * (`[\s\S]{0,80}?`), which reads as the same thing and is not: a legitimate read
 * followed by an unrelated click on the next line falls inside 80 characters and
 * was reported as a swallowed click. Two specs already read this span, so that
 * false positive was a live trap, not a hypothetical one — the negative cases
 * below pin it shut.
 *
 * Known limit, and it fails to the safe side: `[^()]*` does not span a nested
 * paren, so `.filter((x) => f(x)).click()` is NOT matched. A missed offender is
 * recoverable; a guard that cries wolf gets deleted.
 */
const LOCATOR_CHAIN = String.raw`\s*(?:\.\s*\w+\s*\([^()]*\)\s*)*`;

/** 1-indexed line of an offset, for a message that points somewhere. */
function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/**
 * Every swallowed interaction on the `flow_name` span in one file, as readable
 * reasons carrying a line number. Covers the inline form, the `.first()`/chained
 * form, and the variable form — the last one by finding what the locator was
 * assigned to and then looking for an interaction on that name.
 *
 * Each occurrence is reported, not just the first per file: `lock-flow.ts` and
 * `flow-lock.spec.ts` held two and three of these respectively, and a guard that
 * says "this file" instead of "these lines" makes the reader re-find them.
 *
 * The variable form is matched FILE-WIDE, which is the one place this over-reads
 * by design: a file that assigns the span to `header` and, in an unrelated
 * function, clicks a different `header` is flagged. Scoping to a block would cost
 * a parser for a case the suite has never had — but a reader hitting a puzzling
 * hit here should check that the two `header`s are the same one before rewriting
 * anything.
 */
function findSpanInteractions(code: string): string[] {
  const hits: string[] = [];

  const inline = new RegExp(
    `${FLOW_NAME_LOCATOR}${LOCATOR_CHAIN}\\.\\s*(?:${SWALLOWED})\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(inline)) {
    hits.push(`inline locator interaction (line ${lineOf(code, match.index)})`);
  }

  const assigned = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*${FLOW_NAME_LOCATOR}`,
    "g",
  );
  for (const match of code.matchAll(assigned)) {
    const name = match[1];
    const viaVariable = new RegExp(
      `\\b${name}${LOCATOR_CHAIN}\\.\\s*(?:${SWALLOWED})\\s*\\(`,
      "g",
    );
    for (const use of code.matchAll(viaVariable)) {
      hits.push(`via variable \`${name}\` (line ${lineOf(code, use.index)})`);
    }
  }

  return hits;
}

/**
 * This file, excluded from its own sweep.
 *
 * It holds the offending spellings as string FIXTURES — that is how the guard's
 * own detection is asserted below — so scanning it would make the guard fail on
 * the very evidence that it works. The exclusion is one exact filename, not a
 * pattern, so it cannot quietly grow to cover real specs.
 */
const GUARD_FIXTURES = "open-flow-settings.test.ts";

function* walkTypeScript(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === GUARD_FIXTURES) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTypeScript(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

test("nothing in the suite interacts with the aria-hidden flow_name span", () => {
  const offenders: string[] = [];
  for (const file of walkTypeScript(TESTS_ROOT)) {
    const hits = findSpanInteractions(stripComments(readFileSync(file, "utf8")));
    for (const hit of hits) {
      offenders.push(`${file.slice(TESTS_ROOT.length + 1)} (${hit})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `interacting with the aria-hidden flow_name span is swallowed with no error ` +
      `while upstream has menu_bar_display disabled (#1215). Use ` +
      `openFlowSettings(page). Offenders: ${offenders.join("; ")}`,
  );
});

test("the guard catches the spellings it claims to catch", () => {
  // A guard nobody has seen fail is a guard nobody knows works, and this one has
  // no behavioural counterpart — so its own detection is asserted here rather
  // than trusted.
  const cases: Array<[string, string]> = [
    ["inline", `await page.getByTestId("flow_name").click();`],
    [
      "chained",
      `await page.getByTestId("flow_name").first().click({ timeout: 500 });`,
    ],
    [
      "variable",
      `const header = page.getByTestId("flow_name");\nawait header.hover();`,
    ],
    [
      "variable, chained",
      `const header = page.getByTestId("flow_name");\nawait header.first().click();`,
    ],
    [
      "raw locator",
      `await page.locator('[data-testid="flow_name"]').click();`,
    ],
  ];
  for (const [label, snippet] of cases) {
    assert.ok(
      findSpanInteractions(snippet).length > 0,
      `the ${label} form must be caught`,
    );
  }

  // And reads must NOT be flagged: several specs assert the committed name off
  // this span, which cannot be swallowed the way a click can.
  //
  // The last two are the ones that matter. They are what the proximity-window
  // version of this guard reported as offenders — a legitimate read followed by
  // an unrelated click, which is ordinary spec code and lands well inside 80
  // characters. Both live shapes are taken from the suite: `flow-rename-header`
  // reads the header back after a rename, `setup-playground` asserts it hydrated.
  const reads = [
    `await expect(page.getByTestId("flow_name")).toBeVisible();`,
    `const header = page.getByTestId("flow_name");\nawait expect(header).toHaveText(name);`,
    `const header = page.getByTestId("flow_name");\nconst text = await header.textContent();`,
    `await expect(page.getByTestId("flow_name")).toHaveText(name);\nawait page.getByTestId("save-flow-settings").click();`,
    `await expect(page.getByTestId("flow_name")).toContainText(n, {\n  timeout: 30000,\n});\nawait page.getByTestId("menu_bar_display").click();`,
  ];
  for (const snippet of reads) {
    assert.deepEqual(
      findSpanInteractions(snippet),
      [],
      `a read must not be flagged: ${snippet}`,
    );
  }

  // A trailing comment quoting the pattern must not fail the lane, and stripping
  // must not eat a URL.
  assert.deepEqual(
    findSpanInteractions(
      stripComments(
        `await openFlowSettings(page); // not getByTestId("flow_name").click()`,
      ),
    ),
    [],
  );
  assert.match(
    stripComments(`await page.goto("http://localhost:7860/flows");`),
    /http:\/\/localhost:7860/,
  );

  // Every occurrence is reported with its line, not one verdict per file. The
  // three call sites this issue removed all lived in one file each; "somewhere in
  // flow-lock.spec.ts" would have sent the next reader looking for them by hand.
  const twoSites = [
    `await page.getByTestId("flow_name").click();`,
    ``,
    `await page.getByTestId("flow_name").click();`,
  ].join("\n");
  assert.deepEqual(findSpanInteractions(twoSites), [
    "inline locator interaction (line 1)",
    "inline locator interaction (line 3)",
  ]);
});

test("the helper drives the button, and gates on it being enabled", () => {
  const code = stripComments(
    readFileSync(join(__dirname, "open-flow-settings.ts"), "utf8"),
  );
  // The gate is the whole point: driving the button WITHOUT waiting for enabled
  // would throw Playwright's own "element is not enabled" instead of silently
  // doing nothing — better, but still a failure where a wait belongs.
  assert.match(code, /getByTestId\("menu_bar_display"\)/);
  assert.match(code, /toBeEnabled\(/);
  assert.match(code, /\.click\(\)/);
  assert.deepEqual(findSpanInteractions(code), []);
});

test("the header-present budget is a positive, bounded wait", () => {
  // Still deliberately NOT pinned to `rename-flow.ts`'s `MODAL_TIMEOUT` by parsing
  // its source. That coupling read as provenance it does not have, and #1221
  // removed it precisely so #1222 could converge the permissions gate without
  // failing the unit lane.
  //
  // What this constant covers narrowed in #1222: it is now the "the editor put a
  // header on screen at all" wait only. The enabled gate it used to share a number
  // with is `PERMISSIONS_GATE_TIMEOUT_MS`, measured and shared with four other
  // sites — and the two are now different numbers, which is what makes their
  // independence visible rather than asserted.
  assert.ok(HEADER_PRESENT_TIMEOUT_MS > 0);
  assert.ok(
    HEADER_PRESENT_TIMEOUT_MS <= 30000,
    "a header that never appears must fail well inside the per-test timeout",
  );
});
