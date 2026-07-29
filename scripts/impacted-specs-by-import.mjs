#!/usr/bin/env node
/**
 * Maps changed files of THIS repo to the spec files that import them —
 * transitively.
 *
 * Why it exists: `pr-validation.yml` used to select its E2E work from changed
 * `*.spec.ts` files only, so the highest-reach change the repo can receive — a
 * shared helper, a Page Object — passed PR validation without executing a
 * single spec (#1054). PR #1052 changed `adjust-screen-view.ts`, reached by 112
 * specs, and ran zero; PR #1088 changed `get-auth-token.ts`, imported directly
 * by 135 and reaching 171, and ran zero.
 *
 * (#1054 estimated #1052 at 108 from a grep over four known intermediaries. The
 * import graph puts it at 112: the grep missed one direct importer and counted
 * testid strings like "add-component-button-prompt-template" as reach.)
 *
 * Not to be confused with `scripts/impacted-tests.ts`, whose input is a
 * *Langflow source path* resolved through the `External dependencies` prose of
 * the spec docs (it serves `file-watcher.yml`). This script resolves imports
 * over this repo's own TypeScript — a different question, deliberately a
 * different script.
 *
 * Resolution is TRANSITIVE by contract: helper A imported by helper B imported
 * by spec C selects C. A direct-importers-only pass would have selected 62 of
 * #1052's 112 and read as coverage — worse than an honest zero.
 *
 * Run:
 *   node scripts/impacted-specs-by-import.mjs <changed-path...>
 *   node scripts/impacted-specs-by-import.mjs --stdin < changed.txt
 *   node scripts/impacted-specs-by-import.mjs --format=json --cap 20 <paths...>
 *
 * Output:
 *   text (default) — space-separated spec paths, ready for `npx playwright test`
 *   json           — { specs, selected, dropped, direct, transitive, stableSelected, fullSuite }
 *
 * Dependency-free on purpose: it runs as a workflow step with plain node, and
 * its unit tests run in the `npm run test:scripts` lane.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SUITE_ROOT = "tests";
const SPEC_RE = /\.spec\.ts$/;
const SOURCE_RE = /\.(ts|mts|mjs|js)$/;

/**
 * Changes every spec depends on, so resolving them per-import would understate
 * the reach: the fixture is imported by every spec by construction, and the
 * config/global hooks are not imported at all yet govern how each one runs.
 * These raise a full-suite signal that the gate must SHOW rather than skip.
 */
export const FULL_SUITE_PATHS = [
  "tests/fixtures/",
  "playwright.config.ts",
  "tests/globalSetup.ts",
  "tests/globalTeardown.ts",
];

