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
  // A blacklist alone is not a pin: a DIFFERENT past tense ("the array has been
  // emptied") passes it. Each pending constant is matched positively, on the voice
  // it has to be in.
  for (const pending of [PENDING_HEADLINE_PREFIX, PENDING_SOLE_TAG_NOTE]) {
    assert.doesNotMatch(pending, /\bremoved\b|was the only tag|were committed|has been/i);
  }
  assert.match(PENDING_HEADLINE_PREFIX, /Selected for `@stable` removal/);
  assert.match(PENDING_SOLE_TAG_NOTE, /`@stable` is its only tag/);
  assert.match(PENDING_SOLE_TAG_NOTE, /removing it leaves the array empty/);
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
  const headlineOnly = withoutCommittedClaim(summaryOf({ footer: false, soleTag: true }));
  assert.equal(headlineOnly.neutralized, false);
  assert.ok(headlineOnly.text.includes(PENDING_HEADLINE_PREFIX));
  // Symmetric to the footer-only case below: the note is corrected on EITHER
  // recognised claim, and testing only one side left the other rewritable.
  assert.ok(!headlineOnly.text.includes(SOLE_TAG_NOTE));
  assert.ok(headlineOnly.text.includes(PENDING_SOLE_TAG_NOTE));

  const footerOnly = withoutCommittedClaim(summaryOf({ headline: false, soleTag: true }));
  assert.equal(footerOnly.neutralized, false);
  assert.ok(!footerOnly.text.includes(COMMITTED_FOOTER));
  // The note is corrected on EITHER recognised claim, not only on the headline —
  // otherwise this shape keeps "the array was left empty" over a commit that never
  // happened, and only this combination can see it.
  assert.ok(!footerOnly.text.includes(SOLE_TAG_NOTE));
  assert.ok(footerOnly.text.includes(PENDING_SOLE_TAG_NOTE));
});

test("a summary with neither claim is returned untouched, note included", () => {
  const summary = "No per-test `@stable` hard failures were auto-removed.";
  assert.deepEqual(withoutCommittedClaim(summary), { text: summary, neutralized: false });

  // Including the sole-tag note: a text this recognises nothing else in is one it
  // no longer understands, so it is reported rather than half-rewritten — and the
  // consumer's hedge is what covers the reader (#1012).
  const foreign = `something else entirely${SOLE_TAG_NOTE}`;
  assert.deepEqual(withoutCommittedClaim(foreign), { text: foreign, neutralized: false });
});

test("a non-string never throws — the consumer runs inside issue rendering", () => {
  for (const input of [undefined, null, 0, 42, {}, []]) {
    const { neutralized } = withoutCommittedClaim(input);
    assert.equal(neutralized, false, `threw or claimed recognition on ${JSON.stringify(input)}`);
  }
});
