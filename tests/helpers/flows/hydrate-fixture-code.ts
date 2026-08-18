// Fixture component-code hydration (#1478).
//
// A fixture flow under tests/assets/flows/ stores a FROZEN copy of each
// component's Python source in `node.data.node.template.code.value`, captured
// on whatever image the fixture was recorded against. Langflow EXECS that copy
// (lfx/custom/validate.py: prepare_global_scope -> create_class), not the
// installed component — so a fixture is a dependency on one specific build.
//
// On 2026-08-18 upstream commit 99ea9044f (PR #14413, release-1.12.0 — the line
// the nightly is cut from) deleted `load_kb_metadata` from `_kb_paths`. The
// frozen copy still imported it, `Graph.from_payload` raised ImportError, the
// graph was never built, and two @stable specs waited the full 90s for a
// duration badge that could not exist.
//
// Dropping the field is NOT an option and the measurement is recorded so nobody
// re-derives it: `POST /api/v1/flows/` accepts a payload with no `code` and does
// not repopulate it, and the graph build then fails with
// `Error while creating graph from payload: 'code'` — a message that names
// nothing. `code` is required; what has to change is WHERE its value comes from.
//
// This module is the pure half: given the flow data and a `type -> code` index
// built from the running image, it returns a cloned payload with the code
// replaced plus a report of what it did. It performs no I/O and never decides
// policy — an absent component type is REPORTED, and the caller
// (`load-fixture-flow.ts`) is what turns that into a thrown error.
//
// It replaces the stored source of EVERY node in the fixture, not just the
// one the spec exercises. That is safe for a stock catalog component: its
// code is an installed artifact identical across every flow using that type,
// so hydrating it only re-syncs a frozen copy with the image it will actually
// run on. It is NOT safe for a component whose stored code is the thing under
// test — a `CustomComponent` node's `code` IS the spec's subject, and
// hydrating it would silently replace that authored behaviour with the empty
// template, making the spec pass having verified nothing. `AUTHORED_CODE_TYPES`
// below is the refusal for that case.

export type CodeIndex = Record<string, string>;

/** Component types whose stored code is authored by the test, not installed
 * by the image. Hydrating one of these would replace the behaviour under
 * test — this module refuses instead. Extending this set (e.g. to cover a
 * fixture with a `CustomComponent` node) is the migration follow-up's
 * decision, not something this helper works around on its own. */
export const AUTHORED_CODE_TYPES: ReadonlySet<string> = new Set([
  "CustomComponent",
]);

export interface TemplateField {
  value?: unknown;
  options?: unknown[];
  [key: string]: unknown;
}

interface FixtureNode {
  id: string;
  data?: {
    type?: string;
    node?: { template?: Record<string, TemplateField | undefined> };
  };
}

export interface FlowData {
  nodes: FixtureNode[];
  [key: string]: unknown;
}

export interface HydrationReport {
  data: FlowData;
  /** Node ids whose stored code differed from the image's and was replaced. */
  hydrated: string[];
  /** Node ids whose stored code already matched the image's. */
  unchanged: string[];
  /** Node ids carrying no `template.code` — not a drift signal, but counted. */
  skipped: string[];
  /** Component types absent from the index, deduped and sorted. */
  missing: string[];
}

/**
 * Replaces every node's stored component source with the image's, returning a
 * NEW payload plus the report.
 *
 * When any component type is absent from the index, NOTHING is rewritten: a
 * half-hydrated payload would be created successfully and then fail at graph
 * build, with a cause this function already knew. The caller inspects
 * `missing` and refuses before creating the flow.
 */
export function hydrateFixtureCode(
  data: unknown,
  index: CodeIndex,
): HydrationReport {
  const source = data as FlowData | undefined;
  if (!source || !Array.isArray(source.nodes)) {
    throw new Error(
      "hydrateFixtureCode: flow data has no `nodes` array — not a fixture payload",
    );
  }

  const clone = structuredClone(source) as FlowData;
  const hydrated: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const missing = new Set<string>();

  for (const node of clone.nodes) {
    const code = node.data?.node?.template?.code;
    if (!code || typeof code.value !== "string") {
      skipped.push(node.id);
      continue;
    }
    const type = node.data?.type;
    if (type && AUTHORED_CODE_TYPES.has(type)) {
      throw new Error(
        `hydrateFixtureCode: node ${node.id} is a ${type} — its stored code is ` +
          `authored by the test, not installed by the image, and hydrating it ` +
          `would silently replace the behaviour under test. This helper cannot ` +
          `hydrate authored code; the migration must decide how to handle it.`,
      );
    }
    if (!type || !Object.hasOwn(index, type)) {
      missing.add(type ?? `<node ${node.id} has no data.type>`);
      continue;
    }
    if (code.value === index[type]) {
      unchanged.push(node.id);
      continue;
    }
    hydrated.push(node.id);
  }

  // Any missing type poisons the whole payload — return the ORIGINAL values.
  if (missing.size > 0) {
    return {
      data: structuredClone(source) as FlowData,
      hydrated: [],
      unchanged: [],
      skipped,
      missing: [...missing].sort(),
    };
  }

  for (const node of clone.nodes) {
    const code = node.data?.node?.template?.code;
    const type = node.data?.type;
    if (code && typeof code.value === "string" && type) {
      code.value = index[type];
    }
  }

  return { data: clone, hydrated, unchanged, skipped, missing: [] };
}

/** One always-emitted line per fixture, in the shape of the catalog-drift report. */
export function formatHydrationReport(
  fixtureName: string,
  report: HydrationReport,
): string {
  const total =
    report.hydrated.length + report.unchanged.length + report.skipped.length;
  if (report.hydrated.length === 0) {
    const noun = total === 1 ? "node" : "nodes";
    let msg = `all ${total} ${noun} already current`;
    if (report.skipped.length > 0) {
      msg += ` (${report.skipped.length} without code field)`;
    }
    return `[fixture] ${fixtureName} — ${msg}`;
  }
  const parts = [`hydrated: ${report.hydrated.join(", ")}`];
  if (report.unchanged.length > 0) {
    parts.push(`unchanged: ${report.unchanged.join(", ")}`);
  }
  if (report.skipped.length > 0) {
    parts.push(`no code field: ${report.skipped.join(", ")}`);
  }
  return `[fixture] ${fixtureName} — ${parts.join(" · ")}`;
}
