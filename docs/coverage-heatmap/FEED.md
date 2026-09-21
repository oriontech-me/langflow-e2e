# Dashboard feed — contract

Data source for a coverage-risk dashboard built **outside this repository** (the QA platform).
This file is the contract: what the feed guarantees, what it does not, and what a consumer must
never assume. If you are building the dashboard, this is the only file you need to read.

| File | What it is | Cadence |
|---|---|---|
| [`dashboard-feed.json`](./dashboard-feed.json) | The current generation, complete. One object. | Regenerated per Langflow release cycle |
| [`history.jsonl`](./history.jsonl) | One line per generation, for trend charts. Append-only. | One line added per generation |
| [`data.json`](./data.json) | The working file the feed is derived FROM. Not a contract. | — |
| [`README.md`](./README.md) | The human-readable rendering. Not a contract. | — |

**Consume `dashboard-feed.json` and `history.jsonl`. Do not consume `data.json` or `README.md`** —
those are working files whose prose fields and nesting change every cycle by design.

---

## Regenerating

```bash
npm run coverage:feed             # rewrite the feed and append/replace this generation's history line
npm run coverage:feed -- --check  # verify the committed feed matches data.json; exit 1 if it drifted
```

The feed is **generated, never hand-edited**. `data.json` plus two curated inputs are the whole
source:

- `scripts/lib/coverage-matrix-keys.json` — the stable id per area (see below).
- `scripts/lib/coverage-matrix-annotations.json` — curation the risk model does not compute:
  which areas are capped by a product limitation, which of this cycle's moves are the instrument
  rather than the product, the QA-platform items that act on an area, and the actionable backlog.

Logic is split on purpose: `scripts/lib/coverage-matrix-feed.ts` is pure and unit-tested
(`npm run test:units`), `scripts/build-coverage-matrix-feed.ts` owns the I/O.

---

## The one rule that matters: key on `key`, never on `label`

Every area carries both:

```json
{ "key": "mcp", "label": "13/14 MCP" }
```

`label` is a **display name tied to the section numbering of `QA-CHECKLIST.md`**, and that
numbering moves — `NEW security` was called that when it had no checklist section at all, and it
now has section 17 while keeping the name so the generation-over-generation comparison survives.
`key` is assigned once in `coverage-matrix-keys.json` and **never changes, is never reused for a
different area, and is never renumbered**. A dashboard keyed on `label` breaks on the first
renumbering; one keyed on `key` does not. `history.jsonl` is keyed the same way.

Adding an area appends a key. A build that meets an area with no key **fails loudly**, naming the
area and the file — it never invents one.

---

## Schema

### `dashboard-feed.json`

Top level: `schema` (always `"coverage-matrix-feed"`), `version` (integer), `generated`
(`YYYY-MM-DD`), `previousGeneration`, `source`, `model`, `confidence`, `totals`, `areas[]`,
`actions[]`.

Each entry of `areas[]`, ranked by `residualRisk` descending:

| Field | Meaning |
|---|---|
| `key` / `label` | Stable id / display name. See the rule above. |
| `rank` | 1-based position in this generation. Derived, not stored. |
| `residualRisk` | `inherentRisk × (1 − mitigation)`. **The headline number.** |
| `inherentRisk` | `probability × impact`, 1–25. |
| `probability` / `impact` | 1–5 each. Use the pair for a 5×5 heatmap cell. |
| `mitigation` | 0–1, **effective** — bullet-derived, minus the test-health penalty. Colour by this. |
| `mitigationBulletDerived` / `mitigationOverride` | The raw value and the judged override, when one applies. `graph-engine` is the only override today. |
| `axes` | `bugQuintile`, `churnQuintile`, `fragility` (each 1–5) and the raw `weightedBugs` / `weightedChurn`. |
| `bullets` | `{total, validated, automatedUnwatched, partial, flaky, empty}`. **`automatedUnwatched` is the `[-]` state: automated and running in no scheduled lane.** An `unaccounted` field appears only if the checklist grows a marker the feed does not know — treat its presence as a bug to report, never as zero. |
| `specs` | `{specs, stable}` counted from the regression tree, or **`null`** for a sub-area that shares a directory with its parent (6 areas today). `null` means *not separately countable*, never zero. |
| `testHealth` | `{chronicHardFailures, chronicFlaky, stableSpecs, penalty}` over the daily-run window, or `null`. |
| `upstreamBugsByYear` | `{"2024": n, …}` issue counts. `{}` means genuinely zero, which for a 1.12 surface means **young, not safe**. |
| `previous` / `delta` / `isNew` | Last generation's `rank`/`residualRisk`/`inherentRisk`/`mitigation`; the signed change and a `direction` of `improved`/`worsened`/`flat`; `isNew` is true when there is no previous. |
| `cappedByProduct` | **true = this area's residual risk cannot be reduced by writing tests.** Every remaining empty bullet carries a recorded product limitation. A dashboard that ranks work to do should filter or badge on this, or it will send someone to write specs that cannot exist. |
| `instrumentCaveat` | Non-null when this cycle's inherent-risk move is the measuring instrument rather than the product. **Show it next to the number.** Two areas today. |
| `platformItems` | `friendly_id`s of QA-platform checklist items acting on this area. Snapshot link, not a sync. |
| `rationale` | Free prose. Safe to show; never parse. |

