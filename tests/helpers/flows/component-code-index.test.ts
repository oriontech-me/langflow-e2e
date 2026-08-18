// Unit tests for the component code index (#1478).
// Run with: npm run test:units
//
// Fixtures are shaped after the real `GET /api/v1/all` measured on
// 1.12.0.dev31: `{ category: { ComponentType: { template: { code: { value } } } } }`,
// plus the `component_display_names` metadata map that is NOT a category.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodeIndex } from "./component-code-index";

test("indexes component types by their stored code value", () => {
  const index = buildCodeIndex({
    files_and_knowledge: {
      Knowledge: { template: { code: { value: "KNOWLEDGE SOURCE" } } },
    },
    inputs: { ChatInput: { template: { code: { value: "CHATINPUT SOURCE" } } } },
  });

  assert.deepEqual(index, {
    Knowledge: "KNOWLEDGE SOURCE",
    ChatInput: "CHATINPUT SOURCE",
  });
});

test("component_display_names is skipped — it is a metadata map, not a category", () => {
  // 189 entries keyed by the lowercased type name; folding it in would add
  // phantom types with no code at all.
  const index = buildCodeIndex({
    component_display_names: { knowledge: "Knowledge", chatinput: "Chat Input" },
    inputs: { ChatInput: { template: { code: { value: "SRC" } } } },
  });

  assert.deepEqual(Object.keys(index), ["ChatInput"]);
});

test("a component with no code field is omitted rather than indexed as empty", () => {
  const index = buildCodeIndex({
    inputs: { NoCode: { template: {} }, WithCode: { template: { code: { value: "SRC" } } } },
  });

  assert.deepEqual(Object.keys(index), ["WithCode"]);
});

test("a catalog that yields zero types is refused, not returned empty", () => {
  // A 200 with an empty body (registry still starting, a disguised 401) would
  // otherwise mark every fixture node `missing` and blame the fixture for an
  // instance problem — the 200-with-no-categories floor (#1012).
  assert.throws(() => buildCodeIndex({}), /no component types/);
  assert.throws(() => buildCodeIndex({ detail: "Not authenticated" }), /no component types/);
  assert.throws(() => buildCodeIndex(null), /no component types/);
});
