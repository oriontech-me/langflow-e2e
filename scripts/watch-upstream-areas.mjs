#!/usr/bin/env node
/**
 * The file-watcher's monitored-area table, its existence guard, and its change
 * sweep (issue #1092).
 *
 * WHY THIS EXISTS
 *
 * `file-watcher.yml` opens a revalidation issue when upstream Langflow touches a
 * path one of our areas depends on, and prints the `--grep` to revalidate. It
 * carried two defects that made its output untrustworthy:
 *
 *   1. `src/lfx/` was watched by ZERO of the 13 areas, while Langflow has been
 *      moving backend behavior into that package. The consequence is ATTRIBUTION,
 *      not detection: the change that broke all six stdio registrations in
 *      `mcp-server.spec.ts` (#1091) landed in `lfx/base/mcp/security.py` as part
 *      of a 70-file commit (f4d6ac4) that also touched `api/v1/users.py`,
 *      `processing/`, `agentic/` and `SettingsPage/` — so four areas would have
 *      fired on it, and none of them would have been MCP Server. `@mcp` was
 *      absent from the printed grep, so `mcp-server.spec.ts` was never in the
 *      revalidation set. Two areas were also watching a path whose
 *      implementation had left: `langflow/base/agents/` is a 3-line shim next to
 *      `lfx/base/agents/`'s 15 files.
 *
 *      (Independently of any of this, the workflow has been `workflow_dispatch`
 *      only since 9da85fa, so in July it produced no signal at all. Re-enabling
 *      the schedule is a separate decision — this script does not change it.)
 *
 *   2. A monitored path that does not exist was SILENT. The sweep ran
 *      `git log --since=… -- $PATHS 2>/dev/null`, and `git log` over a
 *      nonexistent path prints nothing — so "this path is not there" and
 *      "nothing changed here" produced the same empty string, and the empty
 *      string was read as good news. `src/frontend/src/constants/flow_constants.tsx`
 *      was such a path: it has never existed on any upstream ref (the file is
 *      `src/frontend/src/flow_constants.tsx`), so that entry was dead from the
 *      day it was written and nothing ever said so.
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
 * or it is out of scope WITH a reason. A subtree earns a mapping by being the
 * counterpart of something already watched, or by being what a spec observes
 * directly.
 *
 * Measured cost of that choice, areas firing per 24h window on `origin/main`:
 * the median goes from ~3 of 13 to ~7 of 13, and a busy upstream day now names
 * 11 — whose tag union is close to the whole suite. That is the honest price of
 * covering `lfx` at all, and it is near the limit of what stays a signal. Widen
 * the mapped set further only with a reason, and prefer moving an entry to
 * out-of-scope over adding one.
 *
 * KNOWN LIMIT: the guard proves a monitored path EXISTS. It cannot tell a live
 * implementation from an emptied compatibility shim — `langflow/base/agents/`
 * passes today with 3 lines. Shim detection needs a size/content signal and is
 * deliberately not attempted here.
 *
 * That table is also the guard's input: a subtree that appears upstream and
 * matches no entry FAILS the job by name, so the next `lfx` split forces a
 * decision instead of silently widening the blind spot.
 *
 * Run:
 *   node scripts/watch-upstream-areas.mjs --mode=check  --root langflow-upstream
 *   node scripts/watch-upstream-areas.mjs --mode=detect --root langflow-upstream --since "24 hours ago"
 *   node scripts/watch-upstream-areas.mjs --mode=areas          # print the table, no checkout needed
 *   node scripts/watch-upstream-areas.mjs --mode=release-ref --root langflow-upstream
 *   node scripts/watch-upstream-areas.mjs --mode=check-docs --root langflow-upstream \
 *       --ref origin/main --releases origin/release-1.12.0,origin/release-1.11.5 \
 *       [--changed changed-docs.txt]   # spec-doc dependency paths (#1298, #1574)
 *
 * A path satisfied by the trunk OR by any release line resolves (#1574): the
 * suite validates the nightly, which is cut from a release line, not from `main`.
 * `--mode=release-ref` prints the lines to fetch, newest first.
 *
 * Exit codes: 0 = verdict produced; 1 = the checkout contradicts the table (a
 * monitored path is gone, an unclassified subtree exists, or a changed doc names
 * a dependency path that does not resolve); 2 = the script could not decide (bad
 * flag, unreadable checkout, `git log`/`git ls-tree` failed, unreadable
 * `--changed` list).
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  // `parse.py` IS the cURL parser two @stable tests exercise end-to-end
  // (api-request-component-regression.spec.ts, the cURL tab and the
  // parses-and-executes case). Recorded as unwatched in the first draft of this
  // table on the false grounds that no spec asserted it.
  "base/curl": { area: "Component Input Types" },
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
  "base/data": { area: null, reason: "data-component base; packaging axis (#1040)" },
  "base/langchain_utilities": { area: null, reason: "LangChain interop helpers; reached only through component families" },

  // ── out of scope: no monitored area owns it yet (follow-up, not a silent gap)
  "base/knowledge_bases": {
    area: null,
    reason:
      "UNCOVERED GAP, not a safe exclusion: 7 knowledge-ingestion specs depend on this and two spec docs list it under External dependencies, but no watcher area owns knowledge ingestion. Adding an area is a scoping decision beyond #1092 — tracked as a follow-up",
  },
  templates: {
    area: null,
    reason:
      "packaging templates (hello-world flow + CI templates), NOT the starter projects the @templates specs load — those live in `src/backend/base/langflow/initial_setup/starter_projects/`, referenced by four spec docs and watched by no area. Same uncovered gap as `base/knowledge_bases`",
  },
  workflow: { area: null, reason: "AG-UI workflow surface; no spec drives it yet" },
  run: { area: null, reason: "programmatic run/HITL API; no spec drives it — revisit if HITL coverage lands" },
  load: { area: null, reason: "programmatic load API; the suite drives Langflow over HTTP" },
  cli: { area: null, reason: "`lfx` CLI entry points; the suite never invokes them" },

  // ── out of scope: plumbing that surfaces through an already-watched path
  _assets: {
    area: null,
    reason:
      "`component_index.json` (2.3 MB, the registry the sidebar renders from) plus `stable_hash_history.json` — excluded because it is regenerated by every component edit, so watching it would fire @components on nearly every sweep with no added information over the component sources themselves",
  },
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

/* ------------------------------------------------------------------------- *
 * Spec-doc dependency paths (issue #1298)
 * ------------------------------------------------------------------------- */

