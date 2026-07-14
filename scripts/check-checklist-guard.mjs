#!/usr/bin/env node
/**
 * PR guard for QA-CHECKLIST.md — blocks PRs that edit the AUTO-GENERATED blocks.
 *
 * Why: the Coverage Summary table, the Coverage Summary Note, the
 * `Phase 0 — Validated` list, and the Phase 1/2 module tables are regenerated
 * automatically by `update-coverage-summary.yml` on push to `main`
 * (`chore(checklist): auto-update coverage summary [skip ci]`). PRs must edit
 * ONLY the manual Part II bullets (`- [x] <item> → <spec>.spec.ts`); the counts
 * are left to the merge job so that many PRs can be in flight without colliding.
 * When a PR commits regenerated blocks, two `@stable` add/remove PRs rewrite the
 * SAME count lines and conflict on `QA-CHECKLIST.md` — a guaranteed, avoidable
 * collision (see issue #741, #740-vs-#683).
 *
 * Rule: in the PR diff for QA-CHECKLIST.md, no changed line at or after the
 * `## Coverage Summary` anchor may be a generated line — a table row (`|`),
 * the `@stable` count note (`> N \`test()\` calls …`), or a Phase list bullet
 * (`- [x] …`). Static headings / prose / separators before or after the anchor
 * are unaffected, and Part II bullets (which live BEFORE the anchor) stay
 * editable.
 *
 * Usage: `node scripts/check-checklist-guard.mjs [baseRef]` (default
 * `origin/main`). Exits non-zero and prints the offending lines on violation.
 */
import { execFileSync } from "node:child_process";

const FILE = "QA-CHECKLIST.md";
const ANCHOR = "## Coverage Summary";
const baseRef = process.argv[2] || "origin/main";

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" });
}

// A changed line is "generated" if it is a table row, the count note, or a
// Phase list bullet. These are the only line shapes the generators emit; static
// headings, blockquote prose, separators and blanks are not matched.
function isGeneratedLine(text) {
  const t = text.trimStart();
  return (
    t.startsWith("|") || // any table row (Coverage Summary + Phase 1/2 tables)
    /^>\s*\d+\s+`test\(\)`/.test(t) || // the @stable count note
    /^-\s*\[[x\-~! ]\]/.test(t) // a Phase 0 validated-list bullet
  );
}

// Line number of the anchor in a given revision of the file (":0:" style path
// via `git show`), so we can tell Part II bullets (before) from Phase list
// bullets (after). Returns Infinity if the file/anchor is absent (nothing to
// protect on that side).
function anchorLine(revText) {
  const lines = revText.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(ANCHOR));
  return idx === -1 ? Infinity : idx + 1; // 1-based
}

function fileAt(rev) {
  try {
    return git(["show", `${rev}:${FILE}`]);
  } catch {
    return "";
  }
}

const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
const baseAnchor = anchorLine(fileAt(mergeBase));
const headAnchor = anchorLine(fileAt("HEAD"));

// Unified diff with zero context so every hunk line is a real change, and the
// hunk header line numbers map cleanly to added/removed lines.
const diff = git([
  "diff",
  "--unified=0",
  `${mergeBase}..HEAD`,
  "--",
  FILE,
]);

const violations = [];
let newLineNo = 0;
let oldLineNo = 0;
// The file-header lines (`diff --git`, `index`, `--- a/…`, `+++ b/…`) all
// precede the first `@@` hunk. Only classify +/- lines once inside a hunk, so a
// removed `---` separator (whose diff line is `----`) or an added `+++` line is
// treated as content — not mistaken for a header — keeping the line counters in
// sync (QA-CHECKLIST.md uses `---` separators, so this is a real case).
let inHunk = false;

for (const raw of diff.split("\n")) {
  const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (hunk) {
    inHunk = true;
    oldLineNo = Number(hunk[1]);
    newLineNo = Number(hunk[2]);
    continue;
  }
  if (!inHunk) continue; // skip the pre-hunk file-header preamble

  if (raw.startsWith("+")) {
    const text = raw.slice(1);
    if (newLineNo >= headAnchor && isGeneratedLine(text)) {
      violations.push(`+ (new line ${newLineNo}) ${text}`);
    }
    newLineNo++;
  } else if (raw.startsWith("-")) {
    const text = raw.slice(1);
    if (oldLineNo >= baseAnchor && isGeneratedLine(text)) {
      violations.push(`- (old line ${oldLineNo}) ${text}`);
    }
    oldLineNo++;
  }
}

if (violations.length > 0) {
  console.error(
    `\n✖ ${FILE} guard: this PR edits AUTO-GENERATED blocks (below the "${ANCHOR}" anchor).\n`,
  );
  for (const v of violations) console.error(`    ${v}`);
  console.error(
    `\nThose blocks (Coverage Summary table + note, Phase 0 list, Phase 1/2 tables)\n` +
      `are regenerated automatically on merge to main by update-coverage-summary.yml.\n` +
      `Edit ONLY the manual Part II bullet ("- [x] <item> → <spec>.spec.ts") and revert\n` +
      `the generated changes:\n` +
      `    git checkout ${baseRef} -- ${FILE}   # take main's generated blocks\n` +
      `    # then re-apply just your Part II bullet edit\n` +
      `See CONTRIBUTING.md ("QA-CHECKLIST — bullet-only in PRs") and issue #741.\n`,
  );
  process.exit(1);
}

console.log(`✓ ${FILE} guard: no auto-generated blocks were edited by this PR.`);
