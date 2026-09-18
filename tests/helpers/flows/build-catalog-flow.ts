import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { escapeHandle } from "./create-python-interpreter-flow-via-api";

export { fetchComponentCatalog } from "./build-custom-component-graph";

/**
 * Builds a `POST /api/v1/flows/` payload out of **built-in** components taken from
 * the live `GET /api/v1/all` catalog, so a spec can open a known graph on the canvas
 * without dragging nodes and clicking handles (issue #1911). The canvas setup is then
 * deterministic and the spec's steps are about its subject, not about the sidebar.
 *
 * Components come from the running image, never from a committed asset, so their code
 * is current and the canvas shows no "Update ready" banner. The builder encodes what
 * the canvas does to a graph it loads, measured on `1.13.0.dev16`:
 *
 *   - **Ungrouped outputs show one at a time.** A component whose outputs are not
 *     `group_outputs` (Create List: `list` / `dataframe`) displays only its
 *     `selected_output` — the first one when none is set — and the canvas DELETES an
 *     edge leaving from a hidden output in its first autosave. So an edge from any
 *     output other than the visible one throws, naming the `selectedOutput` to set.
 *   - **A loop feedback edge targets an OUTPUT.** The Loop's `item` output accepts
 *     the body's result back (`allows_loop`); the target handle is the output's, and
 *     it advertises the output's `types` plus its `loop_types`.
 *   - **Both handle forms are sent and must agree.** The backend parses the escaped
 *     strings, the canvas reads `data`; a divergence builds one graph and reasons about
 *     another (same rule as `build-custom-component-graph.ts`).
 *
 * Every lookup that can miss throws naming the component, node and field — a renamed
 * field or a dropped component surfaces here, not as an unattributable 422 or as a
 * canvas that silently lost an edge.
 */

export interface CatalogField {
  type?: string;
  value?: unknown;
  input_types?: string[];
  [key: string]: unknown;
}

export interface CatalogOutput {
  name: string;
  types: string[];
  allows_loop?: boolean;
  loop_types?: string[];
  group_outputs?: boolean;
  [key: string]: unknown;
}

export interface CatalogComponent {
  display_name?: string;
  outputs: CatalogOutput[];
  template: Record<string, CatalogField>;
  [key: string]: unknown;
}

export interface CatalogNodeSpec {
  /** Node id. Output-inspection dialogs are keyed by it (`<id>-message-output-modal`). */
  id: string;
  /** Catalog key, e.g. `ConditionalRouter`, `Prompt Template`, `LoopComponent`. */
  type: string;
  /** Canvas testids derive from it (`button_run_<lowercased name>`, `node_duration_…`). */
  displayName?: string;
  /** Template field values, by field name. */
  values?: Record<string, unknown>;
  /** The output an ungrouped multi-output component shows (and can connect from). */
  selectedOutput?: string;
  /** Component-specific edits on this node's own copy, applied before edges are typed. */
  configure?: (component: CatalogComponent) => void;
}

export interface CatalogEdgeSpec {
  source: string;
  output: string;
  target: string;
  /** An input field of the target… */
  field?: string;
  /** …or an output of the target that accepts a loop feedback edge. */
  loopOutput?: string;
}

export interface CatalogFlowSpec {
  nodes: CatalogNodeSpec[];
  edges: CatalogEdgeSpec[];
}

export interface CatalogFlowNode {
  id: string;
  type: "genericNode";
  position: { x: number; y: number };
  data: { id: string; type: string; node: CatalogComponent; selected_output?: string };
}

export interface CatalogFlowEdge {
  animated: boolean;
  className: string;
  selected: boolean;
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  data: { sourceHandle: Record<string, unknown>; targetHandle: Record<string, unknown> };
}

