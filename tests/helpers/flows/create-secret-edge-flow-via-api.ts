import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";
import { escapeHandle } from "./create-python-interpreter-flow-via-api";

/**
 * Builds the five-node graph that makes `langflow-ai/langflow#14216` assertable:
 * a credential-fed node whose single output feeds two downstreams — one that
 * MEASURES what arrived and one that RE-EMITS it — and the re-emitting one feeds
 * the same pair again, one hop further from the secret.
 *
 * Why a chain at all: #14216's root cause is that
 * `Component._get_output_result()` sanitized its return value in place before
 * storing it in `Output.value`, and `ComponentVertex._get_result()` prefers that
 * cache for connected EDGES — so a downstream received the literal mask instead
 * of the real value. `create-credential-consumer-flow-via-api.ts` cannot show
 * this: its nodes are deliberately independent roots with no edges.
 *
 * Why the fan-out: the two downstreams read the SAME upstream output on the SAME
 * run, so "real to execution, masked to display" is one measurement rather than
 * two runs compared after the fact. The echoing node is the half that pins the
 * metadata propagation — a downstream re-emitting a secret it legitimately
 * received must still be masked, which is the exposure that masking in
 * `_build_results()` alone would have left open.
 *
 * Why a second hop (#2049): the secret metadata does not ride the edge as a
 * value — a requester copies the SOURCE component's `_secret_values` when it reads
 * the source's result (`Vertex.get_result` → `_inherit_secret_values`), and merges
 * them into its own at build time. A hop-1 node copies from the upstream, which
 * DECLARED the secret; a hop-2 node copies from the relay, which knows it only
 * through that merge. Inheritance that stopped one level deep leaves every hop-1
 * reading green and the hop-2 echo in plaintext — measured on a patched
 * `1.13.0.dev29` backend (spec doc: `docs/security/credential-secret-across-edges.md`).
 *
 * Why custom components: no shipped component gives "reads a secret and reports
 * something that proves it without disclosing it" offline. A length does — it is
 * impossible to produce without having resolved the credential and it discloses
 * nothing (the idea `create-credential-consumer-flow-via-api.ts` established).
 *
 * The instance must run with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`; the image
 * defaults it to false (#668/#746) and with it off the code never executes.
 */

/** Catalog key of the component the nodes are built from. */
export const CUSTOM_COMPONENT_TYPE = "CustomComponent";

/**
 * The mask Langflow substitutes for a `password=True` input on display surfaces.
 *
 * **Ten characters, and that is load-bearing.** The delivery assertion reads a
 * LENGTH, so a ten-character sentinel would make the real value indistinguishable
 * from the mask a pre-fix build delivered. Callers assert their sentinel is not
 * this length.
 */
export const MASK = "**********";

/** Prefix of the measuring downstream's output; the suffix is what it received. */
export const RECEIVED_LEN_PREFIX = "received_len=";

/**
 * Node ids, fixed so a spec can key its readings by `component_id`.
 *
 * `echo` is also the RELAY: the two `hop2*` nodes read its output, not the
 * upstream's, so they sit two edges from the secret (#2049).
 */
export const SECRET_EDGE_NODE_IDS = {
  upstream: "SecretEdgeUpstream",
  measure: "SecretEdgeMeasure",
  echo: "SecretEdgeEcho",
  hop2Measure: "SecretEdgeHop2Measure",
  hop2Echo: "SecretEdgeHop2Echo",
} as const;

/** Input name every downstream receives the edge on. */
const DOWNSTREAM_INPUT = "incoming";

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

export interface BuildSecretEdgeFlowOptions {
  /**
   * Name of the upstream's `SecretStrInput`.
   *
   * A caller should pick a name matching no sensitive-key pattern: #7313's defect
   * was a NAME-based mask, the fix is type-based (`password=True`), and a
   * conveniently-named field would hide a regression back to name matching.
   */
  secretFieldName: string;
  /** Name of the `Credential` global variable the upstream resolves. */
  credentialVariableName: string;
}

