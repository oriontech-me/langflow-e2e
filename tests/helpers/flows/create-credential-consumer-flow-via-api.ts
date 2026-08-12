import type { APIRequestContext } from "@playwright/test";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";

/**
 * Builds a flow whose nodes each consume a **Credential-type global variable**
 * through a `SecretStrInput`, from the LIVE component catalog (`GET /api/v1/all`),
 * and creates it via the REST API.
 *
 * Why it exists: `security/credential-secret-exposure.spec.ts` has to prove that a
 * resolved credential reaches the component and reaches NONE of the observable
 * surfaces (trace detail, exported flow, run response). No shipped component
 * gives that combination offline — every built-in `SecretStrInput` belongs to a
 * vendor component that needs the vendor to answer. A `CustomComponent` whose
 * code declares the secret input and returns only the secret's LENGTH does: the
 * length is impossible to produce without having resolved the credential, and it
 * discloses nothing.
 *
 * Why the field NAME is a parameter: the upstream defect (`langflow-ai/langflow#7313`)
 * was a name-based mask — only inputs whose key contained `api_key` were
 * obfuscated. The fix is type-based (`password=True`). A caller therefore passes
 * at least one field whose name matches no sensitive-key pattern anywhere, so a
 * regression back to name matching fails the spec instead of hiding behind a
 * conveniently-named field.
 *
 * Why one flow with several ROOT nodes: each node is an independent entry point,
 * so a single `POST /api/v1/run/{id}` with `output_type: "debug"` executes them
 * all (measured on 1.12.0.dev23) — one run, one trace, every field covered.
 *
 * The instance must run with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`; with it off
 * the custom code never executes and the caller's `resolved_len` assertion fails
 * loudly rather than passing vacuously.
 */

/** Catalog key of the component the nodes are built from. */
export const CUSTOM_COMPONENT_TYPE = "CustomComponent";

/** Prefix of the text each node outputs; the suffix is the resolved secret's length. */
export const RESOLVED_LEN_PREFIX = "resolved_len=";

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

export interface FlowData {
  nodes: FlowNode[];
  edges: never[];
  viewport: { x: number; y: number; zoom: number };
}

/** One credential-consuming node: a secret field bound to a global variable. */
export interface CredentialConsumerField {
  /** Name of the `SecretStrInput` the component declares, e.g. `gateway_pin`. */
  fieldName: string;
  /** Name of the Credential global variable the field is bound to. */
  variableName: string;
  /** Node id — also the key the run response and the transactions are read by. */
  nodeId: string;
}

/**
 * The component source for one node. It reads the secret and returns only its
 * length, so the caller can prove the credential resolved without the test
 * itself becoming a place the secret is printed.
 */
export function credentialConsumerCode(fieldName: string): string {
  return `from lfx.custom.custom_component.component import Component
from lfx.io import Output, SecretStrInput
from lfx.schema.message import Message


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Reports the length of a credential without disclosing it."
    icon = "code"
    name = "CustomComponent"

    inputs = [
        SecretStrInput(name="${fieldName}", display_name="Secret Field", required=False),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        secret = self.${fieldName} or ""
        return Message(text=f"${RESOLVED_LEN_PREFIX}{len(secret)}")
`;
}

/**
 * Finds a component template in a `GET /api/v1/all` payload, whose top level is
 * `category -> { componentType: template }`.
 *
 * Throws naming the component when it is absent: an undefined template reaching
 * `POST /api/v1/flows/` surfaces as an unattributable 422, and an auth failure
 * answers this endpoint with a `detail` body rather than a catalog.
 */
function findComponentTemplate(
  catalog: Record<string, unknown>,
  componentType: string,
): ComponentTemplate {
  for (const category of Object.values(catalog)) {
    if (!category || typeof category !== "object") continue;
    const entry = (category as Record<string, unknown>)[componentType];
    if (entry && typeof entry === "object" && "template" in entry) {
      // Deep copy: one catalog read builds every node, and each build mutates
      // the template it was given.
      return JSON.parse(JSON.stringify(entry)) as ComponentTemplate;
    }
  }

  throw new Error(
    `Component "${componentType}" is not present in GET /api/v1/all on this instance. ` +
      "Either the image does not ship it, or the response was not a component catalog " +
      "(an auth failure answers with a `detail` body). See docs/component-distribution-policy.md.",
  );
}

