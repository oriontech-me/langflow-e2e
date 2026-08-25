import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";

/**
 * Builds a runnable `Python Interpreter -> Chat Output` flow from the LIVE
 * component catalog (`GET /api/v1/all`) and creates it via the REST API.
 *
 * Why a live catalog instead of a committed fixture: this flow exists to prove
 * that the Tweaks API refuses to overwrite a code-execution component's
 * executable fields (`python_code`, `global_imports`). Those field names and the
 * component's output shape are exactly what upstream may rename — a frozen
 * fixture would keep testing the old shape and stay green while the guard it
 * covers no longer applies to anything the image ships. Building the node from
 * the running instance turns that drift into a real failure.
 *
 * Why an edge is required: a Langflow vertex only runs when it is reachable from
 * the graph's entry point. A two-node flow with no edge answers 200 with the
 * unreachable vertex simply absent from `outputs` (measured on 1.12.0.dev23), so
 * a spec asserting "the interpreter still ran the author's code" would pass
 * while asserting nothing at all.
 */

/** Catalog key of the Python Interpreter (`CODE_EXECUTION_COMPONENT_TYPES` member). */
export const PYTHON_INTERPRETER_COMPONENT_TYPE = "PythonREPLComponent";

/** Catalog key of the Chat Output that renders the interpreter's `Data`. */
export const CHAT_OUTPUT_COMPONENT_TYPE = "ChatOutput";

/** The interpreter's default `python_code`, kept only as documentation of the shape. */
export const DEFAULT_AUTHOR_CODE = 'print("AUTHOR")';

