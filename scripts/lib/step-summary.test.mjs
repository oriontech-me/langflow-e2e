// Unit tests for the shared step-summary helper (#1456).
//
// Run: npm run test:scripts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { appendSummary, tableCell } from "./step-summary.mjs";
import { makeTempDir } from "./tmp-dir.mjs";

test("writing the summary is best-effort and never throws", () => {
  const dir = makeTempDir("step-summary-");
  const sink = path.join(dir, "summary.md");

  assert.equal(appendSummary("### hi", sink), true);
  assert.match(fs.readFileSync(sink, "utf-8"), /### hi/);

  // Appends rather than replaces: several steps of one job write into the same sink.
  assert.equal(appendSummary("### there", sink), true);
  const written = fs.readFileSync(sink, "utf-8");
  assert.match(written, /### hi[\s\S]*### there/);

  // No sink (every local run) and nothing to say are no-ops, not failures — the
  // callers also print an annotation and their decision on stdout, so a block that
  // cannot be written must never be the reason a lane fails.
  assert.equal(appendSummary("### hi", ""), false);
  assert.equal(appendSummary("", sink), false);
  assert.equal(appendSummary("### hi", path.join(dir, "no", "such", "dir", "s.md")), false);
});

test("tableCell keeps a provider error inside its markdown cell", () => {
  // A pipe ends the cell and a newline ends the ROW, so an unescaped provider string
  // eats the rest of the table it was meant to fill.
  assert.equal(tableCell("a | b"), "a \\| b");
  assert.equal(tableCell("first\nsecond"), "first second");
  assert.equal(tableCell("  padded \t out  "), "padded out");

  // Capped, with the cut made visible. Google's spend-cap error carries a
  // documentation URL and nothing bounds what a provider may answer with.
  const long = "x".repeat(500);
  const capped = tableCell(long);
  assert.equal(capped.length, 240);
  assert.ok(capped.endsWith("…"));
  assert.equal(tableCell(long, 10), `${"x".repeat(9)}…`);

  // Never the literal "undefined"/"null" in a report about missing information.
  assert.equal(tableCell(undefined), "");
  assert.equal(tableCell(null), "");
});
