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
// The guard covers three spellings, because the narrow one is not the likely
// regression. `rename-flow.ts` ALREADY holds `const header =
// page.getByTestId("flow_name")` for its read-back assertions, so
// `header.click()` two lines later is the most probable way this comes back — and
// a guard that only matched the inline form would have blessed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HEADER_ENABLED_TIMEOUT_MS } from "./open-flow-settings";

/** The suite root, resolved from this file rather than from `process.cwd()`. */
const TESTS_ROOT = join(__dirname, "..", "..");

/** Interactions that a disabled ancestor swallows. Reads are fine and not matched. */
const SWALLOWED = String.raw`click|hover|dblclick|tap`;

/** Any locator spelling that resolves the `flow_name` span. */
const FLOW_NAME_LOCATOR = String.raw`(?:getByTestId\(\s*["'\`]flow_name["'\`]\s*\)|locator\(\s*["'\`]\[data-testid=["'\\]*flow_name["'\\]*\]["'\`]\s*\))`;

/**
 * Strip comments so the guard does not fail on its own documentation.
 *
 * Line comments are matched only when `//` follows start-of-line or whitespace
 * AND is not preceded by a colon — otherwise `page.goto("http://…")` would be
 * truncated mid-string and the file would stop parsing as the code it is.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\w])\/\/.*$/gm, "$1");
}

/**
 * Every swallowed interaction on the `flow_name` span in one file, as readable
 * reasons. Covers the inline form, the `.first()`/chained form, and the variable
 * form — the last one by finding what the locator was assigned to and then looking
 * for an interaction on that name.
 */
function findSpanInteractions(code: string): string[] {
  const hits: string[] = [];

  const inline = new RegExp(
    `${FLOW_NAME_LOCATOR}[\\s\\S]{0,80}?\\.\\s*(?:${SWALLOWED})\\s*\\(`,
    "g",
  );
  if (inline.test(code)) hits.push("inline locator interaction");

  const assigned = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*${FLOW_NAME_LOCATOR}`,
    "g",
  );
  for (const match of code.matchAll(assigned)) {
    const name = match[1];
    const viaVariable = new RegExp(
      `\\b${name}\\s*(?:\\.\\s*\\w+\\s*\\([^)]*\\)\\s*)*\\.\\s*(?:${SWALLOWED})\\s*\\(`,
    );
    if (viaVariable.test(code)) hits.push(`via variable \`${name}\``);
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

test("the guard catches the three spellings it claims to catch", () => {
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
  const reads = [
    `await expect(page.getByTestId("flow_name")).toBeVisible();`,
    `const header = page.getByTestId("flow_name");\nawait expect(header).toHaveText(name);`,
    `const header = page.getByTestId("flow_name");\nconst text = await header.textContent();`,
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

test("the header budget is a positive, bounded wait", () => {
  // Deliberately NOT pinned to `rename-flow.ts`'s `MODAL_TIMEOUT` by parsing its
  // source. That coupling read as provenance it does not have — `MODAL_TIMEOUT`
  // was sized in #357 for the modal's inputs, not for the permissions query this
  // gate waits on — and it would have cemented a divergence: the sibling gate in
  // `open-flow-by-id.ts` (#1214) waits 30 s on the SAME button. Converging the two
  // is tracked separately; pinning one to a third constant here would have made
  // that convergence fail the unit lane.
  assert.ok(HEADER_ENABLED_TIMEOUT_MS > 0);
  assert.ok(
    HEADER_ENABLED_TIMEOUT_MS <= 30000,
    "a header that never enables must fail well inside the per-test timeout",
  );
});
