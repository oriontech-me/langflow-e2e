// Unit tests for fixture component-code hydration (#1478).
// Run with: npm run test:units
//
// Context: fixture flows under tests/assets/flows/ store a FROZEN copy of each
// component's Python source in `node.data.node.template.code.value`, and Langflow
// execs that copy instead of the installed component. On 2026-08-18 upstream
// commit 99ea9044f (PR #14413, release-1.12.0) deleted `load_kb_metadata` from
// `_kb_paths`, so the frozen copy raised ImportError at graph build and two
// @stable specs waited 90s for a duration badge that could never render.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORED_CODE_TYPES,
  formatHydrationReport,
  hydrateFixtureCode,
  type CodeIndex,
} from "./hydrate-fixture-code";

const node = (id: string, type: string, code?: string) => ({
  id,
  data: {
    type,
    node: {
      template: code === undefined ? {} : { code: { value: code } },
    },
  },
});

const flow = (nodes: unknown[]) => ({ nodes, edges: [] });

test("a node whose frozen code differs from the catalog is hydrated", () => {
  const data = flow([node("Knowledge-ingest", "Knowledge", "OLD SOURCE")]);
  const index: CodeIndex = { Knowledge: "NEW SOURCE" };

  const r = hydrateFixtureCode(data, index);

  assert.deepEqual(r.hydrated, ["Knowledge-ingest"]);
  assert.deepEqual(r.unchanged, []);
  assert.equal(
    (r.data.nodes[0]! as ReturnType<typeof node>).data.node.template.code!.value,
    "NEW SOURCE",
  );
});

test("a node already identical to the catalog is NOT counted as hydrated", () => {
  // Otherwise every run reports drift for every node and the report is noise —
  // the mode=count lesson: a line nobody can act on is a line nobody reads.
  const data = flow([node("SplitText-doc01", "SplitText", "SAME")]);

  const r = hydrateFixtureCode(data, { SplitText: "SAME" });

  assert.deepEqual(r.hydrated, []);
  assert.deepEqual(r.unchanged, ["SplitText-doc01"]);
});

test("a component type absent from the index is reported, and no node is rewritten", () => {
  // A partially rewritten payload is worse than an untouched one: it would be
  // created, then fail at graph build with a cause the report already knew.
  const data = flow([
    node("Knowledge-ingest", "Knowledge", "OLD"),
    node("Gone-1", "VanishedComponent", "OLD"),
  ]);

  const r = hydrateFixtureCode(data, { Knowledge: "NEW" });

  assert.deepEqual(r.missing, ["VanishedComponent"]);
  assert.equal(
    (r.data.nodes[0]! as ReturnType<typeof node>).data.node.template.code!.value,
    "OLD",
  );
  assert.deepEqual(r.hydrated, []);
});

test("a duplicated missing type is reported once, sorted", () => {
  const data = flow([
    node("b", "Zeta", "OLD"),
    node("a", "Alpha", "OLD"),
    node("c", "Zeta", "OLD"),
  ]);

  const r = hydrateFixtureCode(data, {});

  assert.deepEqual(r.missing, ["Alpha", "Zeta"]);
});

test("a node without template.code is skipped, never reported as missing", () => {
  // Not every node is a coded component; counting those as drift would make the
  // report unreadable, and counting them as missing would blame the image.
  const data = flow([node("Note-1", "NoteNode")]);

  const r = hydrateFixtureCode(data, {});

  assert.deepEqual(r.skipped, ["Note-1"]);
  assert.deepEqual(r.missing, []);
});

test("the caller's payload is never mutated", () => {
  // A spec hydrates once per test in a serial file; a mutated input would leak
  // the previous test's state into the next one.
  const data = flow([node("Knowledge-ingest", "Knowledge", "OLD")]);

  hydrateFixtureCode(data, { Knowledge: "NEW" });

  assert.equal(
    (data.nodes[0] as ReturnType<typeof node>).data.node.template.code!.value!,
    "OLD",
  );
});

test("regression #1478: hydration removes the frozen load_kb_metadata import", () => {
  // The exact failure: the frozen copy imports a symbol deleted upstream in
  // 99ea9044f, so `Graph.from_payload` raises
  // ImportError(Cannot import name 'load_kb_metadata' ...) and the graph is
  // never built. Fails if hydration is ever reverted.
  const frozen =
    "from lfx.components.files_and_knowledge._kb_paths import (\n    load_kb_metadata,\n)\n";
  const current =
    "from lfx.components.files_and_knowledge._kb_paths import (\n    get_knowledge_bases_root_path,\n)\n";
  const data = flow([node("Knowledge-ingest", "Knowledge", frozen)]);

  const r = hydrateFixtureCode(data, { Knowledge: current });

  assert.equal(
    (r.data.nodes[0]! as ReturnType<typeof node>).data.node.template.code!.value!.includes(
      "load_kb_metadata",
    ),
    false,
  );
});

test("the report names what happened, and says so even when nothing changed", () => {
  // Never silent: "no line" must be readable as "the mechanism did not run".
  const allCurrent = hydrateFixtureCode(
    flow([node("a", "ChatInput", "SAME")]),
    { ChatInput: "SAME" },
  );
  assert.match(
    formatHydrationReport("x-fixture.json", allCurrent),
    /all 1 node[s]? already current/,
  );

  const changed = hydrateFixtureCode(flow([node("a", "ChatInput", "OLD")]), {
    ChatInput: "NEW",
  });
  assert.match(formatHydrationReport("x-fixture.json", changed), /hydrated: a/);
});

test("a payload with no nodes array is refused as malformed", () => {
  assert.throws(() => hydrateFixtureCode({}, {}), /nodes/);
});

test("a component type inherited from Object.prototype is never treated as present", () => {
  // `type in index` reads true for "toString"/"constructor" on a plain object
  // even when the index never declared them, and would assign a function to
  // code.value. Object.hasOwn must be used instead.
  const data = flow([node("Weird-1", "toString", "OLD")]);

  const r = hydrateFixtureCode(data, {});

  assert.deepEqual(r.missing, ["toString"]);
  assert.deepEqual(r.hydrated, []);
});

test("a CustomComponent node's authored code is refused, not hydrated", () => {
  // Its stored code is the spec's subject; silently replacing it with the
  // catalog's empty template would make the spec pass having verified
  // nothing.
  assert.ok(AUTHORED_CODE_TYPES.has("CustomComponent"));
  const data = flow([
    node("Custom-1", "CustomComponent", "def build(self): ..."),
  ]);

  assert.throws(
    () => hydrateFixtureCode(data, { CustomComponent: "OTHER" }),
    /authored/,
  );
});