/** The upstream's source: emit the resolved credential onto the output edge. */
function upstreamCode(fieldName: string): string {
  return `from lfx.custom.custom_component.component import Component
from lfx.io import Output, SecretStrInput
from lfx.schema.message import Message


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Emits the resolved credential onto its output edge."
    icon = "code"
    name = "CustomComponent"

    inputs = [
        SecretStrInput(name="${fieldName}", display_name="Secret Field", required=False),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        return Message(text=self.${fieldName} or "")
`;
}

/**
 * A downstream's source. `measure` reports the LENGTH of what arrived — the proof
 * the real value crossed the edge, disclosing nothing. `echo` re-emits it, which
 * is only safe if the secret metadata rode the edge with it.
 */
function downstreamCode(kind: "measure" | "echo"): string {
  const body =
    kind === "measure"
      ? `return Message(text=f"${RECEIVED_LEN_PREFIX}{len(got)}")`
      : `return Message(text=got)`;
  const description =
    kind === "measure"
      ? "Reports the length of whatever arrived on its input edge."
      : "Re-emits whatever arrived on its input edge.";
  return `from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "${description}"
    icon = "code"
    name = "CustomComponent"

    inputs = [
        MessageTextInput(name="${DOWNSTREAM_INPUT}", display_name="Incoming", required=False),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        got = self.${DOWNSTREAM_INPUT} or ""
        ${body}
`;
}

/**
 * Finds the component template in a `GET /api/v1/all` payload, whose top level is
 * `category -> { componentType: template }`.
 *
 * Throws naming the component: with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` — the
 * image default — the catalog omits it, and an undefined template reaching
 * `POST /api/v1/flows/` surfaces as an unattributable 422.
 */
function findComponentTemplate(catalog: Record<string, unknown>): ComponentTemplate {
  for (const category of Object.values(catalog)) {
    if (!category || typeof category !== "object") continue;
    const entry = (category as Record<string, unknown>)[CUSTOM_COMPONENT_TYPE];
    if (entry && typeof entry === "object" && "template" in entry) {
      // Deep copy per node: every node is built from one catalog and each
      // mutates its own fields. Sharing would put the upstream's secret field on
      // the downstreams, making the graph resolve the credential once per node
      // instead of carrying it across an edge — passing for the wrong reason.
      return JSON.parse(JSON.stringify(entry)) as ComponentTemplate;
    }
  }
  throw new Error(
    `Component "${CUSTOM_COMPONENT_TYPE}" is not present in GET /api/v1/all on this instance. ` +
      "The image ships LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false, which hides it and makes " +
      "POST /api/v1/custom_component answer 403 (#668/#746) — start the instance with it true.",
  );
}

/**
 * The output declaration every node needs.
 *
 * **The stock template says `types: ["JSON"]` and pasting code does not change
 * it.** The frontend rebuilds the template from the code; an API caller must do it
 * here. Langflow reports the mismatch as `Edge between CustomComponent and
 * CustomComponent has no matched type` — byte-identical to what a wrongly-encoded
 * handle produces, so leaving this alone costs a debug cycle chasing the other
 * trap.
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

function makeNode(
  catalog: Record<string, unknown>,
  id: string,
  code: string,
  extraFields: Record<string, TemplateField>,
): FlowNode {
  const template = findComponentTemplate(catalog);
  template.template.code = { ...template.template.code, value: code };
  for (const [name, field] of Object.entries(extraFields)) {
    template.template[name] = field;
  }
  template.outputs = [messageOutput()];
  return {
    id,
    type: "genericNode",
    position: { x: 0, y: 0 },
    data: { id, type: CUSTOM_COMPONENT_TYPE, node: template },
  };
}

function makeEdge(source: string, target: string): FlowEdge {
  const sourceHandle = {
    dataType: CUSTOM_COMPONENT_TYPE,
    id: source,
    name: "output",
    output_types: ["Message"],
  };
  const targetHandle = {
    fieldName: DOWNSTREAM_INPUT,
    id: target,
    inputTypes: ["Message"],
    type: "str",
  };
  const escapedSource = escapeHandle(sourceHandle);
  const escapedTarget = escapeHandle(targetHandle);
  return {
    animated: false,
    className: "",
    selected: false,
    id: `reactflow__edge-${source}${escapedSource}-${target}${escapedTarget}`,
    source,
    target,
    // Both forms are sent, and they must agree: the backend parses the STRINGS,
    // while the frontend reads `data`. A divergence would build one graph and let
    // the spec reason about another.
    sourceHandle: escapedSource,
    targetHandle: escapedTarget,
    data: { sourceHandle, targetHandle },
  };
}

/**
 * Turns a live catalog into the flow payload. Pure — no network, no clock, no
 * randomness — so the wiring and both traps are unit-testable.
 */
