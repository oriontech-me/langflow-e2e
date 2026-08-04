// Pricing and aggregation for the token consumption monitor (issue #1197).
//
// Pure functions only: no I/O, no env, no clock. The poller and the summarizer own
// those. That is what lets the whole cost surface be unit-tested without a backend.
//
// Two rules from the design (§2.1, §3.1) live here and nowhere else:
//   - a model absent from the price table yields NULL dollars and is named, never 0;
//   - the run total comes from the trace's own totalTokens, because Langflow reports
//     the same usage twice per call (component span + provider span) and summing
//     spans would double-count. A disagreement between the two is REPORTED.
import fs from "node:fs";

// Reworded per #1197 review (finding C2b): the previous text blamed a spec "not
// migrated to trackCreatedFlows (#1108)", which is no longer the live cause now
// that the sidecar's one call site (agent-max-tokens.spec.ts) passes
// `attribution` — a triager reading that string would wait on a migration that
// does nothing to turn attribution on. Name the two causes that actually put a
// trace here: the spec's own `cleanup()` call did not pass `attribution` (most
// specs, by design — the sidecar is opt-in per #1197), or the flow was deleted
// between two poller ticks before the sidecar could read its trace (#1197 §S4).
export const UNATTRIBUTED_REASON =
  "the spec's cleanup() did not pass attribution (most specs don't, by design), or its flow was deleted between two poller ticks";

// Pure validation step, split out from loadPrices() so a caller with its own I/O
// (the summarizer's injected readFile, in particular) can reuse the exact same
// rules without going through this module's hardcoded fs.readFileSync. Takes the
// RAW file text (not a pre-parsed object) so both callers do the same JSON.parse.
//
// A model's value is one of two shapes (#1211):
//   - a FLAT rate:   { inputPerMillion, outputPerMillion }               — the
//     common case, kept exactly as-is so a maintainer never has to wrap an
//     ordinary one-rate model in an array just to satisfy the schema, and so
//     a model priced this way sees no behaviour change from before #1211.
//   - DATED bands:   [{ since, inputPerMillion, outputPerMillion }, …]    — a
//     rate that changed over time (a promotional rate, a price correction).
//     `since` is a "YYYY-MM-DD" string; usdFor() picks the band effective on
//     the caller's date. Each band is validated the same way a flat rate is
//     (drop a non-numeric rate); a model whose bands are ALL invalid is
//     dropped entirely, same policy as an invalid flat rate.
export function parsePrices(raw) {
  const parsed = JSON.parse(raw);
  const prices = {};
  for (const [model, entry] of Object.entries(parsed)) {
    if (model.startsWith("_")) continue; // "_comment"
    if (Array.isArray(entry)) {
      const bands = entry
        .map((band) => ({
          since: typeof band?.since === "string" ? band.since : null,
          inputPerMillion: Number(band?.inputPerMillion),
          outputPerMillion: Number(band?.outputPerMillion),
        }))
        .filter((band) => Number.isFinite(band.inputPerMillion) && Number.isFinite(band.outputPerMillion));
      if (bands.length) prices[model] = bands;
      continue;
    }
    const input = Number(entry?.inputPerMillion);
    const output = Number(entry?.outputPerMillion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    prices[model] = { inputPerMillion: input, outputPerMillion: output };
  }
  return prices;
}

export function loadPrices(filePath) {
  return parsePrices(fs.readFileSync(filePath, "utf8"));
}

// Normalizes a raw price-table VALUE (flat rate or dated-bands array) into an
// array of bands. A flat rate becomes a single band with `since: null`,
// meaning "always effective" — selectBand() below treats it as the fallback
// when no dated band covers the requested date.
function toBands(entry) {
  return Array.isArray(entry) ? entry : [{ since: null, ...entry }];
}

// Selects the band effective on `date` ("YYYY-MM-DD"): the DATED band with
// the latest `since` that is still <= date, falling back to the undated
// ("always") band when one exists. Returns null when NEITHER applies — a
// model whose dated bands do not cover `date` (the run predates the earliest
// recorded rate) is reported unknown, never guessed. Silently reusing the
// newest band would misprice a run from before that rate is known to have
// existed, and there is no honest way to tell "priced" from "assumed" after
// the fact (#1211 — the same "never a stand-in for unknown" rule #1012
// applies to prices applies here to dates).
//
// Pure: takes `date` as an argument, never reads the wall clock (design
// constraint — a clock read in this module would break the scripts' unit-test
// determinism; see this file's own structural guard in token-cost.test.mjs).
function selectBand(bands, date) {
  const dated = bands
    .filter((band) => band.since)
    .sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0)); // latest since first
  if (date) {
    for (const band of dated) {
      if (band.since <= date) return band;
    }
  }
  return bands.find((band) => !band.since) ?? null;
}