export function isFullSuiteTrigger(file) {
  return FULL_SUITE_PATHS.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

const IMPORT_PATTERNS = [
  // import … from "x" / export … from "x"  (covers `import type`)
  /(?:^|[\s;}])(?:import|export)\s[\s\S]*?from\s*['"`]([^'"`]+)['"`]/g,
  // bare side-effect import "x"
  /(?:^|[\s;}])import\s*['"`]([^'"`]+)['"`]/g,
  // require("x") and dynamic import("x")
  /(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
];

export function parseImportSpecifiers(source) {
  const found = new Set();
  for (const re of IMPORT_PATTERNS) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Resolve a specifier to a repo-relative file, or null when it is a package or
 * cannot be found. Mirrors TypeScript's extensionless + index resolution; the
 * `.js`→`.ts` case covers NodeNext-style imports.
 */
export function resolveSpecifier(fromFile, specifier, exists) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.js`,
    base.replace(/\.js$/, ".ts"),
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.mjs"),
  ];
  return candidates.find((c) => SOURCE_RE.test(c) && exists(c)) ?? null;
}

/** module → set of files importing it. */
export function buildImporterGraph(files) {
  const exists = (p) => files.has(p);
  const graph = new Map();
  for (const [file, source] of files) {
    for (const specifier of parseImportSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier, exists);
      if (!target || target === file) continue;
      if (!graph.has(target)) graph.set(target, new Set());
      graph.get(target).add(file);
    }
  }
  return graph;
}

/** Cap the selection, returning what was kept AND what was dropped. */
export function applyCap(specs, cap) {
  if (!cap || cap <= 0 || specs.length <= cap) return { selected: [...specs], dropped: [] };
  return { selected: specs.slice(0, cap), dropped: specs.slice(cap) };
}

/**
 * Order within a tier: `@stable` first. When a cap truncates the selection, the
 * subset that still runs should be the validated one the daily reads as release
 * signal — otherwise the cap keeps whatever sorts alphabetically first, which
 * carries no meaning. Used as an ORDERING, never as a filter: a non-`@stable`
 * spec is still selected and still reported, just later in the queue.
 */
function stableFirst(specs, files) {
  const isStable = (f) => /@stable/.test(files.get(f) ?? "");
  return [...specs.filter(isStable).sort(), ...specs.filter((f) => !isStable(f)).sort()];
}

/**
 * Specs impacted by `changed`, walking importers breadth-first so direct
 * importers are ordered ahead of transitive ones — the order a cap truncates.
 */
export function selectImpactedSpecs({ changed, files, cap = 0 }) {
  const graph = buildImporterGraph(files);
  const fullSuite = changed.some(isFullSuiteTrigger);

  const direct = new Set();
  const transitive = new Set();
  const seen = new Set();
  // Distance from a changed file: 0 for the file itself, 1 for its importers…
  let frontier = changed.filter((f) => f.startsWith(`${SUITE_ROOT}/`) || isFullSuiteTrigger(f));
  for (const f of frontier) {
    seen.add(f);
    if (SPEC_RE.test(f)) direct.add(f);
  }
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next = [];
    for (const file of frontier) {
      for (const importer of graph.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (SPEC_RE.test(importer)) (depth === 1 ? direct : transitive).add(importer);
        next.push(importer);
      }
    }
    frontier = next;
  }

  // Every spec runs the fixture, so a fixture/config change reaches all of
  // them whether or not an import edge says so.
  if (fullSuite) {
    for (const file of files.keys()) {
      if (SPEC_RE.test(file) && !direct.has(file)) transitive.add(file);
    }
  }

  const ordered = [...stableFirst([...direct], files), ...stableFirst([...transitive], files)];
  const { selected, dropped } = applyCap(ordered, cap);
  return {
    specs: ordered,
    selected,
    dropped,
    direct: [...direct].sort(),
    transitive: [...transitive].sort(),
    stableSelected: selected.filter((f) => /@stable/.test(files.get(f) ?? "")).length,
    fullSuite,
  };
}

// ---------- CLI ----------

function readSuiteFiles(root = ".") {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (SOURCE_RE.test(entry.name)) {
        files.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
      }
    }
  };
  walk(SUITE_ROOT);
  for (const extra of ["playwright.config.ts"]) {
    if (fs.existsSync(path.join(root, extra))) {
      files.set(extra, fs.readFileSync(path.join(root, extra), "utf8"));
    }
  }
  return files;
}

function main(argv) {
  const args = argv.slice(2);
  let format = "text";
  let cap = 0;
  const changed = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stdin") {
      changed.push(...fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } else if (a.startsWith("--format=")) format = a.slice(9);
    else if (a === "--cap") cap = Number(args[++i]);
    else if (a.startsWith("--cap=")) cap = Number(a.slice(6));
    else if (!a.startsWith("--")) changed.push(a);
  }
  if (changed.length === 0) {
    process.stderr.write("usage: impacted-specs-by-import.mjs [--format=json] [--cap N] <changed-path...>\n");
    process.exit(2);
  }

  const result = selectImpactedSpecs({ changed, files: readSuiteFiles(), cap });
  if (format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (result.dropped.length > 0) {
    process.stderr.write(
      `warning: capped at ${cap} of ${result.specs.length} impacted specs — ${result.dropped.length} dropped:\n  ${result.dropped.join("\n  ")}\n`,
    );
  }
  process.stdout.write(result.selected.join(" ") + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("impacted-specs-by-import.mjs")) {
  main(process.argv);
}