export function buildSecretEdgeFlowData(
  catalog: Record<string, unknown>,
  { secretFieldName, credentialVariableName }: BuildSecretEdgeFlowOptions,
): FlowData {
  const { upstream, measure, echo, hop2Measure, hop2Echo } = SECRET_EDGE_NODE_IDS;

  const secretField: TemplateField = {
    type: "str",
    // The credential resolves by NAME at run time. A literal here would prove
    // nothing about credential resolution, which is the spec's own control.
    value: credentialVariableName,
    load_from_db: true,
    password: true,
    name: secretFieldName,
    display_name: "Secret Field",
    required: false,
    _input_type: "SecretStrInput",
    show: true,
  };
  const incomingField: TemplateField = {
    type: "str",
    value: "",
    name: DOWNSTREAM_INPUT,
    display_name: "Incoming",
    required: false,
    _input_type: "MessageTextInput",
    input_types: ["Message"],
    show: true,
  };

  return {
    nodes: [
      makeNode(catalog, upstream, upstreamCode(secretFieldName), {
        [secretFieldName]: secretField,
      }),
      makeNode(catalog, measure, downstreamCode("measure"), { [DOWNSTREAM_INPUT]: incomingField }),
      makeNode(catalog, echo, downstreamCode("echo"), { [DOWNSTREAM_INPUT]: incomingField }),
      // The second hop: the same two codes, reading the relay instead of the
      // upstream. The relay never declared the secret, so these nodes can only
      // learn it through what the relay inherited and merged (#2049).
      makeNode(catalog, hop2Measure, downstreamCode("measure"), {
        [DOWNSTREAM_INPUT]: incomingField,
      }),
      makeNode(catalog, hop2Echo, downstreamCode("echo"), { [DOWNSTREAM_INPUT]: incomingField }),
    ],
    edges: [
      makeEdge(upstream, measure),
      makeEdge(upstream, echo),
      makeEdge(echo, hop2Measure),
      makeEdge(echo, hop2Echo),
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export interface SecretEdgeFlow {
  flowId: string;
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/** Fetches the live catalog. Separate so a caller can fetch once. */
export async function fetchComponentCatalog(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await request.get("/api/v1/all", { headers });
  if (!res.ok()) {
    throw new Error(
      `GET /api/v1/all answered HTTP ${res.status()}, so no component template could be read. ` +
        "This is an instance problem, not a verdict on secret handling.",
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function createSecretEdgeFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  catalog: Record<string, unknown>,
  options: BuildSecretEdgeFlowOptions,
): Promise<SecretEdgeFlow> {
  const data = buildSecretEdgeFlowData(catalog, options);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const flowId = await createFlow(
    request,
    {
      name: `Secret Edge ${suffix}`,
      description:
        "Credential-fed node feeding a measuring and an echoing downstream, over two hops",
      data,
      is_component: false,
    },
    { headers },
  );
  return {
    flowId,
    deleteFlow: (reqOverride?: APIRequestContext) =>
      deleteFlow(reqOverride ?? request, flowId, { headers }),
  };
}
