// Unit tests for scripts/render-triage-summary.mjs.
// Run with: npm run test:scripts
//
// What these protect: the three flake classes land under the action the protocol gives
// each one, a count built on rows that predate the recurrence keys says so on the line
// that cites it, and "skips not read" never renders as "no skips" (#1012, #2031).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTriageSummary, recurrenceText, SKIPS_LISTED } from "./render-triage-summary.mjs";

const rec = (dates, extra = {}) => ({
  count: dates.length,
  dates,
  same_signature: dates.length >= 2,
  total_count: dates.length,
  total_dates: dates,
  unverified_dates: [],
  outage_by_date: {},
  ...extra,
});

const entry = (test, extra = {}) => ({
  test,
  file: `tests/${test}.spec.ts`,
  line: 10,
  error_signature: "TimeoutError: locator.click: Timeout 20000ms exceeded.",
  infra_signature: null,
  recurrence: rec(["2026-09-21"]),
  ...extra,
});

const base = { guard_tripped: false, hard_failures: [], flakes: [], provider_wide_clusters: [], skips: [], skips_read: true };

test("each flake lands under the action the protocol gives its class", () => {
  const md = renderTriageSummary({
    ...base,
    flakes: [
      entry("recurs", { actionable: true, recurrence: rec(["2026-09-15", "2026-09-21"]) }),
      entry("wedge", {
        actionable: false,
        infra_signature: "api-request-timeout",
        infra_excluded: { signature: "api-request-timeout" },
        recurrence: rec(["2026-09-10", "2026-09-21"]),
      }),
      entry("measured", {
        actionable: false,
        outage_excluded: { min_coverage: 0.8 },
        outage_overlap: { state: "overlapped", min_coverage: 0.82, shard_down_pct: 0.41 },
        recurrence: rec(["2026-09-08", "2026-09-21"]),
      }),
      entry("once", { actionable: false }),
    ],
  });
  const section = (heading) => md.slice(md.indexOf(heading), md.indexOf("\n\n_", md.indexOf(heading) + 1) >>> 0);
  assert.match(section("_Recurrent under the same cause (1)"), /recurs\.spec\.ts/);
  assert.match(md, /open a dedicated issue and quarantine via PR/);
  const exempt = section("_Recurrent, but exempt as backend collateral (2)");
  assert.match(exempt, /wedge\.spec\.ts[\s\S]*transport-level `api-request-timeout` \(#1310\)/);
  assert.match(exempt, /measured\.spec\.ts[\s\S]*82% inside a measured outage, shard 41% down[\s\S]*#1763/);
  assert.match(section("_Not recurrent (1)"), /once\.spec\.ts/);
  assert.doesNotMatch(section("_Not recurrent (1)"), /recurs\.spec\.ts|wedge\.spec\.ts/);
});

test("a flake with no verdict at all is never promoted to the actionable list", () => {
  // `actionable` absent is not true: the dataset did not say file it.
  const md = renderTriageSummary({ ...base, flakes: [entry("unknown", { recurrence: rec(["2026-09-20", "2026-09-21"]) })] });
  assert.doesNotMatch(md, /Recurrent under the same cause/);
  assert.match(md, /_Not recurrent \(1\)/);
});

test("a count built on rows before the recurrence keys says so where it is cited", () => {
  const text = recurrenceText(rec(["2026-09-10", "2026-09-14", "2026-09-21"], { unverified_dates: ["2026-09-10", "2026-09-14"] }));
  assert.match(text, /same cause on 3 run\(s\): 2026-09-10, 2026-09-14, 2026-09-21/);
  assert.match(text, /2 of them predate the recurrence keys \(2026-09-10, 2026-09-14\): check that run's log/);
});

test("runs are counted as runs, and other causes are named apart", () => {
  const text = recurrenceText(rec(["2026-09-14", "2026-09-14"], { total_count: 3 }));
  assert.match(text, /same cause on 2 run\(s\): 2026-09-14, 2026-09-14/);
  assert.match(text, /1 other run\(s\) with a different cause/);
  assert.equal(recurrenceText(rec(["2026-09-21"])), "first occurrence in the window");
});

test("skips not read are not 'no skips'", () => {
  assert.match(renderTriageSummary({ ...base, skips_read: false }), /\*\*Skips \(not read\)\*\*[\s\S]*not the same as none/);
  // Absent is fail-closed too: a dataset that does not say it read the report did not.
  const { skips_read, ...legacy } = base;
  void skips_read;
  assert.match(renderTriageSummary(legacy), /Skips \(not read\)/);
  assert.match(renderTriageSummary(base), /\*\*Skips \(0\)\*\*\n\nNone\./);
});

test("skips are listed with their reasons, and a long list is counted rather than dumped", () => {
  const skips = Array.from({ length: SKIPS_LISTED + 3 }, (_, i) => ({ test: `t${i}`, file: `f${i}.spec.ts`, reason: i ? `reason ${i}` : "" }));
  const md = renderTriageSummary({ ...base, skips });
  assert.match(md, new RegExp(`\\*\\*Skips \\(${SKIPS_LISTED + 3}\\)\\*\\*`));
  assert.match(md, /`f0\.spec\.ts` — t0: _no reason recorded_/);
  assert.match(md, /`f1\.spec\.ts` — t1: reason 1/);
  assert.match(md, /…and 3 more/);
  assert.doesNotMatch(md, new RegExp(`t${SKIPS_LISTED}:`));
});

test("hard failures carry their recurrence and a transport-level signature", () => {
  const md = renderTriageSummary({
    ...base,
    hard_failures: [entry("hard", { infra_signature: "econnrefused", recurrence: rec(["2026-09-18", "2026-09-21"]) })],
  });
  assert.match(md, /\*\*Hard failures \(1\)\*\*[\s\S]*hard\.spec\.ts:10[\s\S]*same cause on 2 run\(s\)[\s\S]*transport-level \(`econnrefused`\)/);
  assert.match(renderTriageSummary(base), /\*\*Hard failures \(0\)\*\*\n\nNone\./);
});

test("the guard and only the provider-WIDE clusters are raised", () => {
  const md = renderTriageSummary({
    ...base,
    guard_tripped: true,
    provider_wide_clusters: [
      { provider: "openai", count: 3, files: ["a.spec.ts", "b.spec.ts"], provider_wide: true },
      { provider: "anthropic", count: 2, files: ["c.spec.ts"], provider_wide: false },
    ],
  });
  assert.match(md, /mass-failure guard tripped/);
  assert.match(md, /\*\*openai\*\*: 3 entries across 2 spec files/);
  assert.doesNotMatch(md, /anthropic/, "two failures of one file are that file's problem, not the provider's");
});

test("a backtick in a title or signature cannot break out of its code span", () => {
  const md = renderTriageSummary({ ...base, hard_failures: [entry("x", { error_signature: "expected `a` got `b`" })] });
  assert.match(md, /`expected 'a' got 'b'`/);
});
