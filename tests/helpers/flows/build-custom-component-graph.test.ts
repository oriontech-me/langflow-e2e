// Unit tests for the CustomComponent graph builder (issue #1896).
// Run with: npm run test:units
//
// Pure function only: no catalog fetch, no network, no clock. The fixture is a
// hand-built catalog shaped like GET /api/v1/all. The two traps this builder
// inherits from `create-secret-edge-flow-via-api.ts` — the Message output type
// and the distinct display_name — each get an assertion, alongside the graph
// validation that keeps a malformed spec from reaching POST /api/v1/flows/ as an
// unattributable 422.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unescapeHandle } from "./create-python-interpreter-flow-via-api";
import {
  CUSTOM_COMPONENT_TYPE,
  buildCustomComponentGraph,
  componentCode,
  findComponentTemplate,
  type GraphSpec,
} from "./build-custom-component-graph";

/** A catalog carrying the stock CustomComponent, shaped like GET /api/v1/all. */
function catalogFixture(): Record<string, unknown> {
  return {
    custom_component: {
      CustomComponent: {
        display_name: "Custom Component",
        // Stock template declares JSON — the trap the builder must overwrite.
        outputs: [{ name: "output", display_name: "Output", types: ["JSON"], selected: "JSON" }],
        template: {
          _type: { type: "str", value: "" },
          code: { type: "code", value: "" },
        },
      },
    },
  };
}

function nodeById(data: ReturnType<typeof buildCustomComponentGraph>, id: string) {
  const n = data.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing`);
  return n;
}

test("echo code sleeps, joins its inputs and appends its own tag", () => {
  const code = componentCode({ id: "Slow", kind: "echo", fields: ["incoming"], delayS: 0.4 });
  assert.match(code, /time\.sleep\(0\.4\)/);
  assert.match(code, /self\.incoming or ""/);
  assert.match(code, /\["Slow"\]/);
  assert.match(code, /display_name = "Slow"/);
});

test("raise code raises a tagged ValueError and declares no sleep", () => {
  const code = componentCode({ id: "X", kind: "raise", fields: ["incoming"] });
  assert.match(code, /raise ValueError\("boom-X"\)/);
  assert.doesNotMatch(code, /time\.sleep/);
});

test("stop code calls self.stop on the output", () => {
  const code = componentCode({ id: "Stopper", kind: "stop", fields: ["incoming"] });
  assert.match(code, /self\.stop\("output"\)/);
});

test("every node declares a Message output, not the stock JSON", () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "Root", kind: "echo" },
      { id: "Leaf", kind: "echo", fields: ["incoming"] },
    ],
    edges: [{ source: "Root", target: "Leaf", field: "incoming" }],
  };
  const data = buildCustomComponentGraph(catalogFixture(), spec);
  for (const node of data.nodes) {
    const outputs = node.data.node.outputs as Array<Record<string, unknown>>;
    assert.equal(outputs[0].types !== undefined && (outputs[0].types as string[])[0], "Message");
    assert.equal(outputs[0].selected, "Message");
  }
});

test("each node carries its own display_name", () => {
  const data = buildCustomComponentGraph(catalogFixture(), {
    nodes: [
      { id: "Root", kind: "echo" },
      { id: "Mid", kind: "echo", fields: ["incoming"] },
    ],
    edges: [{ source: "Root", target: "Mid", field: "incoming" }],
  });
  assert.equal(nodeById(data, "Root").data.node.display_name, "Root");
  assert.equal(nodeById(data, "Mid").data.node.display_name, "Mid");
});

test("an edge encodes both handle forms and they agree", () => {
  const data = buildCustomComponentGraph(catalogFixture(), {
    nodes: [
      { id: "Root", kind: "echo" },
      { id: "Leaf", kind: "echo", fields: ["incoming"] },
    ],
    edges: [{ source: "Root", target: "Leaf", field: "incoming" }],
  });
  const edge = data.edges[0];
  // The backend parses the STRINGS; the frontend reads `data`. They must match.
  assert.deepEqual(unescapeHandle(edge.sourceHandle), edge.data.sourceHandle);
  assert.deepEqual(unescapeHandle(edge.targetHandle), edge.data.targetHandle);
  const target = unescapeHandle(edge.targetHandle) as Record<string, unknown>;
  assert.equal(target.fieldName, "incoming");
  assert.equal(target.id, "Leaf");
});

test("a loopback edge (a cycle) is built without objection", () => {
  // The engine defect this spec pins needs a regular-port cycle, which the API
  // accepts even though the canvas refuses to draw it.
  const data = buildCustomComponentGraph(catalogFixture(), {
    nodes: [
      { id: "Alpha", kind: "echo", fields: ["incoming", "loopback"] },
      { id: "Beta", kind: "echo", fields: ["incoming"] },
    ],
    edges: [
      { source: "Alpha", target: "Beta", field: "incoming" },
      { source: "Beta", target: "Alpha", field: "loopback" },
    ],
  });
  assert.equal(data.edges.length, 2);
});

test("a duplicate node id is rejected", () => {
  assert.throws(
    () =>
      buildCustomComponentGraph(catalogFixture(), {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Root", kind: "echo" },
        ],
        edges: [],
      }),
    /duplicate node id/,
  );
});

test("an edge to a field the target does not declare is rejected", () => {
  assert.throws(
    () =>
      buildCustomComponentGraph(catalogFixture(), {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Leaf", kind: "echo", fields: ["incoming"] },
        ],
        edges: [{ source: "Root", target: "Leaf", field: "nope" }],
      }),
    /not an input of node Leaf/,
  );
});

test("an edge to an unknown node is rejected", () => {
  assert.throws(
    () =>
      buildCustomComponentGraph(catalogFixture(), {
        nodes: [{ id: "Root", kind: "echo" }],
        edges: [{ source: "Root", target: "Ghost", field: "incoming" }],
      }),
    /edge target not a node: Ghost/,
  );
});

test("findComponentTemplate throws naming the flag when the component is absent", () => {
  assert.throws(
    () => findComponentTemplate({ some_category: { SomethingElse: { template: {} } } }),
    new RegExp(`${CUSTOM_COMPONENT_TYPE}.*not present`),
  );
});
