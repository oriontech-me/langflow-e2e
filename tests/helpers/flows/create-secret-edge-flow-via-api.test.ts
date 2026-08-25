// Unit tests for the secret-across-edges flow builder.
// Run with: npm run test:units
//
// The builder wires a credential-fed node to two downstreams so a spec can prove
// the edge carries the REAL value while every display copy carries the mask. Two
// traps here are silent AND indistinguishable from each other by their error
// message — Langflow reports both as "Edge between CustomComponent and
// CustomComponent has no matched type" — so each gets its own assertion:
// the handle encoding, and the node's declared `outputs`.
//
// Pure function only: no catalog fetch, no network, no clock. The fixture is a
// hand-built catalog shaped like `GET /api/v1/all`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unescapeHandle } from "./create-python-interpreter-flow-via-api";
import {
  MASK,
  RECEIVED_LEN_PREFIX,
  SECRET_EDGE_NODE_IDS,
  buildSecretEdgeFlowData,
} from "./create-secret-edge-flow-via-api";

const SECRET_FIELD = "gateway_pin";
const VARIABLE = "cred-edge-probe";

/** A catalog carrying the stock CustomComponent, shaped like GET /api/v1/all. */
function catalogFixture(): Record<string, unknown> {
  return {
    custom_component: {
      CustomComponent: {
        display_name: "Custom Component",
        // The stock template declares JSON, which is trap #2: pasting code that
        // returns a Message does not change it.
        outputs: [
          {
            name: "output",
            display_name: "Output",
            method: "build_output",
            types: ["JSON"],
            selected: "JSON",
            cache: true,
          },
        ],
        template: {
          _type: { type: "str", value: "" },
          code: { type: "code", value: "" },
          input_value: { type: "str", value: "" },
        },
      },
    },
  };
}

function opts() {
  return { secretFieldName: SECRET_FIELD, credentialVariableName: VARIABLE };
}

function nodeById(data: ReturnType<typeof buildSecretEdgeFlowData>, id: string) {
  const n = data.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing`);
  return n;
}

test("the graph is three nodes and two edges, both from the upstream's one output", () => {
  // The fan-out is what makes the spec's claim simultaneous: the measuring and
  // the echoing downstream read the SAME upstream output on the SAME run, so
  // "real to execution, masked to display" is one measurement rather than two.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  assert.equal(data.nodes.length, 3);
  assert.equal(data.edges.length, 2);
  const { upstream, measure, echo } = SECRET_EDGE_NODE_IDS;
  assert.deepEqual(
    data.edges.map((e) => [e.source, e.target]).sort(),
    [
      [upstream, echo],
      [upstream, measure],
    ].sort(),
  );
});

test("the upstream binds the credential by NAME with load_from_db on", () => {
  // A Credential global variable resolves by name at run time. A literal value
  // here would prove nothing about credential resolution — which is the whole
  // premise of the control the spec relies on.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  const field = nodeById(data, SECRET_EDGE_NODE_IDS.upstream).data.node.template[SECRET_FIELD];
  assert.equal(field.value, VARIABLE);
  assert.equal(field.load_from_db, true);
  assert.equal(field.password, true);
  assert.equal(field._input_type, "SecretStrInput");
});

test("every node's declared outputs are rewritten to Message", () => {
  // Trap #2. The stock template says `types: ["JSON"]`; the code returns a
  // Message. Langflow reports the mismatch as "has no matched type" — the SAME
  // message as a wrong handle encoding — so leaving this alone costs a debug
  // cycle chasing the wrong trap.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  for (const n of data.nodes) {
    const outputs = n.data.node.outputs as Array<Record<string, unknown>>;
    assert.equal(outputs.length, 1, `${n.id} should declare one output`);
    assert.deepEqual(outputs[0].types, ["Message"], `${n.id} must declare Message`);
    assert.equal(outputs[0].selected, "Message");
    assert.equal(outputs[0].name, "output");
  }
});

test("edge handles are encoded the way the BACKEND reads them", () => {
  // Trap #1. Langflow serialises handles as JSON with every `"` replaced by `œ`
  // (`scapedJSONStringfy`), and the backend parses those strings — passing only
  // the `data` objects yields "has no matched type". Asserted by round-tripping
  // through the sibling helper's already-exported inverse.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  const { upstream, measure } = SECRET_EDGE_NODE_IDS;
  const edge = data.edges.find((e) => e.target === measure);
  assert.ok(edge);

  assert.ok(!edge.sourceHandle.includes('"'), "a raw quote means the handle was not escaped");
  assert.ok(edge.sourceHandle.includes("œ"), "the escaped form must use œ");

  const src = unescapeHandle(edge.sourceHandle);
  assert.equal(src.id, upstream);
  assert.equal(src.name, "output");
  assert.deepEqual(src.output_types, ["Message"]);

  const tgt = unescapeHandle(edge.targetHandle);
  assert.equal(tgt.id, measure);
  assert.equal(tgt.fieldName, "incoming");
  assert.deepEqual(tgt.inputTypes, ["Message"]);
});

