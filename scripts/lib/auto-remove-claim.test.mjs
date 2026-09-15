// Unit tests for the shared @stable auto-removal claim (#1822).
// Run with: npm run test:scripts
//
// This module exists because the summary is written by the auto-remove action's
// FIRST step, in the past tense, and the commit is the SECOND — so when the commit
// fails, the consumer has to take the claim back. Two things follow, and both are
// asserted here rather than only through the consumer:
//
//  - the REPLACEMENT text matters as much as the removal. Every "is it gone?"
//    assertion still passes if the replacement is itself past tense, which puts
//    #1822's sentence straight back under the heading that denies it.
//  - `neutralized` is a claim about recognition, so a PARTIAL match has to report
//    false: whatever this did not recognise is still in the text.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMITTED_FOOTER,
  PENDING_HEADLINE_PREFIX,
  PENDING_SOLE_TAG_NOTE,
  REMOVED_HEADLINE_PREFIX,
  SOLE_TAG_NOTE,
  removedHeadline,
  withoutCommittedClaim,
} from "./auto-remove-claim.mjs";

const summaryOf = ({ soleTag = false, footer = true, headline = true } = {}) =>
  [
    headline ? removedHeadline(1) : "🔻 Something else entirely:",
    "",
    `- \`a.spec.ts\` — one${soleTag ? SOLE_TAG_NOTE : ""}`,
    "",
    ...(footer ? [COMMITTED_FOOTER] : []),
  ].join("\n");

test("the corrected text says the removal is pending, in no past tense of its own", () => {
  // The mutation this exists for: rewriting PENDING_HEADLINE_PREFIX to
  // "🔻 **Removed `@stable`** from " passes every absence assertion elsewhere.
  for (const pending of [PENDING_HEADLINE_PREFIX, PENDING_SOLE_TAG_NOTE]) {
    assert.doesNotMatch(pending, /removed|was the only tag|were committed/i);
  }
  assert.match(PENDING_HEADLINE_PREFIX, /Selected for `@stable` removal/);
});

test("both claims recognised: both gone, the list intact", () => {
  const { text, neutralized } = withoutCommittedClaim(summaryOf());
  assert.equal(neutralized, true);
  assert.ok(!text.includes(REMOVED_HEADLINE_PREFIX));
  assert.ok(!text.includes(COMMITTED_FOOTER));
  assert.ok(text.includes(PENDING_HEADLINE_PREFIX));
  assert.match(text, /a\.spec\.ts/);
  // The count survives the rewrite — it is the reader's only measure of scale.
  assert.match(text, /— 1 hard-failing test\(s\):/);
  // No dangling blank run where the footer was.
  assert.doesNotMatch(text, /\n\s*$/);
});

test("the sole-tag note is corrected too, and does not vote on recognition", () => {
  const { text, neutralized } = withoutCommittedClaim(summaryOf({ soleTag: true }));
  assert.equal(neutralized, true);
  assert.ok(!text.includes(SOLE_TAG_NOTE));
  assert.ok(text.includes(PENDING_SOLE_TAG_NOTE));
  // Absent from a summary with no sole-tag removal, which says nothing about drift.
  assert.equal(withoutCommittedClaim(summaryOf()).neutralized, true);
});

test("a PARTIAL match corrects what it found and still reports not-recognised", () => {
  // The formatter reworded one side. Reporting `true` here would suppress the
  // consumer's hedge over a summary that still carries the other claim.
  const headlineOnly = withoutCommittedClaim(summaryOf({ footer: false }));
  assert.equal(headlineOnly.neutralized, false);
  assert.ok(headlineOnly.text.includes(PENDING_HEADLINE_PREFIX));

  const footerOnly = withoutCommittedClaim(summaryOf({ headline: false }));
  assert.equal(footerOnly.neutralized, false);
  assert.ok(!footerOnly.text.includes(COMMITTED_FOOTER));
});

test("a summary with neither claim is returned untouched", () => {
  const summary = "No per-test `@stable` hard failures were auto-removed.";
  assert.deepEqual(withoutCommittedClaim(summary), { text: summary, neutralized: false });
});

test("a non-string never throws — the consumer runs inside issue rendering", () => {
  for (const input of [undefined, null, 0, 42, {}, []]) {
    const { neutralized } = withoutCommittedClaim(input);
    assert.equal(neutralized, false, `threw or claimed recognition on ${JSON.stringify(input)}`);
  }
});
