# Templates — surface map, testability decision record and spec batch scope

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`, `langflowai/langflow-nightly:latest`,
measured 2026-09-15)

**Issue:** #1860 (pool — *needs scoping first*; scoping issue) ·
**Related:** #1744 (*Research Translation Loop* is not registered), #1002 (template-load
concurrency), `docs/triage/inherited-spec-triage.md` (T2 row for `starter-projects.spec.ts`)

---

## What this test validates *(required)*

**This document ships no `.spec.ts`.** #1860 is a scoping issue: its deliverable is the
named `QA-CHECKLIST.md` bullets under `### core-functionality/templates/` (§11.1–§11.5)
plus this record, which the template spec issues consume as their input contract. What it
validates is therefore the **scope decision itself** — that every template behavior
reachable from a decoupled, URL-only Playwright suite is either (a) claimed by a named
bullet with a concrete observable, or (b) written down as out of scope with the reason.

It replaces a §11 that could not be scheduled. Measured against the product on
2026-09-15, the 34 bullets it had described a gallery that no longer exists:

- **12 bullets named no template.** Nine names exist on none of `main`,
  `release-1.13.0` or `release-1.12.1` (Invoice Summarizer, Youtube Analysis, Dynamic
  Agent, Hierarchical Agent, Pokedex Agent, News Aggregator, Prompt Chaining, Decision
  Flow, Similarity); three were variants of a template rather than templates (Basic
  Prompting (Anthropic), Simple Agent (Anthropic), Simple Agent with memory).
- **One bullet was counted twice.** *MCP Server (starter projects)* is the MCP-server
  presets surface, already `[x]` in §14.1 — not a flow template.
- **6 shipped templates had no bullet:** Content Aggregator, Multi Agent Flow, Meeting
  Summary, Hybrid Search RAG, Knowledge Retrieval, Deep Research Agent.
- **Its subsections were not the product's taxonomy** (Basic / Content Generation /
  Analysis and Processing / Agent / Advanced), and its one dedicated spec,
  `core-functionality/templates/starter-projects.spec.ts`, waits for cards the gallery no
  longer renders (`template_research-agent`, among others) — 0/3 in the Wave 8
  measurement.

It covers four surfaces, all measured live (see *Surface map*):

1. **Registration** — which shipped templates the running image offers at all.
2. **Gallery** — how the New Flow modal presents them: tabs, category membership,
   featured cards, search, and the welcome panel's quick picks.
3. **Instantiation** — picking a card creates a flow that is the template.
4. **Execution** — the created flow runs, where a run needs nothing the suite cannot
   supply deterministically.

---

## Tags *(required)*

This doc carries no test, so it carries no tag of its own. The batch it authorizes uses:

