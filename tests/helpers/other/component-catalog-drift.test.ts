// Unit tests for the component-catalog drift detector (#1040).
// Run with: npm run test:units
//
// Every fixture below is shaped after the real `GET /api/v1/all` measured on
// Langflow Nightly `1.12.0.dev10` (36 categories, 189 component types, plus the
// `component_display_names` metadata map).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffCatalogSnapshots,
  formatCatalogDrift,
  snapshotCatalog,
  type CatalogSnapshot,
} from "./component-catalog-drift";

const snap = (categories: Record<string, string[]>): CatalogSnapshot => ({
  categories,
});

test("component_display_names is excluded — it is a metadata map, not a family", () => {
  // The real shape: one entry per component, keyed by the LOWERCASED type name.
  // Folding it in would list every component twice and make a reparented
  // component undetectable, since it would always appear under this key too.
  const snapshot = snapshotCatalog({
    openai: { OpenAIModelComponent: {}, OpenAIEmbeddings: {} },
    component_display_names: {
      openaimodelcomponent: "OpenAI",
      openaiembeddings: "OpenAI Embeddings",
    },
  });
  assert.deepEqual(Object.keys(snapshot.categories), ["openai"]);
  assert.deepEqual(snapshot.categories.openai, [
    "OpenAIEmbeddings",
    "OpenAIModelComponent",
  ]);
});

test("a non-object value is skipped instead of throwing", () => {
  // This runs inside globalSetup: a throw would abort the whole suite over a
  // reporting feature. The caller reports "no verdict" instead (#1012).
  for (const registry of [null, undefined, 42, "nope", [], { openai: null }]) {
    assert.doesNotThrow(() => snapshotCatalog(registry));
  }
  assert.deepEqual(snapshotCatalog({ openai: null, google: [] }).categories, {});
  assert.deepEqual(snapshotCatalog(["openai"]).categories, {});
});

test("the version is carried for reporting, and omitted when absent", () => {
  assert.equal(snapshotCatalog({}, "1.12.0.dev10").version, "1.12.0.dev10");
  assert.ok(!("version" in snapshotCatalog({})));
});

test("an identical catalog reports no drift", () => {
  const s = snap({ openai: ["OpenAIModelComponent"], google: ["GoogleSearchAPI"] });
  const drift = diffCatalogSnapshots(s, snap({ ...s.categories }));
  assert.equal(drift.hasDrift, false);
  assert.deepEqual(formatCatalogDrift(drift), []);
});

test("a vanished family is reported as ONE category line carrying its count", () => {
  // The #1039 case: the image stops installing a vendor distribution and the
  // whole Groq family disappears. Listing the category AND each of its
  // components would bury the single line that explains all of them.
  const baseline = snap({
    groq: ["GroqModel", "GroqEmbeddings"],
    openai: ["OpenAIModelComponent"],
  });
  const current = snap({ openai: ["OpenAIModelComponent"] });
  const drift = diffCatalogSnapshots(baseline, current);

  assert.deepEqual(drift.removedCategories, [
    { category: "groq", componentCount: 2, vanishedCount: 2 },
  ]);
  assert.deepEqual(
    drift.removedComponents,
    [],
    "components lost with their whole category must not be re-listed individually",
  );
  assert.equal(drift.hasDrift, true);
});

test("a category that vanished with everything REPARENTED does not claim a timeout", () => {
  // The false statement this distinction exists to prevent. `knowledge_bases`
  // disappearing while its component survives under `files_and_knowledge` is the
  // 1.12 migration's normal shape — and "every spec that places one of these will
  // time out" would be flatly wrong, since nothing was lost.
  const drift = diffCatalogSnapshots(
    snap({ knowledge_bases: ["Knowledge"], files_and_knowledge: ["File"] }),
    snap({ files_and_knowledge: ["File", "Knowledge"] }),
  );
  assert.deepEqual(drift.removedCategories, [
    { category: "knowledge_bases", componentCount: 1, vanishedCount: 0 },
  ]);
  assert.deepEqual(drift.movedComponents, [
    { type: "Knowledge", from: "knowledge_bases", to: "files_and_knowledge" },
  ]);

  const [line] = formatCatalogDrift(drift);
  assert.doesNotMatch(
    line,
    /time out|timeout/i,
    `a category whose components all survived must not claim a timeout: ${line}`,
  );
  assert.match(line, /no component lost/);
});

test("a partially-vanished category counts only what is really gone", () => {
  const drift = diffCatalogSnapshots(
    snap({ oldfamily: ["Survivor", "Casualty"], keep: [] }),
    snap({ keep: ["Survivor"] }),
  );
  assert.deepEqual(drift.removedCategories, [
    { category: "oldfamily", componentCount: 2, vanishedCount: 1 },
  ]);
  const [line] = formatCatalogDrift(drift);
  assert.match(line, /1 of 2/);
  assert.match(line, /time out/i);
});

