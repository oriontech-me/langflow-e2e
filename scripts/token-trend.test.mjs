import test from "node:test";
import assert from "node:assert/strict";

import { MIN_WINDOW, describeLine, main, readTrend, render, trailingWindow } from "./token-trend.mjs";

// Shaped like the real file: attrib_* since #1217, by_provider since #1300.
const line = ({
  date,
  run_id = `r-${date}`,
  tokens,
  calls,
  usd = 0.001,
  specs = 10,
  attrib = true,
  provider = true,
  unpriced = [],
} = {}) => ({
  version: 1,
  date,
  run_id,
  workflow: "daily-stable",
  totals: { traces: calls, total_tokens: tokens, usd_estimated: usd },
  by_model: [{ model: "gpt-4o-mini", calls, total_tokens: tokens }],
  by_spec: Array.from({ length: specs }, (_, i) => ({ test: `t${i}` })),
  unpriced_models: unpriced,
  ...(attrib ? { attrib_ms: 10, attrib_calls: 3 } : {}),
  ...(provider ? { by_provider: [] } : {}),
});

const five = (over = {}) =>
  ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"].map((date) =>
    line({ date, tokens: 1000, calls: 10, ...over }),
  );

test("the rate is per LLM call, because the raw total measures how much of the suite ran", () => {
  // The real 2026-08-05 shape: a degraded run, 4 calls, a small total. Raw, it
  // reads as a 26x cheaper day than its neighbour; per call it is comparable.
  const busy = describeLine(line({ date: "2026-08-04", tokens: 67099, calls: 52 }));
  const degraded = describeLine(line({ date: "2026-08-05", tokens: 2592, calls: 4 }));
  assert.equal(Math.round(busy.tokens / degraded.tokens), 26, "the raw totals differ 26x");
  assert.ok(busy.tokensPerCall / degraded.tokensPerCall < 2.5, "the rates do not");
});

test("calls are summed from by_model — the schema carries no call field", () => {
  const l = line({ date: "2026-08-10", tokens: 300, calls: 1 });
  l.by_model = [
    { model: "a", calls: 2, total_tokens: 100 },
    { model: "b", calls: 4, total_tokens: 200 },
  ];
  assert.equal(describeLine(l).calls, 6);
  assert.equal(describeLine(l).tokensPerCall, 50);
});

test("a window shorter than the detector's own minimum is not a rate", () => {
  const trend = readTrend(five().slice(0, MIN_WINDOW - 1));
  assert.equal(trend.readable, false);
  assert.match(trend.gaps.join(" "), /only 4 consecutive line\(s\)/);
  // The point the issue asked to be made explicit: an empty anomalies[] below the
  // baseline is empty by construction.
  assert.match(trend.gaps.join(" "), /empty by construction/);
});

test("five lines under one shape ARE readable", () => {
  const trend = readTrend(five());
  assert.equal(trend.readable, true);
  assert.equal(trend.window.length, 5);
  assert.equal(trend.tokensPerCall.n, 5);
  assert.equal(trend.tokensPerCall.mean, 100);
});

test("the window is the TRAILING run of one shape — an older stretch does not count", () => {
  const older = five().map((l) => ({ ...l, attrib_ms: undefined, attrib_calls: undefined }));
  const window = trailingWindow([...older, ...five().slice(0, 2)].map(describeLine));
  assert.equal(window.length, 2, "only the newest shape's run is the window");
});

test("a shape change mid-series truncates the window at the change", () => {
  const lines = [
    line({ date: "2026-08-10", tokens: 1000, calls: 10, provider: false }),
    ...five().slice(0, 3),
  ];
  const trend = readTrend(lines);
  assert.equal(trend.window.length, 3);
  assert.equal(trend.readable, false);
});

test("no dollar trend is reported unless the caller states the window is pricing-stable", () => {
  // The fail-closed half: a token count is measured and survives a pricing edit; a
  // dollar figure is computed from a table this file records no version of.
  const withoutClaim = readTrend(five());
  assert.equal(withoutClaim.usdPerCall, null);
  assert.match(withoutClaim.gaps.join(" "), /no dollar trend/);

  const withClaim = readTrend(five(), { pricesStable: true });
  assert.ok(withClaim.usdPerCall, "an explicit claim unlocks it");
  assert.equal(withClaim.usdPerCall.n, 5);
});

test("a line with unpriced models is excluded from the DOLLAR mean but keeps its token rate", () => {
  const lines = five();
  lines[2].unpriced_models = ["brand-new-model"];
  const trend = readTrend(lines, { pricesStable: true });
  assert.equal(trend.tokensPerCall.n, 5, "the tokens are still measured");
  assert.equal(trend.usdPerCall.n, 4, "the dollars are a FLOOR on that line");
  assert.match(trend.gaps.join(" "), /FLOOR, excluded/);
});

test("a line with zero LLM calls is excluded from the mean, never counted as a zero", () => {
  // #1252's lesson: an unmeasured entry counted as 0 drags every derived figure.
  const lines = five();
  lines[1] = line({ date: "2026-08-11", tokens: 0, calls: 0 });
  const trend = readTrend(lines);
  assert.equal(trend.tokensPerCall.n, 4);
  assert.equal(trend.tokensPerCall.mean, 100, "not 80, which counting the zero would give");
  assert.equal(trend.readable, false, "and the window is short by one, honestly");
  assert.match(trend.gaps.join(" "), /recorded no LLM call/);
});

test("the range is reported alongside the mean, as the issue asked", () => {
  const lines = five();
  lines[0] = line({ date: "2026-08-10", tokens: 500, calls: 10 });
  const trend = readTrend(lines);
  assert.equal(trend.tokensPerCall.min, 50);
  assert.equal(trend.tokensPerCall.max, 100);
});

test("render marks the lines outside the window and never prints a bare verdict", () => {
  const md = render(readTrend([line({ date: "2026-08-09", tokens: 900, calls: 9, provider: false }), ...five()]));
  assert.match(md, /2026-08-09 _\(outside window\)_/);
  assert.match(md, /Tokens per LLM call:\*\* 100 \(range 100–100, n=5\)/);
  assert.match(md, /how much of the suite ran, not a spend rate/);
});

test("main reports a missing or empty file instead of printing an empty table", () => {
  const out = [];
  const log = (m) => out.push(m);
  assert.equal(
    main(["missing.jsonl"], {
      readFile: () => {
        throw new Error("ENOENT");
      },
      log,
    }),
    1,
  );
  assert.match(out.join(" "), /cannot read missing.jsonl/);
  assert.equal(main(["empty.jsonl"], { readFile: () => "\n\n", log }), 1);
  assert.match(out.join(" "), /no lines/);
});

test("main reads the real default path and honours --prices-stable", () => {
  const out = [];
  const raw = five().map((l) => JSON.stringify(l)).join("\n");
  assert.equal(main(["--prices-stable"], { readFile: () => raw, log: (m) => out.push(m) }), 0);
  assert.match(out.join("\n"), /USD per LLM call:\*\* \$0\.00010/);
});