`actions[]` is the actionable backlog: `{id, areaKey, priority, title, platformItemId}`, with
`priority` one of `critical` / `high` / `medium` / `low`. `areaKey` joins to `areas[].key`.

`confidence` carries the error bar in prose (`bugAxis`, `churnAxis`, `errorBar`) plus
`unclassifiedPct` and `churnUnmatchedPct` as numbers.

### `history.jsonl`

One JSON object per line, one per generation, sorted by `generated`. Small on purpose —
`{version, generated, areas, residualRiskTotal, bulletsAutomatedUnwatched, top[5], byArea{}}`,
where `byArea` maps the stable key to `{rank, residual, inherent, mitigation}`.

Re-running a generation **replaces** its line rather than appending a duplicate, so a trend never
double-counts. The `2026-08-06` line carries `"seeded": true`: it was reconstructed from that
generation's committed `data.json` and the checklist as it stood, so the trend has two points
rather than one. Its `bugsByYear`, `specs` and annotations are empty because they did not exist
then — absent, not zero.

---

## What a consumer must not assume

- **`residualRisk` is an ORDERING, not a physical quantity.** It ranks areas against each other in
  one generation. Do not sum it across areas and call it "total risk", do not chart it as though a
  4.4 is twice a 2.2, and do not compare it across generations without reading `confidence`.
  `totals.residualRiskTotal` exists for trend shape only.
- **A one-quintile move is noise** unless `upstreamBugsByYear` moves with it. The measuring
  instrument is rebuilt each cycle and calibrated against the last one; `confidence.errorBar` says
  so in the feed itself.
- **Mitigation never reaches 1.0.** An `@stable` bullet is worth 0.8 by design: no test covers
  every path, and a green E2E still hides an HTTP 500. A dashboard showing "80% = full coverage"
  misreads the scale — `model.mitigationScale` carries it.
- **`cappedByProduct` areas will sit near the top forever** and that is correct, not a data error.
- **This feed is not live.** It regenerates per release cycle. Show `generated` prominently; a
  dashboard that looks real-time will be read as real-time.
- **It measures the E2E automation suite, not QA overall.** Manual coverage on the QA platform is
  invisible here. An area at mitigation 0.3 may be well covered by hand — that is exactly what
  action `CRM-07` is about.

## Schema evolution

Follows `reports/README.md`'s rule, which this repo already uses for its run history:

- **Additive** (new optional field): no version bump. Document it here and ship.
- **Breaking** (removing or renaming a field, or changing the meaning of one): bump `version` in
  `scripts/lib/coverage-matrix-feed.ts`. Existing `history.jsonl` lines keep their own `version`,
  so a consumer branches on it.

A dashboard should read `schema` and `version` before anything else and refuse a `version` it does
not know, rather than rendering fields it half-recognises.

---

## How the data stays current

The matrix splits in two, and the split is what makes a live dashboard honest.

