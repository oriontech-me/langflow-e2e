# Coverage Heatmap — Risk-Based Strategy

>This document is the **generation snapshot** — the human-written analysis, frozen at the date
>below. The derivable half of the matrix (mitigation, bullets, spec counts, test health, and the
>residual risk and ranking that follow from them) is **refreshed continuously** and can therefore
>differ from the tables here. For current values read [`dashboard-feed.json`](./dashboard-feed.json);
>the contract is [`FEED.md`](./FEED.md).

**Generated:** 2026-09-21 · **Previous:** 2026-08-06 · **Method:** [design record](../superpowers/specs/2026-08-06-coverage-heatmap-risk-analysis-design.md) · **Data:** [`data.json`](./data.json)

Answers one question: **are the tests we build covering the critical points of Langflow?**
Coverage percentage cannot answer it — coverage is measured against the checklist, and
the checklist only knows what is already in it. Every probability figure here is measured
from the *product*, never from our own test results.

---

## The verdict

**The August holes were closed, and closing them moved the problem rather than removing it.**

Four of the six actions the previous cycle recommended shipped. Security went from *rank 1
at mitigation 0.00* — no checklist area at all — to **rank 7 at 0.65**, with a whole
`security/` module and 30 bullets. i18n went from rank 8 to **rank 24**, the largest single
drop in the table. A2A and Templates both went from near-zero mitigation to 0.59.

What did **not** ship is the one the previous cycle put second: *raise MCP and Agents above
0.80*. They are now **ranks 1 and 3**, and Agents is the only area in the table whose
residual risk **rose while its bullets improved** — because six of its 35 `@stable` specs
are chronically red or flaky, so its coverage is worth less than its checklist says.

Two things the previous matrix could not see at all:

