// Unit tests for the catalog flow builder (issue #1911).
// Run with: npm run test:units
//
// Pure function only: no catalog fetch, no network, no clock. The fixture is a
// hand-built catalog shaped like GET /api/v1/all on 1.13.0.dev16 — the same
// component keys, output names, `group_outputs` flags and `input_types` the specs
// that use this builder rely on — so each trap the builder encodes is pinned by an
// assertion rather than by a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHandle, unescapeHandle } from "./create-python-interpreter-flow-via-api";
import {
  buildCatalogFlow,
  findCatalogComponent,
  type CatalogFlowSpec,
} from "./build-catalog-flow";

/** A catalog shaped like GET /api/v1/all: `category -> { componentKey: entry }`. */
function catalogFixture(): Record<string, unknown> {
  return {
    flow_controls: {
      LoopComponent: {
        display_name: "Loop",
        outputs: [
          {
            name: "item",
            types: ["Data", "JSON"],
            allows_loop: true,
            loop_types: ["Message"],
            group_outputs: true,
          },
          { name: "done", types: ["DataFrame", "Table"], group_outputs: true },
        ],
        template: {
          _type: "Component",
          code: { type: "code", value: "loop" },
          data: { type: "other", input_types: ["DataFrame", "Table", "Data", "Message"] },
        },
      },
      ConditionalRouter: {
        display_name: "If-Else",
        outputs: [
          { name: "true_result", types: ["Message"], group_outputs: true },
          { name: "false_result", types: ["Message"], group_outputs: true },
        ],
        template: {
          _type: "Component",
          code: { type: "code", value: "router" },
          input_text: { type: "str", input_types: ["Message"], value: "" },
          match_text: { type: "str", input_types: ["Message"], value: "" },
        },
      },
    },
    processing: {
      CreateList: {
        display_name: "Create List",
        outputs: [
          { name: "list", types: ["JSON"], group_outputs: false },
          { name: "dataframe", types: ["Table"], group_outputs: false },
        ],
        template: {
          _type: "Component",
          code: { type: "code", value: "create_list" },
          texts: { type: "str", value: [] },
        },
      },
      ParserComponent: {
        display_name: "Parser",
        outputs: [{ name: "parsed_text", types: ["Message"], group_outputs: false }],
        template: {
          _type: "Component",
          code: { type: "code", value: "parser" },
          input_data: { type: "other", input_types: ["DataFrame", "Table", "Data", "JSON"] },
          pattern: { type: "str", input_types: ["Message"], value: "Text: {text}" },
        },
      },
    },
    input_output: {
      ChatOutput: {
        display_name: "Chat Output",
        outputs: [{ name: "message", types: ["Message"], group_outputs: false }],
        template: {
          _type: "Component",
          code: { type: "code", value: "chat_output" },
          input_value: {
            type: "other",
            input_types: ["Data", "JSON", "DataFrame", "Table", "Message"],
          },
        },
      },
    },
    // Not a category: a metadata map from lowercased type names to their
    // localized display names. Its values are strings, never component entries.
    component_display_names: { chatoutput: "Chat Output,Saída do chat" },
  };
}

