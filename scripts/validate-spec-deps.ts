/**
 * Reports which spec files have a corresponding doc with a populated
 * `## External dependencies` section, and which do not.
 *
 * Run: `npx ts-node scripts/validate-spec-deps.ts`
 *
 * Always exits 0 — this is informational, not a gate. The known fragility
 * (a developer can ship a spec without filling the doc) is accepted; this
 * script lets the team see the current state when they want to triage.
 *
 * Scope note (#985): this covers the spec↔doc edge only, and "no mirrored doc"
 * is NOT a defect — 75 specs are documented elsewhere or not at all, and a doc
 * may be SHARED under a different filename (see `scripts/check-checklist-coverage.ts`
 * for the doc-resolution rule). The spec↔checklist edge IS gated, by that
 * script, in `pr-validation.yml`.
 *
 * Output (stdout):
 *   Total specs:        N
 *   With doc + deps:    N
 *   With doc, no deps:  N
 *   Without doc:        N
 *   Followed by lists for the last two categories.
 */

import * as fs from "fs";
import * as path from "path";

const DOCS_ROOT = "docs";
const SPECS_ROOT = "tests/tests-automations/regression";

const EXTERNAL_DEPS_HEADER_RE = /^##\s+External dependencies(\s+\*\(required\)\*)?\s*$/;
const SECTION_END_RE = /^(##\s+|---\s*)$/;
const BULLET_BACKTICK_RE = /^-\s+`([^`]+)`/;

interface SpecStatus {
  spec: string;
  docPath: string;
  docExists: boolean;
  hasDepsSection: boolean;
  hasLangflowDeps: boolean;
}

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function docPathForSpec(specPath: string, repoRoot: string): string {
  const rel = path.relative(path.join(repoRoot, SPECS_ROOT), specPath);
  const withoutExt = rel.replace(/\.spec\.ts$/, "");
  return path.join(repoRoot, DOCS_ROOT, `${withoutExt}.md`);
}

function inspectDoc(docPath: string): { hasDepsSection: boolean; hasLangflowDeps: boolean } {
  if (!fs.existsSync(docPath)) {
    return { hasDepsSection: false, hasLangflowDeps: false };
  }
  const lines = fs.readFileSync(docPath, "utf-8").split("\n");
  let inSection = false;
  let hasDepsSection = false;
  let hasLangflowDeps = false;

  for (const line of lines) {
    if (!inSection) {
      if (EXTERNAL_DEPS_HEADER_RE.test(line)) {
        inSection = true;
        hasDepsSection = true;
      }
      continue;
    }
    if (SECTION_END_RE.test(line)) break;
    const m = line.match(BULLET_BACKTICK_RE);
    if (!m) continue;
    if (m[1].trim().startsWith("src/")) {
      hasLangflowDeps = true;
    }
  }

  return { hasDepsSection, hasLangflowDeps };
}

function main(): void {
  const repoRoot = path.resolve(__dirname, "..");
  const specs = walk(path.join(repoRoot, SPECS_ROOT), (n) => n.endsWith(".spec.ts"));

  const statuses: SpecStatus[] = specs.map((spec) => {
    const docPath = docPathForSpec(spec, repoRoot);
    const docExists = fs.existsSync(docPath);
    const { hasDepsSection, hasLangflowDeps } = inspectDoc(docPath);
    return {
      spec: path.relative(repoRoot, spec),
      docPath: path.relative(repoRoot, docPath),
      docExists,
      hasDepsSection,
      hasLangflowDeps,
    };
  });

  const withDocAndDeps = statuses.filter((s) => s.docExists && s.hasLangflowDeps);
  const withDocNoDeps = statuses.filter(
    (s) => s.docExists && !s.hasLangflowDeps
  );
  const withoutDoc = statuses.filter((s) => !s.docExists);

  console.log(`Total specs:        ${statuses.length}`);
  console.log(`With doc + deps:    ${withDocAndDeps.length}`);
  console.log(`With doc, no deps:  ${withDocNoDeps.length}`);
  console.log(`Without doc:        ${withoutDoc.length}`);

  if (withDocNoDeps.length > 0) {
    console.log("\nSpecs whose doc lacks Langflow source paths in External dependencies:");
    for (const s of withDocNoDeps) {
      const reason = s.hasDepsSection
        ? "section present but no `src/` paths"
        : "no External dependencies section";
      console.log(`  - ${s.spec}  (doc: ${s.docPath}; ${reason})`);
    }
  }

  if (withoutDoc.length > 0) {
    console.log("\nSpecs without a corresponding doc:");
    for (const s of withoutDoc) {
      console.log(`  - ${s.spec}  (expected doc: ${s.docPath})`);
    }
  }
}

main();
