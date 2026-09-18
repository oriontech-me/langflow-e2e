import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";
import { escapeHandle } from "./create-python-interpreter-flow-via-api";

/**
 * Builds an arbitrary `CustomComponent` graph as a `POST /api/v1/flows/` payload,
 * so a spec can drive the **graph-execution engine's** contract (order, partial
 * failure, skipped branches, cycles) with the graph SHAPE as the only variable
 * and no provider key (issue #1896, `docs/api/flows/graph-execution-contract.md`).
 *
 * Each node is one `CustomComponent` whose Python body fixes its behavior:
 *   - `echo`  — returns its inputs joined with its own tag, optionally after a
 *               `time.sleep(delayS)`, so a scheduling regression is observable.
 *   - `raise` — `raise ValueError`, to provoke a branch failure on purpose.
 *   - `stop`  — `self.stop("output")`, the mechanism `If-Else` uses to inactivate
 *               a downstream branch.
 *
 * Generalized from `create-secret-edge-flow-via-api.ts`, and it carries the two
 * traps that helper records:
 *   - the stock template declares `types: ["JSON"]`; the output must be set to
 *     `Message` or every edge fails with `has no matched type`;
 *   - each node needs a distinct `display_name`, because a canvas/run testid is
 *     derived from it and would otherwise collide.
 *
 * The instance must run with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (#668/#746);
 * with it off the catalog omits `CustomComponent` and `findComponentTemplate`
 * throws naming the cause.
 */

/** Catalog key of the component every node is built from. */
export const CUSTOM_COMPONENT_TYPE = "CustomComponent";

export type NodeKind = "echo" | "raise" | "stop";

export interface NodeSpec {
  /** Stable node id AND display name; run events are keyed by it. */
  id: string;
  kind: NodeKind;
  /** Input field names the node receives edges on (echo joins them in order). */
  fields?: string[];
  /** Seconds an `echo` node sleeps before returning (default 0). */
  delayS?: number;
}

