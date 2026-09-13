import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMissingUuid,
  uuidPrefixOverlap,
  TRUNCATION_MIN_OVERLAP,
} from "./describe-missing-uuid";

/**
 * The message this module renders is the product of #1830: it is what a triage
 * reads instead of re-deriving the cause from a bare pattern mismatch. These tests
 * pin the two properties that make it worth having — it names truncation when the
 * answer was cut, and it never claims truncation when it was not.
 *
 * Both were wrong in review: the closing sentence was printed under every head, and
 * the overlap was case-sensitive while `UUID_SHAPE` is `/i`.
 */

const FETCHED = "4e279d8b-638a-4ada-8241-399409196e7d";
const CLOSING = "spends its output budget";

test("names the cut, with its length, when the answer ends inside the fetched UUID", () => {
  const rendered = 'The "uuid" value is: 4e279d8b-638a-4ada-8241-39940919';
  const out = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });

  assert.match(out, /TRUNCATED, not wrong/);
  assert.match(out, /32-character prefix/);
  assert.match(out, /neither a max_iterations failure nor a fetch failure/);
  assert.ok(out.includes(CLOSING), "the truncation branch keeps the closing sentence");
});

test("an UPPERCASE answer is still recognised as truncated", () => {
  // UUID_SHAPE is /i, so this answer would satisfy the assertion if it completed.
  // A case-sensitive overlap scored it 0 and blamed the model for ignoring the tool.
  const rendered = "The UUID value is: 4E279D8B-638A-4ADA-8241-39940919";
  const out = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });

  assert.match(out, /TRUNCATED, not wrong/);
  assert.doesNotMatch(out, /answered without using what it fetched/);
});

test("does NOT claim truncation — or its cause — when the answer ignores the fetched value", () => {
  const rendered = "I could not determine the uuid.";
  const out = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });

  assert.match(out, /answered without using what it fetched/);
  assert.ok(!out.includes(CLOSING), "a cause the head just ruled out must not be asserted");
});

test("says so when the tool output carried no UUID at all, and claims nothing further", () => {
  const rendered = "I could not fetch that URL.";
  const out = describeMissingUuid({ rendered, stored: rendered });

  assert.match(out, /the fetch itself did not deliver one/);
  assert.match(out, /tool output: no UUID found/);
  assert.ok(!out.includes(CLOSING));
});

test("a short shared run of hex is chance, not a cut UUID", () => {
  // Four characters of overlap: below the threshold, so the message must not
  // promote a coincidence into a truncation claim.
  const rendered = "the value ends in 4e27";
  const out = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });

  assert.ok(uuidPrefixOverlap(rendered, FETCHED) < TRUNCATION_MIN_OVERLAP);
  assert.doesNotMatch(out, /TRUNCATED/);
});

test("separates a render artefact from an upstream cut", () => {
  const rendered = 'The "uuid" value is: 4e279d8b-638a-4ada-8241-39940919';
  const same = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });
  const differs = describeMissingUuid({
    rendered,
    stored: `The "uuid" value is: ${FETCHED}`,
    fetchedUuid: FETCHED,
  });

  assert.match(same, /identical to the rendered text — the cut is upstream of the UI/);
  assert.match(differs, /DIFFERENT from the rendered text/);
});

test("reports the model and usage that produced the answer, and survives their absence", () => {
  const rendered = 'The "uuid" value is: 4e279d8b-638a-4ada-8241-39940919';
  const full = describeMissingUuid({
    rendered,
    stored: rendered,
    fetchedUuid: FETCHED,
    model: "gemini-2.5-flash",
    usage: { output_tokens: 479 },
  });
  const bare = describeMissingUuid({ rendered, stored: rendered, fetchedUuid: FETCHED });

  assert.match(full, /model      : gemini-2\.5-flash · usage \{"output_tokens":479\}/);
  assert.match(bare, /model      : unknown · usage \{\}/);
});
