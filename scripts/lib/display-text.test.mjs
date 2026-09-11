// The one sanitiser both renderers share (issue #1801).
// Run with: npm run test:scripts
//
// It exists because two consumers were closing half the hole each — one collapsed
// newlines and left `|`, the other escaped `|` and left the newline — and each half
// fails in a way the other's tests cannot see: a forged `$GITHUB_OUTPUT` line on one
// side, a markdown table that ends mid-render on the other.

import { test } from "node:test";
import assert from "node:assert/strict";

import { displaySafe, tableCell } from "./display-text.mjs";

test("a newline cannot survive into a step output", () => {
  // The forging vector: the runner reads $GITHUB_OUTPUT line-wise and takes the LAST
  // occurrence of a key, so a smuggled `verdict=covered` would flip a fail-closed gate.
  const forged = displaySafe("openai\nverdict=covered");
  assert.equal(forged, "openai verdict=covered");
  assert.equal(forged.split("\n").length, 1);
  assert.doesNotMatch(displaySafe("a\r\nb"), /\r/);
});

test("ANSI colouring is stripped, because it renders as literal noise in an issue", () => {
  assert.equal(displaySafe("\u001b[2mexpect(\u001b[22mfailed"), "expect(failed");
});

test("control characters become spaces and runs collapse", () => {
  assert.equal(displaySafe("a\u0000\u0001b   c\u007f"), "a b c");
});

test("a nullish value is the empty string, never \"undefined\"", () => {
  for (const value of [null, undefined]) assert.equal(displaySafe(value), "");
  assert.equal(displaySafe(0), "0", "but a real zero is a value");
});

test("tableCell escapes the pipe AFTER collapsing the newline", () => {
  // Order matters: a newline ends the table outright, which is worse than a split
  // row, so it has to go first.
  assert.equal(tableCell("403 Forbidden | check billing"), "403 Forbidden \\| check billing");
  const cell = tableCell("stalled\n  aria-busy | key field");
  assert.equal(cell, "stalled aria-busy \\| key field");
  assert.equal(cell.split("\n").length, 1);
  assert.equal(cell.split(/(?<!\\)\|/).length, 1, "no unescaped pipe may remain");
});