/**
 * The same defect as (2) above, one file over: `validate-spec-deps.ts` checks
 * that a spec doc's mandatory `## External dependencies` section EXISTS and is
 * populated, and never that the paths in it RESOLVE. Measured against four real
 * refs (release-1.10.0, release-1.11.2, release-1.12.0, main), 42 distinct paths
 * across 35 files resolved on NONE of them — 17 in the pre-`lfx` tree, gone since
 * *feat: introduce lfx package* (#9133, 2025-09-02); ~20 under `src/frontend/`
 * whose directory was reorganised; 7 missing the real `src/lfx/src/lfx/` prefix.
 *
 * The cost is not only a dead end for a reviewer. `scripts/impacted-tests.ts`
 * maps a changed Langflow path to the specs whose docs name it, by PREFIX — so a
 * path that resolves to nothing makes that spec unselectable by
 * `adaptive-impacted.yml`. A wrong path there is silent in exactly the way a
 * missing one is.
 *
 * WHY THIS LIVES HERE, AND WHY IT RESOLVES VIA `git ls-tree`
 *
 * The resolution machinery — an upstream checkout plus a fail-closed verdict over
 * it — is what `--mode=check` already is (#1092), so the check extends this
 * script rather than growing a second copy inside `validate-spec-deps.ts`.
 *
 * It reads the tree with `git ls-tree` instead of `fs.existsSync`, which is what
 * lets it run on a lane that has no upstream working tree: a
 * `--filter=blob:none --depth 1 --no-checkout` clone of langflow is 520 KB and
 * 1.6 s (measured), while materialising the files is ~117 MB. `--mode=check`
 * still needs the working tree for its `lfx` subtree scan, so the two modes read
 * the checkout differently on purpose.
 */