function nodeById(data: ReturnType<typeof buildCatalogFlow>, id: string) {
  const n = data.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing`);
  return n;
}

test("findCatalogComponent returns a deep copy from whichever category holds the key", () => {
  const catalog = catalogFixture();
  const parser = findCatalogComponent(catalog, "ParserComponent");
  assert.equal(parser.display_name, "Parser");

  parser.template.pattern.value = "mutated";
  const again = findCatalogComponent(catalog, "ParserComponent");
  assert.equal(again.template.pattern.value, "Text: {text}", "the catalog must not be mutated through a copy");
});

test("findCatalogComponent skips the display-name metadata map and names a missing component", () => {
  const catalog = catalogFixture();
  assert.throws(
    () => findCatalogComponent(catalog, "chatoutput"),
    /"chatoutput" is not in GET \/api\/v1\/all/,
  );
  assert.throws(
    () => findCatalogComponent(catalog, "ArXivComponent"),
    /"ArXivComponent" is not in GET \/api\/v1\/all/,
  );
});

test("a node carries the catalog template, its id, and the overridden display name and values", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      {
        id: "ChatOutput-true",
        type: "ChatOutput",
        displayName: "true branch",
      },
      {
        id: "CreateList-src",
        type: "CreateList",
        values: { texts: ["alpha", "beta"] },
        selectedOutput: "dataframe",
      },
    ],
    edges: [],
  });

  const out = nodeById(data, "ChatOutput-true");
  assert.equal(out.type, "genericNode");
  assert.equal(out.data.id, "ChatOutput-true");
  assert.equal(out.data.type, "ChatOutput");
  assert.equal(out.data.node.display_name, "true branch");
  assert.equal(out.data.node.template.code.value, "chat_output");

  const list = nodeById(data, "CreateList-src");
  assert.deepEqual(list.data.node.template.texts.value, ["alpha", "beta"]);
  assert.equal(data.edges.length, 0);
});

test("a value naming a field the component does not declare throws, naming both", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [{ id: "P", type: "ParserComponent", values: { template: "{text}" } }],
        edges: [],
      }),
    /ParserComponent "P" has no field "template"/,
  );
});

test("duplicate node ids throw", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Same", type: "ChatOutput" },
          { id: "Same", type: "ParserComponent" },
        ],
        edges: [],
      }),
    /duplicate node id: Same/,
  );
});

test("two nodes of the same type do not share template objects", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "A", type: "ParserComponent", values: { pattern: "{a}" } },
      { id: "B", type: "ParserComponent" },
    ],
    edges: [],
  });
  assert.equal(nodeById(data, "A").data.node.template.pattern.value, "{a}");
  assert.equal(nodeById(data, "B").data.node.template.pattern.value, "Text: {text}");
});

test("an edge into an input field is typed from both templates, and both handle forms agree", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "Route", type: "ConditionalRouter" },
      { id: "Out", type: "ChatOutput" },
    ],
    edges: [{ source: "Route", output: "false_result", target: "Out", field: "input_value" }],
  });

  const [edge] = data.edges;
  assert.deepEqual(edge.data.sourceHandle, {
    dataType: "ConditionalRouter",
    id: "Route",
    name: "false_result",
    output_types: ["Message"],
  });
  assert.deepEqual(edge.data.targetHandle, {
    fieldName: "input_value",
    id: "Out",
    inputTypes: ["Data", "JSON", "DataFrame", "Table", "Message"],
    type: "other",
  });
  // The backend parses the escaped STRINGS; the canvas reads `data`. They must be
  // the same handle or the two sides build different graphs.
  assert.equal(edge.sourceHandle, escapeHandle(edge.data.sourceHandle));
  assert.equal(edge.targetHandle, escapeHandle(edge.data.targetHandle));
  assert.deepEqual(unescapeHandle(edge.targetHandle), edge.data.targetHandle);
  assert.equal(edge.source, "Route");
  assert.equal(edge.target, "Out");
  assert.equal(edge.id, `reactflow__edge-Route${edge.sourceHandle}-Out${edge.targetHandle}`);
});

test("a feedback edge into a loop output advertises the output's types plus its loop_types", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "Loop", type: "LoopComponent" },
      { id: "Fmt", type: "ParserComponent" },
    ],
    edges: [{ source: "Fmt", output: "parsed_text", target: "Loop", loopOutput: "item" }],
  });
  assert.deepEqual(data.edges[0].data.targetHandle, {
    dataType: "LoopComponent",
    id: "Loop",
    name: "item",
    output_types: ["Data", "JSON", "Message"],
  });
});

test("a feedback edge into an output that does not allow loops throws", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Loop", type: "LoopComponent" },
          { id: "Fmt", type: "ParserComponent" },
        ],
        edges: [{ source: "Fmt", output: "parsed_text", target: "Loop", loopOutput: "done" }],
      }),
    /output "done" of "Loop" does not accept a loop feedback edge/,
  );
});

test("an edge naming an output, a field or a node that does not exist throws", () => {
  const nodes: CatalogFlowSpec["nodes"] = [
    { id: "Route", type: "ConditionalRouter" },
    { id: "Out", type: "ChatOutput" },
  ];
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes,
        edges: [{ source: "Route", output: "maybe_result", target: "Out", field: "input_value" }],
      }),
    /"Route" has no output "maybe_result"/,
  );
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes,
        edges: [{ source: "Route", output: "true_result", target: "Out", field: "message" }],
      }),
    /"Out" has no field "message"/,
  );
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes,
        edges: [{ source: "Nowhere", output: "true_result", target: "Out", field: "input_value" }],
      }),
    /edge source is not a node: Nowhere/,
  );
});

test("an edge must name exactly one of field and loopOutput", () => {
  const nodes: CatalogFlowSpec["nodes"] = [
    { id: "Loop", type: "LoopComponent" },
    { id: "Fmt", type: "ParserComponent" },
  ];
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes,
        edges: [{ source: "Fmt", output: "parsed_text", target: "Loop" }],
      }),
    /exactly one of field and loopOutput/,
  );
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes,
        edges: [{ source: "Fmt", output: "parsed_text", target: "Loop", field: "data", loopOutput: "item" }],
      }),
    /exactly one of field and loopOutput/,
  );
});

test("an edge whose types do not intersect throws, naming both sides", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Route", type: "ConditionalRouter" },
          { id: "Fmt", type: "ParserComponent" },
        ],
        edges: [{ source: "Route", output: "true_result", target: "Fmt", field: "input_data" }],
      }),
    /"Route"\.true_result emits \[Message\] but "Fmt"\.input_data accepts \[DataFrame, Table, Data, JSON\]/,
  );
});

test("a field that accepts no connection cannot be an edge target", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Route", type: "ConditionalRouter" },
          { id: "Src", type: "CreateList" },
        ],
        edges: [{ source: "Route", output: "true_result", target: "Src", field: "texts" }],
      }),
    /"Src"\.texts accepts no connection/,
  );
});

test("selectedOutput is recorded on the node, and an edge from any other output throws", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "Src", type: "CreateList", selectedOutput: "dataframe" },
      { id: "Loop", type: "LoopComponent" },
    ],
    edges: [{ source: "Src", output: "dataframe", target: "Loop", field: "data" }],
  });
  assert.equal(nodeById(data, "Src").data.selected_output, "dataframe");

  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Src", type: "CreateList", selectedOutput: "dataframe" },
          { id: "Out", type: "ChatOutput" },
        ],
        edges: [{ source: "Src", output: "list", target: "Out", field: "input_value" }],
      }),
    /"Src" shows only its selected output "dataframe"/,
  );
});

test("an unknown selectedOutput throws", () => {
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [{ id: "Src", type: "CreateList", selectedOutput: "table" }],
        edges: [],
      }),
    /CreateList "Src" has no output "table" to select/,
  );
});

test("without selectedOutput an edge from a non-first ungrouped output throws — the canvas would drop it", () => {
  // Measured on 1.13.0.dev16: with no `selected_output` the canvas selects the
  // FIRST ungrouped output on load and deletes the edge from `dataframe` in its
  // first autosave, so the backend and the canvas disagree about the graph.
  assert.throws(
    () =>
      buildCatalogFlow(catalogFixture(), {
        nodes: [
          { id: "Src", type: "CreateList" },
          { id: "Loop", type: "LoopComponent" },
        ],
        edges: [{ source: "Src", output: "dataframe", target: "Loop", field: "data" }],
      }),
    /"Src" shows only its selected output "list".*set selectedOutput: "dataframe"/,
  );
});

test("grouped outputs take edges from every output without a selection", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "Route", type: "ConditionalRouter" },
      { id: "T", type: "ChatOutput" },
      { id: "F", type: "ChatOutput" },
    ],
    edges: [
      { source: "Route", output: "true_result", target: "T", field: "input_value" },
      { source: "Route", output: "false_result", target: "F", field: "input_value" },
    ],
  });
  assert.equal(data.edges.length, 2);
  assert.equal(nodeById(data, "Route").data.selected_output, undefined);
});

test("configure runs on the node's own copy before its edges are typed", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      {
        id: "Fmt",
        type: "ParserComponent",
        configure: (component) => {
          component.outputs = [{ name: "rows", types: ["Table"], group_outputs: false }];
        },
      },
      { id: "Loop", type: "LoopComponent" },
    ],
    edges: [{ source: "Fmt", output: "rows", target: "Loop", field: "data" }],
  });
  assert.deepEqual(data.edges[0].data.sourceHandle.output_types, ["Table"]);
  // The catalog itself is untouched by a configure hook.
  const pristine = findCatalogComponent(catalogFixture(), "ParserComponent");
  assert.equal(pristine.outputs[0].name, "parsed_text");
});

test("the payload carries a viewport and spreads the nodes apart", () => {
  const data = buildCatalogFlow(catalogFixture(), {
    nodes: [
      { id: "A", type: "ChatOutput" },
      { id: "B", type: "ChatOutput" },
    ],
    edges: [],
  });
  assert.deepEqual(data.viewport, { x: 0, y: 0, zoom: 1 });
  assert.notDeepEqual(nodeById(data, "A").position, nodeById(data, "B").position);
});
