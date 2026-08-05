// The infra-signature list is data (`infra-signature-patterns.json`) read by two
// accessors: `infra-signatures.ts` (CommonJS, for `@stable` auto-removal) and
// `infra-signatures.mjs` (ESM, for the triage path). #1310 explains why one code
// module cannot serve both on Node 20.
//
// The design's whole claim is that the two behave identically. This file asserts
// that instead of trusting it, because the first draft of the `.mjs` dropped the
// ESC prefix from one regex and widened `+` to `*` — a divergence that reads as
// correct and that a by-eye review of the diff passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import {
  INFRA_SIGNATURES as MJS_SIGNATURES,
  classifyInfraError as mjsClassify,
  stripAnsi as mjsStripAnsi,
} from "./infra-signatures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The TypeScript half compiles to CommonJS, so it is reachable from here only
// through ts-node's require hook — `npm run test:scripts` runs plain
// `node --test` with no hook. Registering it here rather than skipping the
// comparison: this is the only cross-language guard in the design, and a test
// that quietly skips itself would leave uncovered exactly the drift it exists
// to catch.
function loadTsHalf() {
  require("ts-node/register");
  return require("./infra-signatures.ts");
}

// A real ESC (0x1b), built from its code point so the byte cannot be silently
// lost or mangled by an editor or a diff.
const ESC = String.fromCharCode(27);

// Every input below is either a signature copied out of
// reports/daily-history.jsonl or a shape the exemption's own header names.
const CASES = [
  // --- must be classified as infra ---
  {
    label: "api-request-timeout, the shape that reached triage in #1296",
    error: "TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.",
    expected: "api-request-timeout",
  },
  {
    label: "api-request-timeout on post",
    error: "TimeoutError: apiRequestContext.post: Timeout 20000ms exceeded.",
    expected: "api-request-timeout",
  },
  {
    // This is the case that justifies classifying at write time (#1310): the
    // stored `error_signature` is line 1 only, so a triage-side fallback that
    // sees just that line cannot reach the transport error below it.
    label: "the transport error is NOT on line 1 — the #751 guard wraps it",
    error: [
      "Error: Agent credential never settled on the persisted flow (#751 guard, #1072).",
      "  observed       no successful read of the persisted flow",
      "  last read err  apiRequestContext.get: Timeout 20000ms exceeded.",
      "  verdict        read-failed",
    ].join("\n"),
    expected: "api-request-timeout",
  },
  {
    label: "preflight unreachable",
    error: "[preflight] http://localhost:7860/ is not reachable after 120s",
    expected: "preflight-unreachable",
  },
  {
    label: "ECONNREFUSED",
    error: "Error: connect ECONNREFUSED 127.0.0.1:7860",
    expected: "connection-refused",
  },
  { label: "socket hang up", error: "Error: socket hang up", expected: "connection-dropped" },
  { label: "ECONNRESET", error: "Error: read ECONNRESET", expected: "connection-dropped" },
  { label: "DNS", error: "Error: getaddrinfo EAI_AGAIN langflow", expected: "host-unresolvable" },
  {
    label: "ANSI-wrapped with a real ESC still classifies",
    error: ESC + "[31mTimeoutError: apiRequestContext.get: Timeout 20000ms exceeded." + ESC + "[39m",
    expected: "api-request-timeout",
  },
  {
    label: "ANSI-wrapped with the escape already lost still classifies",
    error: "[31mTimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.[39m",
    expected: "api-request-timeout",
  },

  // --- must NOT be classified: a wedge produces these, but so does a regression ---
  {
    label: "locator.click timeout — deliberately excluded",
    error: "TimeoutError: locator.click: Timeout 20000ms exceeded.",
    expected: null,
  },
  {
    label: "waitForSelector timeout — deliberately excluded",
    error: "page.waitForSelector: Timeout 30000ms exceeded.",
    expected: null,
  },
  {
    label: "toBeVisible — deliberately excluded, and the commonest signature there is",
    error: "Error: expect(locator).toBeVisible() failed",
    expected: null,
  },
  { label: "empty string", error: "", expected: null },
  { label: "null", error: null, expected: null },
  { label: "undefined", error: undefined, expected: null },
  {
    label: "the literal string the history stores when there was no message",
    error: "unknown",
    expected: null,
  },
  {
    label: "prose merely mentioning apiRequestContext is not a transport error",
    error: "Error: expected the docs to explain that apiRequestContext exists",
    expected: null,
  },
];

