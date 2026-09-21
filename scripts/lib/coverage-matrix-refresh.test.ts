import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshAreas, JUDGED_FIELDS, type RefreshArea, type Measured } from "./coverage-matrix-refresh";

const area = (over: Partial<RefreshArea> = {}): RefreshArea => ({
  area: "13/14 MCP", inherentRisk: 25, mitigation: 0.65, checklistBullets: 30,
  bulletStates: { x: 24 }, residualRisk: 8.8, probability: 5, impact: 5,
  inputs: { bugQuintile: 5 }, mitigationOverride: null, ...over,
});
const measured = (over: Partial<Measured> = {}): Measured => ({
  bullets: { "13/14 MCP": { bullets: 32, states: { x: 28, " ": 4 }, mitigation: 0.7 } },
  health: {}, specCounts: { "13/14 MCP": { specs: 12, stable: 11 } }, ...over,
});

test("mitigation and residual follow the bullets", () => {
  const { areas } = refreshAreas([area()], measured());
  assert.equal(areas[0].mitigationBulletDerived, 0.7);
  assert.equal(areas[0].mitigation, 0.7);
  assert.equal(areas[0].residualRisk, 7.5); // 25 * (1 - 0.70)
  assert.equal(areas[0].checklistBullets, 32);
});

test("judged fields survive a refresh untouched", () => {
  const before = area();
  const { areas } = refreshAreas([before], measured());
  for (const f of JUDGED_FIELDS) assert.deepEqual(areas[0][f] ?? null, before[f] ?? null, `refresh changed ${f}`);
});

test("the test-health penalty is applied to the effective mitigation", () => {
  const { areas } = refreshAreas([area()], measured({ health: { "13/14 MCP": { chronicHardFailures: 1, chronicFlaky: 1 } } }));
  // gross 0.70, 2 chronic of 11 stable -> penalty 0.70*0.5*(2/11) = 0.064
  assert.equal(areas[0].testHealth?.penalty, 0.064);
  assert.equal(areas[0].mitigation, 0.64);
  assert.equal(areas[0].residualRisk, 9);
});

test("a judged override does NOT follow the bullets", () => {
  const { areas } = refreshAreas([area({ mitigationOverride: 0.72 })], measured());
  assert.equal(areas[0].mitigationBulletDerived, 0.7, "the derived value is still recorded");
  assert.equal(areas[0].mitigation, 0.72, "but the override is what counts");
});

test("an override the bullets have overtaken is reported as stale, not silently kept", () => {
  const { areas, warnings } = refreshAreas(
    [area({ mitigationOverride: 0.65 })],
    measured({ bullets: { "13/14 MCP": { bullets: 32, states: { x: 32 }, mitigation: 0.8 } } }),
  );
  assert.equal(areas[0].mitigation, 0.65, "the override still wins until a human re-judges it");
  assert.match(warnings.join(" "), /EXCEEDS the judged override/);
});

test("an area whose sections match nothing keeps its values and says so", () => {
  const { areas, warnings } = refreshAreas([area()], measured({ bullets: {} }));
  assert.equal(areas[0].mitigation, 0.65, "unchanged rather than zeroed");
  assert.equal(areas[0].checklistBullets, 30);
  assert.match(warnings.join(" "), /no checklist sections matched/);
});

test("areas are re-ranked by the recomputed residual risk", () => {
  const { areas } = refreshAreas(
    [area(), area({ area: "20 Memory Base", inherentRisk: 16, residualRisk: 8.8 })],
    measured({
      bullets: { "13/14 MCP": { bullets: 32, states: { x: 32 }, mitigation: 0.9 },
                 "20 Memory Base": { bullets: 16, states: { x: 9 }, mitigation: 0.45 } },
      specCounts: {},
    }),
  );
  assert.deepEqual(areas.map(a => a.area), ["20 Memory Base", "13/14 MCP"]);
});

test("changes are reported per field so a commit message can name what moved", () => {
  const { changes } = refreshAreas([area()], measured());
  const fields = changes.filter(c => c.area === "13/14 MCP").map(c => c.field);
  assert.ok(fields.includes("mitigation") && fields.includes("checklistBullets"));
  assert.equal(changes.find(c => c.field === "mitigation")?.from, 0.65);
});

test("a refresh with nothing to change reports no changes", () => {
  const settled = refreshAreas([area()], measured()).areas[0];
  const { changes } = refreshAreas([settled], measured());
  assert.deepEqual(changes, [], "refresh must be idempotent");
});
