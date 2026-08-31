// Unit tests for the provider-list verdict (issue #1648).
// Run with: npm run test:units
//
// What rides on this file: `providerRowVerdict` is the difference between a
// provider-row failure that names the instance and one that names nothing. The
// measured cost of naming nothing was 20 attempts across 8 of 25 dailies, over
// 12 spec files and three providers, every one of them reported as
//
//   TimeoutError: locator.click: Timeout 20000ms exceeded.
//   Call log:
//     - waiting for getByTestId('provider-item-OpenAI')
//
// — a string that matches none of the five patterns in
// `scripts/lib/infra-signature-patterns.json`, so the wedge exemption could not
// claim any of them (#1589), and that `reports/daily-history.jsonl` stores as a
// first-error line carrying no locator at all (#1626).
//
// The classification is pure precisely so these branches are reachable here. On
// a live instance you can only produce `stalled` by wedging the backend and
// `errored` by breaking the catalog endpoint — neither is something a spec may
// do — which is the same argument `censusForTarget` (#1464) and
// `decideEntryPoint` (#1465) settled for their own decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_LIST_TESTIDS,
  providerNameFromTestId,
  providerRowVerdict,
  type ProviderListSnapshot,
} from "./provider-list-state";

const EMPTY: ProviderListSnapshot = {
  loading: false,
  errored: false,
  filteredEmpty: false,
  listed: false,
  rows: [],
  searchTerm: "",
};

const snapshot = (over: Partial<ProviderListSnapshot>): ProviderListSnapshot => ({
  ...EMPTY,
  ...over,
});

test("a list still loading is an INSTANCE stall, and says so", () => {
  const v = providerRowVerdict(
    snapshot({ loading: true }),
    "provider-item-OpenAI",
    20000,
  );
  assert.equal(v.kind, "stalled");
  assert.match(v.message, /PROVIDER_LIST_STALLED/);
  assert.match(v.message, /"OpenAI"/);
  assert.match(v.message, /20000ms/);
  // The endpoint is named because that is what a triager has to go look at.
  assert.match(v.message, /GET \/api\/v1\/models\?purpose=configure/);
  // And the temptation this whole module exists to refuse is refused in text.
  assert.match(v.message, /Do not raise this timeout/);
});

test("stalled outranks every other state — a list that never arrived has no content to judge", () => {
  // The real 2026-08-31 shape: loading on screen, nothing else rendered. But
  // assert the precedence with every other flag ALSO set, because the ordering
  // is the actual invariant: a mid-refetch list can carry stale rows, and
  // reporting "PROVIDER_ABSENT — the list settled" about a list that is still
  // fetching is the false product finding this issue was filed as.
  const v = providerRowVerdict(
    snapshot({
      loading: true,
      errored: true,
      filteredEmpty: true,
      listed: true,
      rows: ["Anthropic"],
      searchTerm: "gpt-4o-mini",
    }),
    "provider-item-OpenAI",
    10000,
  );
  assert.equal(v.kind, "stalled");
});

test("a failed catalog fetch is reported as a backend verdict, not a missing provider", () => {
  const v = providerRowVerdict(
    snapshot({ errored: true }),
    "provider-item-Anthropic",
    20000,
  );
  assert.equal(v.kind, "errored");
  assert.match(v.message, /PROVIDER_LIST_ERROR/);
  assert.match(v.message, /"Anthropic"/);
  assert.match(v.message, /not a missing provider/);
});

test("a search box left filled is a SUITE defect — even when the list itself rendered", () => {
  // `model-provider-model-toggle.spec.ts` fills `model-search-input` two steps
  // before it reopens the panel; a sibling filling `provider-search-input` and
  // not clearing it would empty the list with the backend perfectly healthy.
  const v = providerRowVerdict(
    snapshot({ listed: true, rows: ["Ollama"], searchTerm: "gpt-4o-mini" }),
    "provider-item-OpenAI",
    20000,
  );
  assert.equal(v.kind, "filtered");
  assert.match(v.message, /PROVIDER_LIST_FILTERED/);
  assert.match(v.message, /"gpt-4o-mini"/);
  assert.match(v.message, /SUITE defect/);
});

test("the empty-state testid alone is enough — the search value may not have been read", () => {
  const v = providerRowVerdict(
    snapshot({ filteredEmpty: true }),
    "provider-item-OpenAI",
    20000,
  );
  assert.equal(v.kind, "filtered");
  assert.match(v.message, /down to nothing/);
});

