// Unit tests for buildCredentialConsumerFlowData (#1393).
// Run with: npm run test:units
//
// The helper's network half needs a live instance; its load-bearing half is
// pure — turning a live `GET /api/v1/all` catalog into a flow whose fields are
// BOUND to Credential global variables. Three properties there decide whether
// `security/credential-secret-exposure.spec.ts` proves anything, and none of
// them is visible from a green spec:
//
// (1) The BINDING. The field must carry `load_from_db: true` with the variable
// NAME as its value. Written without `load_from_db`, the run reads the literal
// string "my-var-name" as the secret — the flow still runs, the trace still
// masks, every "the sentinel is absent" assertion still passes, and the spec
// tests nothing at all. The `password: true` half is what the upstream mask
// keys on (`Component._get_trace_value`), so it is pinned too.
//
// (2) The CODE ↔ FIELD agreement. The generated component declares
// `SecretStrInput(name=<field>)` and reads `self.<field>`; if the template field
// and the code ever disagree, the node runs and reports length 0 — again a
// silently vacuous spec.
//
// (3) The CATALOG LOOKUP and the empty-field case must fail NAMING the cause,
// rather than reaching `POST /api/v1/flows/` as an undefined template (#1012).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCredentialConsumerFlowData,
  credentialConsumerCode,
  CUSTOM_COMPONENT_TYPE,
  RESOLVED_LEN_PREFIX,
} from "./create-credential-consumer-flow-via-api";

/** A minimal stand-in for the single catalog entry the helper reads. */
function fakeCatalog(
  overrides: { customComponent?: unknown } = {},
): Record<string, unknown> {
  const customComponent =
    "customComponent" in overrides
      ? overrides.customComponent
      : {
          display_name: "Custom Component",
          base_classes: ["JSON"],
          field_order: ["input_value"],
          outputs: [{ display_name: "Output", name: "output", types: ["Data"] }],
          template: {
            _type: "Component",
            code: { type: "code", value: "class CustomComponent: ..." },
            input_value: { type: "str", value: "Hello, World!" },
          },
        };

  const catalog: Record<string, Record<string, unknown>> = {
    input_output: {},
    custom_component: {},
  };
  if (customComponent !== undefined) {
    catalog.custom_component[CUSTOM_COMPONENT_TYPE] = customComponent;
  }
  return catalog;
}

const FIELDS = [
  {
    fieldName: "secret_token",
    variableName: "cred-token-1",
    nodeId: "CustomComponent-secret_token-t1",
  },
  {
    fieldName: "gateway_pin",
    variableName: "cred-pin-1",
    nodeId: "CustomComponent-gateway_pin-t1",
  },
];

test("binds each field to its variable with load_from_db and password set", () => {
  const data = buildCredentialConsumerFlowData(fakeCatalog(), FIELDS);

  assert.equal(data.nodes.length, 2);
  for (const [index, field] of FIELDS.entries()) {
    const template = data.nodes[index].data.node.template;
    const bound = template[field.fieldName];

    assert.ok(bound, `node ${index} has no ${field.fieldName} field`);
    // The variable NAME is the stored value — the secret itself never enters
    // the flow, which is the guarantee the spec's export test asserts on.
    assert.equal(bound.value, field.variableName);
    // Without this the run reads the variable name AS the secret and the whole
    // spec passes while proving nothing.
    assert.equal(bound.load_from_db, true);
    // What `Component._get_trace_value()` keys the "**********" mask on.
    assert.equal(bound.password, true);
    assert.equal(bound._input_type, "SecretStrInput");
  }
});

test("the generated code declares and reads the same field name", () => {
  const data = buildCredentialConsumerFlowData(fakeCatalog(), FIELDS);

  for (const [index, field] of FIELDS.entries()) {
    const code = data.nodes[index].data.node.template.code.value as string;

    assert.match(code, new RegExp(`SecretStrInput\\(name="${field.fieldName}"`));
    assert.match(code, new RegExp(`self\\.${field.fieldName}\\b`));
    assert.ok(code.includes(RESOLVED_LEN_PREFIX));
    // The secret's length is the only thing the component may emit.
    assert.ok(!code.includes("secret}"), "the component must never echo the secret");
  }
});

test("drops the stock input the generated component does not declare", () => {
  const data = buildCredentialConsumerFlowData(fakeCatalog(), FIELDS);

  for (const node of data.nodes) {
    assert.equal(node.data.node.template.input_value, undefined);
    assert.deepEqual(node.data.node.field_order, [
      // field_order mirrors the single declared input.
      Object.keys(node.data.node.template).find((k) => k !== "_type" && k !== "code"),
    ]);
  }
});

test("nodes are independent roots — no edges, one node per field", () => {
  const data = buildCredentialConsumerFlowData(fakeCatalog(), FIELDS);

  assert.deepEqual(data.edges, []);
  assert.deepEqual(
    data.nodes.map((n) => n.id),
    FIELDS.map((f) => f.nodeId),
  );
  // Distinct positions keep the canvas readable when the flow is opened by hand
  // during triage; the run itself does not care.
  assert.notEqual(data.nodes[0].position.x, data.nodes[1].position.x);
});

test("each node gets its own template copy", () => {
  const catalog = fakeCatalog();
  const data = buildCredentialConsumerFlowData(catalog, FIELDS);

  // A shared reference would leave the last field's code on every node.
  assert.notEqual(
    data.nodes[0].data.node.template.code.value,
    data.nodes[1].data.node.template.code.value,
  );
  // The catalog the caller holds is never mutated — it builds every node.
  const source = (catalog.custom_component as Record<string, { template: Record<string, unknown> }>)[
    CUSTOM_COMPONENT_TYPE
  ];
  assert.ok(source.template.input_value, "the source catalog was mutated");
});

test("fails naming the component when the catalog does not ship it", () => {
  assert.throws(
    () => buildCredentialConsumerFlowData(fakeCatalog({ customComponent: undefined }), FIELDS),
    (error: Error) =>
      error.message.includes(CUSTOM_COMPONENT_TYPE) &&
      error.message.includes("GET /api/v1/all"),
  );
});

test("refuses an empty field list instead of building a flow that asserts nothing", () => {
  assert.throws(
    () => buildCredentialConsumerFlowData(fakeCatalog(), []),
    /at least one field/,
  );
});

test("credentialConsumerCode is exported for the spec to document what runs", () => {
  const code = credentialConsumerCode("db_passphrase");

  assert.match(code, /SecretStrInput\(name="db_passphrase"/);
  assert.match(code, /self\.db_passphrase/);
});
