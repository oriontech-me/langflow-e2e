#!/usr/bin/env node
/**
 * The file-watcher's monitored-area table, its existence guard, and its change
 * sweep (issue #1092).
 *
 * WHY THIS EXISTS
 *
 * `file-watcher.yml` opens a revalidation issue when upstream Langflow touches a
 * path one of our areas depends on. It carried two defects that made a clean
 * verdict worthless:
 *
 *   1. `src/lfx/` was watched by ZERO of the 13 areas, while Langflow has been
 *      moving backend behavior into that package. The change that broke all six
 *      stdio registrations in `mcp-server.spec.ts` (#1091) landed in
 *      `src/lfx/src/lfx/base/mcp/security.py` — the watcher did not fire, and it
 *      was never going to. Two areas were watching a path whose implementation
 *      had already left: `langflow/base/agents/` is a 1-file shim next to
 *      `lfx/base/agents/`'s 15 files.
 *
 *   2. A monitored path that no longer exists was SILENT. The sweep ran
 *      `git log --since=… -- $PATHS 2>/dev/null`, and `git log` over a
 *      nonexistent path prints nothing — so "this path is gone" and "nothing
 *      changed here" produced the same empty string, and the empty string was
 *      read as good news. `src/frontend/src/constants/flow_constants.tsx` had
 *      already moved to `src/frontend/src/flow_constants.tsx`.
 *
 * Both are fixed the way the repo fixes this class elsewhere — fail closed. A
 * verdict the watcher cannot produce must not read as a pass: the daily's
 * `runguard` treats an unknown verdict as a failure (#1012), and the
 * dedicated-issue guard fails loudly rather than passing (#1035).
 *
 * WHAT IS WATCHED, AND WHY NOT EVERYTHING
 *
 * `src/lfx/` holds ~1200 files. Watching all of them would fire every area on
 * every sweep, which is the same uselessness as watching none — "run the whole
 * suite" is not a signal. So each subtree is classified exactly once, in
 * LFX_CLASSIFICATION below: either it maps to an area the watcher already has,
 * or it is deliberately out of scope WITH a reason. The mapped set is
 * deliberately conservative — a subtree earns a mapping by being the counterpart
 * of something already watched, or by being what a spec observes directly.
 *
 * That table is also the guard's input: a subtree that appears upstream and
 * matches no entry FAILS the job by name, so the next `lfx` split forces a
 * decision instead of silently widening the blind spot.
 *
 * Run:
 *   node scripts/watch-upstream-areas.mjs --mode=check  --root langflow-upstream
 *   node scripts/watch-upstream-areas.mjs --mode=detect --root langflow-upstream --since "24 hours ago"
 *   node scripts/watch-upstream-areas.mjs --mode=areas          # print the table, no checkout needed
 *
 * Exit codes: 0 = verdict produced; 1 = the checkout contradicts the table (a
 * monitored path is gone, or an unclassified subtree exists); 2 = the script
 * could not decide (bad flag, unreadable checkout, `git log` failed).
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Commits listed per area in the issue body — same cap the bash version used. */
export const MAX_COMMITS_PER_AREA = 5;

/**
 * Areas and the `src/backend/…` / `src/frontend/…` paths they watch.
 *
 * `tags` drives the `--grep` command printed in the issue; `checklist` names the
 * QA-CHECKLIST sections to revisit. The `src/lfx/…` half of every area is
 * DERIVED from LFX_CLASSIFICATION by buildAreas() — never listed twice.
 */