/**
 * Turns a live catalog into the flow payload. Pure — no network, no clock, no
 * randomness — so the credential binding it writes is unit-testable.
 *
 * The binding is the shape the UI writes when a Credential variable is attached
 * to a secret field: the field's `value` is the variable NAME and `load_from_db`
 * is `true`, which is what makes the stored flow free of the secret by
 * construction and the run able to resolve it.
 */
export function buildCredentialConsumerFlowData(
  catalog: Record<string, unknown>,
  fields: CredentialConsumerField[],
): FlowData {
  if (fields.length === 0) {
    throw new Error(
      "buildCredentialConsumerFlowData requires at least one field — a flow with " +
        "no credential consumer would run clean and assert nothing.",
    );
  }

  const nodes = fields.map(({ fieldName, variableName, nodeId }, index) => {
    const template = findComponentTemplate(catalog, CUSTOM_COMPONENT_TYPE);

    template.template.code = {
      ...template.template.code,
      value: credentialConsumerCode(fieldName),
    };
    // The stock template's own input is not declared by the code above; leaving
    // it in would make the node's template and its component disagree.
    delete template.template.input_value;
    template.template[fieldName] = {
      _input_type: "SecretStrInput",
      advanced: false,
      display_name: "Secret Field",
      dynamic: false,
      info: "",
      input_types: [],
      load_from_db: true,
      name: fieldName,
      password: true,
      placeholder: "",
      required: false,
      show: true,
      title_case: false,
      type: "str",
      value: variableName,
    };
    template.field_order = [fieldName];
    template.outputs = [
      {
        allows_loop: false,
        cache: true,
        display_name: "Output",
        method: "build_output",
        name: "output",
        selected: "Message",
        types: ["Message"],
        value: "__UNDEFINED__",
      },
    ];
    template.base_classes = ["Message"];

    return {
      id: nodeId,
      type: "genericNode",
      position: { x: index * 600, y: 0 },
      data: { id: nodeId, type: CUSTOM_COMPONENT_TYPE, node: template },
    };
  });

  // No edges on purpose: every node is its own root, so one run executes all of
  // them and each writes its own span, transaction and vertex build.
  return { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

export interface CredentialConsumerFlow {
  /** The created flow's id, for `POST /api/v1/run/{flow_id}`. */
  flowId: string;
  /** The fields as created, with the node ids the caller reads results by. */
  fields: CredentialConsumerField[];
  /** Deletes the created flow. Safe to call in `afterAll` with its own `request`. */
  deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;
}

/**
 * Creates the credential-consuming flow on the instance.
 *
 * `headers` carries the auth the caller already holds (`{ Authorization: bearer }`
 * or `{ "x-api-key": key }`); the same header is reused for the catalog read and
 * for teardown.
 *
 * `fields` pairs each `SecretStrInput` name with the Credential global variable
 * it binds to — the caller creates those variables, because it owns the sentinel
 * values it will later assert on.
 */
export async function createCredentialConsumerFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  fields: Array<Omit<CredentialConsumerField, "nodeId">>,
): Promise<CredentialConsumerFlow> {
  const catalogRes = await request.get("/api/v1/all", { headers });
  if (!catalogRes.ok()) {
    throw new Error(
      `GET /api/v1/all answered ${catalogRes.status()} — cannot build the ` +
        "credential-consumer flow without the component catalog.",
    );
  }
  const catalog = (await catalogRes.json()) as Record<string, unknown>;

  // Unique per call for the same reason as the sibling helpers: Langflow's
  // unique-name fallback is not transaction-safe under parallel creation (#588).
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const resolvedFields: CredentialConsumerField[] = fields.map((field) => ({
    ...field,
    nodeId: `${CUSTOM_COMPONENT_TYPE}-${field.fieldName}-${uniqueSuffix}`,
  }));

  const data = buildCredentialConsumerFlowData(catalog, resolvedFields);

  const flowId = await createFlow(
    request,
    {
      name: `Credential Consumer Flow ${uniqueSuffix}`,
      description:
        "Credential-typed global variables consumed by SecretStrInput fields, " +
        "for the secret-exposure API tests",
      data,
      is_component: false,
    },
    { headers },
  );

  return {
    flowId,
    fields: resolvedFields,
    // `reqOverride` exists for the fixture-scope rule the sibling helpers
    // document: a `beforeAll` request cannot be reused inside `afterAll`.
    deleteFlow: async (reqOverride?: APIRequestContext) => {
      await deleteFlow(reqOverride ?? request, flowId, { headers });
    },
  };
}