test("a component lost from a surviving category IS listed individually", () => {
  const drift = diffCatalogSnapshots(
    snap({ files_and_knowledge: ["Knowledge", "KnowledgeBase"] }),
    snap({ files_and_knowledge: ["Knowledge"] }),
  );
  assert.deepEqual(drift.removedComponents, [
    { type: "KnowledgeBase", category: "files_and_knowledge" },
  ]);
  assert.deepEqual(drift.removedCategories, []);
});

test("a reparented component is MOVED, not one removal plus one addition", () => {
  // The case that made the snapshot component-level rather than category-level:
  // the component is still present, under a name the spec does not look under.
  // Category-level drift would have shown NOTHING here.
  const drift = diffCatalogSnapshots(
    snap({ knowledge_bases: ["Knowledge"], files_and_knowledge: ["File"] }),
    snap({ knowledge_bases: [], files_and_knowledge: ["File", "Knowledge"] }),
  );
  assert.deepEqual(drift.movedComponents, [
    { type: "Knowledge", from: "knowledge_bases", to: "files_and_knowledge" },
  ]);
  assert.deepEqual(drift.addedComponents, []);
  assert.deepEqual(drift.removedComponents, []);
  assert.equal(drift.hasDrift, true);
});

test("a new category is reported, and its components are not listed twice", () => {
  const drift = diffCatalogSnapshots(
    snap({ openai: ["OpenAIModelComponent"] }),
    snap({ openai: ["OpenAIModelComponent"], mistral: ["MistralModel", "MistralEmbeddings"] }),
  );
  assert.deepEqual(drift.addedCategories, [
    { category: "mistral", componentCount: 2, vanishedCount: 0 },
  ]);
  assert.deepEqual(drift.addedComponents, []);
});

test("a component added to an existing category IS listed", () => {
  const drift = diffCatalogSnapshots(
    snap({ processing: ["Operations"] }),
    snap({ processing: ["Operations", "SplitText"] }),
  );
  assert.deepEqual(drift.addedComponents, [
    { type: "SplitText", category: "processing" },
  ]);
  assert.deepEqual(drift.addedCategories, []);
});

test("removals are rendered BEFORE additions", () => {
  // A new category costs nobody a test; a removed one is the failure this exists
  // to attribute. Same ordering rule as the impacted summary (#1226): the line
  // the reader opened the log for goes first.
  const lines = formatCatalogDrift(
    diffCatalogSnapshots(
      snap({ groq: ["GroqModel"], processing: ["Operations"] }),
      snap({ processing: ["Operations"], brandnew: ["Thing"] }),
    ),
  );
  const removedAt = lines.findIndex((l) => l.includes("category GONE"));
  const addedAt = lines.findIndex((l) => l.includes("category NEW"));
  assert.ok(removedAt >= 0 && addedAt >= 0, lines.join("\n"));
  assert.ok(
    removedAt < addedAt,
    `a removal must be rendered above an addition:\n${lines.join("\n")}`,
  );
});

test("a removed category names the consequence, not just the fact", () => {
  // The whole point is attribution: whoever reads this line should not have to
  // already know that a missing family surfaces as a 30 s selector timeout.
  const [line] = formatCatalogDrift(
    diffCatalogSnapshots(snap({ groq: ["GroqModel"] }), snap({})),
  );
  assert.match(line, /groq/);
  assert.match(line, /time out|timeout/i);
});

test("an emptied category is drift, and is not mistaken for a removed one", () => {
  // Installing `lfx-bundles` without the provider's `langchain-*` package leaves
  // the category PRESENT and EMPTY — measured in #1039. That is a different
  // state from the category being gone, and the two must not be conflated.
  const drift = diffCatalogSnapshots(
    snap({ mistral: ["MistralModel"] }),
    snap({ mistral: [] }),
  );
  assert.deepEqual(drift.removedCategories, [], "the category is still there");
  assert.deepEqual(drift.removedComponents, [
    { type: "MistralModel", category: "mistral" },
  ]);
  assert.equal(drift.hasDrift, true);
});

test("output is deterministic — snapshots and diffs sort", () => {
  // The baseline is committed, so a stable order is what keeps its diff
  // reviewable instead of reshuffling on every refresh.
  const s = snapshotCatalog({ z: { B: {}, A: {} }, a: { D: {}, C: {} } });
  assert.deepEqual(s.categories.z, ["A", "B"]);
  assert.deepEqual(s.categories.a, ["C", "D"]);

  const drift = diffCatalogSnapshots(
    snap({ x: ["keep"] }),
    snap({ x: ["keep", "zeta", "alpha", "mid"] }),
  );
  assert.deepEqual(
    drift.addedComponents.map((c) => c.type),
    ["alpha", "mid", "zeta"],
  );
});
