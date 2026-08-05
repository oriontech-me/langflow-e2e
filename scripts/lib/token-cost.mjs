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
//
// A THIRD cause was added for #1255 item 4: the residue measured on run 30867978556
// (1.6% of the run's tokens, 11 flows) was flows deleted through the UI rather than
// through an API helper. The attribution hook lives on the helpers, so a UI delete is
// structurally invisible to it -- closing that needs a hook on the UI delete path, a
// separate design. It is named here because this string is what a reader of the bucket
// sees, and a cause absent from it reads as a cause that does not exist: a triager
// checking both listed causes and finding neither would go looking for a bug in the
// sidecar instead of recognising the one path it cannot see.
export const UNATTRIBUTED_REASON =
  "the spec's cleanup() did not pass attribution (most specs don't, by design), its flow was deleted between two poller ticks, or its flow was deleted through the UI, which the attribution hook cannot see";

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
//
// `provider` is carried through when the entry (or band) declares one, and only
// then (#1300 gap 1). This function used to DROP it — the field existed solely
// for scripts/sync-model-prices.mjs, which reads the raw JSON — so the run's own
// summarizer had no provider axis at all and #1183 owed its per-provider figure
// as a hand rollup of model ids in an issue comment. A model with no `provider`
// key keeps exactly the shape it had before, so a caller's fixture that omits
// the field is unaffected, and an absent provider stays honestly absent instead
// of becoming a default. See declaredProvider() for why it is never inferred.
export function parsePrices(raw) {
  const parsed = JSON.parse(raw);
  const prices = {};
  for (const [model, entry] of Object.entries(parsed)) {
    if (model.startsWith("_")) continue; // "_comment"
    if (Array.isArray(entry)) {
      const bands = entry
        .map((band) => withProvider(
          {
            since: typeof band?.since === "string" ? band.since : null,
            inputPerMillion: Number(band?.inputPerMillion),
            outputPerMillion: Number(band?.outputPerMillion),
          },
          band,
        ))
        .filter((band) => Number.isFinite(band.inputPerMillion) && Number.isFinite(band.outputPerMillion));
      if (bands.length) prices[model] = bands;
      continue;
    }
    const input = Number(entry?.inputPerMillion);
    const output = Number(entry?.outputPerMillion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    prices[model] = withProvider({ inputPerMillion: input, outputPerMillion: output }, entry);
  }
  return prices;
}

// The one place that decides whether a price entry declares a provider (#1300
// gap 1). It is READ, never DERIVED, and it is worth being precise about what
// that does and does not buy, because the first draft of this comment overstated
// it and the review of #1300 refuted the overstatement.
//
// What it buys: the provider comes off the SAME table row that priced the tokens,
// so a run's dollars and its provider rollup can never disagree about where they
// came from, and a model the table says nothing about stays honestly unknown
// instead of being folded into whichever bucket a prefix rule guessed.
//
// What it does NOT buy: the table is keyed by model ID, so it cannot separate two
// ACCOUNTS that serve the same name. `gpt-5-mini` is the live example — the single
// row for it declares `azure` because it prices an Azure AI Foundry deployment
// (#1281), and a genuine OpenAI `gpt-5-mini` call (the id is in the OpenAI catalog
// under tests/helpers/provider-setup/data/models.json) is therefore booked to
// azure. model-prices.json's own header already warns that a row "prices a NAME";
// that warning covers this field too. So a prefix rule and this table are wrong on
// different models, not wrong-vs-right — what makes reading the table the better
// of the two is that it is auditable and correctable in one place, while a
// derivation is silent and would also put a SECOND notion of identity on the same
// data, since resolvePriceKey() below matches ids by substring in both directions.
//
// Empty/blank counts as absent, matching sync-model-prices.mjs's own rejection of
// a whitespace provider.
function declaredProvider(entry) {
  const provider = entry?.provider;
  return typeof provider === "string" && provider.trim() ? provider.trim() : null;
}

// Adds `provider` to a parsed band/flat rate ONLY when one is declared, so an
// entry without the field is byte-identical to what parsePrices() returned
// before #1300 (`{provider: undefined}` is a different object under
// deepStrictEqual, and a caller asserting on the parsed shape would break for a
// field nobody set).
function withProvider(parsed, source) {
  const provider = declaredProvider(source);
  return provider ? { ...parsed, provider } : parsed;
}

export function loadPrices(filePath) {
  return parsePrices(fs.readFileSync(filePath, "utf8"));
}

// Mirror of quality-platform's `public.e2e_normalize_spec_path`
// (20260726120000_e2e_issue_spec_refs.sql:25) -- prepend `tests/` unless the path
// already carries it, pass NULL/empty through untouched. Character for character
// the same rule, deliberately: the DB's row identity is
// md5(e2e_normalize_spec_path(spec_path) || '::' || title_path), so anything this
// function does NOT do is a way for two producer rows to arrive as one DB row.
//
// WHY THE PRODUCER HAS TO KNOW THIS (#1255 item 4, same class as item 2)
//
// The producer used to key its rows on the RAW (spec_path, title_path, model). The DB
// keys on the NORMALIZED pair. A raw key is strictly FINER than a normalized one, and
// finer is the dangerous direction: `a.spec.ts` and `tests/a.spec.ts` are two producer
// rows and one DB row, and the live ingest upserts, keeps the LAST and counts the loser
// in `rows_dropped` -- so one of the two numbers is silently discarded. Merging them
// here sums them instead, which is the arithmetic the DB cannot do after the fact.
//
// Not reachable through today's sidecar: `resolveTestAttribution` returns
// `path.relative(project.testDir, file)`, which never carries a `tests/` prefix
// (testDir IS `./tests`). That is an invariant enforced two modules away, in a
// TypeScript helper this pure ESM module cannot see -- the same shape of inherited
// invariant item 2 removed. This makes it local.
//
// The row still CARRIES the raw spelling it was handed, not the normalized one: the
// normalization exists to decide identity, and rewriting the stored value would change
// what the platform records for every row today for no requirement. When two spellings
// do collapse, the merged row keeps whichever opened it -- cosmetic by construction,
// since both normalize to the one identity the DB will file them under.
export function normalizeSpecPath(specPath) {
  if (!specPath) return specPath;
  return specPath.startsWith("tests/") ? specPath : `tests/${specPath}`;
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

// Who BILLED a model's tokens, resolved through the SAME two steps that price
// them — resolvePriceKey() then selectBand() — so a run's provider rollup and its
// dollars can never disagree about which table row they came from (#1300 gap 1).
// Returns null when the answer is not declared anywhere the price table can be
// read; the caller reports that as its own bucket and never as a provider.
//
// The date-band fallback is the one branch worth arguing. When no band covers
// `date` (the run predates every recorded rate — #1211's "never guess a price"
// case) the model is legitimately UNPRICED, but who bills it is still stated by
// the entry: a rate the table cannot answer for is not the same question as an
// account it names. So fall back to the entry's own declaration, and only when
// every band AGREES — bands that disagree describe a model that changed accounts
// over time, and picking one of them by hand is exactly the silent derivation
// this function exists to refuse.
//
// The fallback fires ONLY when no band is effective, and that is a real
// distinction rather than a restatement (found in review of #1300). When a band
// IS effective but declares no provider, the effective row's silence is the
// answer: reaching past it to a sibling band would report an account the row
// that priced these tokens does not name — the same "dollars and provider from
// one row" property this function exists for, broken in the one case nobody
// would look at. sync-model-prices.mjs rejects a band with no provider, so
// model-prices.json cannot reach that state today; resolveProvider() is exported
// and aggregate() takes an arbitrary price object, so the branch is still live.
export function resolveProvider(model, prices, date) {
  const bands = resolveBands(model, prices);
  if (!bands) return null;
  const effective = selectBand(bands, date);
  return effective ? declaredProvider(effective) : unanimousProvider(bands);
}

// Unanimous means EVERY band says the same thing, and a band that says nothing is
// not one of them. Dropping the silent ones first (`filter(Boolean)`) let bands
// [azure, (none)] answer "azure", which contradicts this path's own rule and
// contradicts the effective-band branch above, where silence IS the answer — the
// same principle has to hold for a set as for one row (Copilot review of #1300).
function unanimousProvider(bands) {
  const declared = new Set(bands.map(declaredProvider));
  return declared.size === 1 && !declared.has(null) ? [...declared][0] : null;
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
  // The provider rollup (#1300 gap 1). Keyed on the resolved provider itself, with
  // `null` — a real Map key — for "no provider is declared for this model". A
  // sentinel string would collide with a provider legitimately named that; the
  // null key is what keeps the unknown bucket distinguishable from a named one.
  const providers = new Map();
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
  // `total_tokens` and `span_tokens` measure the SAME traces from the two sources
  // §2.1 keeps apart, and the pair exists so a consumer never has to guess which one
  // it is holding (#1255 item 4). `total_tokens` is trace-authoritative -- the sum of
  // each trace's own reported total. `span_tokens` is the sum of those traces' model
  // spans, which is exactly what the null-identity `rows[]` of the emitted block add
  // up to, because a row can only ever be built from spans (a trace total has no
  // per-model split to file under a model).
  //
  // So the two disagree precisely when a trace in this bucket is one of `mismatches[]`,
  // and a consumer diffing `unattributed.total_tokens` against the sum of the
  // unattributed rows finds that gap. Before this field the gap was real, internally
  // consistent, and unexplainable from the block alone -- the top level already carried
  // both figures (`total_tokens` + `span_tokens`), and the bucket carried one.
  const unattributed = {
    traces: 0,
    total_tokens: 0,
    span_tokens: 0,
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
    //
    // NORMALIZED before it is keyed (#1255 item 4): the DB's identity runs
    // `e2e_normalize_spec_path` over `spec_path` first, so keying on the raw value
    // splits rows the DB will merge -- see normalizeSpecPath() above for what that
    // costs, and why the stored `spec_path` below deliberately stays raw.
    const identified = Boolean(specPath && titlePath);
    const specModelKey = identified
      ? `${normalizeSpecPath(specPath)}\u0000${titlePath}\u0000`
      : "\u0000\u0000";

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

      // Same accumulation as byModel, one level coarser (#1300 gap 1), with one
      // DELIBERATE difference: a bucket that absorbed even one unpriceable span
      // reports `null` dollars, not the partial sum of its priced ones. byModel
      // cannot face the choice — a model id is either priced or not for the whole
      // run, since the date is fixed — and `totals` is a documented FLOOR, labelled
      // as one in the summary. A provider bucket is the only figure here that can
      // MIX, and it is a table row: an unlabelled partial sum in a row is read as
      // that provider's spend, which is the wrong-number-over-honest-null trade
      // this module refuses everywhere else. `models` names the ids that landed
      // here, so the null is actionable rather than a dead end, and so a reader of
      // any provider row can check what it is made of.
      // Reachable today only through #1211's band-uncovered date; the rule is
      // written down because the next dated entry is what makes it live.
      const providerKey = resolveProvider(m.model, prices, date);
      const bucket =
        providers.get(providerKey) ??
        {
          provider: providerKey,
          models: new Set(),
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          usd_estimated: usd === null ? null : 0,
        };
      bucket.models.add(m.model);
      bucket.calls += Number(m.calls) || 1;
      bucket.prompt_tokens += prompt;
      bucket.completion_tokens += completion;
      bucket.total_tokens += total;
      if (usd === null) bucket.usd_estimated = null;
      else if (bucket.usd_estimated !== null) bucket.usd_estimated += usd;
      providers.set(providerKey, bucket);

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

    // Split on `identified`, not on whether an `attribution` record exists (#1255
    // item 4, extending item 2's fix to the other two outputs). A record carrying a
    // trace_id but no file/test already sends its ROW to the null-identity bucket;
    // sending its trace anywhere else makes one function report the same trace as
    // both attributed and unattributed. Under the old split it opened a `bySpec` row
    // keyed `"null::null"` — a spec nobody can open, next to a bucket that did not
    // count the tokens the row beneath it did. Unreachable today for the same reason
    // item 2 was, and local now for the same reason.
    if (!identified) {
      unattributed.traces += 1;
      unattributed.total_tokens += runTotal;
      unattributed.span_tokens += spanTotal;
      unattributed.usd_estimated += traceUsd;
      continue;
    }
    const key = `${specPath}::${titlePath}`;
    const spec =
      specs.get(key) ??
      { test: titlePath, file: specPath, traces: 0, total_tokens: 0, usd_estimated: 0 };
    spec.traces += 1;
    spec.total_tokens += runTotal;
    spec.usd_estimated += traceUsd;
    specs.set(key, spec);
  }

  return {
    totals,
    byModel: [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    // SPAN-derived, exactly like byModel — so it sums to `spanTokens`, never to
    // `totals.total_tokens`, and the gap between the two is whatever `mismatches[]`
    // reports (reports/README.md's token-history.jsonl row is the authority on that
    // pair). The `models` Set becomes a sorted array here rather than being carried
    // as one: a Set does not survive JSON.stringify, and this value goes straight
    // onto a history line.
    //
    // Ties break lexically, which the sibling rollups do not do. Their order on a
    // tie falls out of which span the trace happened to list first, and that is
    // tolerable for a table a human reads once; this value is APPENDED TO A
    // HISTORY FILE and diffed across runs, where a row order that moves on its own
    // is noise nobody can attribute. `null` (the unknown bucket) sorts last —
    // named providers are the figures being read, and the bucket that names what
    // could not be resolved belongs under them. resolvePriceKey() breaks its own
    // ties lexically for the same "never leave it to input order" reason.
    byProvider: [...providers.values()]
      .map((bucket) => ({ ...bucket, models: [...bucket.models].sort() }))
      .sort(
        (a, b) =>
          b.total_tokens - a.total_tokens ||
          (a.provider === null ? 1 : b.provider === null ? -1 : a.provider.localeCompare(b.provider)),
      ),
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