export interface CatalogFlowData {
  nodes: CatalogFlowNode[];
  edges: CatalogFlowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

/**
 * A deep copy of the catalog entry for `type`, from whichever category holds it.
 * Entries without a `template` are skipped, which is what keeps the
 * `component_display_names` metadata map (string values) from matching.
 */
export function findCatalogComponent(
  catalog: Record<string, unknown>,
  type: string,
): CatalogComponent {
  for (const category of Object.values(catalog)) {
    if (!category || typeof category !== "object") continue;
    const entry = (category as Record<string, unknown>)[type];
    if (entry && typeof entry === "object" && "template" in entry) {
      return JSON.parse(JSON.stringify(entry)) as CatalogComponent;
    }
  }
  throw new Error(
    `Component "${type}" is not in GET /api/v1/all on this instance — the image may not ` +
      "ship its distribution (docs/component-distribution-policy.md).",
  );
}

function isField(value: unknown): value is CatalogField {
  return !!value && typeof value === "object";
}

/** The one output an ungrouped multi-output node shows on the canvas; null when all show. */
function visibleOutput(node: CatalogFlowNode): string | null {
  const outputs = node.data.node.outputs;
  if (outputs.length < 2 || outputs.every((o) => o.group_outputs === true)) return null;
  return node.data.selected_output ?? outputs[0].name;
}

function makeNode(catalog: Record<string, unknown>, spec: CatalogNodeSpec, index: number): CatalogFlowNode {
  const component = findCatalogComponent(catalog, spec.type);
  if (spec.displayName) component.display_name = spec.displayName;
  for (const [name, value] of Object.entries(spec.values ?? {})) {
    const field = component.template[name];
    if (!isField(field)) {
      throw new Error(`${spec.type} "${spec.id}" has no field "${name}"`);
    }
    field.value = value;
  }
  spec.configure?.(component);
  if (spec.selectedOutput !== undefined && !component.outputs.some((o) => o.name === spec.selectedOutput)) {
    throw new Error(`${spec.type} "${spec.id}" has no output "${spec.selectedOutput}" to select`);
  }
  return {
    id: spec.id,
    type: "genericNode",
    // Spread apart so an opened canvas does not stack the nodes.
    position: { x: 80 + (index % 3) * 460, y: 80 + Math.floor(index / 3) * 420 },
    data: {
      id: spec.id,
      type: spec.type,
      node: component,
      ...(spec.selectedOutput !== undefined ? { selected_output: spec.selectedOutput } : {}),
    },
  };
}

function makeEdge(nodes: CatalogFlowNode[], spec: CatalogEdgeSpec): CatalogFlowEdge {
  const source = nodes.find((n) => n.id === spec.source);
  if (!source) throw new Error(`edge source is not a node: ${spec.source}`);
  const target = nodes.find((n) => n.id === spec.target);
  if (!target) throw new Error(`edge target is not a node: ${spec.target}`);
  if ((spec.field === undefined) === (spec.loopOutput === undefined)) {
    throw new Error(
      `edge ${spec.source}.${spec.output} -> ${spec.target} must name exactly one of field and loopOutput`,
    );
  }

  const output = source.data.node.outputs.find((o) => o.name === spec.output);
  if (!output) throw new Error(`"${spec.source}" has no output "${spec.output}"`);
  const visible = visibleOutput(source);
  if (visible !== null && visible !== spec.output) {
    throw new Error(
      `"${spec.source}" shows only its selected output "${visible}" on the canvas, which ` +
        `drops an edge from "${spec.output}" — set selectedOutput: "${spec.output}"`,
    );
  }

  let targetHandle: Record<string, unknown>;
  let accepted: string[];
  let targetName: string;
  if (spec.field !== undefined) {
    targetName = spec.field;
    const field = target.data.node.template[spec.field];
    if (!isField(field)) throw new Error(`"${spec.target}" has no field "${spec.field}"`);
    accepted = field.input_types ?? [];
    if (accepted.length === 0) {
      throw new Error(`"${spec.target}".${spec.field} accepts no connection`);
    }
    targetHandle = { fieldName: spec.field, id: spec.target, inputTypes: accepted, type: field.type };
  } else {
    targetName = spec.loopOutput!;
    const loop = target.data.node.outputs.find((o) => o.name === spec.loopOutput);
    if (!loop) throw new Error(`"${spec.target}" has no output "${spec.loopOutput}"`);
    if (!loop.allows_loop) {
      throw new Error(`output "${spec.loopOutput}" of "${spec.target}" does not accept a loop feedback edge`);
    }
    accepted = [...loop.types, ...(loop.loop_types ?? [])];
    targetHandle = { dataType: target.data.type, id: spec.target, name: spec.loopOutput, output_types: accepted };
  }

  if (!output.types.some((t) => accepted.includes(t))) {
    throw new Error(
      `"${spec.source}".${spec.output} emits [${output.types.join(", ")}] but ` +
        `"${spec.target}".${targetName} accepts [${accepted.join(", ")}]`,
    );
  }

  const sourceHandle = {
    dataType: source.data.type,
    id: spec.source,
    name: spec.output,
    output_types: output.types,
  };
  const escapedSource = escapeHandle(sourceHandle);
  const escapedTarget = escapeHandle(targetHandle);
  return {
    animated: false,
    className: "",
    selected: false,
    id: `reactflow__edge-${spec.source}${escapedSource}-${spec.target}${escapedTarget}`,
    source: spec.source,
    target: spec.target,
    sourceHandle: escapedSource,
    targetHandle: escapedTarget,
    data: { sourceHandle, targetHandle },
  };
}

/**
 * Turns a live catalog and a graph spec into a flow payload. Pure — no network, no
 * clock, no randomness — so every trap above is unit-testable.
 */
export function buildCatalogFlow(
  catalog: Record<string, unknown>,
  spec: CatalogFlowSpec,
): CatalogFlowData {
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  const nodes = spec.nodes.map((node, i) => makeNode(catalog, node, i));
  return {
    nodes,
    edges: spec.edges.map((edge) => makeEdge(nodes, edge)),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * Creates the flow over the API and returns its id. Deleting it is the caller's job,
 * id-scoped (`deleteFlow`), like every other `*-via-api` helper.
 */
export async function createCatalogFlow(
  request: APIRequestContext,
  catalog: Record<string, unknown>,
  spec: CatalogFlowSpec,
  options: { name: string; headers: Record<string, string> },
): Promise<string> {
  return createFlow(
    request,
    { name: options.name, data: buildCatalogFlow(catalog, spec), is_component: false },
    { headers: options.headers },
  );
}
