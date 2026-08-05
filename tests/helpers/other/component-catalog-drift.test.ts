// Unit tests for the component-catalog drift detector (#1040).
// Run with: npm run test:units
//
// Every fixture below is shaped after the real `GET /api/v1/all` measured on
// Langflow Nightly `1.12.0.dev10` (36 categories, 189 component types, plus the
// `component_display_names` metadata map).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  catalogVerdict,
  describeSnapshotDefect,
  diffCatalogSnapshots,
  formatCatalogDrift,
  snapshotCatalog,
  type CatalogSnapshot,
} from "./component-catalog-drift";

const BASELINE_PATH = path.join(
  __dirname,
  "../../assets/catalog/component-catalog-baseline.json",
);

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
    { category: "groq", componentCount: 2, vanishedTypes: ["GroqModel", "GroqEmbeddings"] },
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
    { category: "knowledge_bases", componentCount: 1, vanishedTypes: [] },
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
    { category: "oldfamily", componentCount: 2, vanishedTypes: ["Casualty"] },
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
    { category: "mistral", componentCount: 2, vanishedTypes: [] },
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

test("a malformed baseline is refused BEFORE it can abort the suite", () => {
  // The hazard: the baseline is read off disk and `JSON.parse` succeeding says
  // nothing about its shape. The most natural wrong repair is pasting the raw
  // `GET /api/v1/all` body, whose values are `{type: template}` objects and not
  // arrays of type names. That parses, and `diffCatalogSnapshots` then iterates a
  // non-array and THROWS — out of globalSetup, aborting the run with zero tests
  // executed. `describeSnapshotDefect` is what stands between the two.
  const rawApiShape = { categories: { agents: { Agent: { template: {} } } } };
  assert.throws(
    () =>
      diffCatalogSnapshots(
        rawApiShape as unknown as CatalogSnapshot,
        snap({ agents: ["Agent"] }),
      ),
    /iterable|undefined|not a function/i,
    "if this stops throwing the guard is no longer load-bearing — keep it anyway, but say so here",
  );

  for (const bad of [
    null,
    undefined,
    42,
    "nope",
    [],
    {},
    { categories: null },
    { categories: [] },
    { categories: "openai" },
    { categories: {} },
    rawApiShape,
    { categories: { agents: null } },
    { categories: { agents: 3 } },
    { categories: { agents: "Agent" } },
    { categories: { agents: ["Agent", 7] } },
  ]) {
    const defect = describeSnapshotDefect(bad);
    assert.ok(
      defect,
      `must be refused with a named defect, was accepted: ${JSON.stringify(bad)}`,
    );
  }

  // A string value is the one malformed shape that does NOT throw in the diff —
  // it iterates characters and silently reports nonsense. Named too.
  assert.match(
    String(describeSnapshotDefect({ categories: { agents: "Agent" } })),
    /not an array/,
  );
  // The raw-API confusion is the likeliest hand-repair, so the message says so
  // rather than only that the type is wrong.
  assert.match(
    String(describeSnapshotDefect(rawApiShape)),
    /raw `GET \/api\/v1\/all` shape/,
  );
});

test("the validator accepts the REAL committed baseline", () => {
  // Guards the other direction: a validator strict enough to reject the artifact
  // it exists to protect would turn every run's verdict into "no baseline". This
  // reads the committed file, not a fixture, for exactly that reason.
  const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  assert.equal(describeSnapshotDefect(parsed), null);

  const snapshot = parsed as CatalogSnapshot;
  assert.equal(
    diffCatalogSnapshots(snapshot, snapshot).hasDrift,
    false,
    "the committed baseline must not drift against itself",
  );
});

test("a type registered by two categories does not report a phantom MOVED", () => {
  // `componentIndex` is last-wins over a relation that is not guaranteed 1:1, and
  // an aggregate `lfx-bundles` image (104 categories) invites a duplicate. With
  // insertion order the winner depended on the order the API emitted its keys, so
  // the SAME catalog reported `MOVED` — a warning no baseline refresh can silence.
  const registryA = { core_x: { A: {}, Shared: {} }, bundle_y: { B: {}, Shared: {} } };
  const registryB = { bundle_y: { Shared: {}, B: {} }, core_x: { Shared: {}, A: {} } };
  const drift = diffCatalogSnapshots(
    snapshotCatalog(registryA),
    snapshotCatalog(registryB),
  );
  assert.deepEqual(drift.movedComponents, []);
  assert.equal(drift.hasDrift, false, formatCatalogDrift(drift).join("\n"));
});

test("a partially-vanished category NAMES what is gone, not just how many", () => {
  // The mechanism's whole claim is that the cause is named before the first spec
  // runs. "2 of 3 gone" leaves the reader hand-diffing the baseline for which two.
  const [line] = formatCatalogDrift(
    diffCatalogSnapshots(
      snap({ oldfamily: ["Survivor", "Casualty", "AlsoGone"], keep: [] }),
      snap({ keep: ["Survivor"] }),
    ),
  );
  assert.match(line, /2 of 3/);
  assert.match(line, /Casualty/);
  assert.match(line, /AlsoGone/);
  assert.doesNotMatch(line, /Survivor/, "a reparented component is not a casualty");
});

test("a long casualty list is capped so it cannot bury the category line", () => {
  const many = Array.from({ length: 12 }, (_, i) => `Comp${String(i).padStart(2, "0")}`);
  const [line] = formatCatalogDrift(
    diffCatalogSnapshots(snap({ bigfamily: many }), snap({ keep: [] })),
  );
  assert.match(line, /12 of 12/);
  assert.match(line, /and 4 more/);
  assert.ok(line.split("\n").length === 1, "the consequence stays one line");
});