export const LANGFLOW_AREAS = [
  {
    area: "Routes & Feature Flags",
    tags: ["@release", "@api", "@workspace", "@components"],
    checklist: "ALL AREAS — route or feature flag changes can break any test",
    paths: [
      "src/frontend/src/routes.tsx",
      "src/frontend/src/customization/feature-flags.ts",
      "src/frontend/src/customization/config-constants.ts",
    ],
  },
  {
    area: "Authentication",
    tags: ["@release", "@api"],
    checklist: "AREA 1 — Authentication and User Management",
    paths: [
      "src/backend/base/langflow/api/v1/login.py",
      "src/backend/base/langflow/api/v1/users.py",
      "src/backend/base/langflow/api/v1/api_key.py",
      "src/backend/base/langflow/services/auth/",
      "src/frontend/src/pages/LoginPage/",
      "src/frontend/src/pages/SignUpPage/",
      "src/frontend/src/components/authorization/",
      "src/frontend/src/stores/authStore.ts",
    ],
  },
  {
    area: "Flow CRUD & Canvas",
    tags: ["@workspace", "@release"],
    checklist: "AREA 2 — Flow CRUD | AREA 3 — Folders | AREA 4 — Canvas Editor",
    paths: [
      "src/backend/base/langflow/api/v1/flows.py",
      "src/backend/base/langflow/api/v1/folders.py",
      "src/frontend/src/pages/FlowPage/",
      "src/frontend/src/stores/flowStore.ts",
      "src/frontend/src/stores/flowsManagerStore.ts",
      // Moved out of `constants/` upstream; the old path was dead and silent.
      "src/frontend/src/flow_constants.tsx",
    ],
  },
  {
    area: "Flow Execution",
    tags: ["@release", "@api"],
    checklist: "AREA 10.3 — Flow Execution via API | AREA 4.10 — Run and Stop",
    paths: [
      "src/backend/base/langflow/api/v1/endpoints.py",
      "src/backend/base/langflow/processing/",
      "src/backend/base/langflow/api/v1/chat.py",
      "src/backend/base/langflow/services/chat/",
    ],
  },
  {
    area: "Model Providers & LLM",
    tags: ["@components", "@api"],
    checklist: "AREA 8 — LLM Integrations and Model Providers | AREA 7 — Templates (all integration tests)",
    paths: [
      "src/frontend/src/pages/SettingsPage/pages/ModelProvidersPage/",
      "src/frontend/src/modals/modelProviderModal/",
      "src/frontend/src/constants/providerConstants.ts",
      "src/frontend/src/components/common/modelProviderCountComponent/",
      "src/backend/base/langflow/api/v1/models.py",
      "src/backend/base/langflow/api/v1/model_options.py",
    ],
  },
  {
    area: "Agents & Agentic Flows",
    tags: ["@components", "@release"],
    checklist: "AREA 9.5 — Agent Component | AREA 7.4 — Agent Templates",
    paths: [
      "src/backend/base/langflow/agentic/",
      // Kept although it is a 3-line compatibility shim: it still exists, and it
      // is removed at M4 (#1040). The implementation is `lfx/base/agents/`.
      "src/backend/base/langflow/base/agents/",
      "src/frontend/src/pages/MainPage/",
    ],
  },
  {
    area: "Playground & Chat",
    tags: ["@workspace", "@release"],
    checklist: "AREA 6 — Playground",
    paths: [
      "src/frontend/src/pages/Playground/",
      "src/frontend/src/components/core/playgroundComponent/",
      "src/frontend/src/stores/playgroundStore.ts",
      "src/frontend/src/stores/messagesStore.ts",
      "src/backend/base/langflow/api/v1/chat.py",
    ],
  },
  {
    area: "Settings & Global Variables",
    tags: ["@api", "@release"],
    checklist: "AREA 8.4 — Global Variables | AREA 13 — Settings",
    paths: [
      "src/frontend/src/pages/SettingsPage/",
      "src/backend/base/langflow/api/v1/variable.py",
      "src/frontend/src/stores/globalVariablesStore/",
      "src/backend/base/langflow/settings.py",
    ],
  },
  {
    area: "MCP Server",
    tags: ["@components"],
    checklist: "AREA 11 — MCP Server",
    paths: [
      "src/frontend/src/pages/SettingsPage/pages/MCPServersPage/",
      "src/frontend/src/modals/addMcpServerModal/",
      "src/backend/base/langflow/api/v1/mcp.py",
      "src/backend/base/langflow/api/v1/mcp_projects.py",
      "src/backend/base/langflow/agentic/mcp/",
    ],
  },
  {
    area: "Tracing & Monitoring",
    tags: ["@api"],
    checklist: "AREA 12 — Observability and Monitoring",
    paths: [
      "src/backend/base/langflow/api/v1/traces.py",
      "src/backend/base/langflow/api/v1/monitor.py",
      "src/backend/base/langflow/services/tracing/",
    ],
  },
  {
    area: "Database Models",
    tags: ["@database", "@release"],
    checklist: "AREA 1, 2, 6, 8 — any area with persisted state",
    paths: [
      "src/backend/base/langflow/services/database/models/",
      "src/backend/base/langflow/alembic/",
    ],
  },
  {
    area: "Component Input Types",
    tags: ["@components"],
    checklist: "AREA 5 — Component Configuration | AREA 4 — Canvas Editor",
    paths: [
      "src/frontend/src/components/core/parameterRenderComponent/",
      "src/frontend/src/CustomNodes/",
      "src/backend/base/langflow/inputs/",
      "src/backend/base/langflow/field_typing/",
    ],
  },
  {
    area: "File Upload",
    tags: ["@components", "@api"],
    checklist: "AREA 9.7 — File Upload Component",
    paths: [
      "src/backend/base/langflow/api/v1/files.py",
      "src/backend/base/langflow/services/storage/",
      "src/frontend/src/pages/MainPage/pages/filesPage/",
    ],
  },
];

