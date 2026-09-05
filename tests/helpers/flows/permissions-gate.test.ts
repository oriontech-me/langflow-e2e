// Structural guard for the one effective-permissions budget (issue #1222).
// Run with: npm run test:units
//
// WHY A STRUCTURAL TEST
//
// The defect is not a wrong wait, it is FIVE waits on one upstream element with
// three different provenances and two different numbers. Nothing about that is
// observable from a green run: every one of the five passes, and the divergence
// only shows up the day someone raises one of them for a real reason and the
// other four keep the old value. #1215 already had to document the five-way split
// in prose because there was no mechanism to hold it.
//
// So this asserts the SOURCE, the same shape as `open-flow-settings.test.ts`'s
// swallowed-click guard and `scripts/wait-for-backend.test.mjs`'s workflow-shape
// guard: every gate on `menu_bar_display` being enabled must name
// `PERMISSIONS_GATE_TIMEOUT_MS`, never a literal and never nothing.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not pin the constant to any other constant. PR #1221 removed exactly
// such a coupling — a regex that read `rename-flow.ts`'s `MODAL_TIMEOUT` — and
// #1222's own "done when" forbids re-adding one, because a value pinned to an
// unrelated third number cannot be changed by the measurement that should govern
// it. The only relation asserted anywhere is the INEQUALITY in
// `open-flow-by-id.test.ts` between that entry's own two budgets, which is a
// statement about their ordering and not about either value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS_GATE_TIMEOUT_MS } from "./permissions-gate";

/** The suite root, resolved from this file rather than from `process.cwd()`. */
const TESTS_ROOT = join(__dirname, "..", "..");

/** This file holds the offending spellings as fixtures, so it cannot scan itself. */
const SELF = "permissions-gate.test.ts";

/** Any locator spelling that resolves the header button. */
const HEADER_LOCATOR = String.raw`(?:getByTestId\(\s*["'\`]menu_bar_display["'\`]\s*\)|locator\(\s*["'\`]\[data-testid=["'\\]*menu_bar_display["'\\]*\]["'\`]\s*\))`;

/** `.first()`, `.nth(0)` and friends between the locator and the assertion. */
const LOCATOR_CHAIN = String.raw`\s*(?:\.\s*\w+\s*\([^()]*\)\s*)*`;

/** 1-indexed line of an offset, for a message that points somewhere. */
function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** Strip comments so the guard does not read its own documentation as code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\w])\/\/.*$/gm, "$1");
}

export interface Gate {
  /** The literal text of the `toBeEnabled(...)` argument list, `""` when empty. */
  options: string;
  line: number;
}

/**
 * Every `menu_bar_display` enabled-gate in one file.
 *
 * Two spellings, because both are in the tree today: the inline
 * `expect(page.getByTestId(...)).toBeEnabled(...)` that four call sites use, and
 * the variable form in `open-flow-settings.ts`, which assigns the locator first
 * because it clicks the same button two lines later. A guard matching only the
 * inline form would bless the one file the issue was opened from.
 */
export function findEnabledGates(source: string): Gate[] {
  const code = stripComments(source);
  const gates: Gate[] = [];

  const inline = new RegExp(
    `${HEADER_LOCATOR}${LOCATOR_CHAIN}\\)${LOCATOR_CHAIN}\\.\\s*toBeEnabled\\s*\\(([^()]*(?:\\{[^{}]*\\})?[^()]*)\\)`,
    "g",
  );
  for (const match of code.matchAll(inline)) {
    gates.push({ options: match[1].trim(), line: lineOf(code, match.index) });
  }

  const assigned = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*${HEADER_LOCATOR}`,
    "g",
  );
  for (const declaration of code.matchAll(assigned)) {
    const name = declaration[1];
    const viaVariable = new RegExp(
      `expect\\(\\s*${name}${LOCATOR_CHAIN}\\)${LOCATOR_CHAIN}\\.\\s*toBeEnabled\\s*\\(([^()]*(?:\\{[^{}]*\\})?[^()]*)\\)`,
      "g",
    );
    for (const use of code.matchAll(viaVariable)) {
      gates.push({ options: use[1].trim(), line: lineOf(code, use.index) });
    }
  }

  return gates;
}

/** A gate is compliant when it names the shared constant as its timeout. */
export function gateComplaint(gate: Gate): string | null {
  if (!/\btimeout\s*:/.test(gate.options)) {
    return `line ${gate.line}: no explicit timeout — the gate would fall back to Playwright's 5 s expect default, which is under the measured p95 of the query it waits on`;
  }
  if (!/\btimeout\s*:\s*PERMISSIONS_GATE_TIMEOUT_MS\b/.test(gate.options)) {
    return `line ${gate.line}: timeout is not PERMISSIONS_GATE_TIMEOUT_MS (${gate.options})`;
  }
  return null;
}

