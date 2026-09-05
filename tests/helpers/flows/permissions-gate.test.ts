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
// The comment scanner both guards run first is `./strip-comments`, one copy since
// review of this PR found it losing real code in `open-flow-by-id.ts` — the file
// named in CANONICAL_GATE_FILES below. A guard that reads a blanked file reports
// nothing and passes, which is the one failure mode it cannot tell you about, so
// the scanner carries its own tests.
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
import { stripComments } from "./strip-comments";

/** The suite root, resolved from this file rather than from `process.cwd()`. */
const TESTS_ROOT = join(__dirname, "..", "..");

/** This file holds the offending spellings as fixtures, so it cannot scan itself. */
const SELF = "permissions-gate.test.ts";

/** Any locator spelling that resolves the header button. */
const HEADER_LOCATOR = String.raw`(?:getByTestId\(\s*["'\`]menu_bar_display["'\`]\s*\)|locator\(\s*["'\`]\[data-testid=["'\\]*menu_bar_display["'\\]*\]["'\`]\s*\))`;

/** `.first()`, `.nth(0)` and friends between the locator and the assertion. */
const LOCATOR_CHAIN = String.raw`\s*(?:\.\s*\w+\s*\([^()]*\)\s*)*`;

/**
 * `expect`'s optional second argument, the failure message.
 *
 * Not hypothetical and not exotic: the suite passes one ~9 times already
 * (`serving/end-user-identity-required.spec.ts`, `collect-models.spec.ts`,
 * `enterprise/authz/share-discovery.spec.ts`, ...), and naming the failure is this
 * repo's house style — so it is the likely spelling of the NEXT gate someone
 * writes. Without this the closing paren was required immediately after the
 * locator, and `expect(page.getByTestId("menu_bar_display"), "must be writable")`
 * found zero gates and reported nothing.
 */
const EXPECT_MESSAGE = String.raw`(?:\s*,\s*[^()]*)?`;

/** Regex-escape an identifier before interpolating it into a pattern. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The two spellings of "wait until this button is usable".
 *
 * `not.toBeDisabled` is not hypothetical: `mcp-server.spec.ts` already waits on
 * `stdio-tab` that way, twice. A guard hardcoding `toBeEnabled` goes GREEN on a
 * diverged call site written in the other idiom — measured, by rewriting the
 * existing `open-flow-settings.ts` gate as `not.toBeDisabled({ timeout: 30000 })`:
 * the sweep found 0 gates in that file and reported no offender.
 *
 * `toBeDisabled` and `not.toBeEnabled` are deliberately NOT here. They assert the
 * opposite — a flow the user cannot write — which is a legitimate different
 * question and none of this budget's business.
 */
const USABLE_ASSERTION = String.raw`(?:toBeEnabled|not\s*\.\s*toBeDisabled)`;

/** 1-indexed line of an offset, for a message that points somewhere. */
function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
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
 *
 * KNOWN LIMITS, and every one of them fails to the SAFE side — a missed offender
 * is recoverable, a guard that cries wolf gets deleted rather than fixed:
 *
 *  - a locator returned by a helper or a Page Object method, rather than resolved
 *    at the call site;
 *  - an assignment without `const`/`let`/`var` on the same statement;
 *  - a call as the WHOLE argument (`toBeEnabled(opts(1))`) — the outer `\)`
 *    closes early. An options object CONTAINING a call is fine
 *    (`{ timeout: ms(30) }` is captured whole and correctly reported), which is
 *    the opposite of what this list claimed until it was checked;
 *  - arithmetic on the constant (`{ timeout: PERMISSIONS_GATE_TIMEOUT_MS * 2 }`)
 *    reads as compliant, because the test is that the name appears.
 *
 * None is in the tree today. Adding one would be a reason to widen this, not a
 * reason to have widened it in advance.
 */