> **`20 Memory Base` doubled its inherent risk, 8 → 16, and is now tied for rank 1.** Its
> bug quintile went 1 → 3 on measurement: **6 of its 10 lifetime upstream bugs are 2026**,
> three of them landing since the last generation (#14731, #14860, #14994). Its mitigation
> is 0.45 and section **20.4 Ingestion is 7 bullets, all empty** — the exact surface those
> three bugs are about.

> **Three checklist areas had no row in the matrix at all** — `21 governance`,
> `22 enterprise`, `23 serving`. Together they carry **131 bullets** and **105 of the
> suite's 116 Part II `[-]` marks**, and **0 of their 31 specs carry `@stable`**. Serving
> and Enterprise enter the ranking at **4 and 5**.

## Residual-risk ranking

Residual risk = `inherent × (1 − mitigation)` — the danger that still gets through.
Mitigation is bullet-derived, then reduced by the test-health penalty where an area's
`@stable` specs are chronically red.

| # | Residual | Was | | Area | Inherent | P × I | Mitigation | Bullets |
|---|---|---|---|---|---|---|---|---|
| 1 | **8.8** | 10.5 | ↓ | 13/14 MCP | 25 | 5×5 | 0.65 (0.58) | 30 |
| 2 | **8.8** | 8 | ↑ | 20 Memory Base | 16 (8) | 4×4 | 0.45 (0) | 16 |
| 3 | **8.2** | 7.4 | ↑ | 6 Agents / LLM execution | 25 | 5×5 | 0.67 (0.7) | 44 |
| 4 | **6.9** | — | new | 23 Serving / end-user id | 10 | 2×5 | 0.31 | 13 |
| 5 | **6.6** | — | new | 22 Enterprise / authz | 10 | 2×5 | 0.34 | 104 |
| 6 | **5.6** | 6 | ↓ | 12.6 Build / graph engine | 20 | 4×5 | 0.72 (0.7) | 11 |
| 7 | **5.3** | 15 | ↓ | NEW security | 15 | 3×5 | 0.65 (0) | 30 |
| 8 | **5** | 5.1 | ↓ | 15 Canvas / UI | 20 | 4×5 | 0.75 (0.75) | 54 |
| 9 | **4.9** | 6.3 | ↓ | 16 A2A | 12 (8) | 3×4 | 0.59 (0.21) | 18 |
| 10 | **4.4** | 4.7 | ↓ | 9 Playground / chat | 20 | 5×4 | 0.78 (0.77) | 66 |
| 11 | **4.4** | 4.6 | ↓ | 2 Component config | 20 | 5×4 | 0.78 (0.77) | 58 |
| 12 | **4.2** | 4.8 | ↓ | 12 Flow lifecycle | 20 | 4×5 | 0.79 (0.76) | 25 |
| 13 | **4** | 3.9 | ↑ | 7 Model providers | 16 | 4×4 | 0.75 (0.76) | 32 |
| 14 | **4** | — | new | 21 Governance / policy | 6 | 2×3 | 0.34 | 14 |
| 15 | **3.6** | 4.4 | ↓ | 1 REST API / endpoints | 15 (20) | 3×5 | 0.76 (0.78) | 101 |
| 16 | **3.3** | 7.4 | ↓ | 11 Templates / starter | 8 | 2×4 | 0.59 (0.08) | 46 |
| 17 | **3.3** | 5.4 | ↓ | 4 Auth / users | 15 (10) | 3×5 | 0.78 (0.46) | 16 |
| 18 | **2.4** | 2.8 | ↓ | 3.9 HITL | 6 | 2×3 | 0.6 (0.53) | 4 |
| 19 | **2.4** | 2.4 | = | 8 Observability | 12 | 4×3 | 0.8 (0.8) | 24 |
| 20 | **2.4** | 2.4 | = | 5 Knowledge / files | 12 | 4×3 | 0.8 (0.8) | 8 |
| 21 | **2.2** | 2.3 | ↓ | 3.6 Loop / control flow | 9 | 3×3 | 0.76 (0.75) | 18 |
| 22 | **1.8** | 2 | ↓ | 3.3 API Request / Webhook | 9 | 3×3 | 0.8 (0.77) | 31 |
| 23 | **1.6** | 2.7 | ↓ | 4.3 Global variables | 8 | 2×4 | 0.8 (0.66) | 7 |
| 24 | **1.2** | 6 | ↓ | NEW i18n / localization | 6 | 2×3 | 0.8 (0) | 5 |
| 25 | **1.2** | 1.2 | = | 7.7 Model parameters | 6 | 2×3 | 0.8 (0.8) | 4 |
| 26 | **0.8** | 2.7 | ↓ | 10 Projects / folders | 3 (6) | 1×3 | 0.74 (0.55) | 19 |
*Mitigation and inherent columns carry the previous generation's value in brackets where it
moved. `NEW security` / `NEW i18n` keep their August names: both now have a real checklist
module, and renaming them would break the comparison this table exists for.*

## What actually moved, and what only looks like it moved

**Measured product change** — these are the rows to act on:

| Area | Change | Evidence |
|---|---|---|
| 20 Memory Base | inherent 8 → **16** | bug quintile 1 → 3; 6 of 10 lifetime issues are 2026, 3 of them since 2026-08-06 |
| 16 A2A | inherent 8 → **12** | bug quintile 1 → 2; from 1 lifetime issue to 4, all 2026, plus the AG-UI protocol pair (#14668, #14847) |
| 6 Agents | residual 7.4 → **8.2** | mitigation improved to 0.67 gross, then the test-health penalty took it back |
| 10 Projects | inherent 6 → **3** | probability fell to 1; the area is quiet upstream and well covered |

**Instrument, not product** — two inherent-risk moves are the rebuilt classifier disagreeing
with August's, and must not be read as the product changing:

- **`1 REST API` 20 → 15.** My classifier under-matches this area badly (ratio 0.31 against
  the recorded August weight). Its 101 bullets and 0.76 mitigation are solid; treat the
  inherent drop as unproven.
- **`4 Auth` 10 → 15.** The mirror case, over-matching at 1.36. Its residual still *fell*
  (5.4 → 3.3) because mitigation went 0.46 → 0.78, which is bullet-derived and exact.

The error bar is stated rather than hidden: **read a one-quintile move as noise unless the
per-year counts move with it.** Memory Base and A2A both clear that bar; these two do not.

## The instrument was rebuilt, and calibrated before it was used

August's classifier and churn path-map were never committed — the design record chose
per-row provenance over a generator, which is cheap to maintain and impossible to re-run.
Both were rebuilt this cycle and checked against the recorded figures **before** producing
anything:

- **The corpus reproduces.** 1915 `bug` issues created before 2026-08-06 against the
  **1912** recorded; `question`-labelled = **41**, exactly the recorded exclusion; 2024 =
  842 against the README's 841. Same query, same corpus.
- **Bug axis: Spearman ρ = 0.940**, quintile agreement 15/23, every disagreement ±1. The
  largest exclusion reproduces almost exactly — vendor bundles at **247 issues / 130.4
  weighted** against the recorded **227 / 128.0**.
- **Churn axis: ρ = 0.864**, quintile agreement 12/23. Weaker, which is why it carries
  weight 1 against the bug axis' weight 2 — the design's own reasoning, now with a number.
- **Mitigation was not rebuilt, it was derived.** The area→checklist-section map reproduces
  **all 23 recorded bullet counts exactly** on the August revision of `QA-CHECKLIST.md`.
  Mitigation is the one axis here that is measurement rather than estimate.

Watch the corpus totals: **1912 scored then, 1912 scored now**, which reads like a corpus
that did not grow. It grew by 38 issues; the coincidence is that 41 `question`-labelled
issues come off a 1953 total. The figure is spelled out in `data.json` for that reason.

## The test-health penalty, applied for the first time

The design specified it and the first generation never applied it: *an `@stable` test that
fails chronically is not mitigating 0.8 — it drops to ~0.4.* Over the **32 daily runs from
2026-08-06 to 2026-09-18**, a spec counts as chronic if it failed or flaked on ≥3 distinct
days.

It is almost entirely one area:

| Area | Chronic | Of `@stable` specs | Penalty |
|---|---|---|---|
| **6 Agents** | 1 hard + 5 flaky | 35 | −0.063 |
| 13/14 MCP | 1 hard | 11 | −0.031 |
| 2 Component config | 1 flaky | 38 | −0.010 |
| 12 Flow lifecycle | 1 flaky | 37 | −0.011 |

The six Agents specs, by days affected: `agent-component-regression` (6 flaky),
`model-provider-model-toggle` (5), `agent-multi-tool-selection` (4), `agent-max-iterations`
(4), `agent-multimodal-image-input` (3), `language-model-regression` (3 **hard**).

This is why Agents rose while its bullets improved, and it is the finding the penalty exists
to produce: **the area is not under-tested, it is under-trusted.** Adding bullets there
buys less than fixing the six.

## The graph-engine override was re-measured, not carried

`12.6` carries a judged mitigation of **0.72** against a bullet-derived 0.63. The previous
cycle judged 0.70 against 0.53, and carrying that delta forward would have produced 1.07 —
nonsense, so the reasoning was re-run instead of the number.

- The half that **improved**: **91 regression specs execute a graph and 83 are `@stable`
  (91 %)**, against 73/63 (86 %) in August. A total engine break reddens the daily louder
  than it did.
- The half that **got worse**: it is no longer a suspicion. **#1896** measured that a
  regular-port cycle runs as `completed` without building, and that one failing component
  freezes the canvas at `RUN_ERROR`. Three new upstream bugs land in exactly that class —
  **#14964** (Loop item injected only into the first outgoing edge), **#14966** (concurrent
  vertex completion reactivates a branch stopped by `Component.stop()`), **#15034** (Run
  Flow returns empty content as an Agent tool).