/** Every `.ts` under `tests/`, minus this file. */
function suiteFiles(dir: string = TESTS_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...suiteFiles(full));
    } else if (entry.endsWith(".ts") && entry !== SELF) {
      out.push(full);
    }
  }
  return out;
}

test("every menu_bar_display enabled-gate in the suite names the one constant", () => {
  const offenders: string[] = [];
  let gateCount = 0;

  for (const file of suiteFiles()) {
    for (const gate of findEnabledGates(readFileSync(file, "utf8"))) {
      gateCount += 1;
      const complaint = gateComplaint(gate);
      if (complaint) {
        offenders.push(`${file.slice(TESTS_ROOT.length + 1)} — ${complaint}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these waits on the permissions query have their own budget again:\n  ${offenders.join("\n  ")}`,
  );

  // A sweep that finds nothing passes, and would keep passing after the testid is
  // renamed — the guard's own failure mode. Five call sites exist today; the floor
  // is deliberately below that so removing one is not a red, while removing them
  // all (or breaking the matcher) is.
  assert.ok(
    gateCount >= 4,
    `only ${gateCount} enabled-gate(s) found — the matcher no longer sees the call sites it guards`,
  );
});

test("the guard sees both spellings, and reads the timeout out of each", () => {
  const inline = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display")).toBeEnabled({\n  timeout: PERMISSIONS_GATE_TIMEOUT_MS,\n});`,
  );
  assert.equal(inline.length, 1);
  assert.equal(gateComplaint(inline[0]), null);

  const variable = findEnabledGates(
    `const headerButton = page.getByTestId("menu_bar_display");\nawait expect(headerButton).toBeEnabled({ timeout: PERMISSIONS_GATE_TIMEOUT_MS });`,
  );
  assert.equal(variable.length, 1);
  assert.equal(gateComplaint(variable[0]), null);

  const chained = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display").first()).toBeEnabled({ timeout: PERMISSIONS_GATE_TIMEOUT_MS });`,
  );
  assert.equal(chained.length, 1);
});

test("the guard rejects the two ways the divergence comes back", () => {
  // A literal — how all five started.
  const literal = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display")).toBeEnabled({ timeout: 30000 });`,
  );
  assert.equal(literal.length, 1);
  assert.match(gateComplaint(literal[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);

  // No timeout at all — silently Playwright's 5 s default, which is under the
  // measured p95 of the query, so it reads as correct and fails under load.
  const bare = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display")).toBeEnabled();`,
  );
  assert.equal(bare.length, 1);
  assert.match(gateComplaint(bare[0]) ?? "", /no explicit timeout/);

  // A different constant is still a divergence, whatever it is called.
  const other = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display")).toBeEnabled({ timeout: MODAL_TIMEOUT });`,
  );
  assert.match(gateComplaint(other[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);
});

test("the guard does not fire on a read, or on a different button", () => {
  // `toBeVisible` on the same button is a legitimate, different question.
  assert.deepEqual(
    findEnabledGates(
      `await expect(page.getByTestId("menu_bar_display")).toBeVisible({ timeout: 5000 });`,
    ),
    [],
  );
  // Another element's enabled-gate is none of this guard's business.
  assert.deepEqual(
    findEnabledGates(
      `await expect(page.getByTestId("save-flow-settings")).toBeEnabled({ timeout: 15000 });`,
    ),
    [],
  );
  // A commented-out offender is documentation, not code.
  assert.deepEqual(
    findEnabledGates(
      `// await expect(page.getByTestId("menu_bar_display")).toBeEnabled({ timeout: 30000 });`,
    ),
    [],
  );
});

test("the budget is positive and fails well inside the per-test timeout", () => {
  // Bounds, not a pinned value: the number is governed by the measurement recorded
  // next to it, and an equality here would freeze it against the next one.
  assert.ok(PERMISSIONS_GATE_TIMEOUT_MS > 0);
  assert.ok(
    PERMISSIONS_GATE_TIMEOUT_MS < 300000,
    "a gate that never resolves must fail on its own assertion, not as a test-level timeout",
  );
});
