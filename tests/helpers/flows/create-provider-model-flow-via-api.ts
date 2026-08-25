import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";

/**
 * Builds a single-node **model-provider** flow from the LIVE component catalog
 * (`GET /api/v1/all`) and creates it via the REST API.
 *
 * Sibling of `create-api-request-flow-via-api.ts` and built from its skeleton, for
 * the same two reasons. A live catalog rather than a committed fixture, because
 * the flow exists to prove what the SSRF policy does with a given base URL and
 * the policy is reached only through the component's base-URL field — the field
 * name and the catalog key are exactly what upstream may rename, and a frozen
 * fixture would keep creating a node the running image no longer understands. A
 * single node with no edge, because the provider model components accept
 * `input_value` directly and run as a graph root, so a second node would only add
 * a surface that can fail for reasons unrelated to the guard.
 *
 * The deviation from that sibling is the whole point of the helper: **two
 * components name the base-URL field differently**, and `langflow-ai/langflow`
 * #14704 exists because a per-component fix missed a call site. So the component
 * under test is a record rather than a constant.
 */

/** A model-provider component behind `lfx/base/models/provider_ssrf.py`. */
export interface ProviderModelUnderTest {
  /** Short label for test titles and error messages. */
  label: string;
  /** Catalog key in `GET /api/v1/all`. */
  componentType: string;
  /** The base-URL field name. Differs per component — that asymmetry is under test. */
  baseUrlField: string;
  /**
   * The provider's own canonical endpoint.
   *
   * Per provider, never shared: `_is_provider_default` compares the tenant value
   * against THIS provider's default, so testing one component's skip path with
   * the other's endpoint would send a validated, admitted public URL and pass for
   * the wrong reason.
   */
  canonicalBaseUrl: string;
  /**
   * A deliberately invalid key, shaped like the provider's own.
   *
   * Shape matters: the control assertion is that the PROVIDER refuses the key, and
   * a malformed key is rejected before authentication with a different message.
   */
  dummyApiKey: string;
  /**
   * A fragment of the provider's OWN refusal of `dummyApiKey`, measured on
   * 1.12.0.dev38.
   *
   * This is what the skip-path control asserts, and it has to be the provider's
   * words rather than a bare `401`: the claim is that the request left the box and
   * the PROVIDER decided, which is what makes "no SSRF refusal here" mean the
   * policy skipped rather than that the run died early for some other reason.
   */
  authRefusalFragment: string;
}

export const OPENAI_MODEL: ProviderModelUnderTest = {
  label: "OpenAI",
  componentType: "ext:openai:OpenAIModelComponent@official",
  baseUrlField: "openai_api_base",
  canonicalBaseUrl: "https://api.openai.com/v1",
  dummyApiKey: "sk-dummy-not-a-real-key",
  authRefusalFragment: "Incorrect API key provided",
};

export const ANTHROPIC_MODEL: ProviderModelUnderTest = {
  label: "Anthropic",
  componentType: "ext:anthropic:AnthropicModelComponent@official",
  baseUrlField: "base_url",
  canonicalBaseUrl: "https://api.anthropic.com",
  dummyApiKey: "sk-ant-dummy-not-a-real-key",
  authRefusalFragment: "API key is invalid",
};

