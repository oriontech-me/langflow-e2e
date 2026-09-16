// Unit tests for the template graph-shape comparison (#1864).
// Run with: npm run test:units
//
// The fixtures mirror the real listing measured on Langflow Nightly
// `1.13.0.dev12`: 26 registered templates, 138 `genericNode`s and 29 notes, with
// *Basic Prompting* carrying two notes of DIFFERENT shape — one with
// `data.type: "note"`, one with no `data.type` at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeShapeDiff,
  graphShape,
  nameMatchesTemplate,
  type GraphShape,
} from "./template-graph-shape";

/** Basic Prompting as the listing really serves it. */
const basicPrompting = {
  nodes: [
    { type: "genericNode", data: { type: "ChatInput" } },
    { type: "genericNode", data: { type: "Prompt" } },
    { type: "genericNode", data: { type: "ChatOutput" } },
    { type: "genericNode", data: { type: "LanguageModelComponent" } },
    { type: "noteNode", data: { type: "note" } },
    { type: "noteNode", data: {} },
  ],
  edges: [{}, {}, {}],
};

test("a real template reduces to its multiset, edge count and note count", () => {
  const shape = graphShape(basicPrompting);
  assert.deepEqual(shape, {
    componentTypes: ["ChatInput", "ChatOutput", "LanguageModelComponent", "Prompt"],
    edgeCount: 3,
    noteCount: 2,
  });
});

test("notes are counted as the complement of genericNode, whatever shape they carry", () => {
  // The measured reason: Basic Prompting's two notes differ, one carrying
  // `data.type: "note"` and the other nothing. A rule keyed on the note's own
  // shape would have counted 1.
  assert.equal(graphShape(basicPrompting)?.noteCount, 2);
});

test("node order does not matter but node COUNT does — it is a multiset, not a set", () => {
  const a = graphShape({
    nodes: [
      { type: "genericNode", data: { type: "Agent" } },
      { type: "genericNode", data: { type: "Agent" } },
      { type: "genericNode", data: { type: "ChatInput" } },
    ],
    edges: [],
  });
  const reordered = graphShape({
    nodes: [
      { type: "genericNode", data: { type: "ChatInput" } },
      { type: "genericNode", data: { type: "Agent" } },
      { type: "genericNode", data: { type: "Agent" } },
    ],
    edges: [],
  });
  assert.deepEqual(a, reordered);

  // Multi Agent Flow has three Agents; dropping one must be a difference.
  const dropped = graphShape({
    nodes: [
      { type: "genericNode", data: { type: "Agent" } },
      { type: "genericNode", data: { type: "ChatInput" } },
    ],
    edges: [],
  });
  assert.notDeepEqual(a, dropped);
  assert.deepEqual(describeShapeDiff(a as GraphShape, dropped as GraphShape), [
    "component type Agent: the template has 2, the created flow has 1",
  ]);
});

test("graphShape returns no signal for the four bodies that would diff as a real difference", () => {
  assert.equal(graphShape(null), null);
  assert.equal(graphShape({ nodes: [] , edges: [] }), null, "zero components is a parse failure");
  assert.equal(graphShape({ nodes: [{ type: "genericNode" }], edges: [] }), null);
  assert.equal(graphShape({ nodes: [{ type: "genericNode", data: { type: "" } }], edges: [] }), null);
  assert.equal(graphShape({ nodes: "x", edges: [] }), null);
  assert.equal(graphShape({ nodes: [null], edges: [] }), null);
  assert.equal(graphShape({ nodes: [{ type: "genericNode", data: { type: "A" } }] }), null);
});

test("graphShape cannot throw on anything JSON.parse can produce", () => {
  for (const bad of [undefined, 0, "", [], [1, 2], { nodes: {} }, { edges: [] }]) {
    assert.doesNotThrow(() => graphShape(bad));
  }
});

test("a dropped edge and a discarded note are each named", () => {
  const expected = graphShape(basicPrompting) as GraphShape;
  const lostEdge = { ...expected, edgeCount: 2 };
  assert.deepEqual(describeShapeDiff(expected, lostEdge), [
    "edge count: the template has 3, the created flow has 2",
  ]);
  const lostNote = { ...expected, noteCount: 1 };
  assert.deepEqual(describeShapeDiff(expected, lostNote), [
    "note count: the template has 2, the created flow has 1",
  ]);
  assert.deepEqual(describeShapeDiff(expected, expected), []);
});

test("a rewritten component type reports both halves, not a bare inequality", () => {
  const expected = graphShape(basicPrompting) as GraphShape;
  const rewritten = graphShape({
    ...basicPrompting,
    nodes: basicPrompting.nodes.map((n) =>
      n.data && (n.data as { type?: string }).type === "Prompt"
        ? { type: "genericNode", data: { type: "PromptTemplate" } }
        : n,
    ),
  }) as GraphShape;
  assert.deepEqual(describeShapeDiff(expected, rewritten), [
    "component type Prompt is missing from the created flow (the template has 1)",
    "component type PromptTemplate appears 1× in the created flow and not at all in the template",
  ]);
});

test("the persisted name is the template's own or its ` (N)` duplicate", () => {
  assert.equal(nameMatchesTemplate("Basic Prompting", "Basic Prompting"), true);
  assert.equal(nameMatchesTemplate("Basic Prompting (1)", "Basic Prompting"), true);
  assert.equal(nameMatchesTemplate("Basic Prompting (12)", "Basic Prompting"), true);
});

test("the name check does not accept a different template, a prefix or a non-numeric suffix", () => {
  // The case that matters: loadTemplateByName matches the card heading WITHOUT
  // `exact`, so on an image where one template name became a prefix of another
  // this assertion is what notices the wrong template was created.
  assert.equal(nameMatchesTemplate("Simple Agent", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate("Basic Prompting Extended", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate("Basic Prompting ()", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate("Basic Prompting (copy)", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate("Basic Prompting (1", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate("", "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate(undefined, "Basic Prompting"), false);
  assert.equal(nameMatchesTemplate(42, "Basic Prompting"), false);
});

test("a template name carrying regex metacharacters is compared literally", () => {
  // `Document Q&A` is real; the dangerous shape is a name containing `(` or `)`,
  // which a regex built from the name would mis-parse or over-match.
  assert.equal(nameMatchesTemplate("Document Q&A", "Document Q&A"), true);
  assert.equal(nameMatchesTemplate("Document Q&A (2)", "Document Q&A"), true);
  assert.equal(nameMatchesTemplate("Document QxA", "Document Q&A"), false);
  assert.equal(nameMatchesTemplate("A (b) (1)", "A (b)"), true);
  assert.equal(nameMatchesTemplate("Ax(b) (1)", "A (b)"), false);
});
