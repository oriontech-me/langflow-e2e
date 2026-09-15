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
/** The footer that states, in the past tense, that the commit happened. */
export const COMMITTED_FOOTER =
  "These were committed to `main` automatically. **Restoring `@stable` is manual**: once the test or Langflow is fixed, re-add the tag via PR.";

/** `🔻 **Auto-removed `@stable`** from 2 hard-failing test(s):` */
export const removedHeadline = (count) =>
  `${REMOVED_HEADLINE_PREFIX}${count}${REMOVED_HEADLINE_SUFFIX}`;

/**
 * The same summary with every past-tense claim of a completed removal taken out.
 *
 * `neutralized` is false when neither sentence was found, which is not the same
 * as nothing to do: it means the formatter was reworded and this no longer
 * recognises it. The caller says so rather than presenting a summary it could not
 * correct as a corrected one (#1012), and the round-trip test is what makes that
 * branch a build failure instead of an issue body.
 */
export function withoutCommittedClaim(summary) {
  const text = String(summary ?? "");
  const headlineAt = text.indexOf(REMOVED_HEADLINE_PREFIX);
  const footerAt = text.indexOf(COMMITTED_FOOTER);
  if (headlineAt === -1 && footerAt === -1) return { text, neutralized: false };
  let out = text;
  if (headlineAt !== -1) {
    out = out.replaceAll(REMOVED_HEADLINE_PREFIX, PENDING_HEADLINE_PREFIX);
  }
  if (footerAt !== -1) {
    // Removed outright rather than reworded: the block's own correction paragraph
    // already says what happens next, and two paragraphs about restoring the tag
    // is how a reader ends up believing the first one.
    out = out
      .split("\n")
      .filter((line) => !line.includes(COMMITTED_FOOTER))
      .join("\n")
      .replace(/\n+$/, "");
  }
  return { text: out, neutralized: headlineAt !== -1 && footerAt !== -1 };
}