test("a SETTLED list without the row is a PRODUCT finding, and names who did render", () => {
  const v = providerRowVerdict(
    snapshot({
      listed: true,
      rows: ["Anthropic", "Google Generative AI", "Ollama"],
      searchTerm: "",
    }),
    "provider-item-OpenAI",
    20000,
  );
  assert.equal(v.kind, "absent");
  assert.match(v.message, /PROVIDER_ABSENT/);
  assert.match(v.message, /PRODUCT finding/);
  // Naming the rows is the load-bearing half: a count alone leaves the reader
  // hand-diffing, which is the failure `component-catalog-drift.ts` had to fix
  // for the same reason.
  assert.match(v.message, /Anthropic, Google Generative AI, Ollama/);
  assert.match(v.message, /3 provider\(s\)/);
});

test("a settled but EMPTY list is still `absent`, and does not claim rows it never saw", () => {
  const v = providerRowVerdict(
    snapshot({ listed: true, rows: [] }),
    "provider-item-OpenAI",
    20000,
  );
  assert.equal(v.kind, "absent");
  assert.match(v.message, /0 provider\(s\) \[\] \(none\)/);
});

test("no state at all means the panel never opened — not that the provider is gone", () => {
  // `openProviderPanel()` returns "opened" the moment it clicks, without
  // checking the panel mounted (provider-panel-entry.ts). A dropped click lands
  // here, and reporting it as PROVIDER_ABSENT would blame the product for a
  // click the suite lost.
  const v = providerRowVerdict(EMPTY, "provider-item-OpenAI", 20000);
  assert.equal(v.kind, "unreached");
  assert.match(v.message, /PROVIDER_LIST_UNREACHED/);
  assert.match(v.message, /never opened/);
  // All four testids are named so a rename is diagnosable from the message.
  for (const id of [
    PROVIDER_LIST_TESTIDS.loading,
    PROVIDER_LIST_TESTIDS.error,
    PROVIDER_LIST_TESTIDS.empty,
    PROVIDER_LIST_TESTIDS.list,
  ]) {
    assert.match(v.message, new RegExp(id.replace(/-/g, "\\-")));
  }
});

test("every verdict carries a distinct, greppable prefix", () => {
  const cases: Array<[Partial<ProviderListSnapshot>, string]> = [
    [{ loading: true }, "PROVIDER_LIST_STALLED"],
    [{ errored: true }, "PROVIDER_LIST_ERROR"],
    [{ filteredEmpty: true }, "PROVIDER_LIST_FILTERED"],
    [{ listed: true }, "PROVIDER_ABSENT"],
    [{}, "PROVIDER_LIST_UNREACHED"],
  ];
  const seen = new Set<string>();
  for (const [over, prefix] of cases) {
    const message = providerRowVerdict(
      snapshot(over),
      "provider-item-OpenAI",
      20000,
    ).message;
    assert.ok(
      message.startsWith(prefix),
      `expected message to start with ${prefix}, got: ${message.slice(0, 60)}`,
    );
    seen.add(prefix);
  }
  // A shared prefix would make two situations one `error_signature`, which is
  // the collapse (#1626) this issue is undoing.
  assert.equal(seen.size, cases.length);
});

test("the provider display name survives spaces and is never mangled", () => {
  // `provider-item-Google Generative AI` — the testid carries the display name
  // verbatim, spaces included (provider-config.ts derives one from the other).
  assert.equal(
    providerNameFromTestId("provider-item-Google Generative AI"),
    "Google Generative AI",
  );
  // A caller that already passes a bare name gets it back untouched rather than
  // a silently truncated one.
  assert.equal(providerNameFromTestId("OpenAI"), "OpenAI");
  const v = providerRowVerdict(
    snapshot({ loading: true }),
    "provider-item-Google Generative AI",
    20000,
  );
  assert.match(v.message, /"Google Generative AI"/);
});

test("the row prefix matches what ProviderListItem.tsx renders", () => {
  // Measured on langflow-ai/langflow@release-1.12.0: the row testid is built as
  // `provider-item-${provider.provider}`. If upstream changes the prefix, the
  // verdict degrades to `unreached` (loud) rather than to `absent` (a false
  // product finding) — but this pins the constant the whole module keys on.
  assert.equal(PROVIDER_LIST_TESTIDS.rowPrefix, "provider-item-");
  assert.equal(PROVIDER_LIST_TESTIDS.loading, "provider-list-loading");
  assert.equal(PROVIDER_LIST_TESTIDS.error, "provider-list-error");
  assert.equal(PROVIDER_LIST_TESTIDS.empty, "provider-list-empty");
  assert.equal(PROVIDER_LIST_TESTIDS.list, "provider-list");
  assert.equal(PROVIDER_LIST_TESTIDS.search, "provider-search-input");
});
