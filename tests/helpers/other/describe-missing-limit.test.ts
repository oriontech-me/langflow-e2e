import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMissingLimit, capWasEnforced } from "./describe-missing-limit";

/**
 * The message this module renders is the product of #1991: it is what a triage
 * reads instead of concluding "the cap is broken" from a bare pattern mismatch,
 * which is how the same signature was read across #1264 and #1991.
 *
 * These tests pin the property that makes it worth having — it separates the three
 * runs that produce an identical assertion failure, and it never claims enforcement
 * it cannot see.
 */

// The field reading this diagnosis was written from: #1991, Actions run
// 35731146480, trace `ca7d1f0f`, `claude-haiku-4-5`.
const ENFORCED = {
  rendered: "I'll fetch that URL for you and extract the uuid value.",
  stored: "I'll fetch that URL for you and extract the uuid value.",
  toolNames: ["fetch_content"],
  calls: 1,
  state: "complete",
  errored: false,
  model: "claude-haiku-4-5",
  usage: { input_tokens: 956, output_tokens: 82, total_tokens: 1038 },
};

test("names the fired-but-silent cap when the tool ran and the run stopped at one call", () => {
  const out = describeMissingLimit(ENFORCED);

  assert.match(out, /the cap FIRED and said nothing/);
  assert.match(out, /NOT a broken cap and NOT a declined tool call/);
  assert.match(out, /fetch_content/);
  assert.ok(out.includes("upstream's to surface"), "the enforced branch keeps the upstream pointer");
});

test("names model non-compliance — NOT the cap — when no tool was called", () => {
  // The 2026-08-13 reading on #1264: one model call, no tool_use, prose answer.
  // Scoring this as an enforced cap would resurrect the misdiagnosis this replaces.
  const out = describeMissingLimit({ ...ENFORCED, toolNames: [], calls: 1 });

  assert.match(out, /WITHOUT calling any tool/);
  assert.match(out, /#1264/);
  assert.doesNotMatch(out, /cap FIRED/);
  assert.ok(!out.includes("upstream's to surface"), "no upstream pointer when the model declined");
});

test("states NO cause when the tool ran but the run did not stop at one call", () => {
  const out = describeMissingLimit({ ...ENFORCED, calls: 3 });

  assert.match(out, /does not choose between them/);
  assert.match(out, /calls: 3/);
  assert.doesNotMatch(out, /cap FIRED/);
});

test("a run whose usage reported no call count is NOT scored as enforced", () => {
  // The one fact the diagnosis exists to establish is the one it must never invent.
  const { calls, ...noCalls } = ENFORCED;
  void calls;
  const out = describeMissingLimit(noCalls);

  assert.equal(capWasEnforced(noCalls), false);
  assert.doesNotMatch(out, /cap FIRED/);
  assert.match(out, /not reported/);
});

test("reports the persisted text as its own line when it differs from the rendered one", () => {
  const out = describeMissingLimit({ ...ENFORCED, stored: "something the backend kept instead" });

  assert.match(out, /DIFFERENT from the rendered text/);
  assert.match(out, /something the backend kept instead/);
});

test("says the cut is upstream of the UI when rendered and persisted agree", () => {
  const out = describeMissingLimit(ENFORCED);

  assert.match(out, /not a render artifact/);
});