/** Where the `lfx` package lives inside the upstream checkout. */
export const LFX_ROOT = "src/lfx/src/lfx";

/** A subtree whose children are classified individually, one level down. */
export const PARTIAL = "PARTIAL";

/**
 * The `src/lfx/` decision record (issue #1092, fourth "Done when").
 *
 * Keys are paths relative to LFX_ROOT: a subtree, or a top-level module (`.py`).
 * Every direct child of LFX_ROOT — and of every PARTIAL entry — must appear here,
 * or `--mode=check` fails naming it. Modules are classified too, not just
 * directories: `lfx/settings.py` is the counterpart of the already-watched
 * `langflow/settings.py`, and a directory-only guard would have missed it.
 *
 *   { area: "<area name>" }        watched, folded into that area's path list
 *   { area: PARTIAL }              classified one level down
 *   { area: null, reason: "…" }    deliberately unwatched, with the reason
 *
 * Sizes quoted in the reasons were measured on `langflow-ai/langflow` @ 48aac68
 * (main, 2026-07-28). Re-measure before editing — the migration is ongoing,
 * which is the whole point of this table.
 */
export const LFX_CLASSIFICATION = {
  // ── watched: the counterpart of something already watched, or what a spec sees
  base: { area: PARTIAL },
  services: { area: PARTIAL },
  "base/agents": { area: "Agents & Agentic Flows" },
  "base/tools": { area: "Agents & Agentic Flows" },
  "base/mcp": { area: "MCP Server" },
  mcp: { area: "MCP Server" },
  "base/models": { area: "Model Providers & LLM" },
  inputs: { area: "Component Input Types" },
  field_typing: { area: "Component Input Types" },
  template: { area: "Component Input Types" },
  custom: { area: "Component Input Types" },
  interface: { area: "Component Input Types" },
  upgrade: { area: "Component Input Types" },
  "base/prompts": { area: "Component Input Types" },
  graph: { area: "Flow Execution" },
  execution: { area: "Flow Execution" },
  processing: { area: "Flow Execution" },
  events: { area: "Flow Execution" },
  "base/flow_processing": { area: "Flow Execution" },
  "base/flow_controls": { area: "Flow Execution" },
  memory: { area: "Playground & Chat" },
  schema: { area: "Playground & Chat" },
  "base/io": { area: "Playground & Chat" },
  "base/memory": { area: "Playground & Chat" },
  "services/auth": { area: "Authentication" },
  "services/authorization": { area: "Authentication" },
  "services/chat": { area: "Flow Execution" },
  "services/storage": { area: "File Upload" },
  "services/tracing": { area: "Tracing & Monitoring" },
  "services/variable": { area: "Settings & Global Variables" },
  "services/settings": { area: "Settings & Global Variables" },
  "services/database": { area: "Database Models" },
  "services/mcp_composer": { area: "MCP Server" },
  "settings.py": { area: "Settings & Global Variables" },

  // ── out of scope: component families (the packaging axis, #1040)
  components: {
    area: null,
    reason:
      "component implementations are moving to per-vendor `lfx_*` distributions; which of them ship is a packaging decision per image, tracked by #1040 — not something a path watcher can follow",
  },
  extension: {
    area: null,
    reason: "bundle discovery/registry — the same packaging axis as `components` (#1040)",
  },
  "base/vectorstores": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/embeddings": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/textsplitters": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/document_transformers": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/compressors": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/chains": { area: null, reason: "component-family base; packaging axis (#1040)" },
  "base/huggingface": { area: null, reason: "vendor-specific base; packaging axis (#1040)" },
  "base/composio": { area: null, reason: "vendor-specific base; packaging axis (#1040)" },
  "base/langwatch": { area: null, reason: "vendor-specific base; packaging axis (#1040)" },
  "base/datastax": { area: null, reason: "vendor-specific base; packaging axis (#1040)" },
  "base/curl": { area: null, reason: "cURL import helper for the API Request component; no spec asserts it" },
  "base/data": { area: null, reason: "data-component base; packaging axis (#1040)" },
  "base/langchain_utilities": { area: null, reason: "LangChain interop helpers; reached only through component families" },

  // ── out of scope: no monitored area owns it yet (follow-up, not a silent gap)
  "base/knowledge_bases": {
    area: null,
    reason:
      "knowledge ingestion has specs but no watcher area owns it — adding one is a scoping decision beyond #1092",
  },
  templates: {
    area: null,
    reason:
      "packaging templates (hello-world flow + CI templates), NOT the starter projects the @templates specs load — those live in `src/backend/base/langflow/initial_setup/starter_projects/`, which no area watches yet (same follow-up as `base/knowledge_bases`)",
  },
  workflow: { area: null, reason: "AG-UI workflow surface; no spec drives it yet" },
  run: { area: null, reason: "programmatic run/HITL API; no spec drives it — revisit if HITL coverage lands" },
  load: { area: null, reason: "programmatic load API; the suite drives Langflow over HTTP" },
  cli: { area: null, reason: "`lfx` CLI entry points; the suite never invokes them" },

  // ── out of scope: plumbing that surfaces through an already-watched path
  _assets: { area: null, reason: "static assets bundled into the package" },
  config: { area: null, reason: "package defaults; the suite sets behavior via container env vars" },
  exceptions: { area: null, reason: "exception types; they surface through the watched endpoints" },
  helpers: { area: null, reason: "generic helpers; a change lands in the area that consumes it" },
  io: { area: null, reason: "thin re-export surface over `inputs`/`template`, both watched" },
  log: { area: null, reason: "logging plumbing; not spec-observable" },
  logging: { area: null, reason: "logging plumbing; not spec-observable" },
  serialization: { area: null, reason: "internal serialization; surfaces through `schema`, watched" },
  type_extraction: { area: null, reason: "type introspection used by `custom`, watched" },
  utils: { area: null, reason: "broad utility surface; a change lands in the area that consumes it" },
  testing: { area: null, reason: "upstream's own test helpers; not product behavior our specs observe" },
  tests: { area: null, reason: "upstream's own unit tests; not product behavior our specs observe" },
  "base/processing": { area: null, reason: "single-module shim; the surface is `lfx/processing`, watched" },
  "services/cache": { area: null, reason: "cache plumbing; not spec-observable" },
  "services/durable": { area: null, reason: "durability plumbing; not spec-observable" },
  "services/executor": { area: null, reason: "task executor plumbing; surfaces through `execution`, watched" },
  "services/telemetry": { area: null, reason: "upstream telemetry; disabled in our containers" },
  "services/transaction": { area: null, reason: "transaction plumbing; surfaces through `services/database`, watched" },
  "services/adapters": { area: null, reason: "deployment adapters; the suite tests no deployment target" },
  "services/shared_component_cache": { area: null, reason: "cache plumbing; not spec-observable" },
  "services/extension_events": { area: null, reason: "bundle/extension events — packaging axis (#1040)" },

  // ── out of scope: top-level modules (the guard classifies these too)
  "constants.py": { area: null, reason: "package-level constants; a change surfaces in the area that consumes it" },
  "fork.py": { area: null, reason: "process bootstrap; not spec-observable" },
  "preload.py": { area: null, reason: "import preloading; not spec-observable" },
  "type_extraction.py": { area: null, reason: "type introspection used by `custom`, watched" },
  "base/constants.py": { area: null, reason: "component-base constants; surfaces through the bases themselves" },
  "services/base.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/config_discovery.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/deps.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/factory.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/initialize.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/interfaces.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/manager.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/registry.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/schema.py": { area: null, reason: "service framework plumbing; not spec-observable" },
  "services/session.py": { area: null, reason: "service framework plumbing; not spec-observable" },
};

/** A classification key that names a module rather than a subtree. */
const isModuleKey = (key) => key.endsWith(".py");

/**
 * Merge the derived `src/lfx/…` paths into the static area table.
 *
 * @returns {Array<{area: string, tags: string[], checklist: string, paths: string[]}>}
 */
export function buildAreas({ areas = LANGFLOW_AREAS, classification = LFX_CLASSIFICATION, lfxRoot = LFX_ROOT } = {}) {
  const derived = new Map();
  for (const [subtree, entry] of Object.entries(classification)) {
    if (!entry || !entry.area || entry.area === PARTIAL) continue;
    if (!derived.has(entry.area)) derived.set(entry.area, []);
    derived.get(entry.area).push(`${lfxRoot}/${subtree}${isModuleKey(subtree) ? "" : "/"}`);
  }

  const unknown = [...derived.keys()].filter((a) => !areas.some((x) => x.area === a));
  if (unknown.length > 0) {
    // A typo here would silently drop the subtree from every area's path list.
    throw new Error(
      `LFX_CLASSIFICATION maps subtrees to unknown area(s): ${unknown.join(", ")}. Area names must match LANGFLOW_AREAS exactly.`,
    );
  }

  return areas.map((entry) => ({
    ...entry,
    paths: [...entry.paths, ...(derived.get(entry.area) ?? []).sort()],
  }));
}

/** The live table, langflow + lfx. */
export const AREAS = buildAreas();

/**
 * Monitored paths that are not in the checkout.
 *
 * An area that cannot be evaluated must not read as clean — this is the check
 * that turns the old silent `git log -- <gone-path>` into a named failure.
 *
 * @param {{areas?: Array, exists: (p: string) => boolean}} options
 * @returns {Array<{area: string, path: string}>}
 */
export function findMissingPaths({ areas = AREAS, exists }) {
  const missing = [];
  for (const entry of areas) {
    for (const p of entry.paths) {
      if (!exists(p.replace(/\/$/, ""))) missing.push({ area: entry.area, path: p });
    }
  }
  return missing;
}

/**
 * Compare the `lfx` decision record against the checkout.
 *
 * `listChildren(dir)` returns the classifiable direct children of `dir` — every
 * subdirectory plus every `*.py` module, dunders excluded — or `null` when `dir`
 * is not a directory in the checkout.
 *
 * @param {{classification?: object, listChildren: (dir: string) => string[] | null, lfxRoot?: string}} options
 * @returns {{unclassified: string[], stale: string[], scanned: string[]}}
 *   unclassified — a subtree exists upstream and no entry covers it (fails the job)
 *   stale        — an entry names a subtree that is gone (reported, does not fail:
 *                  a vanished OUT-OF-SCOPE subtree is not a coverage hole, and a
 *                  vanished WATCHED one already fails via findMissingPaths)
 */
export function findLfxDrift({ classification = LFX_CLASSIFICATION, listChildren, lfxRoot = LFX_ROOT }) {
  const partials = ["", ...Object.keys(classification).filter((k) => classification[k]?.area === PARTIAL)];
  const unclassified = [];
  const scanned = [];
  const seen = new Set();

  for (const parent of partials) {
    const dir = parent ? `${lfxRoot}/${parent}` : lfxRoot;
    const children = listChildren(dir);
    if (children === null) {
      // The package root (or a PARTIAL subtree) is gone: the whole record below
      // it is unverifiable. Fail closed rather than reporting an empty scan.
      throw new Error(
        `${dir} is not a directory in the checkout. The lfx layout changed — revisit LFX_CLASSIFICATION in scripts/watch-upstream-areas.mjs.`,
      );
    }
    scanned.push(dir);
    for (const child of children) {
      const key = parent ? `${parent}/${child}` : child;
      seen.add(key);
      if (!(key in classification)) unclassified.push(key);
    }
  }

  const stale = Object.keys(classification).filter((k) => !seen.has(k));
  return { unclassified: unclassified.sort(), stale: stale.sort(), scanned };
}

/**
 * The change sweep: one entry per area with commits in the window.
 *
 * @param {{areas?: Array, commitsFor: (paths: string[]) => string}} options
 */
export function detectChangedAreas({ areas = AREAS, commitsFor }) {
  const changed = [];
  for (const entry of areas) {
    const commits = String(commitsFor(entry.paths) || "").trim();
    if (!commits) continue;
    changed.push({
      area: entry.area,
      tags: entry.tags,
      checklist: entry.checklist,
      grep: entry.tags.join("|"),
      commits: commits.split("\n").slice(0, MAX_COMMITS_PER_AREA),
    });
  }
  return changed;
}

/**
 * A fixed heredoc delimiter for the multiline `body` step output. Any rendered
 * line equal to it is dropped, so an upstream commit subject cannot close the
 * value early — same guard as MD_DELIMITER in report-backend-outages.mjs.
 */
export const BODY_DELIMITER = "WATCHER_BODY_EOF";

/** Cells go into a markdown table, and both tags and checklist contain `|`. */
const cell = (text) => String(text).replace(/\|/g, "\\|");

/**
 * The revalidation issue body.
 *
 * Rendered here rather than in the workflow so it is covered by
 * `npm run test:scripts` — the unescaped `|` that used to shred every row of the
 * table was invisible for exactly as long as this lived in inline YAML.
 */
export function renderIssueBody({ since, areas, today }) {
  return [
    "## Langflow source changes detected — test review required",
    "",
    `**Date:** ${today}`,
    `**Window:** \`${since}\``,
    "**Source:** [langflow-ai/langflow](https://github.com/langflow-ai/langflow)",
    "",
    "### Changed areas, affected tags and checklist sections",
    "",
    "| Area | Run these tests | Checklist |",
    "|---|---|---|",
    ...areas.map(
      (a) => `| ${cell(a.area)} | \`npx playwright test --grep "${cell(a.grep)}"\` | ${cell(a.checklist)} |`,
    ),
    "",
    "### Commits",
    ...areas.flatMap((a) => ["", `#### ${a.area}`, "```", ...a.commits, "```"]),
    "",
    "### Action required",
    "1. Review the commits listed above",
    "2. Run the tests indicated for each changed area",
    '3. Follow the validation guide in `CONTRIBUTING.md` → "Test maintenance"',
    "4. Update or fix stale tests if behavior changed",
    "5. Update `QA-CHECKLIST.md` if new scenarios were introduced",
    "6. Close this issue when done",
    "",
    "/cc @lice-reis",
  ]
    .filter((line) => line !== BODY_DELIMITER)
    .join("\n");
}

// ---------- CLI ----------

const isDir = (root, p) => {
  try {
    return fs.statSync(path.join(root, p)).isDirectory();
  } catch {
    return false;
  }
};

function listChildrenFactory(root) {
  return (dir) => {
    if (!isDir(root, dir)) return null;
    return fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isFile() && e.name.endsWith(".py")))
      .map((e) => e.name)
      .filter((name) => !name.startsWith("__"));
  };
}