// A substring match is only ever SAFE when the leftover — whatever text sits
// beyond the shorter of {model, key} — is recognizably version/alias noise
// (a date, a snapshot suffix, "-latest", "-preview", "-search-preview", …)
// rather than a DIFFERENT product's name. This is the fix for a review-round-2
// defect (#1211): the naive rule ("either string contains the other") let
// `gemini-2.5-flash-lite` match `gemini-2.5-flash` — `-lite` is a real,
// separately-priced tier, not an alias — and silently priced a Lite call at
// its more expensive non-Lite sibling's rate. A wrong number is strictly
// worse than the honest `null` this whole issue exists to produce, so the
// substring pass must refuse a match it cannot vouch for.
//
// The allow-list below was derived from the ids `collect-models` actually
// rotates through (tests/helpers/provider-setup/data/models.json), not
// invented: every observed leftover against this table's own keys is either
// all-digits (a date: `-20250514`, or its parts: `-09`, `-2025`) or one of
// "search" / "preview" (`-search-preview`, `-preview-09-2025`). "latest" is
// included on the same reasoning even though no CURRENT id in the catalog
// produces it as a leftover (gemini-flash-latest already matches by exact
// key) — the original issue names "-latest" alongside "-preview" and a dated
// suffix as the three suffix shapes this fix targets. Tier/size/modality
// words seen in the same catalog (`-lite`, `-image`, `-preview-tts`) and the
// family names the review named (`mini`, `nano`, `pro`, `max`, `opus`,
// `sonnet`, `haiku`) are deliberately ABSENT: refusing them (→ null, named in
// unpriced_models) is the correct, honest outcome, not a gap to fill in.
const ALLOWED_SUFFIX_WORDS = new Set(["latest", "preview", "search"]);
function isAllowedSuffix(leftover) {
  if (!leftover.startsWith("-")) return false;
  const segments = leftover.slice(1).split("-");
  return segments.every((segment) => /^\d+$/.test(segment) || ALLOWED_SUFFIX_WORDS.has(segment));
}

// Resolves a model id to its price bands: an EXACT key match first (#1211 —
// "no behaviour change for a model already priced by an exact key" is a
// stated done-when, so this branch never falls through to substring logic),
// then a substring match in both directions — a dated/preview/latest id
// CONTAINS its family key (`claude-opus-4-20250514` ⊃ `claude-opus-4`), and a
// short alias can be CONTAINED BY a longer, more specific key
// (`gpt-4o` ⊂ `gpt-4o-2024-08-06`) — gated by isAllowedSuffix() above so a
// tier/product suffix is never absorbed into a sibling's rate.
//
// Both directions are checked via `startsWith` (a PREFIX relationship), not
// `includes` anywhere-in-the-string — every real suffix this module targets
// (a date, `-latest`, `-preview`) is appended after the shared base, never
// inserted in the middle, and `startsWith` is what makes computing "the
// leftover" ($longer.slice(shorter.length)$) well-defined.
//
// Candidates are sorted LONGEST-KEY-FIRST — never object/iteration order —
// so the most specific match always wins: `gpt-4o-mini-search-preview`
// matches both `gpt-4o` (leftover `-mini-search-preview`, REFUSED — "mini" is
// not allowed noise) and `gpt-4o-mini` (leftover `-search-preview`, allowed).
// Even without the length sort, the suffix gate alone throws out the wrong
// candidate here; the sort exists for the case where more than one candidate
// survives the gate. A tie in key length falls back to a plain lexical sort
// so the result never depends on which key the price table happened to
// declare first.
//
// Split into resolvePriceKey() + resolveBands() for #1217: the platform's
// e2e_test_token_usage.price_key column records which key priced a row, so the
// key itself became a return value rather than an intermediate.
export function resolvePriceKey(model, prices) {
  if (!model || !prices) return null;
  if (prices[model]) return model;
  const candidates = Object.keys(prices)
    .filter((key) => {
      if (model === key) return false;
      const [shorter, longer] = model.length <= key.length ? [model, key] : [key, model];
      if (!longer.startsWith(shorter)) return false;
      return isAllowedSuffix(longer.slice(shorter.length));
    })
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return candidates.length ? candidates[0] : null;
}

