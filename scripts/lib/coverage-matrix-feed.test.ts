import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeed, buildHistoryLine, nameBulletStates, FEED_VERSION } from "./coverage-matrix-feed";

const area = (over: Record<string, unknown> = {}) => ({
  area: "13/14 MCP", residualRisk: 8.8, inherentRisk: 25, probability: 5, impact: 5,
  mitigation: 0.65, checklistBullets: 30, bulletStates: { x: 24, "-": 2, "~": 1, " ": 3 },
  inputs: { bugQuintile: 5, churnQuintile: 3, fragility: 5, weightedBugs: 56.6, weightedChurn: 1.36 },
  previous: { residualRisk: 10.5, inherentRisk: 25, mitigation: 0.58, checklistBullets: 29 },
  ...over,
});

const input = (areas: ReturnType<typeof area>[], over: Record<string, unknown> = {}) => ({
  data: {
    generated: "2026-09-21", previousGeneration: "2026-08-06",
    corpus: { unclassifiedPct: 26.3 }, churn: { unmatchedPct: 45.9 },
    instrumentRebuild: { bugAxis: "rho 0.940", churnAxis: "rho 0.864", errorBar: "one quintile is noise" },
    formula: { residual: "inherent * (1 - mitigation)" }, mitigationScale: { stable: 0.8 },
    areas,
  },
  keys: { "13/14 MCP": "mcp", "20 Memory Base": "memory-base" },
  bugsByYear: { "13/14 MCP": { "2025": 51, "2026": 18 } },
  specCounts: { "13/14 MCP": { specs: 12, stable: 11 } },
  platformItems: { mcp: [2834] },
  cappedByProduct: ["mcp"],
  instrumentCaveats: {},
  actions: [],
  ...over,
}) as Parameters<typeof buildFeed>[0];

test("areas are ranked by residual risk, highest first", () => {
  const f = buildFeed(input([
    area({ area: "20 Memory Base", residualRisk: 4.4, previous: null }),
    area(),
  ]));
  assert.deepEqual(f.areas.map(a => a.key), ["mcp", "memory-base"]);
  assert.deepEqual(f.areas.map(a => a.rank), [1, 2]);
});

test("a missing stable key is refused, naming the area and the file to fix", () => {
  assert.throws(
    () => buildFeed(input([area({ area: "99 Brand New" })])),
    /no stable key for area "99 Brand New".*coverage-matrix-keys\.json/s,
  );
});

test("delta reports direction against the previous generation, and rank movement", () => {
  const f = buildFeed(input([
    area(),
    area({ area: "20 Memory Base", residualRisk: 4.4, previous: { residualRisk: 2.0, inherentRisk: 8, mitigation: 0.3, checklistBullets: 10 } }),
  ]));
  const mcp = f.areas[0], mem = f.areas[1];
  assert.equal(mcp.delta?.direction, "improved");
  assert.equal(mcp.delta?.residualRisk, -1.7);
  assert.equal(mem.delta?.direction, "worsened");
  // previous ranking was Memory(2.0) below MCP(10.5): both keep their order, so no rank movement
  assert.equal(mcp.previous?.rank, 1);
});

test("an area with no previous generation is flagged new and carries no delta", () => {
  const f = buildFeed(input([area({ area: "20 Memory Base", previous: null })], { keys: { "20 Memory Base": "memory-base" } }));
  assert.equal(f.areas[0].isNew, true);
  assert.equal(f.areas[0].delta, null);
  assert.equal(f.areas[0].previous, null);
  assert.equal(f.totals.newThisGeneration, 1);
});

test("bullet states are named, and an unknown state is reported rather than dropped", () => {
  assert.deepEqual(nameBulletStates({ x: 24, "-": 2, "~": 1, " ": 3 }, 30),
    { total: 30, validated: 24, automatedUnwatched: 2, partial: 1, flaky: 0, empty: 3 });
  // a checklist that grows a sixth marker must not silently lose bullets
  const odd = nameBulletStates({ x: 5 }, 8) as Record<string, number>;
  assert.equal(odd.unaccounted, 3);
});

test("absent bullet states still produce a total, so a consumer never reads undefined", () => {
  const f = buildFeed(input([area({ bulletStates: undefined })]));
  assert.equal(f.areas[0].bullets.total, 30);
  assert.equal(f.areas[0].bullets.validated, 0);
});

test("totals aggregate the unwatched-bullet count the dashboard headlines", () => {
  const f = buildFeed(input([
    area(),
    area({ area: "20 Memory Base", residualRisk: 1, bulletStates: { "-": 83, " ": 13 }, checklistBullets: 96, previous: null }),
  ]));
  assert.equal(f.totals.bulletsAutomatedUnwatched, 85);
  assert.equal(f.totals.cappedByProduct, 1);
});

test("the feed declares its schema and version so the dashboard can branch on it", () => {
  const f = buildFeed(input([area()]));
  assert.equal(f.schema, "coverage-matrix-feed");
  assert.equal(f.version, FEED_VERSION);
  assert.equal(f.source.repository, "oriontech-me/langflow-e2e");
});

test("history line is keyed by stable key, not by label", () => {
  const h = buildHistoryLine(buildFeed(input([area()])));
  assert.equal(h.generated, "2026-09-21");
  assert.ok(h.byArea.mcp, "history must key on the stable id");
  assert.equal(h.byArea.mcp.residual, 8.8);
  assert.deepEqual(h.top[0], { key: "mcp", residualRisk: 8.8 });
});

test("the feed carries both dates, and refresh falls back to the generation", () => {
  const withRefresh = buildFeed({ ...input([area()]), data: { ...input([area()]).data, refreshed: "2026-10-02" } } as Parameters<typeof buildFeed>[0]);
  assert.equal(withRefresh.generated, "2026-09-21");
  assert.equal(withRefresh.refreshed, "2026-10-02", "a refresh is newer than its generation");

  const never = buildFeed(input([area()]));
  assert.equal(never.refreshed, never.generated, "never refreshed reads as the generation date, not null");
});
