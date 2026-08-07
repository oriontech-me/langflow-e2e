# Coverage Heatmap — Risk-Based Strategy

**Generated:** 2026-08-06 · **Method:** [design record](../superpowers/specs/2026-08-06-coverage-heatmap-risk-analysis-design.md) · **Data:** [`data.json`](./data.json)

Answers one question: **are the tests we build covering the critical points of Langflow?**
Coverage percentage cannot answer it — coverage is measured against the checklist, and
the checklist only knows what is already in it. Every probability figure here is measured
from the *product*, never from our own test results.

---

## The verdict

**Yes in the bulk — but every hole at the top is an area the checklist did not have.**

`security` (15.0) and `Memory Base` (8.0) score 0.00 mitigation for the same reason: no
bullet existed, so they were invisible to every coverage figure including the 76 % headline.
Between them sits `MCP` at 10.5 — the matrix maximum for inherent risk, and the area whose
remaining backlog turned out to be blocked or absent rather than merely unvalidated.

Of the areas at inherent risk ≥ 16 (the product's most critical), **7 of 9 are properly
defended** at mitigation 0.75–0.80: Canvas, Flow lifecycle, Playground, Component config,
REST API, Model providers, Observability. The suite *is* where Langflow is critical.

The misalignment is not absence of testing. It is **allocation**:

> The two areas at the matrix maximum (inherent 25) are **MCP** and **Agents** — exactly
> the two things langflow.org sells as the product ("build and deploy AI agents and MCP
> servers"). Both sit at mitigation 0.67 and 0.71, *below* Observability and
> Knowledge/files, which carry half the inherent risk at 0.80.

## Residual-risk ranking

Residual risk = `inherent × (1 − mitigation)` — the danger that still gets through.

| # | Residual | Area | Inherent | P × I | Mitigation | Bullets | Nature of the hole |
|---|---|---|---|---|---|---|---|
| 1 | **15.0** | **NEW security** | 15 | 3×5 | **0.00** | 11 | No checklist area at all |
| 2 | **10.5** | 13/14 MCP | **25** | 5×5 | 0.58 | 29 | Advertised promise; remaining backlog is blocked or absent |
| 3 | **8.0** | **20 Memory Base** | 8 | 2×4 | **0.00** | 8 | No checklist area; new 1.12 surface |
| 4 | **7.4** | 6 Agents / LLM execution | **25** | 5×5 | 0.70 | 43 | Advertised promise, under-defended |
| 5 | **7.4** | 11 Templates / starter | 8 | 2×4 | 0.08 | 34 | Coverage was phantom — see the correction below |
| 6 | **6.3** | 16 A2A | 8 | 2×4 | 0.21 | 18 | Almost no coverage; specs exist, unvalidated |
| 7 | **6.0** | 12.6 Build / graph engine | **20** | 4×5 | 0.70 | 8 | Subtle engine defects unasserted |
| 8 | **6.0** | **NEW i18n / localization** | 6 | 2×3 | **0.00** | 5 | No checklist area; blocked on the en-US locale pin |
| 9 | 5.4 | 4 Auth / users | 10 | 2×5 | 0.46 | 14 | Max blast radius, low probability |
| 10 | 5.1 | 15 Canvas / UI | **20** | 4×5 | 0.75 | 51 | Defended |
| 11 | 4.8 | 12 Flow lifecycle | **20** | 4×5 | 0.76 | 24 | Defended |
| 12 | 4.7 | 9 Playground / chat | **20** | 5×4 | 0.77 | 66 | Defended |
| 13 | 4.6 | 2 Component config | **20** | 5×4 | 0.77 | 52 | Defended |
| 14 | 4.4 | 1 REST API / endpoints | **20** | 4×5 | 0.78 | 28 | Defended |
| 15 | 3.9 | 7 Model providers | 16 | 4×4 | 0.76 | 30 | Defended |
| 16 | 2.8 | 3.9 HITL | 6 | 2×3 | 0.53 | 3 | Low risk |
| 17 | 2.7 | 10 Projects / folders | 6 | 2×3 | 0.55 | 15 | Correctly deprioritised |
| 18 | 2.7 | 4.3 Global variables | 8 | 2×4 | 0.66 | 7 | Low risk |
| 19 | 2.4 | 8 Observability | 12 | 4×3 | 0.80 | 24 | Over-invested relative to risk |
| 20 | 2.4 | 5 Knowledge / files | 12 | 4×3 | 0.80 | 8 | Over-invested relative to risk |
| 21 | 2.3 | 3.6 Loop / control flow | 9 | 3×3 | 0.75 | 16 | Defended |
| 22 | 2.0 | 3.3 API Request / Webhook | 9 | 3×3 | 0.77 | 31 | Defended |
| 23 | 1.2 | 7.7 Model parameters | 6 | 2×3 | 0.80 | 4 | Defended |

## Two holes are taxonomy gaps, not coverage gaps

**Security** and **i18n / localization** have no entry in `QA-CHECKLIST.md`, so they have
never appeared in any coverage count — including the 76 % headline. They were found only
because the bug corpus was measured *outside* the checklist.

- **Security** — 18 issues, 4 in 2026. Includes the SSRF regression in `ensure_url`
  ignoring `LANGFLOW_SSRF_ALLOWED_HOSTS` for loopback, and a reported vulnerability with
  no response. Confirmed in scope for this QA team (decision 2026-08-06).
- **i18n / localization** — churn `4 → 5 → 64 → 459` file touches by year, the steepest
  2026 growth of any area, plus issues reporting a **black screen** when the browser
  language is Norwegian Bokmål and on a Chinese locale. A blank product for a whole locale
  is total failure for those users.

Both were surfaced by the **unclassified residue** of the issue classification, not by the
planned outside-in pass. Reporting the residue instead of forcing it into categories is
what made them visible — the design's rule earning its place.

## Derived churn — a correction to the method

**Team correction, 2026-08-06.** Churn on some surfaces is not independent evidence. Every
component change forces an update to every starter-template JSON that uses that node, so
`starter_projects` churn is a *mechanical consequence* of component churn — counting both
double-counted the same signal. The same shape applies to `locales/`: a new UI string
forces a translation update.

Their churn quintile is floored to 1. Bug evidence and impact are untouched.

| Area | Before | After | Rank |
|---|---|---|---|
| 11 Templates / starter | 7.0 | **4.6** | 4 → 8 |
| NEW i18n / localization | 6.0 | **6.0** | unchanged |

Two things worth carrying from this:

- **Templates was ranked 4th on a double-counted signal.** Its own bug evidence is weighted
  **2.7 across 5 issues** (quintile 1) — if templates were genuinely breaking from component
  drift, users would be reporting it, and they are not. The high churn was the false signal,
  exactly as the team stated.

  The 2.7 is itself a correction. The figure first read 6.1, because **"template" is
  ambiguous in Langflow**: the *Prompt Template component* is not a *starter template*, and
  5 of those 10 issues were Prompt Template defects (`Few Shot Prompt Template`,
  `Prompt template not being saved`, `Text Truncation in Prompt Template Component`, …).
  The component now matches first; Component config went 90.9 → 94.3, the unclassified
  residue stayed at 325, so no issue was lost. The ranking did not move — the bug quintile
  fell 2 → 1 but probability still rounds to 2.
- **i18n does not move**, which is the useful part: its churn never drove its probability.
  The black-screen bug evidence did. The finding survives the same critique that demoted
  Templates — worth knowing, since both were surfaced by the same residue pass.

Templates remains cheap to act on despite ranking 8th: **the specs already exist** as 39
`[-]` bullets. Effort-per-point is not in the risk model, and should not be — but it is a
real input to sequencing.

## Scope exclusions

25 % of Langflow's bug history is not addressable by a Playwright spec against a running
instance. Calling it a coverage gap would be wrong. Excluded, with counts:

| Excluded surface | Issues | Weighted | Why |
|---|---|---|---|
| **Vendor bundles** | **227** | **128.0** | **Team decision 2026-08-06 — no longer supported by this QA team** |
| docker / deploy | 115 | 54.8 | Not a UI surface |
| install / packaging | 94 | 41.2 | Not a UI surface |
| backend internals | 50 | 24.8 | FastAPI/async/pydantic/Redis internals |
| desktop / platform | 37 | 23.0 | Desktop app and OS-specific |
| database / infra | 22 | 9.4 | Postgres/SQLite/migrations |
| docs / website | 14 | 5.4 | Not the product |
| third-party tool components | 10 | 5.1 | Vendor integrations |

### Deployments was scored, then dropped

An area for the 1.12 Deployments page was scored and removed on 2026-08-07. Two reasons,
in order of weight:

1. **Its only implemented destination is watsonx Orchestrate**
   (`WatsonxOrchestrateDeploymentService`, `watsonx_orchestrate`). There is no
   vendor-neutral mechanism underneath it, so the page is a single vendor integration —
   the same class as the excluded bundles, and excluded on the same team decision.
2. Its apparent bug evidence was a **naming collision**: all 21 issues matching
   "deployment" are docker / k8s / Render / Railway / GCP infrastructure, already counted
   under `docker/deploy`. The page itself has zero reported defects.

Recorded rather than deleted, because the first scoring of it used **invented** churn and
bug figures (8.0 and 0.5). Measurement gave 4.25 and 0.0. That mistake is what prompted
the rule now applied throughout: every probability input is measured, never estimated —
see `measuredInputs` in `data.json`.

### The bundle decision is the single largest finding

At **128.0 weighted / 227 issues / 22 of them `jira`**, unsupported vendor bundles are the
**largest single source of Langflow bugs** — larger than any in-scope area, Component
config (90.9) included.

Only 41 of those 227 carried the upstream `bundles` label; the other 186 were identified
by vendor name in the title. Without the team's scope decision they would have counted as
our risk, and they were inflating two areas materially:

| Area | Before exclusion | After | What was removed |
|---|---|---|---|
| 7 Model providers | 75.6 | **34.9** | Bedrock, NVIDIA, OpenRouter, Watsonx, Groq, Mistral, Ollama, Azure |
| 5 Knowledge / files | 40.2 | **25.1** | Qdrant, Pinecone, Chroma, Milvus, PGVector, Weaviate, Cassandra, Astra |

Core providers (OpenAI / Anthropic / Gemini) stay in scope even when a title names a
bundle alongside them.

## Trend — where it is getting worse

Per-year issue counts (`2023 / 2024 / 2025 / 2026`) separate a **chronic** area from a
**one-off spike**:

| Area | By year | Reading |
|---|---|---|
| 13/14 MCP | `0 / 0 / 53 / 17` | Did not exist before 2025. **20 `jira` — the highest severity ratio in the corpus (29 %)**, vs 5 % for Component config. Churn agrees: `0 / 0 / 389 / 306`. |
| 8 Observability | `1 / 7 / 11 / 12` | The only area still rising in 2026, 8 `jira`. Mitigation is already 0.80 — worth checking the tests cover *what changed*. |
| 6 Agents | `0 / 28 / 48 / 18` | Sustained, 13 `jira`. |
| 2 Component config | `6 / 95 / 75 / 13` | Falling sharply — the 2024 peak is a retired surface. Decay is what keeps it from dominating. |
| 11 Templates | churn `433 / 1458 / 2813 / 2232` | Highest matched churn in the product — but **derived**, see the correction above. Its own bug evidence is only 6.1. |

## Confidence and limits

Stated plainly, because the ranking is only as good as these:

- **17.0 % of the issue corpus is unclassified** (325 of 1912). The ×2-weighted axis rests
  on 82.3 % of the corpus. Good enough to *order* areas; **not** good enough for fine
  distinctions between neighbours in the ranking. The residue is concentrated in 2024–2025
  (314 of 325), which enter at decay 0.3 and 0.6.
- **Churn left 90.5 weighted unmatched** — more than all matched areas combined (configs,
  CI, `pyproject`, and the mass `src/lfx/` restructure). It dilutes areas roughly evenly,
  so relative ranking holds; absolute churn is not interpretable alone.
- **Churn measures activity, not quality.** A heavily-committed area may be being
  *improved*. This is why churn carries weight 1 against the issues' weight 2.
- **Fragility and impact are judgement**, one rationale per row in `data.json`. Impact is
  anchored to langflow.org's advertised promise rather than intuition, but the 1–5 mapping
  is still a call.
- **A2A's probability is genuinely low, not artificially low.** Churn was expected to
  rescue it from a thin bug history and did not: 19 file touches, 2026 only, weighted 0.10.
  Its risk comes almost entirely from impact.
- **`12.6 Build / graph engine` mitigation is 0.70, not its bullet-derived 0.53.** Measured:
  73 specs trigger a flow run and 63 are `@stable`, so a *total* engine break reddens the
  daily loudly. Subtle defects — cycles, partial failure, execution order — have no
  dedicated assertion, so it is not 0.80 either.

## What this implies for the next wave

Not issues yet — that is a separate decision. In residual-risk order:

1. **Create a security area in the checklist.** It is rank 1 purely because it is
   unmeasured, and it cannot be triaged while it is invisible to every count.
2. **Raise MCP and Agents above 0.80.** Both are at the matrix maximum and both are the
   advertised product. This is a re-allocation, not new ground.
3. **Close A2A.** Low probability, but 0.21 mitigation on an advertised surface.
4. **Create an i18n area.** Zero coverage, with a known total-failure mode (black screen by
   browser locale) evidenced by bugs rather than by churn.
5. **Assert the graph engine's own contract** — cycles, partial failure, execution order.
   A total break is caught by 63 `@stable` specs; a subtle one is caught by nothing.
6. **Convert the 39 `[-]` template bullets.** Ranks 8th, not 4th, after the derived-churn
   correction — but the specs already exist, so it is the cheapest point on the list.

### The `[-]` problem underneath all of it

**89 of 500 checklist bullets are `[-]`** — automated, and running in **no scheduled lane**.
They count as coverage in every generated figure and are watched by nothing on a schedule.
39 of them are Templates alone. Separating them from `[x]` is most of what this method did.

---

*Regenerating: `data.json` is the source of truth; this document renders it. The collection
scripts are not committed — the two derivable axes are recorded with per-row provenance so
the next cycle is an edit, not a rebuild. Update after each Langflow release cycle.*