function resolveBands(model, prices) {
  const key = resolvePriceKey(model, prices);
  return key ? toBands(prices[key]) : null;
}

export function usdFor(model, promptTokens, completionTokens, prices, date) {
  const bands = resolveBands(model, prices);
  if (!bands) return null;
  const band = selectBand(bands, date);
  if (!band) return null;
  return (
    (Number(promptTokens) || 0) * (band.inputPerMillion / 1e6) +
    (Number(completionTokens) || 0) * (band.outputPerMillion / 1e6)
  );
}

// `date` ("YYYY-MM-DD") is passed straight to usdFor()'s band selection
// (#1211) — the caller (watch-tokens.mjs's summarize()) passes the SAME value
// that lands on the history line's own `date` field, so a line's USD and its
// date can never disagree. Omitted, a model priced only by dated bands
// resolves to unpriced rather than guessing a band.
export function aggregate({ probes = [], attributions = [], costs = [], prices = {}, date } = {}) {
  const byTrace = new Map();
  for (const a of attributions) {
    if (a?.trace_id) byTrace.set(a.trace_id, a);
  }

  // §4.3: `costs` are the sidecar's own COST records — one per
  // `recordTokenAttribution` CALL, carrying that call's wall-clock. One record per
  // call is what makes the PLAIN SUM below correct.
  //
  // **What the pair means, and the trap in dividing one by the other, is defined
  // ONCE — in `reports/README.md`'s `token-history.jsonl` row.** That is the schema
  // doc a reader of the file has open; this comment deliberately does not restate
  // it. The short version, enough to review this loop: `attrib_calls` counts CALLS,
  // not teardowns, so their ratio is a per-call average and never a per-teardown
  // one; the total is the honest figure.
  //
  // Two invariants that live here because they are properties of THIS code, not of
  // the field: do not re-derive either value from `attributions` (the previous
  // per-flow, per-line shape needed a distinct-flow_id reduction and was blind to a
  // flow that produced no traces — the dominant cost), and a record whose
  // `attrib_ms` is not a finite number counts toward neither, keeping the pair
  // consistent.
  let attribMs = 0;
  let attribCalls = 0;
  for (const c of costs) {
    if (!Number.isFinite(c?.attrib_ms)) continue;
    attribMs += c.attrib_ms;
    attribCalls += 1;
  }

  const models = new Map();
  const specs = new Map();
  // §5.3: the cross-tab the platform's fact table needs. Keyed to match the DB's
  // own row identity -- (run_id, COALESCE(test_key,''), model), see
  // 20260803130200_e2e_test_token_usage.sql:83 -- so an unattributed trace keys on
  // the MODEL ALONE.
  //
  // WHY ONE ROW PER IDENTITY (the reason, corrected -- #1253 review, finding 7):
  // NOT "a re-POST would duplicate". The live ingest
  // (20260803130600_e2e_token_ingest_preserve_upsert_clamp.sql) upserts with
  // ON CONFLICT ... DO UPDATE, so it cannot duplicate. What it does instead is
  // keep the LAST occurrence of an identity and count the losers in
  // `rows_dropped`. So emitting two rows the unique index treats as one does not
  // create a duplicate -- it silently DISCARDS one of the two numbers. That is
  // the failure this key avoids.
  const specModels = new Map();
  let spanTokens = 0;
  const unpriced = new Set();
  const mismatches = [];

  const totals = {
    traces: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    usd_estimated: 0,
  };
  const unattributed = {
    traces: 0,
    total_tokens: 0,
    usd_estimated: 0,
    reason: UNATTRIBUTED_REASON,
  };

  for (const probe of probes) {
    if (!probe?.trace_id) continue;
    totals.traces += 1;

    // Resolved BEFORE the span loop because the per-model cross-tab below needs
    // the spec identity while it is walking the spans. The `unattributed`
    // bookkeeping further down still uses the same value.
    const attribution = byTrace.get(probe.trace_id);
    const specPath = attribution?.file ?? null;
    const titlePath = attribution?.test ?? null;
    // Write the separator as the ESCAPE `\u0000`, never as a literal control
    // character in the source. A raw NUL is invisible in an editor, in a diff and
    // in a review, and the first draft of this plan shipped four of them by accident.
    //
    // Keyed on the two VALUES, not on whether `attribution` exists (#1255 item 2).
    // An attribution record carrying a trace_id but no file/test used to key on
    // `"null\u0000null\u0000"` while emitting a row whose spec_path and title_path are
    // both null -- the same DB identity as the unattributed bucket
    // (`COALESCE(test_key,'')`), reached from a different producer key. Two rows on
    // one identity do not duplicate: the live ingest upserts, keeps the LAST, and
    // counts the loser in `rows_dropped`, so one of the two numbers is silently
    // discarded. Unreachable through the sidecar today -- resolveTestAttribution()
    // returns null unless title, file and project.testDir are all present -- but that
    // is an invariant enforced two modules away, in a TypeScript helper this pure ESM
    // module cannot see. Enforcing it here makes the row identity depend only on what
    // this function was handed.
    const identified = Boolean(specPath && titlePath);
    const specModelKey = identified ? `${specPath}\u0000${titlePath}\u0000` : "\u0000\u0000";

    let spanTotal = 0;
    let traceUsd = 0;
    for (const m of probe.models ?? []) {
      const prompt = Number(m.prompt_tokens) || 0;
      const completion = Number(m.completion_tokens) || 0;
      const total = Number(m.total_tokens) || prompt + completion;
      spanTotal += total;
      spanTokens += total;
      totals.prompt_tokens += prompt;
      totals.completion_tokens += completion;

      const usd = usdFor(m.model, prompt, completion, prices, date);
      if (usd === null) unpriced.add(m.model);
      else traceUsd += usd;

      const acc =
        models.get(m.model) ??
        {
          model: m.model,
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          usd_estimated: usd === null ? null : 0,
        };
      acc.calls += Number(m.calls) || 1;
      acc.prompt_tokens += prompt;
      acc.completion_tokens += completion;
      acc.total_tokens += total;
      if (acc.usd_estimated !== null && usd !== null) acc.usd_estimated += usd;
      models.set(m.model, acc);

      const rowKey = `${specModelKey}${m.model}`;
      const row =
        specModels.get(rowKey) ??
        {
          // The row's identity fields must be exactly what `specModelKey` was built
          // from, or a half-identified trace (a `file` with no `test`, say) would key
          // into the unattributed bucket while stamping its own spec_path onto it --
          // and whichever trace happened to create the row first would decide what
          // the merged row claims to measure.
          spec_path: identified ? specPath : null,
          title_path: identified ? titlePath : null,
          model: m.model,
          price_key: resolvePriceKey(m.model, prices),
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
      row.calls += Number(m.calls) || 1;
      row.prompt_tokens += prompt;
      row.completion_tokens += completion;
      row.total_tokens += total;
      specModels.set(rowKey, row);
    }

    // The trace's own total is authoritative for the run (§2.1). When the two
    // disagree, say so — a silent preference would hide a Langflow change in how
    // spans are emitted.
    //
    // Read the RAW value, not `Number(probe.total_tokens)`: the poller emits a
    // literal JSON `null` when the trace's own total is unknown (#1197 review,
    // finding I3), and `Number(null)` coerces to `0` — a finite number — before
    // `Number.isFinite` ever sees it, which would silently treat "unknown" as
    // "the run spent nothing" and flag every such trace as a fake mismatch
    // against its real span sum. `Number.isFinite` on the raw value rejects
    // `null` (and a missing/undefined field) without coercion, so both correctly
    // fall through to `spanTotal` below.
    const traceTotal = probe.total_tokens;
    const runTotal = Number.isFinite(traceTotal) ? traceTotal : spanTotal;
    if (Number.isFinite(traceTotal) && traceTotal !== spanTotal) {
      mismatches.push({ trace_id: probe.trace_id, trace_total: traceTotal, span_total: spanTotal });
    }
    totals.total_tokens += runTotal;
    totals.usd_estimated += traceUsd;

    if (!attribution) {
      unattributed.traces += 1;
      unattributed.total_tokens += runTotal;
      unattributed.usd_estimated += traceUsd;
      continue;
    }
    const key = `${attribution.file}::${attribution.test}`;
    const spec =
      specs.get(key) ??
      { test: attribution.test, file: attribution.file, traces: 0, total_tokens: 0, usd_estimated: 0 };
    spec.traces += 1;
    spec.total_tokens += runTotal;
    spec.usd_estimated += traceUsd;
    specs.set(key, spec);
  }

  return {
    totals,
    byModel: [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    bySpec: [...specs.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    bySpecModel: [...specModels.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    spanTokens,
    attrib_ms: attribMs,
    attrib_calls: attribCalls,
    unattributed,
    unpricedModels: [...unpriced].sort(),
    mismatches,
  };
}
