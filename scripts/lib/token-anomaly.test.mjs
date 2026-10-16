// Unit tests for the token anomaly baseline (issue #1197).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { median, detectAnomalies } from "./token-anomaly.mjs";

const line = (usd, specs = []) => ({
  totals: { usd_estimated: usd },
  by_spec: specs,
});

test("median handles odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("median of an empty list is null, never 0", () => {
  assert.equal(median([]), null);
});

test("no baseline means no anomaly — a first run never alarms", () => {
  const out = detectAnomalies({ run: line(50), history: [line(1), line(1)], minBaseline: 5 });
  assert.deepEqual(out, []);
});

test("a run above the ratio against the median is flagged", () => {
  const history = [line(1), line(1), line(1.2), line(0.9), line(1.1)];
  const out = detectAnomalies({ run: line(6), history, minBaseline: 5, ratio: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, "run");
  assert.equal(out[0].baseline_usd, 1);
  assert.equal(out[0].ratio, 6);
});

test("a per-spec jump is flagged with the spec as the key", () => {
  const spec = (usd) => [{ file: "a.spec.ts", usd_estimated: usd }];
  const history = [
    line(1, spec(0.1)),
    line(1, spec(0.1)),
    line(1, spec(0.12)),
    line(1, spec(0.1)),
    line(1, spec(0.08)),
  ];
  const out = detectAnomalies({ run: line(1, spec(0.9)), history, minBaseline: 5, ratio: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, "spec");
  assert.equal(out[0].key, "a.spec.ts");
});

test("a spec with no history of its own is not an anomaly", () => {
  const history = [line(1), line(1), line(1), line(1), line(1)];
  const out = detectAnomalies({
    run: line(1, [{ file: "new.spec.ts", usd_estimated: 5 }]),
    history,
    minBaseline: 5,
  });
  assert.deepEqual(out, []);
});

test("a zero baseline never divides — it is skipped", () => {
  const history = [line(0), line(0), line(0), line(0), line(0)];
  const out = detectAnomalies({ run: line(3), history, minBaseline: 5 });
  assert.deepEqual(out, []);
});

// #1197 review, finding I5: 2-decimal rounding renders a real sub-cent trace
// cost as "$0.00", making the anomaly line read as a contradiction ("run: $0.00
// vs a $0.00 baseline"). run_usd/baseline_usd must keep enough precision to
// stay distinguishable from 0.
test("run_usd and baseline_usd keep sub-cent precision instead of rounding to 0", () => {
  const history = [line(0.00003), line(0.00003), line(0.00003), line(0.00003), line(0.00003)];
  const out = detectAnomalies({ run: line(0.00021), history, minBaseline: 5, ratio: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].run_usd, 0.00021, "a real sub-cent run cost must not round to 0");
  assert.equal(out[0].baseline_usd, 0.00003, "a real sub-cent baseline must not round to 0");
  assert.ok(out[0].run_usd > 0 && out[0].baseline_usd > 0);
});

// ─── Floors stay out of the baseline (#2288) ─────────────────────────────────

test("a history line or spec entry with unmeasured calls never lowers the baseline", () => {
  const measured = (usd) => ({ totals: { usd_estimated: usd }, by_spec: [{ file: "a.spec.ts", usd_estimated: usd }] });
  // Four measured days at $1 and four Thursdays on Foundry whose agent spend read $0.
  const floor = {
    totals: { usd_estimated: 0 },
    unmeasured: { calls: 40, traces: 20, by_model: [] },
    by_spec: [{ file: "a.spec.ts", usd_estimated: 0, unmeasured_calls: 2 }],
  };
  const history = [measured(1), floor, measured(1), floor, measured(1), floor, measured(1), floor, measured(1)];
  // With the floors counted the median would be $1 over nine lines still, so make
  // the floors the majority to show they are out, not outvoted.
  const floorHeavy = [...history, floor, floor];
  const run = { totals: { usd_estimated: 2 }, by_spec: [{ file: "a.spec.ts", usd_estimated: 2 }] };
  assert.deepEqual(detectAnomalies({ run, history: floorHeavy }), [], "2x a measured $1 is no anomaly");
  // Counted, the floors would pull the median to $0, which divides by nothing and
  // hides a genuine 5x day; with them out, the 5x day still trips.
  const spike = { totals: { usd_estimated: 5 }, by_spec: [{ file: "a.spec.ts", usd_estimated: 5 }] };
  assert.deepEqual(
    detectAnomalies({ run: spike, history: floorHeavy }).map((a) => a.scope),
    ["run", "spec"],
  );
});

test("too few measured lines is no baseline, however many floors there are", () => {
  const floor = { totals: { usd_estimated: 0 }, unmeasured: { calls: 1 }, by_spec: [] };
  const history = [floor, floor, floor, floor, floor, { totals: { usd_estimated: 1 }, by_spec: [] }];
  assert.deepEqual(detectAnomalies({ run: { totals: { usd_estimated: 100 }, by_spec: [] }, history }), []);
});