export function findEnabledGates(source: string): Gate[] {
  const code = stripComments(source);
  const gates: Gate[] = [];

  const inline = new RegExp(
    `${HEADER_LOCATOR}${LOCATOR_CHAIN}${EXPECT_MESSAGE}\\)${LOCATOR_CHAIN}\\.\\s*${USABLE_ASSERTION}\\s*\\(([^()]*(?:\\{[^{}]*\\})?[^()]*)\\)`,
    "g",
  );
  for (const match of code.matchAll(inline)) {
    gates.push({ options: match[1].trim(), line: lineOf(code, match.index) });
  }

  const assigned = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*${HEADER_LOCATOR}`,
    "g",
  );
  // Distinct names, because the scan below is file-wide: two declarations of the
  // same locator variable in one file used to report every one of its gates twice.
  const names = new Set(
    [...code.matchAll(assigned)].map((declaration) => declaration[1]),
  );
  for (const name of names) {
    const viaVariable = new RegExp(
      `expect(?:\\.\\s*soft)?\\(\\s*${escapeForRegExp(name)}${LOCATOR_CHAIN}${EXPECT_MESSAGE}\\)${LOCATOR_CHAIN}\\.\\s*${USABLE_ASSERTION}\\s*\\(([^()]*(?:\\{[^{}]*\\})?[^()]*)\\)`,
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
    // NOT "5 s is too short for the measured p95" — it is not, and saying so
    // would be a justification the measurement 40 lines away refutes, which is
    // how an exemption stops being believed (#1084). The objection is that a bare
    // gate silently inherits a GLOBAL default this budget does not own: ~1.3× the
    // observed max query latency instead of ~8×, and a number that moves the day
    // someone sets `expect.timeout` in `playwright.config.ts` for unrelated
    // reasons.
    return `line ${gate.line}: no explicit timeout — the gate inherits Playwright's global 5 s expect default (~1.3× the measured max of the query it waits on, against ~8× here), and moves whenever that default does`;
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
    // The sibling guard skips this and this one did not; a stray install under
    // `tests/` would have the sweep read a vendored tree it does not own.
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...suiteFiles(full));
    } else if (entry.endsWith(".ts") && entry !== SELF) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The two files that must always carry a gate, one per spelling.
 *
 * A bare count was the first floor here and it was wrong in both directions: it
 * did not catch losing a site to an idiom the matcher missed, and it would have
 * REDDENED the obvious next refactor — folding the two spec-level gates into
 * `setupBlankFlow`, which is what #1108's principle pushes toward. These two are
 * the entry points #1222 is about, they exercise the inline and the variable
 * spelling respectively, and removing either is a change that should come here.
 */
const CANONICAL_GATE_FILES = [
  "helpers/flows/open-flow-by-id.ts",
  "helpers/flows/open-flow-settings.ts",
];

