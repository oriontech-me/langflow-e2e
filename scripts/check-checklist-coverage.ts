/**
 * PR guard for the spec ↔ doc ↔ QA-CHECKLIST triad (issue #985).
 *
 * Three artifacts are supposed to agree about what this suite covers: the spec
 * file, its doc under `docs/`, and its bullet in `QA-CHECKLIST.md`. The bullets
 * are what the Coverage Summary table is derived from, so a spec that no bullet
 * references is invisible in every generated count — including the `@stable`
 * lane the daily workflow gates releases on. Nothing detected that before this
 * script: `validate-spec-deps.ts` is informational and only inspects spec↔doc,
 * and `check-checklist-guard.mjs` protects the generated blocks from hand edits,
 * which is a different concern.
 *
 * Run: `npm run check:checklist-coverage`  (or `npx ts-node scripts/check-checklist-coverage.ts`)
 * Wired into `pr-validation.yml` → `checklist-guard` job. Exits non-zero on
 * violation and prints the exact bullet to add.
 *
 * ── The enforced invariant ───────────────────────────────────────────────────
 *
 *   A spec whose coverage is CLAIMED must be referenced in QA-CHECKLIST.md.
 *
 * Coverage is claimed in two ways, each reported separately below:
 *   1. `@stable` — the spec runs in `daily-stable.yml` and its results are read
 *      as release signal. An unreferenced `@stable` spec is a coverage lie in
 *      the lane that matters most.
 *   2. A spec doc at `docs/<same path>.md` — someone invested in documenting the
 *      spec; the checklist never learning it exists is exactly the #985 drift.
 *
 * A spec that is neither `@stable` nor documented is NOT required to be listed.
 * That is the inherited/legacy part of the suite (see the doc-resolution note
 * below), and forcing bullets for it would turn this gate into busywork.
 *
 * ── Why only the MANUAL region of the checklist counts ───────────────────────
 *
 * Matching against the whole file is VACUOUS for `@stable` specs: the generated
 * `Phase 0 — Validated` block lists one `- [x] <title> → `<basename>`` line per
 * `@stable` `test()`, so every `@stable` spec's basename appears in the file by
 * construction. The #985 audit hit exactly this and concluded the `@stable`
 * invariant held; restricting the search to the hand-written region (everything
 * before the `## Coverage Summary` anchor — Part I helpers + Part II bullets)
 * showed 5 `@stable` specs that no bullet referenced. So: only the manual region
 * counts as a reference.
 *
 * ── Doc resolution: by reference, not by filename ────────────────────────────
 *
 * A missing `docs/<same path>.md` does NOT mean a spec is undocumented, so this
 * script never reports "spec without a doc" as a violation. 75 of the ~244 specs
 * have no mirrored doc — the normal state of the inherited suite, not debt. And
 * a spec can be documented inside a SHARED doc under a different filename: e.g.
 * `core-functionality/llm-agents/model-provider-modal-actions.spec.ts` has no
 * mirrored doc but is documented in
 * `docs/core-functionality/model-provider/provider-management.md` (table row +
 * dedicated section). Any future doc-side checking must therefore resolve docs by
 * CONTENT REFERENCE (does some doc name this spec?), never by filename. The
 * mirrored-path lookup here is used only in the safe direction: as evidence that
 * coverage was claimed, never as evidence that it was not.
 */

import * as fs from "fs";
import * as path from "path";

import {
  REGRESSION_ROOT,
  REPO_ROOT,
  collectStableTests,
  listSpecPaths,
} from "./lib/stable-tests";

const CHECKLIST_PATH = path.join(REPO_ROOT, "QA-CHECKLIST.md");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");

/** Everything from this heading onward is machine-generated (see the header). */
const GENERATED_ANCHOR = "## Coverage Summary";

/**
 * Specs deliberately kept out of QA-CHECKLIST.md, with the written reason
 * (#985 deliverable 1 allows an explicit exemption instead of a bullet).
 * Keep this empty unless there is a real reason — a bullet is almost always the
 * right answer, and an entry here hides the spec from every coverage count.
 */
const INTENTIONALLY_UNLISTED: Record<string, string> = {};

interface Violation {
  spec: string;
  /** Why the spec had to be listed. */
  reasons: string[];
  /** Number of `@stable` `test()` calls in it (0 when it is documented only). */
  stableTests: number;
}

