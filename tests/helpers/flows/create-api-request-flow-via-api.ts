import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";

/**
 * Builds a single-node **API Request** flow from the LIVE component catalog
 * (`GET /api/v1/all`) and creates it via the REST API.
 *
 * Why a live catalog instead of a committed fixture: the flow exists to prove
 * what Langflow's SSRF guard does with a given URL, and the guard is reached
 * only through the component's `url_input`. That field name — and the component's
 * catalog key — are exactly what upstream may rename; a frozen fixture would keep
 * creating a node the running image no longer understands and the spec would fail
 * (or, worse, run something else) without naming the cause.
 *
 * Why a single node with no edge: the API Request component is a graph ROOT and
 * runs on its own, so no Chat Output is needed to make it execute (measured on
 * 1.12.0.dev23/dev24 — `POST /api/v1/run/{id}` with `output_type: "debug"`
 * returns its vertex either way). Adding a second node would only add a surface
 * that can fail for reasons unrelated to the guard.
 */

/** Catalog key of the API Request component (category `data_source` on 1.12.x). */
export const API_REQUEST_COMPONENT_TYPE = "APIRequest";

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

export interface FlowData {
  nodes: FlowNode[];
  edges: never[];
  viewport: { x: number; y: number; zoom: number };
}

export interface BuildApiRequestFlowOptions {
  /** Node id given to the API Request node — also the `tweaks` key. */
  nodeId: string;
  /** The URL the component will fetch; the whole point of the flow. */
  url: string;
  /** HTTP verb. Defaults to `GET`. */
  method?: string;
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
 * randomness — so the field wiring and the failure mode are unit-testable.
 *
 * Both `url_input` and `method` must exist on the template: an upstream rename
 * would otherwise leave the node with the component's DEFAULT url, and the spec
 * would assert the guard's verdict on an address it never chose.
 */
export function buildApiRequestFlowData(
  catalog: Record<string, unknown>,
  { nodeId, url, method = "GET" }: BuildApiRequestFlowOptions,
): FlowData {
  const template = findComponentTemplate(catalog, API_REQUEST_COMPONENT_TYPE);

  for (const field of ["url_input", "method"]) {
    if (!(field in template.template)) {
      throw new Error(
        `The ${API_REQUEST_COMPONENT_TYPE} template on this instance has no "${field}" field ` +
          `(fields: ${Object.keys(template.template).join(", ")}). The component was renamed ` +
          "upstream — a flow built without it would run the component's default URL.",
      );
    }
  }

  template.template.url_input = { ...template.template.url_input, value: url };
  template.template.method = { ...template.template.method, value: method };

  return {
    nodes: [
      {
        id: nodeId,
        type: "genericNode",
        position: { x: 0, y: 0 },
        data: { id: nodeId, type: API_REQUEST_COMPONENT_TYPE, node: template },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export interface ApiRequestFlow {
  /** The created flow's id, for `POST /api/v1/run/{flow_id}` and teardown. */
  flowId: string;
  /** Node id of the API Request node. */
  nodeId: string;
  /** The URL the node will fetch. */
  url: string;
  /** Deletes the created flow. Safe to call in `afterAll`/`afterEach` with its own `request`. */
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/**
 * Creates the single-node API Request flow on the instance.
 *
 * `headers` carries the auth the caller already holds (`{ Authorization: bearer }`
 * or `{ "x-api-key": key }`); the same header is reused for the catalog read and
 * for teardown.
 *
 * The flow NAME deliberately carries no reference to the URL or to SSRF: the name
 * renders in `flow_name` in the editor, and the security spec asserts the guard's
 * message by text (the build-failure banner has no `data-testid`), so a name
 * containing "SSRF" would satisfy that assertion on its own.
 */
export async function createApiRequestFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  options: { url: string; method?: string },
): Promise<ApiRequestFlow> {
  const catalogRes = await request.get("/api/v1/all", { headers });
  if (!catalogRes.ok()) {
    throw new Error(
      `GET /api/v1/all answered ${catalogRes.status()} — cannot build the ` +
        "API Request flow without the component catalog.",
    );
  }
  const catalog = (await catalogRes.json()) as Record<string, unknown>;

  // Unique per call for the same reason as create-python-interpreter-flow-via-api:
  // Langflow's unique-name fallback is not transaction-safe under parallel
  // creation (#588).
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const nodeId = `${API_REQUEST_COMPONENT_TYPE}-${uniqueSuffix}`;

  const data = buildApiRequestFlowData(catalog, {
    nodeId,
    url: options.url,
    method: options.method,
  });

  const flowId = await createFlow(
    request,
    {
      name: `URL Fetch Flow ${uniqueSuffix}`,
      description: "Single API Request node for URL-validation API tests",
      data,
      is_component: false,
    },
    { headers },
  );

  return {
    flowId,
    nodeId,
    url: options.url,
    // `reqOverride` exists for the same fixture-scope rule as the sibling
    // helpers: a `beforeAll` request cannot be reused inside `afterAll`.
    deleteFlow: async (reqOverride?: APIRequestContext) => {
      await deleteFlow(reqOverride ?? request, flowId, { headers });
    },
  };
}