interface TemplateField {
  type?: string;
  value?: unknown;
  load_from_db?: boolean;
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

export interface BuildProviderModelFlowOptions {
  provider: ProviderModelUnderTest;
  /** Node id given to the provider node — also the `tweaks` key. */
  nodeId: string;
  /**
   * The base URL to wire in. **Written through even when empty**, because empty
   * is not "leave the default" — it is the skip path `_is_provider_default`
   * takes, and it must be set explicitly rather than inherited from whatever the
   * template shipped.
   */
  baseUrl: string;
  /** The prompt the component runs with. */
  inputValue?: string;
}

/**
 * Finds a component template in a `GET /api/v1/all` payload, whose top level is
 * `category -> { componentType: template }`.
 *
 * Throws naming the component when it is absent: a vendor distribution can be
 * missing per image (`docs/component-distribution-policy.md`), and an undefined
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
      // Deep copy: the caller fetches the catalog once and builds several flows
      // from it, and every build mutates field values. Sharing would leave every
      // build after the first asserting the previous one's URL — silently, since
      // all the values are plausible.
      return JSON.parse(JSON.stringify(entry)) as ComponentTemplate;
    }
  }

  throw new Error(
    `Component "${componentType}" is not present in GET /api/v1/all on this instance. ` +
      "Either the image does not ship its distribution, or the response was not a component " +
      "catalog (an auth failure answers with a `detail` body). " +
      "See docs/component-distribution-policy.md.",
  );
}

/**
 * Turns a live catalog into the flow payload. Pure — no network, no clock, no
 * randomness — so the field wiring and every failure mode are unit-testable.
 *
 * Both the provider's base-URL field and `api_key` must exist on the template.
 * The base-URL check guards the quiet failure: without the field the node keeps
 * the template's own URL, the policy skips it, and every refusal assertion
 * reports "admitted" against an address the spec never chose.
 */
export function buildProviderModelFlowData(
  catalog: Record<string, unknown>,
  { provider, nodeId, baseUrl, inputValue = "ping" }: BuildProviderModelFlowOptions,
): FlowData {
  const template = findComponentTemplate(catalog, provider.componentType);

  for (const field of [provider.baseUrlField, "api_key"]) {
    if (!(field in template.template)) {
      throw new Error(
        `The ${provider.label} component (${provider.componentType}) on this instance has no ` +
          `"${field}" field (fields: ${Object.keys(template.template).join(", ")}). The field was ` +
          "renamed upstream — a flow built without it would run the component's own default " +
          "base URL, and the SSRF assertions would report a verdict on an address this spec " +
          "never set.",
      );
    }
  }

  template.template[provider.baseUrlField] = {
    ...template.template[provider.baseUrlField],
    value: baseUrl,
  };
  // A literal, with load_from_db OFF. The template ships the NAME of a global
  // variable and `load_from_db: true`; left alone the run fails resolving a
  // credential that does not exist, which is not the guard's error — on a spec
  // whose entire claim is WHICH error appears.
  template.template.api_key = {
    ...template.template.api_key,
    value: provider.dummyApiKey,
    load_from_db: false,
  };
  if ("input_value" in template.template) {
    template.template.input_value = {
      ...template.template.input_value,
      value: inputValue,
    };
  }

  return {
    nodes: [
      {
        id: nodeId,
        type: "genericNode",
        position: { x: 0, y: 0 },
        data: { id: nodeId, type: provider.componentType, node: template },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export interface ProviderModelFlow {
  /** The created flow's id, for `POST /api/v1/run/{flow_id}` and teardown. */
  flowId: string;
  /** Node id of the provider node. */
  nodeId: string;
  /** The base URL wired into the node. */
  baseUrl: string;
  /** Deletes the created flow. Safe to call with `afterAll`'s own `request`. */
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/** Fetches the live catalog. Separate so a caller can fetch once and build many. */
export async function fetchComponentCatalog(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await request.get("/api/v1/all", { headers });
  if (!res.ok()) {
    throw new Error(
      `GET /api/v1/all answered HTTP ${res.status()}, so no component template could be read. ` +
        "This is an instance problem, not a verdict on the SSRF policy.",
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Creates the flow. `headers` carries the auth the caller already holds; the same
 * header is reused for teardown so ownership matches.
 */
export async function createProviderModelFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  catalog: Record<string, unknown>,
  options: BuildProviderModelFlowOptions,
): Promise<ProviderModelFlow> {
  const data = buildProviderModelFlowData(catalog, options);

  // Unique per call: Langflow enforces unique names per user and its auto-rename
  // fallback is not transaction-safe, so two same-named parallel creations race
  // and the loser gets a 500 (same convention as the sibling helpers).
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const flowId = await createFlow(
    request,
    {
      name: `Provider SSRF ${options.provider.label} ${suffix}`,
      description: "Single-node model-provider flow for base-URL SSRF assertions",
      data,
      is_component: false,
    },
    { headers },
  );

  return {
    flowId,
    nodeId: options.nodeId,
    baseUrl: options.baseUrl,
    deleteFlow: (reqOverride?: APIRequestContext) =>
      deleteFlow(reqOverride ?? request, flowId, { headers }),
  };
}
