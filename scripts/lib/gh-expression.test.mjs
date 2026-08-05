import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExpression, evaluateWorkflowValue } from "./gh-expression.mjs";

const TRACING =
  "${{ (contains(needs.detect-specs.outputs.specs, 'observability-monitoring') || " +
  "needs.detect-specs.outputs.needs_models == 'true') && 'false' || 'true' }}";

const run = ({ specs = "", needsModels = "false" } = {}) => ({
  "needs.detect-specs.outputs.specs": specs,
  "needs.detect-specs.outputs.needs_models": needsModels,
});

test("the ternary idiom yields an operand, not a boolean", () => {
  // `cond && 'a' || 'b'` is how a workflow writes a ternary. Modelled as boolean
  // logic it would come out `true` in both branches, which would make every guard
  // built on this module vacuous.
  assert.equal(evaluateExpression("true && 'a' || 'b'"), "a");
  assert.equal(evaluateExpression("false && 'a' || 'b'"), "b");
});

test("pr-validation's tracing expression enables tracing exactly on the runs with spend (#1300)", () => {
  // "false" means DEACTIVATE_TRACING=false, i.e. tracing IS on.
  assert.equal(evaluateWorkflowValue(TRACING, run({ needsModels: "true" })), "false");
  assert.equal(evaluateWorkflowValue(TRACING, run({ specs: "a/observability-monitoring/b.spec.ts" })), "false");
  assert.equal(evaluateWorkflowValue(TRACING, run()), "true", "an LLM-free run keeps the cheap path");
});

test("the two mutations the old substring guard passed are distinguishable here (#1300)", () => {
  const inverted = TRACING.replace("needs_models == 'true'", "needs_models == 'false'");
  const swapped = TRACING.replace("&& 'false' || 'true'", "&& 'true' || 'false'");
  // Both still MENTION needs_models, which is all the old guard asked.
  assert.equal(evaluateWorkflowValue(inverted, run({ needsModels: "true" })), "true", "blind on the LLM run");
  assert.equal(evaluateWorkflowValue(swapped, run({ needsModels: "true" })), "true", "blind on the LLM run");
});

test("an unsupplied context reference throws instead of defaulting", () => {
  assert.throws(() => evaluateExpression("needs.other.outputs.thing == 'true'"), /no value supplied/);
  // The fail-closed point: defaulting to empty would evaluate the whole
  // expression to a value nobody chose, and the guard would report a verdict.
  assert.throws(() => evaluateWorkflowValue(TRACING, {}), /no value supplied/);
});

test("an unsupported function or operator throws rather than evaluating around it", () => {
  assert.throws(() => evaluateExpression("hashFiles('**/package-lock.json')"), /unsupported function/);
  assert.throws(() => evaluateExpression("fromJSON('[]')"), /unsupported function/);
  assert.throws(() => evaluateExpression("1 > 0"), /unexpected character/);
});

test("comparison, negation and grouping", () => {
  assert.equal(evaluateExpression("'a' == 'a'"), true);
  assert.equal(evaluateExpression("'a' != 'b'"), true);
  assert.equal(evaluateExpression("!false"), true);
  assert.equal(evaluateExpression("(false || true) && 'x'"), "x");
  assert.equal(evaluateExpression("contains('abc', 'b')"), true);
  assert.equal(evaluateExpression("startsWith('abc', 'b')"), false);
  assert.equal(evaluateExpression("endsWith('abc', 'bc')"), true);
});

test("GitHub truthiness, not JavaScript's", () => {
  assert.equal(evaluateExpression("x && 'yes' || 'no'", { x: "" }), "no");
  assert.equal(evaluateExpression("x && 'yes' || 'no'", { x: "0" }), "no");
  assert.equal(evaluateExpression("x && 'yes' || 'no'", { x: "false" }), "yes", "a non-empty string is true");
});

test("a mixed comparison is refused rather than cast", () => {
  assert.throws(() => evaluateExpression("x == 1", { x: "1" }), /refusing to compare/);
});

test("a plain scalar comes back as its string, quoted or not", () => {
  assert.equal(evaluateWorkflowValue("false"), "false");
  assert.equal(evaluateWorkflowValue('"false"'), "false");
  assert.equal(evaluateWorkflowValue("'true'"), "true");
  assert.equal(evaluateWorkflowValue("  true  "), "true");
});

test("a value that mixes literal text with an interpolation is refused, not half-read", () => {
  assert.throws(() => evaluateWorkflowValue("prefix-${{ x }}", { x: "a" }), /mixes an interpolation/);
  assert.throws(() => evaluateWorkflowValue("${{ '${{ x }}' }}"), /nested interpolation/);
});

test("a doubled quote is an escaped quote", () => {
  assert.equal(evaluateExpression("'it''s'"), "it's");
});

test("malformed input throws with the source named", () => {
  assert.throws(() => evaluateExpression("(true"), /unbalanced parentheses/);
  assert.throws(() => evaluateExpression("'unterminated"), /unterminated string/);
  assert.throws(() => evaluateExpression("'a' 'b'"), /trailing input/);
  assert.throws(() => evaluateExpression("contains('a')"), /takes 2 argument/);
});
