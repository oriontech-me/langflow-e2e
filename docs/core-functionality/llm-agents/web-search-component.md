# LLM Agents — Web Search component

**File:** `tests/tests-automations/regression/core-functionality/llm-agents/web-search-component.spec.ts`
**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev22`)

> **Replaces `duckduckgo.spec.ts`.** The DuckDuckGo Search component no longer exists
> on any tested image; the capability was consolidated into the core **Web Search**
> component, whose `Web` mode *is* the DuckDuckGo search. Triage row:
> `docs/triage/inherited-spec-triage.md` (T2,
> `core-functionality/llm-agents/duckduckgo.spec.ts`, `0/3 green`), filed as **#1912**.
> See *Why this replaced the DuckDuckGo spec*.

---

## What this test validates *(required)*

That the Langflow build still exposes a usable **web search** surface on the canvas:
the `Web Search` component can be found in the sidebar and added to a flow, it renders
its three search modes, its query field accepts and **persists** a value, and it
declares the `Results` output other components connect to.

If this broke, a user could not build any flow that searches the web — the capability
the deleted DuckDuckGo component used to provide.

**No live search is performed.** The assertions are about the component's presence,
configuration surface and persisted contract, all of which the instance answers on its
own. See *Why there is no live run*.

---

## Tags *(required)*

`@stable` `@release` `@components` `@agents`

`@stable` is claimed on the promotion conditions of the T2 triage design §3: 3/3 green,
id-scoped cleanup, this doc, and an executed force-fail. The spec touches no provider
and no external host, so it carries no provider gate and cannot skip for credentials.

---

## Precondition *(optional)*

- A running Langflow instance whose catalog exposes `data_source` → `UnifiedWebSearch`
  (core; present on the stock nightly, no vendor distribution required)
- Auto-login enabled, as every other spec in this area assumes

---

## Step by step *(required)*

1. Bootstrap the app (`awaitBootstrapTest`) and create a blank flow (`blank-flow`),
   capturing the created flow id from the `POST /api/v1/flows/` 201 for cleanup
2. Search the sidebar for `web search` (`sidebar-search-input`)
3. Hover the sidebar card `data_sourceWeb Search` and click
   `add-component-button-web-search`
4. Assert the node landed: `title-Web Search` is visible
5. Assert the three search modes render as tabs: `tab_0_web`, `tab_1_news`, `tab_2_rss`
6. Fill `popover-anchor-input-query` with a unique sentinel query
7. Assert the output contract is declared on the node:
   `handle-unifiedwebsearch-shownode-results-right` and
   `output-inspection-results-unifiedwebsearch` are present
8. Poll `GET /api/v1/flows/{id}` until the flow holds exactly one node whose
   `data.type` is `UnifiedWebSearch`, then assert its persisted template
9. `afterEach` deletes only the captured flow id

---

## Validation criterion *(required)*

Read from server truth (`GET /api/v1/flows/{id}`), not from the canvas alone:

- the flow holds **exactly one** node and its `data.type` is `UnifiedWebSearch`
- `template.query.value` equals the sentinel typed in step 6
- `template.search_mode.value` is `Web` and `template.search_mode.options` is
  `["Web", "News", "RSS"]`
- the node declares exactly one output named `results`, whose `types` include `Table`

Plus, on the canvas: `title-Web Search` visible and all three mode tabs present.

The sentinel is what makes the persistence assertion non-coincidental — a default or a
neighbour's value cannot satisfy it.

---

## Why this replaced the DuckDuckGo spec *(the measurement, `1.13.0.dev22`)*

**The DuckDuckGo component is gone, and its flavour of absence is not packaging** —
which is what separates this spec from the three parked alongside it in #1912.

1. **Not in the catalog.** `GET /api/v1/all` returns **32 categories / 200 component
   types** (the 33rd top-level key is `component_display_names`, a metadata map and not
   a category) with **zero** `duckduckgo` entries across every `category/type` pair and
   every `component_display_names` key. The four raw substring hits in the response are
   incidental text inside *other* components' source — a `Search Mode` info string and
   the `html.duckduckgo.com` URL inside the Web Search implementation — not components.
   `getByTestId("duckduckgoDuckDuckGo Search")` and
   `waitForSelector('[data-testid="disclosure-bundles-duckduckgo"]')` can never resolve,
   which is the old spec's `page.waitForSelector: Timeout 3000ms exceeded`.

2. **There is no shim, so this is not `lfx-bundles` packaging.** `youtube`, `composio`,
   `assemblyai`, `Notion` and `searchapi` each still have a
   `lfx/components/<family>/__init__.py` marked `# lfx-bundles-shim` in the container.
   **`lfx/components/duckduckgo` does not exist at all** — no shim, no distribution to
   install, nothing for an availability gate to wait for. Parking it behind
   `probeProviderComponent()` would install a gate that can never open.

3. **The capability moved into core.** `lfx/components/data_source/web_search.py`
   implements `UnifiedWebSearch` with `perform_web_search()` documented as *"Perform
   DuckDuckGo web search"* against `https://html.duckduckgo.com/html/`, and its
   `Search Mode` field reads *"Choose search mode: Web (DuckDuckGo), News (Google News),
   or RSS (Feed Reader)"*. The component is `legacy: false` and lives in the `Data
   Sources` group of the sidebar, reachable at `data_sourceWeb Search`.

So `docs/component-distribution-policy.md`'s decision table puts this on its
*"The family is core and vanished, or a component was reparented → **Fix the spec**"*
row, not on the gate-and-skip row. That is the whole reason this file exists instead of
a fourth park.

---

## Why there is no live run *(a decision, not an omission)*

The deleted spec executed a real DuckDuckGo query and raced two outcomes —
`text=built successfully` against `text=ratelimit` — then asserted on whichever won.
Two reasons not to carry that forward:

- **It depends on the public internet.** This suite self-hosts its HTTP dependency
  precisely so a third party's 504 cannot read as a product failure (#1128,
  `go-httpbin`). There is no self-hostable DuckDuckGo, so a live run would reintroduce
  exactly the coupling that issue removed.
- **The old assertion could pass on a failed search.** Its `ratelimit` branch asserted
  only that the output contained the word `ratelimit` — i.e. it passed when the search
  did not work. A test with a branch that green-lights the failure mode is not a
  regression gate for it.

What is given up is stated rather than hidden: **this spec does not prove a search
returns results.** It proves the component that performs them is shipped, placeable,
configurable and wired. Covering execution would need a stubbed search backend, which
is its own issue.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/data_source/web_search.py` — the `UnifiedWebSearch`
  component under test: its `search_mode` options, its `query` input and its `results`
  output are exactly what the validation criterion asserts
- `src/backend/base/langflow/api/v1/endpoints.py` — serves `GET /api/v1/all`, the
  catalog that decides whether the sidebar can offer the component
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — renders
  the sidebar search and the `data_sourceWeb Search` card the spec clicks

---

## What this test does not cover *(optional)*

- executing a search and asserting its results (see *Why there is no live run*)
- the `News` and `RSS` modes' own field sets — only that the three modes are offered
- using Web Search as an agent tool; that path is covered by
  `llm-agents/agent-multi-tool-selection.spec.ts`

---

## When to review this test *(optional)*

- the catalog drift report names `data_source` or `UnifiedWebSearch`
- the component's `search_mode` options change (the criterion pins all three)
- a stubbable search backend becomes available, which would reopen the live-run decision