/** The hand-written part of the checklist: everything before the generated blocks. */
function manualRegion(checklist: string): string {
  const lines = checklist.split("\n");
  const anchor = lines.findIndex((l) => l.startsWith(GENERATED_ANCHOR));
  if (anchor === -1) {
    throw new Error(
      `QA-CHECKLIST.md: generated-blocks anchor not found ("${GENERATED_ANCHOR}") — ` +
        "the document structure changed; update this script before trusting it.",
    );
  }
  return lines.slice(0, anchor).join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `needle` (a spec path or a trailing slice of it) appears in
 * `haystack` at a token boundary. The boundary keeps `traces.spec.ts` from
 * matching inside a hypothetical `agent-traces.spec.ts`; a leading `/` is
 * allowed so the basename form matches a bullet that spells out the full path.
 */
function referenced(haystack: string, needle: string): boolean {
  return new RegExp(`(?:^|[\\s\`(/])${escapeRegExp(needle)}`, "m").test(
    haystack,
  );
}

/**
 * Trailing path slices of a spec, shortest first: `foo.spec.ts`,
 * `llm-agents/foo.spec.ts`, `core-functionality/llm-agents/foo.spec.ts`. Bullets
 * in this checklist reference specs at all three depths, so any of them counts —
 * as long as the slice identifies exactly ONE spec. Two specs share the basename
 * `agent-component-regression.spec.ts` (under `core-components/` and
 * `core-functionality/llm-agents/`), and a bare-filename bullet there would
 * silently let one twin ride on the other's reference.
 */
function distinguishingSuffixes(spec: string, allSpecs: string[]): string[] {
  const segments = spec.split("/");
  const out: string[] = [];
  for (let k = 1; k <= segments.length; k++) {
    const suffix = segments.slice(segments.length - k).join("/");
    const matches = allSpecs.filter(
      (s) => s === suffix || s.endsWith(`/${suffix}`),
    ).length;
    if (matches === 1) out.push(suffix);
  }
  return out;
}

function main(): void {
  const checklist = fs.readFileSync(CHECKLIST_PATH, "utf-8");
  const manual = manualRegion(checklist);

  const specs = listSpecPaths();
  const { tests: stableTests, warnings } = collectStableTests();

  const stableCountBySpec = new Map<string, number>();
  for (const t of stableTests) {
    stableCountBySpec.set(
      t.relativePath,
      (stableCountBySpec.get(t.relativePath) ?? 0) + 1,
    );
  }

  const hasDoc = (spec: string): boolean =>
    fs.existsSync(path.join(DOCS_ROOT, spec.replace(/\.spec\.ts$/, ".md")));

  const violations: Violation[] = [];
  let documentedCount = 0;
  let exempted = 0;

  for (const spec of specs) {
    const stableCount = stableCountBySpec.get(spec) ?? 0;
    const documented = hasDoc(spec);
    if (documented) documentedCount++;

    const reasons: string[] = [];
    if (stableCount > 0) {
      reasons.push(
        `carries \`@stable\` on ${stableCount} test${stableCount === 1 ? "" : "s"} (runs in daily-stable.yml)`,
      );
    }
    if (documented) {
      reasons.push(`has a spec doc at docs/${spec.replace(/\.spec\.ts$/, ".md")}`);
    }
    if (reasons.length === 0) continue;

    if (spec in INTENTIONALLY_UNLISTED) {
      exempted++;
      continue;
    }

    const isReferenced = distinguishingSuffixes(spec, specs).some((suffix) =>
      referenced(manual, suffix),
    );
    if (!isReferenced) {
      violations.push({ spec, reasons, stableTests: stableCount });
    }
  }

  const specsWithoutMirroredDoc = specs.length - documentedCount;
  console.log(`Specs under regression/:            ${specs.length}`);
  console.log(`Carrying @stable:                   ${stableCountBySpec.size} spec files (${stableTests.length} test() calls)`);
  console.log(`With a mirrored doc under docs/:    ${documentedCount}`);
  console.log(`Without a mirrored doc:             ${specsWithoutMirroredDoc} (not a violation — see the header: docs resolve by reference, not filename)`);
  if (exempted > 0) {
    console.log(`Exempted via INTENTIONALLY_UNLISTED: ${exempted}`);
    for (const [spec, reason] of Object.entries(INTENTIONALLY_UNLISTED)) {
      console.log(`  - ${spec} — ${reason}`);
    }
  }

  if (warnings.length > 0) {
    console.error(
      `\n${warnings.length} warning(s) — a non-literal \`tag\` array may hide an @stable test from this guard:`,
    );
    for (const w of warnings) console.error(`  • ${w}`);
  }

  if (violations.length === 0) {
    console.log(
      `\n✓ QA-CHECKLIST coverage guard: every @stable and every documented spec is referenced by a Part II bullet.`,
    );
    if (warnings.length > 0) process.exit(1);
    return;
  }

  console.error(
    `\n✖ QA-CHECKLIST coverage guard: ${violations.length} spec(s) claim coverage that no ` +
      `QA-CHECKLIST.md bullet references, so they are invisible in every generated count.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.spec}`);
    for (const r of v.reasons) console.error(`      • ${r}`);
  }
  console.error(
    `\nFix: add (or extend) a manual Part II bullet in QA-CHECKLIST.md that names the spec —\n` +
      `    - [x] <what it validates> → \`<path under regression/>\`   # [x] only when the test is @stable\n` +
      `    - [-] <what it validates> → \`<path under regression/>\`   # test exists but is not @stable\n` +
      `An existing bullet that already describes the behavior can simply gain the reference.\n` +
      `The reference may be the bare filename, or any deeper path slice — but when two specs\n` +
      `share a basename it must be deep enough to identify one (e.g. \`llm-agents/<file>\`).\n` +
      `Edit ONLY the manual bullets (above the "${GENERATED_ANCHOR}" anchor) — the generated blocks\n` +
      `regenerate on merge to main (issue #741, enforced by scripts/check-checklist-guard.mjs).\n` +
      `Marker legend: QA-CHECKLIST.md → "How to use this checklist".\n` +
      `If a spec is genuinely meant to stay unlisted, add it to INTENTIONALLY_UNLISTED in\n` +
      `${path.relative(REPO_ROOT, __filename)} with a written reason.\n`,
  );
  process.exit(1);
}

// Sanity: the regression root must exist, otherwise a silent "0 specs" run would
// report the guard as green from a wrong working directory.
if (!fs.existsSync(REGRESSION_ROOT)) {
  throw new Error(`Regression root not found: ${REGRESSION_ROOT}`);
}

main();