test("the ESM half classifies every documented shape as the exemption intends", () => {
  for (const { label, error, expected } of CASES) {
    const got = mjsClassify(error);
    assert.equal(got?.id ?? null, expected, label);
    if (expected) {
      assert.ok(got.why && got.why.length > 0, `${label}: a classified error must carry a reason`);
    }
  }
});

test("the ESM half is compiled from the JSON, in the JSON's order", () => {
  const raw = JSON.parse(readFileSync(join(HERE, "infra-signature-patterns.json"), "utf8"));
  assert.ok(Array.isArray(raw) && raw.length > 0, "the JSON list must be a non-empty array");

  assert.deepEqual(
    MJS_SIGNATURES.map((s) => s.id),
    raw.map((s) => s.id),
    "order must be preserved — classifyInfraError returns the FIRST match",
  );
  for (const [i, s] of MJS_SIGNATURES.entries()) {
    assert.equal(s.pattern.source, raw[i].pattern, `${s.id}: pattern source must come from the JSON verbatim`);
    assert.equal(s.pattern.flags, raw[i].flags, `${s.id}: flags must come from the JSON verbatim`);
  }
});

test("the CommonJS and ESM halves agree on everything — the anti-drift guard", () => {
  const ts = loadTsHalf();

  assert.deepEqual(
    ts.INFRA_SIGNATURES.map((s) => [s.id, s.pattern.source, s.pattern.flags]),
    MJS_SIGNATURES.map((s) => [s.id, s.pattern.source, s.pattern.flags]),
    "the two accessors must expose identical patterns, in identical order",
  );

  for (const { label, error, expected } of CASES) {
    assert.equal(
      ts.classifyInfraError(error)?.id ?? null,
      expected,
      `${label}: the CommonJS half must match the expectation`,
    );
    assert.equal(
      ts.classifyInfraError(error)?.id ?? null,
      mjsClassify(error)?.id ?? null,
      `${label}: the two halves must not diverge`,
    );
  }

  // stripAnsi is where the first draft diverged, so compare it directly on the
  // inputs that tell the two regex forms apart.
  for (const input of [
    ESC + "[2mexpect(" + ESC + "[22m",
    "[2mexpect([22m",
    "[m must survive — no digit, so the bare form must not strip it",
    "[preflight] must survive",
    "plain text",
    "",
  ]) {
    assert.equal(ts.stripAnsi(input), mjsStripAnsi(input), `stripAnsi diverged on ${JSON.stringify(input)}`);
  }
});

// The data file must never share the modules' basename. CommonJS resolves an
// extensionless `require("./lib/infra-signatures")` — how
// `remove-stable-from-failures.ts` imports it — by trying `.js`, `.json`, `.node`
// before ts-node's hook offers `.ts`. When the JSON was first added as
// `infra-signatures.json` it won that race, and the script that edits spec files
// on `main` died at runtime with `classifyInfraError is not a function`.
// `tsc --noEmit` stayed green throughout, because TypeScript resolves `.ts`
// first — so only an executing test can hold this line.
test("an extensionless require resolves to the MODULE, not to the data file", () => {
  require("ts-node/register");
  const viaExtensionless = require("./infra-signatures");

  assert.equal(
    typeof viaExtensionless.classifyInfraError,
    "function",
    "extensionless require must yield the accessor module — if this is undefined, a .json/.js sibling is shadowing it",
  );
  assert.ok(
    !Array.isArray(viaExtensionless),
    "extensionless require resolved to the raw pattern array, i.e. the data file shadowed the module",
  );
  assert.equal(viaExtensionless.classifyInfraError("Error: socket hang up")?.id, "connection-dropped");
});

test("the bare-escape form requires a digit, so it cannot eat bracketed prose", () => {
  assert.equal(mjsStripAnsi("[preflight] is not reachable"), "[preflight] is not reachable");
  assert.equal(mjsStripAnsi("[m"), "[m");
  assert.equal(mjsStripAnsi("[2m"), "");
  assert.equal(mjsStripAnsi(ESC + "[2m"), "");
});
