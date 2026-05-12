/**
 * Maps changed Langflow source paths to the spec files whose `External
 * dependencies` section references them.
 *
 * Run:
 *   npx ts-node scripts/impacted-tests.ts <changed-path-1> <changed-path-2> ...
 *   npx ts-node scripts/impacted-tests.ts --format=json <paths...>
 *   cat changed.txt | npx ts-node scripts/impacted-tests.ts --stdin
 *
 * Output formats:
 *   files  (default) — newline-separated spec file paths, ready to pass as
 *                      positional args to `npx playwright test`
 *   json             — `{ specs: string[], catchAll: boolean, unmapped: string[] }`
 *
 * Behavior:
 *   - File-level matching: a doc bullet `src/foo/bar.py` matches an exact diff
 *     path, and a bullet ending in `/` (e.g. `src/foo/`) matches anything inside.
 *   - Catch-all paths (routes / feature flags) trigger a full-suite signal.
 *   - Unmapped paths are skipped with a warning on stderr — the nightly suite
 *     still covers regressions broadly, so missing them in the adaptive run is
 *     acceptable.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Paths that, when changed, can break any test (routes, feature flags, global
 * config). Mirrors the "Routes & Feature Flags" area in
 * `.github/workflows/file-watcher.yml`.
 */
const CATCH_ALL_PATHS: string[] = [
  "src/frontend/src/routes.tsx",
  "src/frontend/src/customization/feature-flags.ts",
  "src/frontend/src/customization/config-constants.ts",
];

const DOCS_ROOT = "docs";
const SPECS_ROOT = "tests/tests-automations/regression";

const EXTERNAL_DEPS_HEADER_RE = /^##\s+External dependencies(\s+\*\(required\)\*)?\s*$/;
const SECTION_END_RE = /^(##\s+|---\s*)$/;
const BULLET_BACKTICK_RE = /^-\s+`([^`]+)`/;

interface DocMap {
  /** Map from Langflow source path (file or dir-with-trailing-slash) → set of spec file paths. */
  pathToSpecs: Map<string, Set<string>>;
  /** Spec files that have a parsed doc (regardless of whether dependencies were found). */
  knownSpecs: Set<string>;
}

interface ImpactResult {
  specs: string[];
  catchAll: boolean;
  unmapped: string[];
}

interface CliOptions {
  format: "files" | "json";
  paths: string[];
  fromStdin: boolean;
}

function readArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { format: "files", paths: [], fromStdin: false };
  for (const arg of argv) {
    if (arg === "--stdin") {
      opts.fromStdin = true;
    } else if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (v !== "files" && v !== "json") {
        throw new Error(`Invalid --format value: ${v} (expected files|json)`);
      }
      opts.format = v;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      opts.paths.push(arg);
    }
  }
  return opts;
}

function readStdin(): string[] {
  const data = fs.readFileSync(0, "utf-8");
  return data
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns the spec path that mirrors the doc path under regression/, or null
 * for top-level docs that are not test specs (template, model catalog, etc.).
 */
function specForDoc(docPath: string, repoRoot: string): string | null {
  const rel = path.relative(path.join(repoRoot, DOCS_ROOT), docPath);
  if (rel.startsWith("..") || !rel.includes(path.sep)) {
    // Outside docs/ or top-level doc with no area folder — not a spec.
    return null;
  }
  const withoutExt = rel.replace(/\.md$/, "");
  return path.join(SPECS_ROOT, `${withoutExt}.spec.ts`);
}

/**
 * Extracts the External dependencies bullets and keeps only entries whose
 * leading backticked token starts with `src/` (Langflow source). Helpers,
 * external services, and bare filenames are filtered out.
 */
function parseExternalDeps(markdown: string): string[] {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (!inSection) {
      if (EXTERNAL_DEPS_HEADER_RE.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (SECTION_END_RE.test(line)) break;
    const m = line.match(BULLET_BACKTICK_RE);
    if (!m) continue;
    const token = m[1].trim();
    if (token.startsWith("src/")) {
      out.push(token);
    }
  }

  return out;
}

function buildDocMap(repoRoot: string): DocMap {
  const docsDir = path.join(repoRoot, DOCS_ROOT);
  const docs = walkMarkdown(docsDir);
  const pathToSpecs = new Map<string, Set<string>>();
  const knownSpecs = new Set<string>();

  for (const doc of docs) {
    const spec = specForDoc(doc, repoRoot);
    if (!spec) continue;
    knownSpecs.add(spec);
    const md = fs.readFileSync(doc, "utf-8");
    const deps = parseExternalDeps(md);
    for (const dep of deps) {
      let set = pathToSpecs.get(dep);
      if (!set) {
        set = new Set<string>();
        pathToSpecs.set(dep, set);
      }
      set.add(spec);
    }
  }

  return { pathToSpecs, knownSpecs };
}

function isCatchAll(changedPath: string): boolean {
  return CATCH_ALL_PATHS.some(
    (p) => changedPath === p || changedPath.startsWith(`${p}/`)
  );
}

function matchSpecsForPath(changedPath: string, docMap: DocMap): Set<string> {
  const matched = new Set<string>();
  for (const [depPath, specs] of docMap.pathToSpecs) {
    const isDir = depPath.endsWith("/");
    if (isDir) {
      if (changedPath === depPath.slice(0, -1) || changedPath.startsWith(depPath)) {
        for (const s of specs) matched.add(s);
      }
    } else if (changedPath === depPath) {
      for (const s of specs) matched.add(s);
    }
  }
  return matched;
}

function computeImpact(changedPaths: string[], docMap: DocMap): ImpactResult {
  const specs = new Set<string>();
  const unmapped: string[] = [];
  let catchAll = false;

  for (const cp of changedPaths) {
    if (isCatchAll(cp)) {
      catchAll = true;
      continue;
    }
    const matched = matchSpecsForPath(cp, docMap);
    if (matched.size === 0) {
      unmapped.push(cp);
    } else {
      for (const s of matched) specs.add(s);
    }
  }

  return {
    specs: [...specs].sort(),
    catchAll,
    unmapped,
  };
}

function reportUnmapped(unmapped: string[]): void {
  if (unmapped.length === 0) return;
  console.error(
    `[impacted-tests] WARNING: ${unmapped.length} changed path(s) are not referenced by any spec doc:`
  );
  for (const p of unmapped) {
    console.error(`  - ${p}`);
  }
  console.error(
    "[impacted-tests] These will not run in the adaptive subset; the nightly suite still covers them."
  );
}

function main(): void {
  const opts = readArgs(process.argv.slice(2));
  const inputs = opts.fromStdin ? readStdin() : opts.paths;
  if (inputs.length === 0) {
    console.error(
      "Usage: impacted-tests [--format=files|json] [--stdin] <path1> <path2> ..."
    );
    process.exit(2);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const docMap = buildDocMap(repoRoot);
  const result = computeImpact(inputs, docMap);
  reportUnmapped(result.unmapped);

  if (result.catchAll) {
    // Empty output signals "run everything" to the caller; the workflow checks
    // the catchAll flag separately via --format=json before invoking playwright.
    console.error(
      "[impacted-tests] Catch-all path changed — full suite required; emitting empty output."
    );
  }

  switch (opts.format) {
    case "json":
      console.log(JSON.stringify(result, null, 2));
      break;
    case "files":
    default:
      if (!result.catchAll) {
        for (const s of result.specs) console.log(s);
      }
      break;
  }
}

main();