So the override keeps the same position between the derived value and the 0.80 ceiling that
August used, and the area stays well under that ceiling for a reason that is now evidenced.

## The three areas the matrix could not see

`governance/`, `enterprise/` and `serving/` are checklist sections that post-date the matrix.
Impact and fragility are judged, with the rationale per row in `data.json`; bug and churn are
measured by the same instrument as every other area.

| Area | Residual | Inherent | Specs | `@stable` | Bullets | Upstream bugs |
|---|---|---|---|---|---|---|
| 23 Serving / end-user id | **6.9** | 10 (2×5) | 3 | **0** | 13 | **0** |
| 22 Enterprise / authz | **6.6** | 10 (2×5) | 21 | **0** | 104 | 1 |
| 21 Governance / policy | **4.0** | 6 (2×3) | 7 | **0** | 14 | **0** |

Two things to read carefully here.

**Zero upstream bugs is a young surface, not a safe one.** Both areas at zero are 1.12
surfaces. Their probability rests on fragility, and the fragility is real: serving's
`TRUST=0` mode is fail-closed *and* fail-silent — every request becomes `anon::<uuid>` and
persists nothing, while runs still answer `200`. Enterprise RBAC is a property of the
database rather than the process, and three surfaces already disagree about inherited access
(#1532).

**Their impact scores are the highest in the table for a reason.** A wrong allow in the deny
matrix exposes another tenant's flows; a serving identity leak means one end user reads
another's chat memory. Both are 5 on blast radius alone.

They rank 4 and 5 on mitigation ~0.3 — which is what **104 + 13 bullets and not one
`@stable` spec** produces. These specs run in no scheduled lane: not in `daily-stable.yml`
(no enterprise or serving lane), not in the weekly (disabled). They are reachable only by a
deliberate `PW_ENTERPRISE=1` / `PW_SERVING_IDENTITY=1` dispatch.

## The `[-]` problem got worse, and moved

Counted the same way on both dates — bullets under Part II, `QA-CHECKLIST.md`:

| | 2026-08-10 | 2026-09-21 |
|---|---|---|
| Part II bullets | 531 | **793** |
| `[x]` validated | 393 | **597** |
| `[-]` automated, watched by nothing | 37 | **116** |

**105 of those 116 `[-]` sit in the three new areas.** The previous generation's closing
point — *"they count as coverage in every generated figure and are watched by nothing on a
schedule"* — is now concentrated rather than diffuse, which makes it a lane decision instead
of a per-spec one.

The August README reported "89 of 500" for this figure. That does not reproduce under either
scope on the committed revision (Part II gives 37/531, whole-file 58/1021), so it is recorded
as unreproducible rather than compared against.

## Scope exclusions

Unchanged from the previous generation and re-measured with the rebuilt classifier, which is
what the vendor-bundle agreement above establishes. 25 % of Langflow's bug history is not
addressable by a Playwright spec against a running instance:

| Excluded surface | Issues (now) | Weighted | Why |
|---|---|---|---|
| **Vendor bundles** | **247** | **130.4** | Team decision 2026-08-06 — no longer supported by this QA team |
| docker / deploy | 93 | 47.0 | Not a UI surface |
| install / packaging | 67 | 28.8 | Not a UI surface |
| database / infra | 34 | 19.1 | Postgres/SQLite/migrations |
| desktop / platform | 26 | 16.3 | Desktop app and OS-specific |
| backend internals | 26 | 15.2 | FastAPI/async/pydantic internals |
| docs / website | 13 | 5.1 | Not the product |

Core providers (OpenAI / Anthropic / Gemini) stay in scope even when a title names a bundle
alongside them. The 1.12 Deployments page stays dropped — see `data.json`.

## Confidence and limits

- **26.3 % of the issue corpus is unclassified** (502 of 1912), against 17.0 % under
  August's classifier. My rules are stricter and leave more residue; the design's rule is to
  report the residue rather than force it, and a larger residue dilutes areas roughly evenly.
  Good enough to *order* areas; not good enough for fine distinctions between neighbours.
- **Churn left 45.9 % of weighted file touches unmatched** (configs, CI, the `src/lfx/`
  restructure). Relative ranking holds; absolute churn is not interpretable alone.
- **Churn measures activity, not quality.** A heavily-committed area may be being *improved*.
- **Fragility and impact are judgement**, one rationale per row in `data.json`. Impact is
  anchored to langflow.org's advertised promise rather than intuition.
- **Impact and fragility were carried forward** for the 23 existing areas: the advertised
  promise has not changed, and re-judging them without a reason would manufacture movement.
  Only the three new areas were judged this cycle.
- **The churn ref is `origin/main` at 5621dcfd84 (2026-09-15)**, six days behind this
  generation. Bugs are fetched through 2026-09-21.
- **The test-health window is 32 runs.** A spec quarantined *before* 2026-08-06 shows as
  healthy here, because it no longer runs.

## What this implies for the next wave

Not issues yet — that is a separate decision. In residual-risk order, with what the previous
cycle asked for carried through:

1. **Close `20.4 Ingestion` — 7 bullets, all empty.** The area doubled its inherent risk on
   measurement and three 2026 bugs land on exactly this surface. Cheapest high-rank move on
   the list.
2. **Fix the six Agents specs before adding any.** `agent-component-regression`,
   `model-provider-model-toggle`, `agent-multi-tool-selection`, `agent-max-iterations`,
   `agent-multimodal-image-input`, `language-model-regression`. Agents is rank 3 *because of
   these*, not despite them.
3. **Decide the lane question for serving and enterprise.** 117 bullets and 24 specs that run
   nowhere on a schedule. Either they get a scheduled lane or their bullets stop counting as
   coverage — the current state is the `[-]` problem at its largest.
4. **MCP is rank 1, and its remaining coverage is blocked rather than unwritten.** This
   corrects the previous cycle's *"raise MCP and Agents above 0.80"* into something
   actionable: all **3** of its empty bullets are recorded as not implementable on the
   product (no client resource surface, `prompts/list` returns `[]` — #829), so no amount of
   spec-writing moves them. The levers that exist are the chronic hard failure
   (`mcp-client-agent-gemini-tool-regression`, 3 days), **#963**'s owed `@stable` restore on
   `mcp-client-agent.spec.ts`, the `resources/read` guard waiting on upstream **LE-2012**,
   and the `[~]` install bullet, which needs a lane that calls `POST /{project_id}/install`
   from inside the container. Rank 1 here is a *watch*, not a backlog.
5. **Land #1896.** Already open, already measured, and the graph-engine override is now
   explicitly propped up by it not having landed.
6. **A2A rose on inherent risk, not on missing tests — treat it as a watch too.** 4 upstream
   bugs in 2026 against 1 lifetime before, including the AG-UI protocol pair. But all **4**
   of its empty bullets carry a recorded reason they are out of reach (two real users under
   `AUTO_LOGIN` — #1010; a receiver with an inspectable inbox — `LE-1706`; no URL-observable
   signature surface — `LE-1718`), and its one `[~]` is pending an upstream question on a
   string with zero call sites (#1244). Its mitigation is close to structurally capped.

**Two of the top six are capped, and that is the finding to carry into the wave discussion.**
MCP and A2A cannot be bought down by writing specs. Memory Base, Agents, and the serving /
enterprise lane question all can — which is why they are 1, 2 and 3 on this list rather than
ordered strictly by residual risk.

Dropped from the previous cycle's list, because they are done: *create a security area*
(rank 1 → 7), *create an i18n area* (rank 8 → 24), *convert the 39 `[-]` template bullets*
(mitigation 0.08 → 0.59).

---

*Regenerating: `data.json` is the source of truth; this document renders it. The collection
instruments are rebuilt per cycle and calibrated against the previous generation's recorded
figures before use — the calibration numbers above are what make a rebuild honest, and they
belong in every future generation. Update after each Langflow release cycle.*