test("the escaped handle and its data object agree", () => {
  // Both are sent. If they disagree the graph builds against one and the spec
  // reasons about the other — a divergence no assertion downstream could see.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  for (const e of data.edges) {
    assert.deepEqual(unescapeHandle(e.sourceHandle), e.data.sourceHandle);
    assert.deepEqual(unescapeHandle(e.targetHandle), e.data.targetHandle);
  }
});

test("the upstream emits the secret and the two downstreams differ", () => {
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  const code = (id: string) =>
    String(nodeById(data, id).data.node.template.code.value);

  // The upstream must emit the RESOLVED field, not a literal.
  assert.match(code(SECRET_EDGE_NODE_IDS.upstream), new RegExp(`self\\.${SECRET_FIELD}`));
  // The measuring downstream reports a LENGTH — impossible to produce without
  // the real value, and it discloses nothing.
  assert.ok(code(SECRET_EDGE_NODE_IDS.measure).includes(RECEIVED_LEN_PREFIX));
  assert.match(code(SECRET_EDGE_NODE_IDS.measure), /len\(/);
  // The echoing downstream re-emits it, which is what pins the metadata
  // propagation: it must still be masked on display.
  assert.ok(!code(SECRET_EDGE_NODE_IDS.echo).includes(RECEIVED_LEN_PREFIX));
  assert.notEqual(code(SECRET_EDGE_NODE_IDS.echo), code(SECRET_EDGE_NODE_IDS.measure));
});

test("the mask is ten characters, which is why a sentinel may not be", () => {
  // The single most load-bearing fact in the spec: the delivery assertion reads
  // a LENGTH, so a 10-character sentinel makes the real value indistinguishable
  // from the mask the pre-fix build delivered.
  assert.equal(MASK.length, 10);
  assert.equal(MASK, "**********");
});

test("three nodes built from one catalog do not share mutated state", () => {
  // Every node is a deep copy: without it the upstream's secret field would
  // appear on the downstreams too, and the graph would resolve the credential
  // three times instead of carrying it across an edge — passing for the wrong
  // reason.
  const data = buildSecretEdgeFlowData(catalogFixture(), opts());
  const measure = nodeById(data, SECRET_EDGE_NODE_IDS.measure).data.node.template;
  const echo = nodeById(data, SECRET_EDGE_NODE_IDS.echo).data.node.template;
  assert.equal(SECRET_FIELD in measure, false, "the secret field must not leak downstream");
  assert.equal(SECRET_FIELD in echo, false);
  assert.notEqual(measure.code.value, echo.code.value);
});

test("a catalog without CustomComponent throws, naming it", () => {
  assert.throws(
    () => buildSecretEdgeFlowData({ custom_component: {} }, opts()),
    (e: Error) =>
      e.message.includes("CustomComponent") && /ALLOW_CUSTOM_COMPONENTS/.test(e.message),
  );
});