export const DOC_DEPS_HEADER_RE = /^##\s+External dependencies(\s+\*\(required\)\*)?\s*$/;
const DOC_DEPS_SECTION_END_RE = /^(##\s+|---\s*)$/;

/**
 * Docs whose dependency bullets are illustrative by design. The template's whole
 * job is to show the SHAPE of the section, so `src/frontend/...` there is content,
 * not a defect. Kept as an explicit allowlist rather than a heuristic, because
 * "looks like a placeholder" is exactly the judgement that let 10 real ellipses
 * pass unverified.
 */
export const DOC_DEPS_EXEMPT_FILES = ["docs/TEST-SPEC-TEMPLATE.md"];

/**
 * Every backticked `src/…` token inside the section — not just the leading one.
 *
 * A bullet routinely names a second file mid-sentence, and a multi-file
 * dependency is written as continuation lines; checking only the first token per
 * bullet (what `impacted-tests.ts` consumes) would leave those unverified, which
 * is the silence this guard exists to remove.
 *
 * @param {string} markdown
 * @returns {Array<{token: string, line: number}>}
 */
export function parseDocDeps(markdown) {
  const out = [];
  const lines = String(markdown).split("\n");
  let inSection = false;

  lines.forEach((line, index) => {
    if (!inSection) {
      if (DOC_DEPS_HEADER_RE.test(line)) inSection = true;
      return;
    }
    if (DOC_DEPS_SECTION_END_RE.test(line)) {
      inSection = false;
      return;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim();
      if (token.startsWith("src/")) out.push({ token, line: index + 1 });
    }
  });

  return out;
}

/**
 * What kind of thing a dependency token is, and what should be resolved for it.
 *
 * - `literal` — a path. A trailing `:70-78` line range is informative and is
 *   stripped before resolving; a trailing slash is cosmetic.
 * - `glob` — contains `*`. Resolvable: it must match at least one tree entry.
 * - `ellipsis` — contains `...` or `…`. NOT resolvable, by any means, so it is a
 *   defect rather than a skip: an unevaluated path is unknown, not clean
 *   (#1012's rule, the same one `runguard` and the lfx scan apply).
 *
 * @param {string} token
 * @returns {{kind: "literal"|"glob"|"ellipsis", target: string}}
 */
export function classifyDepToken(token) {
  const target = String(token).replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
  if (/\.\.\.|…/.test(target)) return { kind: "ellipsis", target };
  if (target.includes("*")) return { kind: "glob", target };
  return { kind: "literal", target };
}

/**
 * Anchored glob match over tree entries. `**` crosses directories, `*` does not,
 * which is how the three surviving `pages/MainPage/**`-style entries are meant to
 * read.
 *
 * @param {string} pattern
 * @param {string[]} treeEntries
 * @returns {string[]} matches (empty means the pattern resolves to nothing)
 */
export function matchGlob(pattern, treeEntries) {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const re = new RegExp(`^${source}$`);
  return treeEntries.filter((entry) => re.test(entry));
}

/**
 * The verdict, over already-read docs so it is testable without a checkout.
 *
 * Severity follows the coverage-first trade (#980): a path the PR itself touched
 * FAILS, everything else is reported. One upstream rename must not redden every
 * PR that edits an unrelated doc — but it must not be invisible either, so the
 * pre-existing half is announced, never dropped (#1012).
 *
 * **Resolution is over the trunk AND the release lines, and any one of them is
 * enough (issue #1574).** The suite does not validate upstream `main`: every
 * scheduled lane runs `langflowai/langflow-nightly:latest`, which is cut from a
 * release line, and upstream merges that line back into `main` only sporadically
 * (~1–2 months). Resolving against `main` alone therefore failed a PR for a path
 * that is genuinely correct for the image under test — measured on PR #1570,
 * where `src/lfx/src/lfx/exceptions/tweaks.py` was absent from `main` and present
 * on `release-1.12.0`.
 *
 * What does NOT change is the guard's original purpose (#1298): a path that
 * resolves on NO ref is still a defect. What is added is attribution, and the
 * refs carry ROLES rather than sitting in a flat list, because only two shapes
 * are worth a reader's attention:
 *
 * - `release-only` — absent from the trunk. This is #1574's case, and naming it
 *   is what stops a green verdict from reading as "exists on `main`".
 * - `trunk-only` — on the trunk and on no release line, so the image this suite
 *   actually runs does not carry it. The mirror of the same defect.
 *
 * A flat list would instead report every path merely NEWER than the oldest
 * release line tracked — measured, that is 8 of 9 findings on this repo's docs
 * today, all of them noise, and it grows with every release cut.
 *
 * @param {{
 *   docs: Array<{file: string, markdown: string}>,
 *   trunk: {ref: string, entries: string[]},
 *   releases?: Array<{ref: string, entries: string[]}>,
 *   changedFiles?: string[],
 *   exemptFiles?: string[],
 * }} options
 * @returns {{
 *   checked: number,
 *   failures: Array,
 *   warnings: Array,
 *   partial: Array<{
 *     file: string, line: number, token: string,
 *     class: "release-only"|"trunk-only", resolvedOn: string[], missingOn: string[],
 *   }>,
 *   exempt: string[],
 * }}
 */
export function checkDocDeps({ docs, trunk, releases = [], changedFiles = [], exemptFiles = DOC_DEPS_EXEMPT_FILES }) {
  if (!trunk || !Array.isArray(trunk.entries)) {
    // No trunk would resolve nothing and read as "every path is broken", which is
    // the same false verdict an empty tree is rejected for in runCheckDocs.
    throw new Error("checkDocDeps needs a trunk { ref, entries } tree to resolve against");
  }
  const index = ({ ref, entries }) => ({ ref, entries, set: new Set(entries) });
  const trunkTree = index(trunk);
  const releaseTrees = releases.map(index);
  const allTrees = [trunkTree, ...releaseTrees];
  const changed = new Set(changedFiles);
  const exemptSet = new Set(exemptFiles);
  const failures = [];
  const warnings = [];
  const partial = [];
  const exempt = [];
  let checked = 0;

  for (const doc of docs) {
    if (exemptSet.has(doc.file)) {
      exempt.push(doc.file);
      continue;
    }
    for (const { token, line } of parseDocDeps(doc.markdown)) {
      const { kind, target } = classifyDepToken(token);
      checked += 1;

      // An ellipsis is unresolvable by construction, so no ref can decide it and
      // asking each one would only make the reason misleading (#1012).
      if (kind === "ellipsis") {
        const finding = {
          file: doc.file,
          line,
          token,
          kind,
          reason: "contains an ellipsis, so it can never be resolved against upstream — write the real path, or a glob",
        };
        (changed.has(doc.file) ? failures : warnings).push(finding);
        continue;
      }

      const satisfies = (tree) =>
        kind === "glob" ? matchGlob(target, tree.entries).length > 0 : tree.set.has(target);
      const resolvedOn = allTrees.filter(satisfies).map((tree) => tree.ref);

      if (resolvedOn.length === 0) {
        const where = allTrees.map((tree) => tree.ref).join(", ");
        const finding = {
          file: doc.file,
          line,
          token,
          kind,
          reason: kind === "glob" ? `glob matches nothing on ${where}` : `does not exist on ${where}`,
        };
        (changed.has(doc.file) ? failures : warnings).push(finding);
        continue;
      }

      const onTrunk = resolvedOn.includes(trunkTree.ref);
      const onSomeRelease = releaseTrees.some((tree) => resolvedOn.includes(tree.ref));
      if (!onTrunk) {
        partial.push({
          file: doc.file,
          line,
          token,
          class: "release-only",
          resolvedOn,
          missingOn: [trunkTree.ref],
        });
      } else if (releaseTrees.length > 0 && !onSomeRelease) {
        partial.push({
          file: doc.file,
          line,
          token,
          class: "trunk-only",
          resolvedOn,
          missingOn: releaseTrees.map((tree) => tree.ref),
        });
      }
    }
  }

  return { checked, failures, warnings, partial, exempt };
}

/**
 * How many release lines are resolved against, newest first.
 *
 * Not one. The line the nightly SHIPS lags the newest line CUT: upstream branches
 * `release-1.13.0` off `main` before the nightly switches to it, and a
 * single-line window would drop the shipping line at that moment — taking with
 * it every path that landed there and was never merged back, which is exactly the
 * class #1574 exists to accommodate. Measured on the real remote: 61 `src/` paths
 * live on `release-1.11.5` and on NEITHER `main` nor `release-1.12.0`, one of
 * them `services/tracing/otel_fastapi_patch.py` — a plausible `@observability`
 * dependency. Two lines cover a full cycle of that lag.
 *
 * Not more than two, either: a path only the line before last carries is a path
 * the tested image does not run, and the guard would then be confirming a file
 * nobody tests.
 */
export const RELEASE_LINES_TRACKED = 2;

/**
 * The newest `release-X.Y[.Z]` branches upstream — the lines the nightly is cut
 * from, newest first.
 *
 * `langflowai/langflow-nightly:latest` is built from a release line, not from
 * `main`, so those are the refs a doc naming 1.12-only code must be allowed to
 * resolve against (#1574). Deriving them beats hardcoding: the lines rotate, and
 * a hardcoded ref goes stale silently — on a guard whose whole job is to refuse
 * silent verdicts.
 *
 * Selection is by NUMERIC version, never lexically: upstream carries
 * `release-1.9.7` and `release-1.12.0` side by side, and a string sort picks the
 * 1.9 line. The shape is also strict — upstream's branch list holds
 * `release-notes`, `release-0.6.0a`, `release-1.6.0-backup` and
 * `release-1.6.0-at-scheduling-logic-branch`, none of which is a release line.
 *
 * `release-1.12` and `release-1.12.0` are the same version, so the order between
 * them would otherwise be decided by whatever order `ls-remote` printed. The
 * more specific spelling wins, then lexical order — arbitrary is fine, undefined
 * is not, since the winner is a ref the caller then fetches.
 *
 * @param {string} lsRemoteOutput raw `git ls-remote --heads origin 'refs/heads/release-*'`
 * @param {number} count how many lines to return
 * @returns {string[]} e.g. `["release-1.12.0", "release-1.11.5"]`
 * @throws when the output names no release line at all — undecidable, not "none".
 */
export function pickReleaseBranches(lsRemoteOutput, count = RELEASE_LINES_TRACKED) {
  const candidates = [];
  for (const line of String(lsRemoteOutput || "").split("\n")) {
    const name = line.trim().split(/\s+/).pop() || "";
    const match = /^(?:refs\/heads\/)?(release-(\d+)\.(\d+)(?:\.(\d+))?)$/.exec(name);
    if (!match) continue;
    candidates.push({
      branch: match[1],
      version: [Number(match[2]), Number(match[3]), Number(match[4] || 0)],
      segments: match[4] === undefined ? 2 : 3,
    });
  }
  if (candidates.length === 0) {
    throw new Error(
      "no `release-X.Y[.Z]` branch found upstream, so the release line(s) the nightly is cut from cannot be derived",
    );
  }
  candidates.sort(
    (a, b) =>
      b.version[0] - a.version[0] ||
      b.version[1] - a.version[1] ||
      b.version[2] - a.version[2] ||
      b.segments - a.segments ||
      (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0),
  );
  return candidates.slice(0, Math.max(1, count)).map((c) => c.branch);
}

/**
 * Accepted `--since` windows.
 *
 * `git log --since=` is parsed by approxidate, which NEVER errors — it guesses.
 * Measured against the real clone: `--since=undefined` selects 0 commits (a green
 * "nothing changed" run indistinguishable from a quiet day) and
 * `--since="last thursdya"` selects 200 (12 of 13 areas fire). A typo in the
 * dispatch form must not decide the window, so the input is validated here
 * instead of being handed to git unchecked.
 *
 * Upstream does have genuinely quiet days (2026-07-19 and 2026-07-11/12 had zero
 * commits on main), so an empty result is NOT treated as a failure — it is
 * reported as an empty window with the newest commit in the checkout, which is
 * what makes a wrong window obvious.
 */
export const SINCE_PATTERN = /^(?:\d+ (?:hour|day|week|month)s? ago|yesterday|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)$/;

/** @throws when the window is not one of the accepted forms. */
export function assertValidSince(since) {
  if (!SINCE_PATTERN.test(String(since || "").trim())) {
    throw new Error(
      `--since "${since}" is not an accepted window. Use "N hours|days|weeks|months ago", "yesterday", or an ISO date/time ("2026-07-15", "2026-07-15T17:24:00-0700"). git's approxidate would silently guess instead of rejecting a typo.`,
    );
  }
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
export function renderIssueBody({ since, areas, today, window }) {
  return [
    "## Langflow source changes detected — test review required",
    "",
    `**Date:** ${today}`,
    `**Window:** \`${since}\`` +
      (window ? ` — ${window.count} upstream commit(s) repo-wide; newest in checkout: \`${window.newest}\`` : ""),
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
    return (
      fs
        .readdirSync(path.join(root, dir), { withFileTypes: true })
        // A symlinked subtree is neither isDirectory() nor isFile(), so taking
        // those two alone would skip it silently — a classifiable child the
        // guard could not see. Resolve instead of ignoring.
        .filter((e) => {
          if (e.isSymbolicLink()) return isDir(root, path.join(dir, e.name)) || e.name.endsWith(".py");
          return e.isDirectory() || (e.isFile() && e.name.endsWith(".py"));
        })
        .map((e) => e.name)
        .filter((name) => !name.startsWith("__"))
    );
  };
}

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

function commitsForFactory(root, since) {
  return (paths) => git(root, ["log", `--since=${since}`, "--oneline", "--", ...paths]);
}

/**
 * What the window actually selected, repo-wide. Printed so a window that
 * resolved to something other than what was typed is visible at a glance
 * instead of arriving as a per-area verdict.
 */
function describeWindow(root, since) {
  const total = git(root, ["log", `--since=${since}`, "--oneline"]).trim();
  const count = total ? total.split("\n").length : 0;
  const newest = git(root, ["log", "-1", "--format=%h %cs %s"]).trim();
  return { count, newest };
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

/** Every `.md` under `docs/`, plus the top-level README — the files that can carry the section. */
function collectDocFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(path.join(repoRoot, "docs"));
  const readme = path.join(repoRoot, "README.md");
  if (fs.existsSync(readme)) out.push(readme);
  return out.map((file) => ({ file: path.relative(repoRoot, file), markdown: fs.readFileSync(file, "utf8") }));
}

/** How many `partial` findings the report names before it starts eliding (#1012: named, and capped visibly). */
const MAX_NAMED_PARTIALS = 20;

/**
 * Prints the release lines the lanes' nightly is cut from, newest first, one per
 * line, for a caller that has to fetch them before `--mode=check-docs` can
 * resolve against them.
 *
 * It lives here rather than as a `git ls-remote | sort -V | head -2` in the
 * workflow so the selection is covered by `npm run test:scripts` — the lexical
 * trap it exists to avoid (`release-1.9.7` > `release-1.12.0`) is exactly the
 * kind of defect that stays invisible in inline YAML (#1226).
 */
function runReleaseRef(root) {
  let output;
  try {
    output = git(root, ["ls-remote", "--heads", "origin", "refs/heads/release-*"]);
  } catch (error) {
    process.stderr.write(
      `::error::watch-upstream-areas: could not list upstream release branches in --root "${root}" (${error.message}). Refusing to guess the release line.\n`,
    );
    process.exit(2);
  }
  try {
    process.stdout.write(`${pickReleaseBranches(output).join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`::error::watch-upstream-areas: ${error.message}.\n`);
    process.exit(2);
  }
}

function runCheckDocs(root, trunkRef, releaseRefs, changedListPath) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // Every declared ref must be listable. A ref that is absent from the checkout
  // would otherwise narrow the resolution back to the remaining ones and fail a
  // PR for a path that is correct on the ref nobody fetched — #1574 all over
  // again, this time with nothing in the log to say so.
  const listTree = (ref) => {
    let entries;
    try {
      entries = git(root, ["ls-tree", "-r", "-t", "--name-only", ref]).split("\n").filter(Boolean);
    } catch (error) {
      process.stderr.write(
        `::error::watch-upstream-areas: could not list the upstream tree at "${ref}" in --root "${root}" (${error.message}). Treating as undecidable, not as "every path resolves".\n`,
      );
      process.exit(2);
    }
    if (entries.length === 0) {
      process.stderr.write(
        `::error::watch-upstream-areas: the upstream tree at "${ref}" is empty, so every path would "not exist". Undecidable.\n`,
      );
      process.exit(2);
    }
    return { ref, entries };
  };

  const trunk = listTree(trunkRef);
  const releases = releaseRefs.map(listTree);

  // An unreadable changed-file list is undecidable too: defaulting to "nothing
  // changed" would silently downgrade every finding to a warning, which is the
  // same fail-open the guard exists to remove.
  let changedFiles = [];
  if (changedListPath) {
    try {
      changedFiles = fs
        .readFileSync(changedListPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      process.stderr.write(
        `::error::watch-upstream-areas: could not read --changed "${changedListPath}" (${error.message}). Refusing to report a diff-scoped verdict without the diff.\n`,
      );
      process.exit(2);
    }
  }

  const docs = collectDocFiles(repoRoot);
  const { checked, failures, warnings, partial, exempt } = checkDocDeps({ docs, trunk, releases, changedFiles });

  const describe = (t) => `${t.ref} (${t.entries.length} tree entries)`;
  process.stdout.write(
    `Resolved ${checked} dependency path(s) from ${docs.length - exempt.length} doc(s) against ${describe(trunk)}` +
      (releases.length > 0 ? ` and the release line(s) ${releases.map(describe).join(", ")}` : "") +
      `; ${exempt.length} doc(s) exempt.\n`,
  );
  if (releases.length === 0) {
    process.stdout.write(
      "No release line given, so this run resolves against the trunk alone — which is what #1574 is about: the suite validates the nightly, not `main`.\n",
    );
  }
  if (!changedListPath) {
    process.stdout.write(
      "No --changed list given, so every finding is reported and none fails: the diff decides severity.\n",
    );
  }

  // The attribution half of #1574. Both classes resolve — one ref is enough — and
  // both are reported, because in each of them "green" is a fact about a ref that
  // is NOT the whole story.
  const named = partial.slice(0, MAX_NAMED_PARTIALS);
  if (partial.length > 0) {
    const releaseOnly = partial.filter((p) => p.class === "release-only").length;
    const trunkOnly = partial.length - releaseOnly;
    process.stdout.write(
      `\n${partial.length} path(s) resolve on only one side: ${releaseOnly} on a release line but not on ${trunk.ref}, ${trunkOnly} on ${trunk.ref} but on no release line.\n`,
    );
    for (const item of named) {
      process.stdout.write(
        `- ${item.file}:${item.line} \`${item.token}\` — resolves on ${item.resolvedOn.join(", ")}; absent from ${item.missingOn.join(", ")}` +
          (item.class === "trunk-only" ? ", so the image this suite tests does not carry it yet" : "") +
          "\n",
      );
    }
    if (partial.length > MAX_NAMED_PARTIALS) {
      process.stdout.write(`- …and ${partial.length - MAX_NAMED_PARTIALS} more, elided.\n`);
    }
    // Also as annotations: before #1574 a path that upstream deleted on `main`
    // while the release line kept it raised a `::warning::` and was visible in the
    // checks panel. It resolves now, correctly — but it must not become invisible
    // on the way, so it lands one severity down instead of disappearing (#1012).
    for (const item of named) {
      process.stderr.write(
        `::notice::${item.file}:${item.line} — dependency path \`${item.token}\` resolves on ${item.resolvedOn.join(", ")} but is absent from ${item.missingOn.join(", ")}.\n`,
      );
    }
    process.stdout.write(
      "\nA path resolving is a fact about a FILE existing, never about the code inside it — a file present on every ref can still carry the behaviour on only one.\n",
    );
  }

  for (const w of warnings) {
    process.stderr.write(
      `::warning::${w.file}:${w.line} — dependency path \`${w.token}\` ${w.reason}. Pre-existing (this PR did not touch the doc), so it is reported, not failed.\n`,
    );
  }
  for (const f of failures) {
    process.stderr.write(
      `::error::${f.file}:${f.line} — dependency path \`${f.token}\` ${f.reason}. This PR changed the doc, so the path must resolve on at least one of them (issue #1298, #1574).\n`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(
      `::error::${failures.length} dependency path(s) in doc(s) this PR changed resolve on none of ${[trunk, ...releases].map((t) => t.ref).join(", ")}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    warnings.length > 0
      ? `No unresolved dependency path in the changed docs; ${warnings.length} pre-existing one(s) reported above.\n`
      : "Every dependency path resolves on at least one of the refs above.\n",
  );
}

function runDetect(root, since) {
  let changed;
  let window;
  try {
    window = describeWindow(root, since);
    changed = detectChangedAreas({ commitsFor: commitsForFactory(root, since) });
  } catch (error) {
    process.stderr.write(
      `::error::watch-upstream-areas could not read the upstream history (${error.message}). Treating as undecidable, not as "nothing changed".\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `Window "${since}" selects ${window.count} upstream commit(s) repo-wide. Newest commit in the checkout: ${window.newest}\n`,
  );
  if (window.count === 0) {
    // Not a failure: upstream has genuinely quiet days (2026-07-19, 07-11/12).
    // But "0 areas changed" must not be the only thing the log says, or a wrong
    // window reads exactly like a quiet weekend.
    process.stderr.write(
      `::warning::the window selected NO upstream commits at all, so "0 areas changed" says nothing about the areas. Either upstream was quiet or the window is wrong for this checkout — compare it against the newest commit above.\n`,
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const body = renderIssueBody({ since, areas: changed, today, window });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `has_changes=${changed.length > 0}`,
        `window_commits=${window.count}`,
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

/** The area table as the same markdown the issue body prints — reviewable. */
function renderAreaTable() {
  return [
    "| Area | Run these tests | Checklist | Paths |",
    "|---|---|---|---|",
    ...AREAS.map(
      (a) =>
        `| ${cell(a.area)} | \`--grep "${cell(a.tags.join("|"))}"\` | ${cell(a.checklist)} | ${a.paths.length} |`,
    ),
    "",
    ...AREAS.flatMap((a) => [`### ${a.area}`, ...a.paths.map((p) => `- \`${p}\``), ""]),
  ].join("\n");
}

/**
 * `--releases` is a COMMA-SEPARATED list of the release lines to resolve against
 * alongside the trunk (#1574). `--ref` keeps its old meaning and shape — one
 * trunk ref — so a caller that passes only `--ref origin/main` gets exactly the
 * pre-#1574 behaviour, which is why the new capability is a new flag rather than
 * a new spelling of the old one.
 *
 * Order is preserved and duplicates dropped, because the order is what the
 * report prints and a ref named twice would read as two verdicts.
 *
 * A ref whose own name contains a comma is therefore inexpressible. git permits
 * one; upstream has never carried one, and the failure is loud rather than
 * silent — the two halves resolve to nothing and `runCheckDocs` exits 2 naming
 * them, which is the accepted outcome for a ref it cannot list.
 *
 * @param {string} value
 * @param {{allowEmpty?: boolean}} [options] an empty `--releases` is legitimate —
 *   it is the trunk-only run, announced as such — while an empty ref list where
 *   one is required would report every path as broken.
 * @returns {string[]}
 * @throws when the list holds no ref and `allowEmpty` is not set.
 */
export function parseRefList(value, { allowEmpty = false } = {}) {
  const refs = [];
  for (const part of String(value || "").split(",")) {
    const ref = part.trim();
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  if (refs.length === 0 && !allowEmpty) throw new Error(`"${value}" names no ref`);
  return refs;
}

/** `--flag value` and `--flag=value` both work — the mixed forms bit a reviewer. */
export function parseArgs(args) {
  const opts = { mode: "check", root: ".", since: "24 hours ago", ref: "HEAD", releases: "", changed: "" };
  const KEYS = new Set(["mode", "root", "since", "ref", "releases", "changed"]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!match || !KEYS.has(match[1])) throw new Error(`unknown argument ${a}`);
    const value = match[2] !== undefined ? match[2] : args[++i];
    if (value === undefined) throw new Error(`--${match[1]} needs a value`);
    opts[match[1]] = value;
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::watch-upstream-areas: ${error.message}\n`);
    process.exit(2);
  }
  const { mode, root, since, ref, releases, changed } = opts;

  if (mode === "areas") {
    process.stdout.write(`${renderAreaTable()}\n`);
    return;
  }
  if (mode !== "check" && mode !== "detect" && mode !== "check-docs" && mode !== "release-ref") {
    process.stderr.write(`::error::watch-upstream-areas: unknown mode "${mode}"\n`);
    process.exit(2);
  }
  // An unusable --root is "could not decide" (exit 2), never a table that
  // disagrees with the checkout (exit 1) — otherwise a typo'd path prints 88
  // missing-path errors instead of naming the real problem.
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`::error::watch-upstream-areas: --root "${root}" is not a directory.\n`);
    process.exit(2);
  }
  if (mode === "detect") {
    try {
      assertValidSince(since);
    } catch (error) {
      process.stderr.write(`::error::watch-upstream-areas: ${error.message}\n`);
      process.exit(2);
    }
  }

  let releaseRefs = [];
  if (mode === "check-docs") {
    try {
      releaseRefs = parseRefList(releases, { allowEmpty: true });
    } catch (error) {
      process.stderr.write(`::error::watch-upstream-areas: ${error.message}\n`);
      process.exit(2);
    }
  }

  try {
    if (mode === "check") return runCheck(root);
    if (mode === "release-ref") return runReleaseRef(root);
    if (mode === "check-docs") return runCheckDocs(root, ref, releaseRefs, changed);
    return runDetect(root, since);
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