function commitsForFactory(root, since) {
  return (paths) =>
    execFileSync("git", ["log", `--since=${since}`, "--oneline", "--", ...paths], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
}

function runCheck(root) {
  const missing = findMissingPaths({ exists: (p) => fs.existsSync(path.join(root, p)) });
  const drift = findLfxDrift({ listChildren: listChildrenFactory(root) });

  const total = AREAS.reduce((n, a) => n + a.paths.length, 0);
  process.stdout.write(`Checked ${total} monitored paths across ${AREAS.length} areas; scanned ${drift.scanned.length} lfx level(s).\n`);

  for (const key of drift.stale) {
    process.stderr.write(
      `::warning::LFX_CLASSIFICATION records "${key}", which no longer exists upstream — drop or repoint the entry.\n`,
    );
  }

  let failed = false;
  for (const { area, path: p } of missing) {
    process.stderr.write(
      `::error::monitored path "${p}" (area: ${area}) does not exist in the checkout. An area that cannot be evaluated must not read as clean — repoint or drop it in scripts/watch-upstream-areas.mjs.\n`,
    );
    failed = true;
  }
  for (const key of drift.unclassified) {
    process.stderr.write(
      `::error::${LFX_ROOT}/${key} exists upstream and no LFX_CLASSIFICATION entry covers it. Map it to an area or record it as out of scope with a reason (issue #1092).\n`,
    );
    failed = true;
  }
  if (failed) process.exit(1);
  process.stdout.write("All monitored paths exist and every lfx subtree is classified.\n");
}

function runDetect(root, since) {
  let changed;
  try {
    changed = detectChangedAreas({ commitsFor: commitsForFactory(root, since) });
  } catch (error) {
    process.stderr.write(
      `::error::watch-upstream-areas could not read the upstream history (${error.message}). Treating as undecidable, not as "nothing changed".\n`,
    );
    process.exit(2);
  }

  const today = new Date().toISOString().split("T")[0];
  const body = renderIssueBody({ since, areas: changed, today });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `has_changes=${changed.length > 0}`,
        `title=[Test Review] Langflow source changed on ${today} — validate affected tests`,
        `body<<${BODY_DELIMITER}`,
        body,
        BODY_DELIMITER,
        "",
      ].join("\n"),
    );
  } else {
    process.stdout.write(`${body}\n`);
  }
  for (const entry of changed) {
    process.stderr.write(`  ${entry.area}: ${entry.commits.length} commit(s)\n`);
  }
  process.stdout.write(`${changed.length} area(s) changed since ${since}\n`);
}

function main(argv) {
  const args = argv.slice(2);
  let mode = "check";
  let root = ".";
  let since = "24 hours ago";
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--mode=")) mode = a.slice(7);
    else if (a === "--root") root = args[++i];
    else if (a === "--since") since = args[++i];
    else {
      process.stderr.write(`::error::watch-upstream-areas: unknown argument ${a}\n`);
      process.exit(2);
    }
  }

  try {
    if (mode === "areas") {
      process.stdout.write(`${JSON.stringify(AREAS, null, 2)}\n`);
      return;
    }
    if (mode === "check") return runCheck(root);
    if (mode === "detect") return runDetect(root, since);
    process.stderr.write(`::error::watch-upstream-areas: unknown mode "${mode}"\n`);
    process.exit(2);
  } catch (error) {
    // Includes the fail-closed throw from findLfxDrift and a bad area name in
    // buildAreas — both mean the table no longer describes the checkout.
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("watch-upstream-areas.mjs")) {
  main(process.argv);
}
