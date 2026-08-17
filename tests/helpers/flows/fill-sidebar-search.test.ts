// Unit tests for the sidebar search barrier (issue #1468).
// Run with: npm run test:units
//
// What rides on these functions: whether a sidebar that dropped the typed term is
// REPAIRED by the one repair measured to work, and whether the two failures a
// caller can hit stay named apart. Before this, both surfaced as the caller's own
// `expect(input_output<Display Name>).toBeVisible()` timing out — the signature
// #1468 was filed under, on two tests of one file, with no add ever attempted.
//
// Measured on nightly 1.12.0.dev30 under four-way backend contention: 23 failures
// in 220 adds (10.5 %), against 0 in 30 on a quiet instance. An in-page probe
// sampling the input every animation frame put the cause beyond inference — the
// input node is ABSENT at ~100 ms and a NEW empty one is mounted at ~156 ms, so
// the term does not fail to arrive, it is discarded with the node that held it.
//
// The reload repair is measured, not preferred: re-typing into the remounted
// input recovered 0 of 4, `reload()` 4 of 4. That asymmetry is the whole reason
// this helper exists instead of a second `fill()`, and it is why the message
// tells the reader a longer wait cannot help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  SEARCH_VALUE_TIMEOUT_MS,
  classifySearchOutcome,
  droppedSearchMessage,
  missingRowMessage,
} from "./fill-sidebar-search";

const DETAIL = {
  term: "chat input",
  rowTestId: "input_outputChat Input",
  observedValue: "",
  attempts: 2,
  reloaded: true,
  perAttemptMs: SEARCH_VALUE_TIMEOUT_MS,
  rowCount: 0,
};

test("the term surviving in the input is a held search", () => {
  assert.equal(classifySearchOutcome("chat input", "chat input"), "held");
});

test("an emptied input is a dropped search — the measured shape of #1468", () => {
  assert.equal(classifySearchOutcome("chat input", ""), "dropped");
});

test("a vanished input is dropped, not held", () => {
  // `readValue` reports `<gone>` when the input cannot be read at all, which is
  // the remount's own middle state. It must never classify as held.
  assert.equal(classifySearchOutcome("chat input", "<gone>"), "dropped");
});

test("a truncated term is dropped — a partial filter lists different rows", () => {
  assert.equal(classifySearchOutcome("chat input", "chat inpu"), "dropped");
});

test("whitespace is not normalised away — it changes what the sidebar filters", () => {
  assert.equal(classifySearchOutcome("chat input", " chat input"), "dropped");
});

test("the dropped-term message names the mechanism, the repair and the rate", () => {
  const msg = droppedSearchMessage(DETAIL);
  assert.match(msg, /dropped the search term/);
  assert.match(msg, /sidebar-search-input/);
  assert.match(msg, /"chat input"/);
  assert.match(msg, /#1468/);
  // The two numbers a reader needs to not re-run it as a flake.
  assert.match(msg, /23 of 220/);
  assert.match(msg, /0 of 30/);
  assert.match(msg, /re-typing\s+recovers 0 of 4/);
  assert.match(msg, /NOT a slow sidebar/);
  assert.match(msg, /page reload/);
});

test("the message reports the value it actually observed, not the term", () => {
  // A message that echoed the term back would read as though the fill worked.
  const msg = droppedSearchMessage({ ...DETAIL, observedValue: "cha" });
  assert.match(msg, /reads "cha"/);
});

test("a message for a run with no reload does not claim one happened", () => {
  const msg = droppedSearchMessage({ ...DETAIL, attempts: 1, reloaded: false });
  assert.doesNotMatch(msg, /reload/i);
});

test("a held term with no row is NOT reported as #1468", () => {
  // Different cause, different fix: the catalog does not carry the component
  // under that category. Borrowing #1468's explanation would send the reader to
  // a remount that did not happen.
  const msg = missingRowMessage(DETAIL);
  assert.match(msg, /held the search term/);
  assert.doesNotMatch(msg, /remount happened/);
  assert.match(msg, /NOT issue #1468's remount/);
  assert.match(msg, /#1040/);
  assert.match(msg, /<category><Display Name>/);
});

test("neither message is classified as infra — a real sidebar defect must stay eligible for @stable auto-removal", () => {
  // The #1262 rule: an infra prefix would exempt this from the daily's
  // auto-removal, and a sidebar that drops what you type is a product defect,
  // not a runner problem.
  assert.equal(classifyInfraError(droppedSearchMessage(DETAIL)), null);
  assert.equal(classifyInfraError(missingRowMessage(DETAIL)), null);
});

test("the settle budget spans the measured remount window", () => {
  // The remount landed at 96–215 ms in every reproduction. A budget at or below
  // that would call an inert sidebar healthy.
  assert.ok(SEARCH_VALUE_TIMEOUT_MS > 215);
});