| Half | Refreshed | By what |
|---|---|---|
| **Derivable** — mitigation, bullet states, spec and `@stable` counts, test health, and the residual risk and ranking that follow | **Once a weekday**, after the daily run | `.github/workflows/refresh-coverage-matrix.yml` |
| **Judged** — impact, fragility, the bug and churn quintiles, probability, inherent risk, the graph-engine override, `cappedByProduct`, `instrumentCaveat`, `actions[]` | **Per release cycle, by a human** | A full generation |

`data.json` therefore carries two dates: **`generated`** (the last full generation) and
**`refreshed`** (the last derivable recompute). Show both, or show `refreshed` and say which
generation it belongs to. They are not interchangeable.

Two reasons the judged half is deliberately not automated:

- **Impact and fragility are judgement.** No amount of data produces "a serving identity leak
  means one end user reads another's chat memory, so impact is 5".
- **Re-quintiling daily would manufacture noise.** A quintile is relative to the area set, so one
  upstream issue crossing a boundary flips a whole probability step and the inherent risk jumps
  20 → 25 with nothing having happened to the product. Upstream bugs arrive at roughly 5.8 a
  week; the real signal needs a release cycle to show.

Both figures above are dated and re-derivable rather than quoted: the checklist cadence is
`git log --since=90.days --format=%ad --date=short -- QA-CHECKLIST.md | sort -u | wc -l`
(76 of 90 days on 2026-09-21), and the upstream bug rate is the count of `bug`-labelled issues
created since the previous generation divided by the weeks between them (38 over 6.5 weeks).

`refreshAreas` **throws** rather than write a judged field, so the daily job cannot quietly
re-score the product. An override the bullets have overtaken is reported as stale rather than
silently kept or silently dropped.

### Triggers

- completion of the **Daily Stable E2E** workflow — the lane that moves test health, and the
  natural clock for the refresh;
- a Monday `schedule`, as a fallback for the case this repo has hit twice (a scheduled lane going
  dormant: `nightly.yml`, `weekly-stable.yml`); without it a disabled daily would freeze the feed
  with nothing saying so;
- manual dispatch.

**Deliberately not a push trigger.** Refreshing on every push that touches `QA-CHECKLIST.md` is the
obvious wiring and the wrong one: it puts this job on the same paths as
`update-coverage-summary.yml`, and both commit back to `main` — a push race on the ~76-of-90 days
the checklist moves, plus an extra job per merge. The workflow shares no trigger with any other
lane, and a test pins that.

**The cost is bounded and stated: mitigation can be up to a day stale.** It is the derivable half of
a risk ranking, not a gate; nothing blocks on it being current to the minute. `refreshed` on the
feed says exactly how fresh it is.

---

## Platform side: the endpoint this feed needs

The workflow POSTs `dashboard-feed.json` **verbatim** — the file documented above is the request
body, so the repo's contract and the dashboard's cannot drift apart.

```
POST  $QA_COVERAGE_MATRIX_ENDPOINT
      Authorization: Bearer $QA_E2E_AUTOMATION_TOKEN
      Content-Type: application/json
      <dashboard-feed.json, unmodified>
```

To switch it on, two things are needed — one in each repository:

1. **Platform repo:** an edge function beside the existing `fn/e2e-automation-runs-create`, plus
   its table. Suggested name `e2e-coverage-matrix-create`, to match the convention
   `sync-model-prices.mjs` already relies on (it derives a sibling endpoint by replacing the last
   path segment of `QA_PLATFORM_ENDPOINT`).
2. **This repo:** set the Actions variable `QA_COVERAGE_MATRIX_ENDPOINT` to that URL. The token
   `QA_E2E_AUTOMATION_TOKEN` is already provisioned and is the same one the run POST uses.

Until the variable is set the POST step **skips with a warning** and the committed feed is still
refreshed — so nothing breaks while the platform side is built, and nothing silently pretends to
have published.

Storage shape is the platform's call, but two properties are worth keeping:

- **Upsert on `(generated, refreshed)`**, not append-only. A refresh re-POSTs the whole feed, and
  the same pair arriving twice is the same measurement, not two.
- **Keep every refresh**, not only the newest. `history.jsonl` in this repo is the same series and
  is the fallback if the table is ever rebuilt — but it is small by design, and the feed carries
  per-area detail the history line does not.
