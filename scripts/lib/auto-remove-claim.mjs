// The sentences the `@stable` auto-removal summary uses to claim a removal
// HAPPENED, and the one way to take that claim back (#1822).
//
// WHY THEY LIVE HERE RATHER THAN IN THE FORMATTER
//
// `format-auto-remove-summary.mjs` runs in the auto-remove action's FIRST step,
// before the commit is even attempted, so its wording is necessarily written in
// the past tense about something that has not happened yet: "Auto-removed
// `@stable` from N hard-failing test(s)" and "These were committed to `main`
// automatically". When the commit step then fails, that text is already an
// output — and a composite action's outputs are published even when an embedded
// step fails — so the umbrella issue renders it verbatim about tags that are
// still on `main`. That is the exact false claim #1822 was raised about.
//
// The first fix relabelled the heading around it and left the two sentences
// underneath, which is worse than it sounds: the reader met "did NOT commit" and
// then, one line down, "These were committed to `main` automatically".
//
// So producer and consumer share ONE copy of the claim, the way
// `provider-health-reason.mjs` makes one formatter and one parser share a
// pattern: a consumer holding its own copy fails by silently matching nothing,
// i.e. by leaving the false sentence exactly where it was. The round trip is
// unit-tested from both ends.

/** `🔻 **Auto-removed `@stable`** from ` — the half before the count. */
export const REMOVED_HEADLINE_PREFIX = "🔻 **Auto-removed `@stable`** from ";
/** ` hard-failing test(s):` — the half after it. */
export const REMOVED_HEADLINE_SUFFIX = " hard-failing test(s):";
/** What the headline becomes once the removal is known not to have landed. */
export const PENDING_HEADLINE_PREFIX = "🔻 **Selected for `@stable` removal** — ";
/**
 * The per-item note for a test whose `@stable` was its ONLY tag. Past tense, so
 * it is a third claim and not a decoration: under a heading saying nothing
 * reached `main`, "the array was left empty, please review" sends the reader to
 * review a file `main` never saw changed.
 */
export const SOLE_TAG_NOTE =
  " — _`@stable` was the only tag; the array was left empty, please review_";
/** The same note about a removal that has not happened. */
export const PENDING_SOLE_TAG_NOTE =
  " — _`@stable` is its only tag; removing it leaves the array empty, please review_";
/** The footer that states, in the past tense, that the commit happened. */
export const COMMITTED_FOOTER =
  "These were committed to `main` automatically. **Restoring `@stable` is manual**: once the test or Langflow is fixed, re-add the tag via PR.";

/** `🔻 **Auto-removed `@stable`** from 2 hard-failing test(s):` */
export const removedHeadline = (count) =>
  `${REMOVED_HEADLINE_PREFIX}${count}${REMOVED_HEADLINE_SUFFIX}`;

/**
 * The same summary with every past-tense claim of a completed removal taken out.
 *
 * `neutralized` requires BOTH claim sentences to have been recognised, and the
 * strictness is the point: a PARTIAL match means the formatter was reworded on one
 * side, so whatever this did not recognise is still in the text. The caller hedges
 * on anything short of both rather than presenting a summary it could only
 * half-correct as a corrected one (#1012); the round-trip test against the real
 * formatter is what keeps that branch out of a real issue body.
 *
 * The `soleTag` note is corrected whenever either claim was recognised, and does
 * NOT vote: it is present only for a removal whose `@stable` was the only tag, so
 * its absence says nothing about whether the formatter drifted. It is not
 * corrected when NEITHER was — that summary is returned untouched and reported as
 * unrecognised, which is the honest answer for a text this no longer understands.
 */
export function withoutCommittedClaim(summary) {
  const text = String(summary ?? "");
  const hasHeadline = text.includes(REMOVED_HEADLINE_PREFIX);
  const hasFooter = text.includes(COMMITTED_FOOTER);
  if (!hasHeadline && !hasFooter) return { text, neutralized: false };
  let out = text;
  if (hasHeadline) {
    out = out.replaceAll(REMOVED_HEADLINE_PREFIX, PENDING_HEADLINE_PREFIX);
  }
  out = out.replaceAll(SOLE_TAG_NOTE, PENDING_SOLE_TAG_NOTE);
  if (hasFooter) {
    // Removed outright rather than reworded: the block's own correction paragraph
    // already says what happens next, and two paragraphs about restoring the tag
    // is how a reader ends up believing the first one.
    out = out
      .split("\n")
      .filter((line) => !line.includes(COMMITTED_FOOTER))
      .join("\n")
      .replace(/\n+$/, "");
  }
  return { text: out, neutralized: hasHeadline && hasFooter };
}