| Planned spec | Cross-cutting | Functional |
|---|---|---|
| `templates-registration` | `@api` `@release` | `@templates` |
| `templates-gallery` | `@workspace` `@release` | `@templates` |
| `templates-instantiate` | `@workspace` `@regression` | `@templates` |
| `templates-run-*` | `@release` | `@templates` (+ `@agents` where the template's model is an Agent, `@files` for file input) |

`@stable` is not pre-assigned here. It follows the repo rule per spec: it enters in the
spec's own PR once that spec is validated, or its absence is explained in the spec doc.

---

## Validation criterion *(required)*

The scoping deliverable is satisfied when all four hold:

1. `QA-CHECKLIST.md` §11 contains `#### 11.1 Registration and Gallery`, `#### 11.2
   Instantiation — every registered template`, `#### 11.3 Execution — prompts, agents and
   image input`, `#### 11.4 Execution — file input` and `#### 11.5 Execution — knowledge
   base`, whose bullets each name a **concrete observable** (a listing, a testid, a graph
   equality, a build badge, a sentinel) — never "the template works".
2. Every bullet maps to exactly one row of the *Planned spec inventory* below, and every
   row of that inventory maps to at least one bullet.
3. Every bullet the old §11 carried is accounted for in *Checklist reconciliation*, and
   every behavior not scoped is listed under *Out of scope* with the reason, so a future
   reader does not re-litigate it.
4. `MODULES` in `scripts/coverage-summary.ts` needs **no** change: the section header
   `### core-functionality/templates/` is kept, so every new bullet is still counted under
   the same module. Only `####` headings inside the section change, and no generated block
   keys off them.

---

## External dependencies *(required)*

Every path below was resolved on `main`, `release-1.13.0` and `release-1.12.1`.

- `src/backend/base/langflow/initial_setup/starter_projects/` — the shipped template
  JSONs (27 on all three refs): `name`, `name_key`, `tags` and the graph each card creates.
  A rename, a re-tag or a graph edit here moves every bullet in §11.
- `src/backend/base/langflow/initial_setup/setup.py` —
  `filter_starter_projects_by_available_components`, the startup rule that drops a
  template whose component types the image does not ship, and the warning text it logs.
- `src/lfx/src/lfx/utils/component_aliases.py` — `flatten_components_with_aliases`, which
  is why legacy node types in the JSONs (`Prompt`, `parser`, `AstraDB`) still count as
  available.
- `src/backend/base/langflow/api/v1/flows.py` — `read_basic_examples`
  (`GET /api/v1/flows/basic_examples/`, the listing the modal reads) and
  `_filter_basic_examples_by_catalog_policy` (a template blocklist removes entries from it).
- `src/frontend/src/modals/templatesModal/index.tsx` — the tab list (*Get started*, *All
  templates*, the five *Use Cases* and three *Methodology* tabs) and `blank-flow`.
- `src/frontend/src/modals/templatesModal/utils/template-availability.ts` —
  `FEATURED_TEMPLATE_KEYS`, `availableTemplateTabs` (a tab is offered only when a visible
  template carries its id) and `isTemplateVisible` (the `ENABLE_KNOWLEDGE_BASES` gate).
- `src/frontend/src/modals/templatesModal/components/TemplateContentComponent/index.tsx` —
  the exact-tag filter, the Fuse search over `name` and `description`, and
  `search-input-template`.
- `src/frontend/src/modals/templatesModal/components/GetStartedComponent/index.tsx` — the
  featured cards, resolved by `name_key`.
- `src/frontend/src/modals/templatesModal/components/TemplateGetStartedCardComponent/index.tsx`
  — `template-get-started-card-<slug>`, the featured card's testid.
- `src/frontend/src/modals/templatesModal/components/navComponent/index.tsx` — the tab
  navigation and `modal-title`: `side_nav_options_<title>` is built from the tab's
  lowercased **title**, not its tag id, and `category_title_<title>` labels it in every tab.
- `src/frontend/src/modals/templatesModal/components/TemplateCardComponent/index.tsx` —
  `template-<slug>` on the card and `template_<slug>` on its heading.
- `src/lfx/src/lfx/components/data_source/web_search.py` — Web Search backends
  (DuckDuckGo for *Web*, Google News for *News*, a feed reader for *RSS*), none keyed; the
  reason eight templates' execution is not scoped.

Suite side: `tests/helpers/flows/load-template-by-name.ts` and
`tests/helpers/flows/open-new-flow-templates-modal.ts` (the canonical New Flow → gallery →
pick path, concurrency-hardened in #1002), `tests/helpers/knowledge/knowledge-base.ts`,
`tests/helpers/filesystem/upload-file.ts`, the self-hosted echo endpoint (`ECHO_BASE_URL`,
#1128) and `resolveTestTargets` for the one model an execution spec needs.

---

## Surface map (measured on `1.13.0.dev12`)

### Registration

Upstream ships **27** template JSONs, the same 27 on the three refs above. At startup the
backend keeps only templates whose every node type is in the live component registry —
aliases included, and with one exemption: a node that carries its own `code` and no
`metadata.module` counts as an embedded custom component and is never "missing". On this
image one template is dropped, with this line in the log:

```
[warning] Skipping starter project 'Research Translation Loop'; unavailable components: ArXivComponent
```

That is #1744's condition, and it is image-side: no test-side change can make the card
appear. The exemption is also why **Meeting Summary is registered** even though
`AssemblyAITranscriber` is absent from `GET /api/v1/all` — its node embeds its own code.

| Listing | Items | Role |
|---|---|---|
| `GET /api/v1/flows/basic_examples/` | **26** | What the gallery reads. Each entry carries `name`, `name_key`, `tags` and the full graph; the response is gzip-encoded |
| `GET /api/v1/starter-projects/` | **5** (Basic Prompting, Blog Writer, Document Q&A, Memory Chatbot, Vector Store RAG) | A smaller, separate listing. Its auth gate is §1.15's and its blocklist filtering is §21.2's; not scoped further here |

A catalog policy that blocks a template removes it from the listing — which means a gallery
or registration spec must never share an instance with an active template block. The
governance specs that set one run in the `@destructive` lane and restore the policy.

### Gallery

**Entry.** `new-project-btn` (or `new_project_btn_empty_page` on an empty project) creates
a placeholder flow named `New Flow` and opens `flow-builder-welcome-panel` over its canvas.
The panel offers two quick picks — `flow-builder-welcome-template-simple-agent` and
`flow-builder-welcome-template-vector-store-rag` — and `flow-builder-welcome-browse-more`,
which opens the modal (`modal-title`). Measured: picking a template leaves only the
template's flow behind (the placeholder is removed), while dismissing the modal keeps the
placeholder — a spec that opens the gallery without picking owns that flow's cleanup.

**Tabs.** A template belongs to a tab when its `tags` contain that tab's id **exactly**;
*All templates* lists everything visible, and a tab is offered only when some visible
template carries its id. The navigation testid is built from the tab's **title**, not its
id, so two of them differ from the tag they filter on:

| Nav testid | Filters on tag | Cards measured |
|---|---|---|
| `side_nav_options_get-started` | `FEATURED_TEMPLATE_KEYS` by `name_key` | `template-get-started-card-basic-prompting`, `template-get-started-card-vector-store-rag`, `template-get-started-card-simple-agent` |
| `side_nav_options_all-templates` | — | 26 |
| `side_nav_options_assistants` | `assistants` | 8 |
| `side_nav_options_classification` | `classification` | 2 |
| `side_nav_options_coding` | `coding` | 2 |
| `side_nav_options_content-generation` | `content-generation` | 5 |
| `side_nav_options_q&a` | `q-a` | 3 |
| `side_nav_options_prompting` | `chatbots` | 10 |
| `side_nav_options_rag` | `rag` | 3 |
| `side_nav_options_agents` | `agents` | 10 |

Selector traps, each measured:

- **`category_title_<tab>` is the navigation label, rendered in every tab.** It is not a
  "the tab switched" signal; asserting it visible after a click proves nothing, which is
  one of the assertions `starter-projects.spec.ts` relies on.
- **Cards carry two testids**: `template_<slug>` on the heading and `template-<slug>` on
  the card. The slug keeps punctuation — `template_document-q&a`.
- **Search is fuzzy.** `search-input-template` runs Fuse over `name` and `description`
  within the current tab: *Knowledge* returns Knowledge Retrieval, SEO Keyword Generator
  and Document Q&A; *Social Media* also returns Financial Report Parser and Deep Research
  Agent; a string matching nothing returns zero cards. An assertion on search results can
  be inclusion or emptiness, never equality.
- **Visibility has a build-time gate.** When `ENABLE_KNOWLEDGE_BASES` is off, every
  template whose name contains *Knowledge* is hidden from every tab. The nightly build has
  it on (Knowledge Retrieval is listed); a spec cannot toggle it, so it reads the listing
  it is given rather than hardcoding 26.

Tags that name no tab, and so place a template nowhere beyond *All templates*: `openai`,
`knowledge-base`, `hybrid`, `web-scraping` — and `agent`, below.

### Catalog anomalies found by this scoping (candidate upstream defects, not filed)

1. **Social Media Agent is missing from the *Agents* tab.** It is tagged `agent`, not
   `agents`, on `main`, `release-1.13.0` and `release-1.12.1`; under the exact-match rule
   it appears under *Assistants* only.
2. **Knowledge Retrieval appears in no tab.** Its `tags` is `[]`; it is reachable only
   from *All templates* or by search.
3. **Meeting Summary ships a stale memory-base reference.** Its `MemoryBase` node's
   required `memory_base` field defaults to `test MB`, a name no user instance has.

None of the three is asserted as a defect by the planned specs: the gallery spec derives
membership from the listing, so it stays green on the data as shipped and turns red only if
the filter stops honoring it. Filing them is a follow-up, below.

### Instantiation (measured)

Every registered template was instantiated through the path `loadTemplateByName` takes —
New Flow → welcome panel → *Browse more templates* → *All templates* → the card's heading —
one fresh page per template. Each created flow was read back through
`GET /api/v1/flows/{id}`, compared with its entry in the listing, and deleted; the
instance's user-flow count ended where it started.

**26 of 26 match exactly**: the persisted component types, edge count and note count equal
the listing's, the editor opened on every one, and the canvas rendered the same numbers. No
template rendered an outdated-component, missing-component or error indicator (no visible
testid or text matching *update*, *outdated*, *error*, *warn*, *invalid*, *missing*,
*broken*, *legacy* or *deprecated*). Each pick took 7–10 s including a 4 s settle; the
first, on a cold page, 14.5 s.

| Template | Components | Edges | Notes | Persisted = listing |
|---|---|---|---|---|
| Basic Prompting | 4 | 3 | 2 | yes |
| Blog Writer | 5 | 4 | 1 | yes |
| Content Aggregator | 7 | 6 | 1 | yes |
| Custom Component Generator | 5 | 4 | 1 | yes |
| Deep Research Agent | 8 | 8 | 1 | yes |
| Document Q&A | 6 | 6 | 1 | yes |
| Financial Report Parser | 4 | 3 | 1 | yes |
| Hybrid Search RAG | 8 | 7 | 3 | yes |
| Image Sentiment Analysis | 3 | 2 | 1 | yes |
| Instagram Copywriter | 5 | 4 | 1 | yes |
| Knowledge Retrieval | 4 | 3 | 1 | yes |
| Market Research | 6 | 5 | 1 | yes |
| Meeting Summary | 6 | 5 | 1 | yes |
| Memory Chatbot | 4 | 3 | 1 | yes |
| Multi Agent Flow | 5 | 4 | 1 | yes |
| Portfolio Website Code Generator | 3 | 2 | 1 | yes |
| Price Deal Finder | 6 | 5 | 1 | yes |
| SaaS Pricing | 4 | 3 | 1 | yes |
| SEO Keyword Generator | 3 | 2 | 1 | yes |
| Sequential Tasks Agents | 7 | 7 | 1 | yes |
| Simple Agent | 5 | 4 | 1 | yes |
| Social Media Agent | 5 | 4 | 1 | yes |
| Text Sentiment Analysis | 7 | 6 | 1 | yes |
| Travel Planning Agents | 8 | 7 | 1 | yes |
| Twitter Thread Generator | 4 | 3 | 1 | yes |
| Vector Store RAG | 6 | 6 | 1 | yes |

**What that measurement means for the batch.** A spec asserting this equality finds no
defect on `1.13.0.dev12` — every template instantiates faithfully today. Its value is the
day that stops being true: a template JSON edited into a graph the frontend rewrites, a
node type the editor drops, an instantiation path that loses edges. That is a regression
detector, so it is only worth shipping with a force-fail that proves the comparison bites
(for instance, removing one edge from the expected entry must turn exactly that template's
test red).

---

## Per-template inventory

*Components* are display names, ×N marking a repeated node; *Run needs* is read from each template's graph in the listing. Every template needs a
configured model except Knowledge Retrieval, which needs an embedding provider for its
knowledge base instead.

| Template | Tabs (from tags) | Components | Run needs | Execution |
|---|---|---|---|---|
| Basic Prompting | Prompting | Chat Input, Prompt Template, Language Model, Chat Output | model | §11.3 |
| Blog Writer | Prompting, Content Generation | Chat Input, URL, Prompt Template, Agent, Chat Output | model + URL fetch (`docs.langflow.org`) | §11.3, URL re-pointed at `ECHO_BASE_URL` |
| Content Aggregator | Agents | Chat Input, Web Search (*News*), Batch Run, Write File, Parser, Agent, Chat Output | model + public web + writes a file | not scoped |
| Custom Component Generator | Coding | Chat Input, URL, Memory Base, Agent, Chat Output | model + Memory Base + URL fetch | not scoped |
| Deep Research Agent | Assistants, Agents | Chat Input, Web Search, Prompt Template ×2, Agent ×3, Chat Output | model + public web | not scoped |
| Document Q&A | RAG, Q&A | Chat Input, Knowledge, Parser, Prompt Template, Agent, Chat Output | model + knowledge base | §11.5 |
| Financial Report Parser | Prompting, Content Generation | Read File, Parser, Agent, Chat Output (no Chat Input) | model + uploaded file | §11.4 |
| Hybrid Search RAG | RAG, Q&A | Chat Input, Read File, Split Text, Astra DB ×2, Parser, Agent, Chat Output | model + Astra DB credentials | not scoped |
| Image Sentiment Analysis | Classification | Chat Input, Language Model, Chat Output | vision-capable model + image | §11.3 |
| Instagram Copywriter | Content Generation, Prompting, Agents | Chat Input, Web Search, Agent ×2, Chat Output | model + public web | not scoped |
| Knowledge Retrieval | — (*All templates* only) | Chat Input, Knowledge, Parser, Chat Output | knowledge base (embeddings), no LLM | §11.5 |
| Market Research | Assistants, Agents | Chat Input, Web Search, Agent, Structured Output, Parser, Chat Output | model + public web | not scoped |
| Meeting Summary | Prompting, Content Generation | Chat Input, AssemblyAI Transcriber, Memory Base, Prompt Template, Agent, Chat Output | model + AssemblyAI key + Memory Base | not scoped |
| Memory Chatbot | Prompting, Assistants | Chat Input, Memory Base, Agent, Chat Output | model + Memory Base | §11.3 (`[x]`) |
| Multi Agent Flow | Agents, Prompting | Chat Input, Agent ×3, Chat Output | model | §11.3 |
| Portfolio Website Code Generator | Prompting, Coding | Read File, Agent, Chat Output (no Chat Input) | model + uploaded file | §11.4 |
| Price Deal Finder | Agents | Chat Input, Web Search, URL, Memory Base, Agent, Chat Output | model + public web + Memory Base | not scoped |
| SaaS Pricing | Agents, Assistants | Chat Input, SQL Database, Agent, Chat Output | model + a database URL | not scoped |
| SEO Keyword Generator | Prompting, Assistants | Prompt Template, Agent, Chat Output (no Chat Input) | model | §11.3 |
| Sequential Tasks Agents | Assistants, Agents | Chat Input, Web Search, Prompt Template, Agent ×3, Chat Output | model + public web | not scoped |
| Simple Agent | Assistants, Agents | Chat Input, URL, Web Search, Agent, Chat Output | model (+ public web when a tool is called) | §11.3 (`[x]`) |
| Social Media Agent | Assistants | Chat Input, URL, Web Search, Agent, Chat Output | model + public web | not scoped |
| Text Sentiment Analysis | Classification | Read File, Prompt Template, Agent ×3, Chat Output ×2 (no Chat Input) | model + uploaded file | §11.4 |
| Travel Planning Agents | Agents | Chat Input, Web Search, URL, Calculator, Agent ×3, Chat Output | model + public web | not scoped |
| Twitter Thread Generator | Prompting, Content Generation | Chat Input, Prompt Template, Agent, Chat Output | model | §11.3 |
| Vector Store RAG | RAG, Q&A | Chat Input, Knowledge, Parser, Prompt, Agent, Chat Output | model + knowledge base | §11.5 |

Incidental use today: *Basic Prompting* is opened by 30 spec files as a fixture, *Simple
Agent* by the 29 that load `SimpleAgentTemplatePage`, *Memory Chatbot* by 3, *SaaS
Pricing* by the two catalog-policy specs, *Portfolio Website Code Generator* by
`ui-ux/refresh-dropdown-list.spec.ts`. Opening a template as a fixture exercises the path
while asserting nothing about the template, so it earns no bullet state on its own; the
two `[~]` in §11.2 are the specs that do assert part of a template's composition.

---

## Checklist reconciliation (the 34 bullets §11 carried before 2026-09-15)

| Old bullet (old state) | Disposition |
|---|---|
| Basic Prompting (OpenAI) `[~]` | §11.2 Basic Prompting `[~]` + §11.3 Basic Prompting `[ ]` — the provider is a lane's choice, not the template's |
| Basic Prompting (Anthropic) `[ ]` | **Removed** — a provider variant, not a template; provider coverage is `model-provider/` §7 |
| Simple Agent (OpenAI) `[~]` | §11.2 Simple Agent `[ ]` + §11.3 Simple Agent `[x]` |
| Simple Agent (Anthropic) `[ ]` | **Removed** — provider variant, as above |
| Simple Agent with memory `[ ]` | **Removed** — no such template; the memory template is Memory Chatbot |
| Vector Store RAG `[ ]` | §11.2 + §11.5 |
| Memory Chatbot `[x]` | §11.2 `[~]` + §11.3 `[x]` |
| Blog Writer `[ ]` | §11.2 + §11.3 |
| Instagram Copywriter `[ ]` | §11.2; execution not scoped (public web) |
| Twitter Thread Generator `[ ]` | §11.2 + §11.3 |
| SEO Keyword Generator `[ ]` | §11.2 + §11.3 |
| Portfolio Website Code Generator `[~]` | §11.2 `[ ]` + §11.4 `[ ]` — the spec that opens it asserts nothing about it |
| SaaS Pricing `[ ]` | §11.2; execution not scoped (database) |
| Document QA `[ ]` | §11.2 + §11.5, under its real name *Document Q&A* |
| Invoice Summarizer `[ ]` | **Removed** — no such template on any of the three refs |
| Financial Report Parser `[ ]` | §11.2 + §11.4 |
| Image Sentiment Analysis `[ ]` | §11.2 + §11.3 |
| Text Sentiment Analysis `[ ]` | §11.2 + §11.4 |
| Youtube Analysis `[ ]` | **Removed** — no such template |
| Dynamic Agent `[ ]` | **Removed** — no such template |
| Hierarchical Agent `[ ]` | **Removed** — no gallery template; upstream keeps `hierarchical_tasks_agent.py` as a programmatic graph beside the JSONs, which the gallery never lists |
| Sequential Task Agent `[ ]` | §11.2 *Sequential Tasks Agents*; execution not scoped (public web) |
| Social Media Agent `[ ]` | §11.2; execution not scoped (public web) |
| Travel Planning Agent `[ ]` | §11.2 *Travel Planning Agents*; execution not scoped (public web) |
| Market Research `[ ]` | §11.2; execution not scoped (public web) |
| Research Translation Loop `[~]` | §11.1 registered-set bullet, as a **declared absence** (#1744); the Loop component spec keeps its own bullet in §3.6 |
| Pokedex Agent `[ ]` | **Removed** — no such template |
| Price Deal Finder `[ ]` | §11.2; execution not scoped (public web) |
| News Aggregator `[ ]` | **Removed** — no such template. *Content Aggregator* is listed as new rather than as a rename, because nothing on the three refs proves it is one |
| Custom Component Generator `[ ]` | §11.2; execution not scoped |
| Prompt Chaining `[ ]` | **Removed** — no such template |
| Decision Flow `[ ]` | **Removed** — no such template |
| Similarity `[ ]` | **Removed** — no such template |
| MCP Server (starter projects) `[x]` | **Removed from §11** — MCP-server presets, already `[x]` in §14.1 (`mcp/server/mcp-server-starter-projects.spec.ts`); it was counted twice |

Net: 13 bullets removed, 21 replaced, and 6 templates gain bullets they never had.

---

## Testability decision record

### Depth policy

Three depths, chosen per template by what a run needs rather than by gallery category:

- **Registration and gallery** — keyless and deterministic, for everything. The expected
  sets are read from `GET /api/v1/flows/basic_examples/` at run time, so an upstream
  template change moves the expectation instead of reddening the spec; only the
  registration spec compares against a committed baseline, because it is the one place
  "a template disappeared" must be a failure.
- **Instantiation** — keyless and deterministic, for **every registered template**. The
  observable is equality: the persisted flow's component types, edges and notes equal the
  template's in the listing, and the editor opens on it. One bullet per template, like the
  per-provider bullets of §7, because a template breaking is a per-template red and the
  parametrized spec reports it that way.
- **Execution** — one model, only where every input the run needs can be supplied by the
  suite: a prompt, an image, a fixture file, a knowledge base the spec ingests into, or a
  URL on the self-hosted echo endpoint. The assertion is that the run completed — the
  terminal node's build badge, a non-empty output, and `page.flowErrorReport()` reporting
  `evaluated > 0` and `clean` (#1452) — **never the model's wording**. Where retrieval is
  involved, the retrieved text must contain a sentinel the spec ingested, which is
  model-free. The model tier is each spec's own decision under #1187.

### Planned spec inventory

Every path below is relative to `tests/tests-automations/regression/` (specs) and to
`docs/` (docs), i.e. `core-functionality/templates/<name>.spec.ts` ↔
`core-functionality/templates/<name>.md`.

| ID | Spec / doc basename | Bullets | What proves it |
|---|---|---|---|
| **R1** | `templates-registration` | §11.1 registered set | `GET /api/v1/flows/basic_examples/` names match a committed per-image baseline; an undeclared absence fails naming the template; a declared absence (*Research Translation Loop*, #1744) fails when it comes back, naming the declaration to delete; an extra template is reported, not failed |
| **G1** | `templates-gallery` | §11.1 all templates, tabs, get started, search, welcome panel | Card sets per tab equal the listing filtered by exact tag; the offered tabs equal the tags present; the three featured cards each create their template (`POST /api/v1/flows/` 201, name matching) while the two welcome quick picks **convert the New Flow placeholder in place** (`PATCH /api/v1/flows/{id}` 200, same id — measured 2026-09-16, corrected in #1863); a name query keeps its card and a nonsense query leaves none. Supersedes `starter-projects.spec.ts` |
| **S1** | `templates-instantiate` | §11.2, one test per registered template | Pick from *All templates* → editor opens → `GET /api/v1/flows/{id}` component types, edges and notes equal the listing's entry; id-scoped cleanup of the template flow |
| **E1** | `templates-run-prompts` | §11.3 Basic Prompting, Blog Writer, Multi Agent Flow, SEO Keyword Generator, Twitter Thread Generator | Run the terminal Chat Output; build badge, non-empty reply, clean flow-error report. Blog Writer's URL points at `ECHO_BASE_URL` |
| **E2** | `templates-run-image-input` | §11.3 Image Sentiment Analysis | An image attached in the Playground reaches a vision-capable model; the run completes with a non-empty reply and a clean report |
| **E3** | `templates-run-file-input` | §11.4 | A plain-text fixture uploaded into the File node (text, so no OCR or Docling model is involved) reaches the model; the run completes with a non-empty output and a clean report |
| **E4** | `templates-run-knowledge` | §11.5 | The spec ingests a sentinel document into a knowledge base it creates; the Knowledge node retrieves text containing the sentinel; Knowledge Retrieval shows it in Chat Output, the two RAG templates complete with a non-empty reply; the knowledge base is deleted |
| — | `llm-agents/memory-history-regression` (existing) | §11.2 Memory Chatbot `[~]`, §11.3 Memory Chatbot `[x]` | Already `@stable` |
| — | `llm-agents/agent-component-regression` (existing) | §11.3 Simple Agent `[x]` | Already `@stable`: the template as shipped, tools wired, answers three Playground turns |
| — | `flow-functionality/create-flow-from-template` (existing) | §11.2 Basic Prompting `[~]` | Already `@stable`: non-empty graph named after the template, not its composition |

**Shared preconditions.** R1, G1 and S1 need no provider key, no network egress and no
setup beyond the instance — they are the batch to schedule first (32 of the 46 bullets).
S1 creates one flow per template through the #1002-hardened path, so under parallel
workers it inherits that helper's retry and cleanup rather than re-implementing either.
E1–E4 need the one model `collect-models` resolved and run with `--workers=1`.

### Out of scope — and why

| Behavior | Why it is not scoped |
|---|---|
| Execution of Content Aggregator, Deep Research Agent, Instagram Copywriter, Market Research, Price Deal Finder, Sequential Tasks Agents, Social Media Agent, Travel Planning Agents | Their output depends on DuckDuckGo or Google News, which the self-hosted echo endpoint cannot stand in for, and on the model choosing to call a tool. The Agent-plus-web-search run shape is already executed through Simple Agent (§11.3); what these add over it is their other components, whose behavior is `core-components/` coverage, not template coverage. Each still gets its §11.2 instantiation bullet |
| Execution of Hybrid Search RAG and Meeting Summary | They need Astra DB and AssemblyAI credentials that no lane holds, with no self-hosted equivalent |
| Execution of SaaS Pricing | The SQL node needs a database URL the suite cannot provision through the instance it points at, and a schema the model would have to query |
| Execution of Custom Component Generator | Reachable — §20 registers memory bases and the URL can use the echo endpoint — but deferred: its run is Blog Writer's shape plus a Memory Base read §20 already covers |
| Research Translation Loop, anything beyond its declared absence | Not registered by the image (#1744); lifting that is #1744's deliverable |
| The `ENABLE_KNOWLEDGE_BASES`-off gallery | A frontend build-time flag; no instance the suite points at can switch it |
| The legacy `GET /api/v1/starter-projects/` listing beyond what §1.15 and §21.2 assert | Not what the gallery reads |
| Asserting the three catalog anomalies as defects | A spec that encodes today's data as wrong fails on every run until upstream changes it; they are filed instead |

---

## Follow-up work this scoping creates

1. ~~**Retire `core-functionality/templates/starter-projects.spec.ts`** once G1 is
   `@stable`.~~ **Done in #1863**: G1 shipped `@stable` as
   `core-functionality/templates/templates-gallery.spec.ts` and the file was deleted in the same
   PR, with `tests/assets/triage/inherited-backlog-baseline.json` refreshed — Wave 8's T2 DELETE
   outcome required a named replacing spec and test, and G1 is that name.
2. **File the three catalog anomalies upstream** (Social Media Agent's `agent` tag,
   Knowledge Retrieval's empty tags, Meeting Summary's `test MB`), each as its own issue.
3. **Date the batch at a roadmap review.** `ROADMAP.md`'s pool entry now points here as a
   decided tail; the natural first slice is R1 + G1 + S1.