interface TemplateField {
  type?: string;
  value?: unknown;
  input_types?: string[];
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
  data: { sourceHandle: Record<string, unknown>; targetHandle: Record<string, unknown> };
  id: string;
  selected: boolean;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface FlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface BuildPythonInterpreterFlowOptions {
  /** Node id given to the Python Interpreter — also the `tweaks` key. */
  pythonNodeId: string;
  /** Node id given to the Chat Output — also the `tweaks` key. */
  chatOutputNodeId: string;
  /** The code the flow AUTHOR stores; a refused tweak must leave this running. */
  authorCode: string;
}

/**
 * Langflow serializes edge handles as JSON with every `"` replaced by `œ`
 * (`scapedJSONStringfy` in the frontend). The backend reads these strings, so
 * they must be produced in the same encoding — not as plain JSON.
 */
export function escapeHandle(handle: Record<string, unknown>): string {
  return JSON.stringify(handle).replace(/"/g, "œ");
}

/** Inverse of {@link escapeHandle}; used by the unit tests to read an edge back. */
export function unescapeHandle(handle: string): Record<string, never> &
  Record<string, unknown> {
  return JSON.parse(handle.replace(/œ/g, '"'));
}

/**
 * Finds a component template in a `GET /api/v1/all` payload, whose top level is
 * `category -> { componentType: template }`.
 *
 * Throws naming the component when it is absent: the image may not ship its
 * distribution (`docs/component-distribution-policy.md`), and an undefined
 * template reaching `POST /api/v1/flows/` surfaces as an unattributable 422.
 */
function findComponentTemplate(
  catalog: Record<string, unknown>,
  componentType: string,
): ComponentTemplate {
  for (const category of Object.values(catalog)) {
    if (!category || typeof category !== "object") continue;
    const entry = (category as Record<string, unknown>)[componentType];
    if (entry && typeof entry === "object" && "template" in entry) {
      // Deep copy: the caller fetches the catalog once and may build several
      // flows from it, and every build mutates field values.
      return JSON.parse(JSON.stringify(entry)) as ComponentTemplate;
    }
  }

  throw new Error(
    `Component "${componentType}" is not present in GET /api/v1/all on this instance. ` +
      "Either the image does not ship its distribution, or the response was not a component catalog " +
      "(an auth failure answers with a `detail` body). See docs/component-distribution-policy.md.",
  );
}

/**
 * Turns a live catalog into the flow payload. Pure — no network, no clock, no
 * randomness — so the edge encoding and the failure mode are unit-testable.
 */
export function buildPythonInterpreterFlowData(
  catalog: Record<string, unknown>,
  { pythonNodeId, chatOutputNodeId, authorCode }: BuildPythonInterpreterFlowOptions,
): FlowData {
  const pythonTemplate = findComponentTemplate(
    catalog,
    PYTHON_INTERPRETER_COMPONENT_TYPE,
  );
  const chatOutputTemplate = findComponentTemplate(
    catalog,
    CHAT_OUTPUT_COMPONENT_TYPE,
  );

  pythonTemplate.template.python_code = {
    ...pythonTemplate.template.python_code,
    value: authorCode,
  };

  const node = (
    id: string,
    type: string,
    template: ComponentTemplate,
    x: number,
  ): FlowNode => ({
    id,
    type: "genericNode",
    position: { x, y: 0 },
    data: { id, type, node: template },
  });

  const sourceHandle = {
    dataType: PYTHON_INTERPRETER_COMPONENT_TYPE,
    id: pythonNodeId,
    name: "results",
    output_types: ["Data"],
  };
  const chatOutputInput = chatOutputTemplate.template.input_value ?? {};
  const targetHandle = {
    fieldName: "input_value",
    id: chatOutputNodeId,
    inputTypes: chatOutputInput.input_types ?? [],
    type: chatOutputInput.type ?? "str",
  };

  const edge: FlowEdge = {
    animated: false,
    className: "",
    data: { sourceHandle, targetHandle },
    id:
      `reactflow__edge-${pythonNodeId}${escapeHandle(sourceHandle)}` +
      `-${chatOutputNodeId}${escapeHandle(targetHandle)}`,
    selected: false,
    source: pythonNodeId,
    sourceHandle: escapeHandle(sourceHandle),
    target: chatOutputNodeId,
    targetHandle: escapeHandle(targetHandle),
  };

  return {
    nodes: [
      node(pythonNodeId, PYTHON_INTERPRETER_COMPONENT_TYPE, pythonTemplate, 0),
      node(chatOutputNodeId, CHAT_OUTPUT_COMPONENT_TYPE, chatOutputTemplate, 500),
    ],
    edges: [edge],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export interface PythonInterpreterFlow {
  /** The created flow's id, for `POST /api/v1/run/{flow_id}`. */
  flowId: string;
  /** Node id of the Python Interpreter — use as the `tweaks` key. */
  pythonNodeId: string;
  /** Node id of the Chat Output — use as the `tweaks` key. */
  chatOutputNodeId: string;
  /** The code stored by the flow author, echoed by a run the tweaks did not alter. */
  authorCode: string;
  /** Deletes the created flow. Safe to call in `afterAll` with its own `request`. */
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/**
 * Creates the `Python Interpreter -> Chat Output` flow on the instance.
 *
 * `headers` carries the auth the caller already holds (`{ Authorization: bearer }`
 * or `{ "x-api-key": key }`); the same header is reused for the catalog read and
 * for teardown.
 *
 * Note the instance must run with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` for the
 * interpreter to execute at all (`ensure_code_execution_enabled`,
 * GHSA-8qpj-27x8-pwpq) — with it off the flow builds but produces no author
 * output, which a caller asserting on that output will surface immediately.
 */
export async function createPythonInterpreterFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  options: { authorCode?: string } = {},
): Promise<PythonInterpreterFlow> {
  const authorCode = options.authorCode ?? DEFAULT_AUTHOR_CODE;

  const catalogRes = await request.get("/api/v1/all", { headers });
  if (!catalogRes.ok()) {
    throw new Error(
      `GET /api/v1/all answered ${catalogRes.status()} — cannot build the ` +
        "Python Interpreter flow without the component catalog.",
    );
  }
  const catalog = (await catalogRes.json()) as Record<string, unknown>;

  // Unique per call for the same reason as create-runnable-chat-flow-via-api:
  // Langflow's unique-name fallback is not transaction-safe under parallel
  // creation (#588). The node ids are unique too so a tweaks key can never
  // address a node from another flow.
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pythonNodeId = `${PYTHON_INTERPRETER_COMPONENT_TYPE}-${uniqueSuffix}`;
  const chatOutputNodeId = `${CHAT_OUTPUT_COMPONENT_TYPE}-${uniqueSuffix}`;

  const data = buildPythonInterpreterFlowData(catalog, {
    pythonNodeId,
    chatOutputNodeId,
    authorCode,
  });

  const flowId = await createFlow(
    request,
    {
      name: `Python Interpreter Flow ${uniqueSuffix}`,
      description:
        "Python Interpreter -> Chat Output for tweaks-injection API tests",
      data,
      is_component: false,
    },
    { headers },
  );

  return {
    flowId,
    pythonNodeId,
    chatOutputNodeId,
    authorCode,
    // `reqOverride` exists for the same fixture-scope rule as the chat-flow
    // helper: a `beforeAll` request cannot be reused inside `afterAll`.
    deleteFlow: async (reqOverride?: APIRequestContext) => {
      await deleteFlow(reqOverride ?? request, flowId, { headers });
    },
  };
}