test("a reparent into a BRAND-NEW category is not called 'surviving'", () => {
  // The target of a reparent is routinely a category that is itself new, which
  // did not survive anything.
  const lines = formatCatalogDrift(
    diffCatalogSnapshots(snap({ old_fam: ["X"] }), snap({ brand_new: ["X"] })),
  );
  const gone = lines.find((l) => l.includes("category GONE")) as string;
  assert.match(gone, /no component lost/);
  assert.doesNotMatch(gone, /surviving/);
  assert.ok(lines.some((l) => l.includes("category NEW: brand_new")), lines.join("\n"));
});

test("catalogVerdict NEVER throws — on any input, from either side", () => {
  // The property that keeps a reporting feature from costing a day of coverage.
  // `globalSetup` calls this and nothing else; a throw escaping it aborts the run
  // with zero tests executed, which `daily-stable.yml` reports as an infra abort
  // (#1012's "executed ZERO tests"). The inline version this replaced was one
  // unguarded `for` away from exactly that, on a hand-edited baseline.
  const wild: unknown[] = [
    null,
    undefined,
    42,
    "",
    "nope",
    [],
    {},
    { categories: null },
    { categories: [] },
    { categories: {} },
    { categories: { agents: null } },
    { categories: { agents: 3 } },
    { categories: { agents: "Agent" } },
    { categories: { agents: ["Agent", 7] } },
    { categories: { agents: { Agent: { template: {} } } } },
    { detail: "Not authenticated" },
    { categories: { agents: ["Agent"] }, version: 3 },
  ];
  const sane = { categories: { agents: ["Agent"] } };
  const saneRegistry = { agents: { Agent: {} } };

  for (const baseline of [...wild, sane]) {
    for (const registry of [...wild, saneRegistry]) {
      let verdict;
      assert.doesNotThrow(() => {
        verdict = catalogVerdict(baseline, registry);
      }, `threw on baseline=${JSON.stringify(baseline)} registry=${JSON.stringify(registry)}`);
      const v = verdict as unknown as ReturnType<typeof catalogVerdict>;
      assert.ok(
        ["clean", "drift", "unknown"].includes(v.kind),
        `no verdict for baseline=${JSON.stringify(baseline)}`,
      );
      // An unknown verdict must always say why — silence would read as clean.
      if (v.kind === "unknown") assert.ok(v.reason, "an unknown verdict owes a reason");
    }
  }
});

test("a malformed baseline yields UNKNOWN, never a drift report", () => {
  // The distinction #1012 exists for: a baseline nobody can read is not evidence
  // that the catalog is fine, and it is not evidence that 36 categories vanished
  // either. Both wrong answers were reachable before.
  const registry = { agents: { Agent: {} }, openai: { OpenAIModel: {} } };
  for (const bad of [
    { categories: { agents: { Agent: { template: {} } } } }, // the raw API shape
    { categories: {} },
    { categories: null },
    null,
  ]) {
    const verdict = catalogVerdict(bad, registry);
    assert.equal(verdict.kind, "unknown", JSON.stringify(bad));
    assert.match(String(verdict.reason), /baseline is unusable/);
    assert.deepEqual(verdict.lines, []);
  }
});

test("an empty catalog response yields UNKNOWN, not 'every category is gone'", () => {
  // A 200 is not a catalog. `snapshotCatalog` is tolerant by design, so an error
  // envelope, `{}` and a still-building registry all normalise to zero
  // categories — and diffing that against the real baseline reports EVERY
  // category as GONE, the loudest false verdict this mechanism can emit. The
  // baseline writer already refuses this state; the reader had no floor at all.
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  for (const registry of [{}, null, [], { detail: "Not authenticated" }]) {
    const verdict = catalogVerdict(baseline, registry);
    assert.equal(verdict.kind, "unknown", JSON.stringify(registry));
    assert.match(String(verdict.reason), /no component categories/);
    assert.deepEqual(
      verdict.lines,
      [],
      "an unreadable catalog must not be rendered as mass removal",
    );
  }
});

test("catalogVerdict is CLEAN on the real baseline against its own registry shape", () => {
  // End to end over the committed artifact and a raw-API-shaped registry built
  // from it, so the happy path is pinned on real data rather than a fixture — the
  // same reason the validator test reads the file.
  const baseline = JSON.parse(
    fs.readFileSync(BASELINE_PATH, "utf8"),
  ) as CatalogSnapshot;
  const registry: Record<string, unknown> = { component_display_names: {} };
  for (const [category, types] of Object.entries(baseline.categories)) {
    registry[category] = Object.fromEntries(types.map((t) => [t, { template: {} }]));
  }
  const verdict = catalogVerdict(baseline, registry);
  assert.equal(verdict.kind, "clean", verdict.lines.join("\n") || verdict.reason);
  assert.equal(verdict.categoryCount, Object.keys(baseline.categories).length);

  // And it reports drift when one family is dropped from that same registry.
  const [dropped] = Object.keys(baseline.categories);
  delete registry[dropped];
  const drifted = catalogVerdict(baseline, registry);
  assert.equal(drifted.kind, "drift");
  assert.ok(
    drifted.lines.some((l) => l.includes(`category GONE: ${dropped}`)),
    drifted.lines.join("\n"),
  );
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