export interface EdgeSpec {
  source: string;
  target: string;
  /** The target input field this edge lands on (must be in the target's fields). */
  field: string;
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

interface TemplateField {
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

interface ComponentTemplate {
  template: Record<string, TemplateField>;
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { id: string; type: string; node: ComponentTemplate };
}

export interface FlowEdge {
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

export interface FlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

const CODE_HEADER =
  "from lfx.custom.custom_component.component import Component\n" +
  "from lfx.io import MessageTextInput, Output\n" +
  "from lfx.schema.message import Message\n" +
  "import time\n\n\n";

/** The Python source for one node, fixed by its kind. */
export function componentCode(node: NodeSpec): string {
  const fields = node.fields ?? [];
  const inputs = fields
    .map((f) => `        MessageTextInput(name="${f}", display_name="${f}", required=False),\n`)
    .join("");
  const collected = fields.map((f) => `(self.${f} or "")`).join(", ");

  let body: string;
  if (node.kind === "echo") {
    body =
      `        time.sleep(${node.delayS ?? 0})\n` +
      `        got = [${collected}]\n` +
      `        return Message(text="|".join([g for g in got if g] + ["${node.id}"]))\n`;
  } else if (node.kind === "raise") {
    body = `        raise ValueError("boom-${node.id}")\n`;
  } else if (node.kind === "stop") {
    body = '        self.stop("output")\n        return Message(text="")\n';
  } else {
    throw new Error(`unknown node kind: ${node.kind as string}`);
  }

  return (
    CODE_HEADER +
    "class CustomComponent(Component):\n" +
    `    display_name = "${node.id}"\n` +
    `    description = "graph-execution probe ${node.kind} ${node.id}"\n` +
    '    icon = "code"\n' +
    '    name = "CustomComponent"\n\n' +
    "    inputs = [\n" +
    inputs +
    "    ]\n\n" +
    "    outputs = [\n" +
    '        Output(display_name="Output", name="output", method="build_output"),\n' +
    "    ]\n\n" +
    "    def build_output(self) -> Message:\n" +
    body
  );
}

/**
 * The output declaration every node needs. The stock template says
 * `types: ["JSON"]`, and pasting code does not change it over the API, so the
 * edge type must be set to `Message` here.
 */
function messageOutput(): Record<string, unknown> {
  return {
    allows_loop: false,
    cache: true,
    display_name: "Output",
    group_outputs: false,
    method: "build_output",
    name: "output",
    selected: "Message",
    tool_mode: true,
    types: ["Message"],
    value: "__UNDEFINED__",
  };
}

function inputField(name: string): TemplateField {
  return {
    type: "str",
    value: "",
    name,
    display_name: name,
    required: false,
    _input_type: "MessageTextInput",
    input_types: ["Message"],
    show: true,
    advanced: false,
    list: false,
  };
}

/**
 * Finds the `CustomComponent` template in a `GET /api/v1/all` body, whose top
 * level is `category -> { componentType: template }`. Throws naming the cause
 * when it is absent — with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` the catalog
 * omits it and an undefined template reaching `POST /api/v1/flows/` surfaces as
 * an unattributable 422.
 */
export function findComponentTemplate(catalog: Record<string, unknown>): ComponentTemplate {
  for (const category of Object.values(catalog)) {
    if (!category || typeof category !== "object") continue;
    const entry = (category as Record<string, unknown>)[CUSTOM_COMPONENT_TYPE];
    if (entry && typeof entry === "object" && "template" in entry) {
      // Deep-copy per node: each node mutates its own code/fields, and sharing
      // one object would cross-contaminate the graph.
      return JSON.parse(JSON.stringify(entry)) as ComponentTemplate;
    }
  }
  throw new Error(
    `Component "${CUSTOM_COMPONENT_TYPE}" is not present in GET /api/v1/all on this instance. ` +
      "The image ships LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false, which hides it and makes " +
      "POST /api/v1/custom_component answer 403 (#668/#746) — start the instance with it true.",
  );
}

function makeNode(catalog: Record<string, unknown>, node: NodeSpec, index: number): FlowNode {
  const template = findComponentTemplate(catalog);
  template.template.code = { ...template.template.code, value: componentCode(node) };
  for (const f of node.fields ?? []) {
    template.template[f] = inputField(f);
  }
  template.outputs = [messageOutput()];
  template.display_name = node.id;
  return {
    id: node.id,
    type: "genericNode",
    // Spread nodes so a canvas open (debugging) does not stack them.
    position: { x: 80 + (index % 3) * 420, y: 80 + Math.floor(index / 3) * 360 },
    data: { id: node.id, type: CUSTOM_COMPONENT_TYPE, node: template },
  };
}

function makeEdge(edge: EdgeSpec): FlowEdge {
  const sourceHandle = {
    dataType: CUSTOM_COMPONENT_TYPE,
    id: edge.source,
    name: "output",
    output_types: ["Message"],
  };
  const targetHandle = {
    fieldName: edge.field,
    id: edge.target,
    inputTypes: ["Message"],
    type: "str",
  };
  const escapedSource = escapeHandle(sourceHandle);
  const escapedTarget = escapeHandle(targetHandle);
  return {
    animated: false,
    className: "",
    selected: false,
    id: `reactflow__edge-${edge.source}${escapedSource}-${edge.target}${escapedTarget}`,
    source: edge.source,
    target: edge.target,
    // Both forms are sent and must agree: the backend parses the STRINGS, the
    // frontend reads `data`. A divergence builds one graph and reasons about another.
    sourceHandle: escapedSource,
    targetHandle: escapedTarget,
    data: { sourceHandle, targetHandle },
  };
}

/**
 * Turns a live catalog and a graph spec into a flow payload. Pure — no network,
 * no clock, no randomness — so the wiring and both traps are unit-testable.
 */
export function buildCustomComponentGraph(
  catalog: Record<string, unknown>,
  spec: GraphSpec,
): FlowData {
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) {
      throw new Error(`duplicate node id in graph spec: ${node.id}`);
    }
    ids.add(node.id);
  }
  for (const edge of spec.edges) {
    if (!ids.has(edge.source)) throw new Error(`edge source not a node: ${edge.source}`);
    if (!ids.has(edge.target)) throw new Error(`edge target not a node: ${edge.target}`);
    const target = spec.nodes.find((n) => n.id === edge.target)!;
    if (!(target.fields ?? []).includes(edge.field)) {
      throw new Error(`edge field "${edge.field}" is not an input of node ${edge.target}`);
    }
  }
  return {
    nodes: spec.nodes.map((node, i) => makeNode(catalog, node, i)),
    edges: spec.edges.map(makeEdge),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** Fetches the live component catalog. Separate so a caller can fetch once. */
export async function fetchComponentCatalog(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await request.get("/api/v1/all", { headers });
  if (!res.ok()) {
    throw new Error(`GET /api/v1/all -> ${res.status()} while fetching the component catalog`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export interface GraphFlow {
  flowId: string;
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/**
 * Creates a `CustomComponent` graph flow over the API and returns its id plus an
 * id-scoped cleanup, mirroring the other `*-via-api` helpers.
 */
export async function createCustomComponentGraphFlow(
  request: APIRequestContext,
  catalog: Record<string, unknown>,
  spec: GraphSpec,
  options: { name: string; headers: Record<string, string> },
): Promise<GraphFlow> {
  const data = buildCustomComponentGraph(catalog, spec);
  const flowId = await createFlow(
    request,
    { name: options.name, data, is_component: false },
    { headers: options.headers },
  );
  return {
    flowId,
    deleteFlow: (reqOverride?: APIRequestContext) =>
      deleteFlow(reqOverride ?? request, flowId, { headers: options.headers }),
  };
}
