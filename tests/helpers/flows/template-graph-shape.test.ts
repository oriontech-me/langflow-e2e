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
    { id: "ci", type: "genericNode", data: { type: "ChatInput" } },
    { id: "pr", type: "genericNode", data: { type: "Prompt" } },
    { id: "co", type: "genericNode", data: { type: "ChatOutput" } },
    { id: "lm", type: "genericNode", data: { type: "LanguageModelComponent" } },
    { id: "n1", type: "noteNode", data: { type: "note" } },
    { id: "n2", type: "noteNode", data: {} },
  ],
  edges: [
    { source: "ci", target: "pr" },
    { source: "pr", target: "lm" },
    { source: "lm", target: "co" },
  ],
};

test("a real template reduces to its multiset, edge count and note count", () => {
  const shape = graphShape(basicPrompting);
  assert.deepEqual(shape, {
    componentTypes: ["ChatInput", "ChatOutput", "LanguageModelComponent", "Prompt"],
    edgeCount: 3,
    noteCount: 2,
    wiring: [
      "ChatInput ←() →(Prompt)",
      "ChatOutput ←(LanguageModelComponent) →()",
      "LanguageModelComponent ←(Prompt) →(ChatOutput)",
      "Prompt ←(ChatInput) →(LanguageModelComponent)",
    ],
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
      (n.data as { type?: string })?.type === "Prompt"
        ? { ...n, data: { type: "PromptTemplate" } }
        : n,
    ),
  }) as GraphShape;
  const diff = describeShapeDiff(expected, rewritten);

  // Both halves of the component change are named…
  assert.ok(
    diff.includes("component type Prompt is missing from the created flow (the template has 1)"),
    JSON.stringify(diff),
  );
  assert.ok(
    diff.includes(
      "component type PromptTemplate appears 1× in the created flow and not at all in the template",
    ),
    JSON.stringify(diff),
  );
  // …and the wiring moves with it, because renaming a node also changes what its
  // NEIGHBOURS report as their neighbour types. Every remaining line is a wiring
  // line: the counts are untouched, which is the point.
  assert.ok(
    diff.filter((l) => !l.startsWith("component type")).every((l) => l.startsWith("wiring")),
    JSON.stringify(diff),
  );
  assert.equal(expected.edgeCount, rewritten.edgeCount);
  assert.equal(expected.noteCount, rewritten.noteCount);
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

/**
 * Multi Agent Flow's real shape: ChatInput → A1 → A2 → A3 → ChatOutput, three
 * nodes of the SAME type. This is where an edge that MOVED hides, and 7 of the 26
 * templates have a repeated type like this.
 */
const multiAgent = {
  nodes: [
    { id: "ci", type: "genericNode", data: { type: "ChatInput" } },
    { id: "a1", type: "genericNode", data: { type: "Agent" } },
    { id: "a2", type: "genericNode", data: { type: "Agent" } },
    { id: "a3", type: "genericNode", data: { type: "Agent" } },
    { id: "co", type: "genericNode", data: { type: "ChatOutput" } },
  ],
  edges: [
    { source: "ci", target: "a1" },
    { source: "a1", target: "a2" },
    { source: "a2", target: "a3" },
    { source: "a3", target: "co" },
  ],
};

test("an edge repointed onto a DIFFERENT node of the same type is caught", () => {
  // The defect the edge COUNT cannot see and a type-level topology cannot either:
  // moving `ChatInput → a1` to `ChatInput → a2` leaves the component multiset, the
  // edge count, the note count and the multiset of (sourceType → targetType) pairs
  // all identical. Measured on the live build, this shape is reachable in 7 of the
  // 26 templates.
  const moved = {
    ...multiAgent,
    edges: multiAgent.edges.map((e) =>
      e.source === "ci" ? { source: "ci", target: "a2" } : e,
    ),
  };
  const before = graphShape(multiAgent) as GraphShape;
  const after = graphShape(moved) as GraphShape;

  assert.deepEqual(before.componentTypes, after.componentTypes, "multiset is blind to this");
  assert.equal(before.edgeCount, after.edgeCount, "the edge count is blind to this");
  assert.equal(before.noteCount, after.noteCount);
  assert.notDeepEqual(before.wiring, after.wiring, "the wiring must NOT be blind to it");

  const diff = describeShapeDiff(before, after);
  assert.ok(diff.length > 0, "a moved edge must produce a difference");
  assert.ok(
    diff.every((l) => l.startsWith("wiring")),
    `only the wiring should differ, got: ${JSON.stringify(diff)}`,
  );
});

test("the wiring is order-independent and ignores node ids, which instantiation rewrites", () => {
  // `updateIds` rewrites every node id on instantiation, so comparing ids would
  // fail on every healthy run.
  const renamed = {
    nodes: multiAgent.nodes.map((n) => ({ ...n, id: `x-${n.id}` })).reverse(),
    edges: multiAgent.edges.map((e) => ({ source: `x-${e.source}`, target: `x-${e.target}` })).reverse(),
  };
  assert.deepEqual(graphShape(multiAgent), graphShape(renamed));
});

test("an edge touching a non-component node counts but contributes no wiring", () => {
  const withNoteEdge = {
    nodes: [...multiAgent.nodes, { id: "nt", type: "noteNode", data: {} }],
    edges: [...multiAgent.edges, { source: "nt", target: "a1" }],
  };
  const shape = graphShape(withNoteEdge) as GraphShape;
  assert.equal(shape.edgeCount, 5, "it is still an edge");
  assert.equal(shape.noteCount, 1);
  // a1's incoming stays ChatInput only — the note has no component type to name.
  assert.ok(shape.wiring.includes("Agent ←(ChatInput) →(Agent)"));
});

test("graphShape still cannot throw once wiring is computed", () => {
  for (const bad of [
    { nodes: multiAgent.nodes, edges: [null] },
    { nodes: multiAgent.nodes, edges: [{ source: 1, target: 2 }] },
    { nodes: multiAgent.nodes, edges: [{ source: "nope", target: "a1" }] },
    { nodes: [{ id: "a", type: "genericNode", data: { type: "A" } }], edges: [{}] },
  ]) {
    assert.doesNotThrow(() => graphShape(bad));
  }
  // An unreadable edge is no signal at all, not an edge to guess about.
  assert.equal(graphShape({ nodes: multiAgent.nodes, edges: [null] }), null);
});
