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

test("five lines under one shape ARE readable, once measurement stability is claimed", () => {
  const trend = readTrend(five(), { measurementStable: true });
  assert.equal(trend.readable, true);
  assert.equal(trend.window.length, 5);
  assert.equal(trend.tokensPerCall.n, 5);
  assert.equal(trend.tokensPerCall.mean, 100);
});

test("the token rate is NOT readable on an unclaimed window, however long", () => {
  // The asymmetric half found in review: only the dollar rate required a claim,
  // while the shape check — two flags over field presence — cannot see a change to
  // how tokens are summed or captured. Neither claim defaults to true now.
  const trend = readTrend(five());
  assert.equal(trend.readable, false);
  assert.match(trend.gaps.join(" "), /unverified for measurement drift/);
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
  const trend = readTrend(lines, { measurementStable: true });
  assert.equal(trend.tokensPerCall.n, 3, "the streak restarts after the gap — lines 3,4,5");
  assert.equal(trend.tokensPerCall.mean, 100, "not 80, which counting the zero would give");
  assert.equal(trend.readable, false, "and the window is short, honestly");
  assert.match(trend.gaps.join(" "), /carry no rate/);
  assert.equal(trend.rawTokens.n, 5, "but the raw total keeps it: that figure IS 'how much ran'");
});

test("CONSECUTIVE means consecutive — five rated lines inside a longer run is not five in a row", () => {
  // Found in review: `rated.length >= 5` over a 6-line window reported readable
  // when line 2 measured nothing, i.e. the streak was 4. The two readings coincide
  // at exactly five lines, which is the only case the tests used to cover.
  const six = [line({ date: "2026-08-09", tokens: 1000, calls: 10 }), ...five()];
  six[1] = line({ date: "2026-08-10", tokens: 0, calls: 0 });
  const trend = readTrend(six, { measurementStable: true });
  assert.equal(trend.window.length, 6);
  assert.equal(trend.rated.length, 4, "the run after the gap is four long");
  assert.equal(trend.readable, false);
});

test("an unreadable denominator is undecidable, not a measured zero", () => {
  // A line with 152 traces and an absent/corrupt by_model was announced as
  // "recorded no LLM call" — the #1012/#1252 rule broken in this file's own
  // denominator, in a file that invokes it three times.
  const noModels = line({ date: "2026-08-14", tokens: 5000, calls: 1 });
  delete noModels.by_model;
  assert.equal(describeLine(noModels).calls, null, "unknown");
  assert.equal(describeLine(noModels).tokensPerCall, null);

  const badCalls = line({ date: "2026-08-14", tokens: 5000, calls: 1 });
  badCalls.by_model = [{ model: "a", calls: "abc", total_tokens: 5000 }];
  assert.equal(describeLine(badCalls).calls, null, "a non-numeric calls field is not a zero either");
});

test("the rate divides span tokens by span calls — never the trace-authoritative total", () => {
  // The published 08-05 figure was 648 on a mixed basis and is 635 on one basis;
  // reports/README.md's own rule is "reconcile against by_model, never totals".
  const mixed = line({ date: "2026-08-14", tokens: 2592, calls: 4 });
  mixed.by_model = [{ model: "a", calls: 4, total_tokens: 2540 }];
  const d = describeLine(mixed);
  assert.equal(d.tokens, 2592, "the raw total is still reported as itself");
  assert.equal(d.spanTokens, 2540);
  assert.equal(d.tokensPerCall, 635);
});

test("the range is reported alongside the mean, as the issue asked", () => {
  const lines = five();
  lines[0] = line({ date: "2026-08-10", tokens: 500, calls: 10 });
  const trend = readTrend(lines);
  assert.equal(trend.tokensPerCall.min, 50);
  assert.equal(trend.tokensPerCall.max, 100);
});

test("render marks the lines outside the window and never prints a bare verdict", () => {
  const lines = [line({ date: "2026-08-09", tokens: 900, calls: 9, provider: false }), ...five()];
  const md = render(readTrend(lines, { measurementStable: true }));
  assert.match(md, /2026-08-09 _\(outside window\)_/);
  assert.match(md, /Tokens per LLM call:\*\* 100 \(range 100–100, n=5\)/);
  assert.match(md, /how much of the suite ran, not a spend rate/);
});

test("when the read is refused, the refusal comes FIRST and the figure is labelled provisional", () => {
  // #1226's "counts before caveats" applied literally here put a copy-pasteable
  // `969 (range 648–1290)` above the line saying it is not a rate — the figure the
  // tool exists to withhold, as its headline.
  const md = render(readTrend(five().slice(0, 2), { measurementStable: true }));
  const verdict = md.indexOf("NOT a rate");
  const figure = md.indexOf("Tokens per LLM call");
  assert.ok(verdict > -1 && verdict < figure, "the refusal must precede the number");
  assert.match(md, /Tokens per LLM call:\*\* 100 .* _\(provisional — see above\)_/);
  // And a supported read leads with the counts, as that lesson intends.
  const good = render(readTrend(five(), { measurementStable: true }));
  assert.doesNotMatch(good, /provisional/);
  assert.match(good, /✅ The window supports quoting a token rate/);
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

test("a malformed line is refused by NAME, not skipped and not thrown", () => {
  // It used to throw an uncaught SyntaxError, unlike its two sibling failures. And
  // skipping it would be worse than either: silently shortening the window is how
  // a read gets quoted over data that was never there.
  const out = [];
  const raw = [JSON.stringify(five()[0]), "{not json", JSON.stringify(five()[1])].join("\n");
  assert.equal(main(["x.jsonl"], { readFile: () => raw, log: (m) => out.push(m) }), 1);
  assert.match(out.join(" "), /x\.jsonl:2 is not valid JSON/);
  assert.match(out.join(" "), /refusing to read a partial series/);
});

test("main honours --prices-stable and --measurement-stable", () => {
  const out = [];
  const raw = five().map((l) => JSON.stringify(l)).join("\n");
  assert.equal(main(["--prices-stable", "--measurement-stable"], { readFile: () => raw, log: (m) => out.push(m) }), 0);
  assert.match(out.join("\n"), /USD per LLM call:\*\* \$0\.00010/);
});