test("every menu_bar_display enabled-gate in the suite names the one constant", () => {
  const offenders: string[] = [];
  const filesWithGates = new Set<string>();

  for (const file of suiteFiles()) {
    const relative = file.slice(TESTS_ROOT.length + 1);
    for (const gate of findEnabledGates(readFileSync(file, "utf8"))) {
      filesWithGates.add(relative);
      const complaint = gateComplaint(gate);
      if (complaint) {
        offenders.push(`${relative} — ${complaint}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these waits on the permissions query have their own budget again:\n  ${offenders.join("\n  ")}`,
  );

  // A sweep that finds nothing passes, and would keep passing after the testid is
  // renamed or the matcher rots — the guard's own failure mode, and the one it
  // cannot report because it looks exactly like compliance.
  for (const file of CANONICAL_GATE_FILES) {
    assert.ok(
      filesWithGates.has(file),
      `no gate found in ${file} — the matcher no longer sees a call site it is supposed to guard, or that gate moved (which belongs in CANONICAL_GATE_FILES)`,
    );
  }
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
  assert.equal(gateComplaint(chained[0]), null);
});

test("a failure message on the expect is the same gate, and the guard sees it", () => {
  // ~9 call sites in this suite already pass one, and naming the failure is the
  // house style — so this is the likely spelling of the next gate. The guard used
  // to find ZERO here, which is the quiet failure: green, and blind.
  const inline = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display"), "the flow must be writable").toBeEnabled({ timeout: 30000 });`,
  );
  assert.equal(inline.length, 1);
  assert.match(gateComplaint(inline[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);

  const variable = findEnabledGates(
    `const headerButton = page.getByTestId("menu_bar_display");\nawait expect(headerButton, "writable").toBeEnabled({ timeout: PERMISSIONS_GATE_TIMEOUT_MS });`,
  );
  assert.equal(variable.length, 1);
  assert.equal(gateComplaint(variable[0]), null);
});

test("a `$`-prefixed locator variable is not a regex anchor", () => {
  // `$` is admitted by the identifier class and was interpolated into the pattern
  // unescaped, so `$btn` compiled to an end-of-input assertion and matched nothing.
  const gates = findEnabledGates(
    `const $btn = page.getByTestId("menu_bar_display");\nawait expect($btn).toBeEnabled({ timeout: 30000 });`,
  );
  assert.equal(gates.length, 1);
  assert.match(gateComplaint(gates[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);
});

test("one locator variable declared twice reports each gate once", () => {
  const gates = findEnabledGates(
    [
      `const headerButton = page.getByTestId("menu_bar_display");`,
      `await expect(headerButton).toBeEnabled({ timeout: 30000 });`,
      `const headerButton = page.getByTestId("menu_bar_display");`,
    ].join("\n"),
  );
  assert.equal(gates.length, 1);
});

test("a gate is found next to the code shapes that used to blank it", () => {
  // The scanner defect this guard shipped with, as behaviour rather than prose:
  // a `/*` inside a string or inside a line comment opened a span that ran to the
  // next `*/`, and every gate in between was invisible. Both shapes are in the
  // tree — the xpath idiom 49 times, and the glob in `open-flow-by-id.ts:20`, the
  // canonical file this very guard asserts a gate in.
  for (const preamble of [
    `const CANVAS = '//*[@id="react-flow-id"]';`,
    "// see `tests/fixtures/**` for why this is a helper",
    `await page.goto("http://localhost:7860/");`,
    `await page.goto("//protocol-relative");`,
  ]) {
    const gates = findEnabledGates(
      `${preamble}\nawait expect(page.getByTestId("menu_bar_display")).toBeEnabled({ timeout: 30000 });\n/** a doc comment closing the fake span */`,
    );
    assert.equal(gates.length, 1, `blanked by: ${preamble}`);
    assert.equal(gates[0].line, 2, `wrong line after: ${preamble}`);
  }
});

test("`not.toBeDisabled` is the same gate, and the guard sees it", () => {
  // Not hypothetical: `mcp-server.spec.ts` waits on `stdio-tab` this way twice.
  // A guard hardcoding `toBeEnabled` went GREEN on the diverged call site — I
  // rewrote the real `open-flow-settings.ts` gate in this idiom with a literal
  // 30000 and the sweep reported nothing at all.
  const inline = findEnabledGates(
    `await expect(page.getByTestId("menu_bar_display")).not.toBeDisabled({ timeout: 30000 });`,
  );
  assert.equal(inline.length, 1);
  assert.match(gateComplaint(inline[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);

  const variable = findEnabledGates(
    `const headerButton = page.getByTestId("menu_bar_display");\nawait expect(headerButton).not.toBeDisabled({ timeout: PERMISSIONS_GATE_TIMEOUT_MS });`,
  );
  assert.equal(variable.length, 1);
  assert.equal(gateComplaint(variable[0]), null);

  // `expect.soft` is 21 uses deep in this suite; the variable form used to miss it.
  const soft = findEnabledGates(
    `const headerButton = page.getByTestId("menu_bar_display");\nawait expect.soft(headerButton).toBeEnabled({ timeout: 30000 });`,
  );
  assert.equal(soft.length, 1);
  assert.match(gateComplaint(soft[0]) ?? "", /not PERMISSIONS_GATE_TIMEOUT_MS/);
});

test("asserting the button is NOT usable is a different question, and is left alone", () => {
  // A spec that observes a read-only flow asserts exactly this, and it is none of
  // this budget's business — firing on it would make the guard wrong about the one
  // case #1214's `requireWritable: false` exists for.
  for (const source of [
    `await expect(page.getByTestId("menu_bar_display")).toBeDisabled({ timeout: 5000 });`,
    `await expect(page.getByTestId("menu_bar_display")).not.toBeEnabled({ timeout: 5000 });`,
  ]) {
    assert.deepEqual(findEnabledGates(source), []);
  }
});

test("the guard rejects the three ways the divergence comes back", () => {
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
