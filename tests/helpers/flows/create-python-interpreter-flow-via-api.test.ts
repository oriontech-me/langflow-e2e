// Unit tests for buildPythonInterpreterFlowData (#1394).
// Run with: npm run test:units
//
// The helper's network half needs a live instance, but its load-bearing half is
// pure: turning a live `GET /api/v1/all` catalog into a runnable two-node flow
// payload. Two properties there cannot be seen from a green spec.
//
// (1) The EDGE. A tweak refused on a component is only observable if that
// component actually RUNS, and a Langflow vertex only runs when it is reachable
// from the graph's entry point — a disconnected Python Interpreter node is
// silently absent from the run response (measured on 1.12.0.dev23), which would
// make `tweaks-injection.spec.ts` Test 3 pass while asserting nothing. So the
// edge's handle encoding is pinned here rather than trusted.
//
// (2) The CATALOG LOOKUP. If a component the flow needs is not in the image, the
// helper must fail naming it — an undefined template would otherwise reach
// `POST /api/v1/flows/` and surface as an unattributable 422 (#1012's rule:
// never let a missing precondition read like a test failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPythonInterpreterFlowData,
  CHAT_OUTPUT_COMPONENT_TYPE,
  PYTHON_INTERPRETER_COMPONENT_TYPE,
  unescapeHandle,
} from "./create-python-interpreter-flow-via-api";

/** A minimal stand-in for the two catalog entries the helper reads. */
function fakeCatalog(
  overrides: { python?: unknown; chatOutput?: unknown } = {},
): Record<string, unknown> {
  const python = "python" in overrides
    ? overrides.python
    : {
        display_name: "Python Interpreter",
        template: {
          code: { type: "code", value: "class PythonREPLComponent: ..." },
          global_imports: { type: "str", value: "math" },
          python_code: { type: "str", value: "print('Hello, World!')" },
        },
      };
  const chatOutput = "chatOutput" in overrides
    ? overrides.chatOutput
    : {
        display_name: "Chat Output",
        template: {
          code: { type: "code", value: "class ChatOutput: ..." },
          input_value: {
            type: "str",
            input_types: ["Data", "JSON", "DataFrame", "Table", "Message"],
          },
          sender_name: { type: "str", value: "AI" },
        },
      };

  const catalog: Record<string, Record<string, unknown>> = {
    utilities: {},
    input_output: {},
  };
  if (python !== undefined) {
    catalog.utilities[PYTHON_INTERPRETER_COMPONENT_TYPE] = python;
  }
  if (chatOutput !== undefined) {
    catalog.input_output[CHAT_OUTPUT_COMPONENT_TYPE] = chatOutput;
  }
  return catalog;
}

const IDS = {
  pythonNodeId: "PythonREPLComponent-t1",
  chatOutputNodeId: "ChatOutput-t1",
  authorCode: 'print("AUTHOR-42")',
};

test("stores the author's code in the Python Interpreter's python_code field", () => {
  const data = buildPythonInterpreterFlowData(fakeCatalog(), IDS);

  const python = data.nodes.find((n) => n.id === IDS.pythonNodeId);
  assert.ok(python, "the python node must be present");
  assert.equal(python.data.type, PYTHON_INTERPRETER_COMPONENT_TYPE);
  assert.equal(python.data.node.template.python_code.value, IDS.authorCode);
});

test("wires the interpreter's results output into Chat Output's input_value", () => {
  const data = buildPythonInterpreterFlowData(fakeCatalog(), IDS);

  assert.equal(data.edges.length, 1);
  const [edge] = data.edges;
  assert.equal(edge.source, IDS.pythonNodeId);
  assert.equal(edge.target, IDS.chatOutputNodeId);

  // The serialized handles are what the backend reads; a well-formed pair is the
  // difference between a flow that runs both vertices and one that runs neither.
  const source = unescapeHandle(edge.sourceHandle);
  assert.deepEqual(source, {
    dataType: PYTHON_INTERPRETER_COMPONENT_TYPE,
    id: IDS.pythonNodeId,
    name: "results",
    output_types: ["Data"],
  });

  const target = unescapeHandle(edge.targetHandle);
  assert.equal(target.id, IDS.chatOutputNodeId);
  assert.equal(target.fieldName, "input_value");
});

test("takes the target handle's types from the live template, not from a copy", () => {
  // Drift resistance: if upstream narrows or widens what Chat Output accepts, the
  // edge follows the running image instead of a constant frozen at authoring time.
  const catalog = fakeCatalog({
    chatOutput: {
      display_name: "Chat Output",
      template: {
        input_value: { type: "other", input_types: ["Message"] },
      },
    },
  });

  const target = unescapeHandle(
    buildPythonInterpreterFlowData(catalog, IDS).edges[0].targetHandle,
  );
  assert.deepEqual(target.inputTypes, ["Message"]);
  assert.equal(target.type, "other");
});

test("names the missing component when the image does not ship it", () => {
  assert.throws(
    () => buildPythonInterpreterFlowData(fakeCatalog({ python: undefined }), IDS),
    (err: Error) => err.message.includes(PYTHON_INTERPRETER_COMPONENT_TYPE),
    "a missing Python Interpreter must be named, not surface as a 422 from the create call",
  );

  assert.throws(
    () =>
      buildPythonInterpreterFlowData(fakeCatalog({ chatOutput: undefined }), IDS),
    (err: Error) => err.message.includes(CHAT_OUTPUT_COMPONENT_TYPE),
  );
});

test("leaves the caller's catalog untouched", () => {
  // The spec fetches the catalog once and builds from it; mutating the shared
  // object would leak one test's author code into the next flow built from it.
  const catalog = fakeCatalog();
  const before = JSON.stringify(catalog);

  buildPythonInterpreterFlowData(catalog, IDS);

  assert.equal(JSON.stringify(catalog), before);
});

test("rejects a catalog that is not the /api/v1/all shape", () => {
  assert.throws(
    () =>
      buildPythonInterpreterFlowData(
        { detail: "Not authenticated" } as unknown as Record<string, unknown>,
        IDS,
      ),
    (err: Error) => err.message.includes(PYTHON_INTERPRETER_COMPONENT_TYPE),
    "an auth failure must not read as 'the component moved'",
  );
});
