# Templates — the gallery: tabs, featured cards, search and the welcome quick picks

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`, `langflowai/langflow-nightly:latest`,
measured 2026-09-16)

**Issue:** #1863 (row **G1** of the #1860 scoping pass) · **Scoped by:**
`docs/core-functionality/templates/templates-coverage-scope.md` ·
**Related:** #1862 (R1, the registered set), #966/LE-2019 (the New Flow dead click),
#1002 (template-load concurrency), #1865 (the blank editor after New Flow)

---

## What this test validates *(required)*

The **gallery** — the modal a user reaches through New Flow — is the only path from the UI to a
starter template, and this spec owns what it *renders* and what its entry points *do*:

1. the **All templates** tab renders one card per registered template;
2. each **category tab** lists exactly the templates carrying its tag, and only the tabs that have
   one are offered;
3. **Get started** shows exactly the three featured cards, and each of them creates its template;
4. **search** keeps a template's card for its own name and leaves none for a string that matches
   nothing;
5. the **welcome panel**'s quick picks turn the just-created flow into their template, and
   *Browse more templates* opens the gallery.

**Every expected set is derived at run time from `GET /api/v1/flows/basic_examples/`** — the same
listing the gallery itself reads — and none of it is hardcoded. That is the layering with R1
(#1862): **R1 owns WHICH templates are registered**, against a committed baseline, and fails when
one disappears; this spec owns **how the listing is rendered** and follows it. A template removed
upstream therefore reddens exactly one spec (R1) and moves this one's expectation, instead of
reddening both with the same cause — and the reverse also holds: a template that is listed but
never rendered (a tab filter that stops matching, a card that stops mounting) is invisible to R1
and is precisely what this spec is for.

It replaces `core-functionality/templates/starter-projects.spec.ts`, which waits for cards this
gallery no longer renders (0/3 in the Wave 8 measurement) and asserts `category_title_<title>`,
a label visible in **every** tab.

### The tabs, measured

A template belongs to a tab when its `tags` contain that tab's tag **exactly**; the nav testid is
built from the tab's *title*, which is not always its tag:

| Nav testid | Filters on | Cards (2026-09-16) |
|---|---|---|
| `side_nav_options_get-started` | the three featured `name_key`s | 3 featured cards, 0 template headings |
| `side_nav_options_all-templates` | — | 26 |
| `side_nav_options_assistants` | `assistants` | 8 |
| `side_nav_options_classification` | `classification` | 2 |
| `side_nav_options_coding` | `coding` | 2 |
| `side_nav_options_content-generation` | `content-generation` | 5 |
| `side_nav_options_q&a` | `q-a` | 3 |
| `side_nav_options_prompting` | **`chatbots`** | 10 |
| `side_nav_options_rag` | `rag` | 3 |
| `side_nav_options_agents` | `agents` | 10 |

Two consequences the spec encodes rather than hardcodes:

- **A tag is not a tab.** `agent` (singular, on *Social Media Agent*), `openai`, `knowledge-base`,
  `hybrid` and `web-scraping` carry no nav entry. The offered set is the fixed tab list **filtered
  to the tags the listing actually carries**, so a tab whose tag no template has is not offered.
- **A template with no tag at all is reachable only from All templates.** *Knowledge Retrieval*
  ships with an empty `tags` array and appears in no category tab.

### What each entry point does to flows, measured by id

| Path | Flows afterwards |
|---|---|
| Gallery → pick a card | `POST /api/v1/flows/` **201** creates a NEW flow holding the template, and the New Flow placeholder is **removed** (`DELETE /api/v1/flows/` 200). The editor lands on the new id |
| Welcome panel → quick pick | **No new flow.** The 201 already happened at the New Flow click; the quick pick sends `PATCH /api/v1/flows/{placeholder id}` **200** and the **placeholder becomes** the template — same id, renamed to the template's name (suffixed ` (N)` when that name is taken) |
| Gallery → close without picking | The placeholder **stays**, and leaks as `New Flow (N)` unless the spec deletes it |

So the quick-pick assertion is the **`PATCH` on the placeholder's own id** plus the persisted
flow, never a `POST` 201 — the §11.1 bullet and the scope doc's G1 row both said *create*, and
both are corrected in this PR. And every test that opens New Flow **owns that placeholder**: the
shared tracker (`tests/helpers/flows/track-created-flows.ts`) records every
`POST /api/v1/flows` 201 from before the click and deletes them by id in `afterEach`, which covers
all three paths above (a flow the gallery already deleted answers 404, which the cleanup treats as
done).

### Selector traps this spec is written around

- **Each card carries two testids:** `template-<slug>` on the card, `template_<slug>` on its
  heading. The featured cards are a third shape — `template-get-started-card-<slug>`.
- **The slug is `name.replace(/ /g, "-").toLowerCase()`**: only spaces change, punctuation stays,
  so *Document Q&A* is `template_document-q&a`.
- **`modal-title` is asserted VISIBLE, never by text.** Its `innerText` reads `Templates`, but the
  sidebar toggle's screen-reader label lives inside the same node, so `textContent` reads
  `Toggle SidebarTemplates` — a text assertion here is a trap that depends on which accessor runs.
- **No attribute marks the active tab.** The nav buttons expose neither `aria-selected` nor
  `data-state`, so "which tab is open" is only observable through the cards rendered — which is
  how this spec proves that Get started is the default (three featured cards, zero
  `template_<slug>` headings, on a freshly opened modal).
- **`category_title_<title>` is visible in every tab.** It is the nav label; it proves nothing
  about the active tab. `starter-projects.spec.ts` relies on it.
- **Search is fuzzy and tab-scoped.** It runs Fuse over `name` and `description` within the open
  tab: *Knowledge* returns Knowledge Retrieval, Document Q&A and SEO Keyword Generator. The
  assertion is therefore **inclusion** (a template's own name keeps its card) or **emptiness**
  (a nonsense string leaves none) — never an exact set.

### One assumption, stated rather than hidden

The frontend's `isTemplateVisible` hides every template whose name contains *Knowledge* when the
bundle is built with `ENABLE_KNOWLEDGE_BASES` off. **A spec cannot read that build flag**, and the
nightly ships it **on** (*Knowledge Retrieval* is both listed and rendered, measured). This spec
therefore expects the listing as served, and a build with the flag off would fail the All
templates scenario — deliberately, with the failure message naming the flag, so that red is
attributable in one read instead of looking like a vanished template (which is R1's failure, not
this one's).

## Tags *(required)*

`@stable` `@release` `@workspace` + `@templates`

- `@release` — the gallery is how a user starts any flow from a template; a broken tab or a
  featured card that creates nothing is release-blocking.
- `@workspace` — it creates and converts flows.
- `@templates` — the functional area.
- `@stable` enters in this spec's own PR, after the validation below (repo rule: a validated spec
  carries the tag at merge, not a cycle later).
- Deliberately **not** `@api`: the listing is read to derive expectations, not asserted — the
  endpoint's shape is `api/flows/api-flows-public-and-metadata.spec.ts`'s, its membership is R1's.

## Validation criterion *(required)*

| # | Test | Passes only when |
|---|---|---|
| 1.1 | All templates renders every registered template | the set of `template_<slug>` headings equals the listing's names mapped through the slug rule — no extra, none missing |
| 1.2 | Category tabs filter by exact tag | for every offered tab, its headings equal the listing filtered by that tab's tag; and the offered nav testids equal the fixed tab list filtered to the tags the listing carries |
| 1.3 | Get started shows exactly the three featured cards | `template-get-started-card-basic-prompting`, `-vector-store-rag`, `-simple-agent` are visible, there is no fourth featured card, and no `template_<slug>` heading is rendered on that tab |
| 1.4 | Each featured card creates its template | picking it answers `POST /api/v1/flows/` 201 whose `name` is the template's (optionally ` (N)`), on a NEW id, and the editor opens on that id |
| 1.5 | Search keeps a name match and empties on nonsense | typing a template's exact name leaves its own card rendered; a string matching no name or description leaves zero cards |
| 1.6 | A quick pick converts the placeholder in place | the click answers `PATCH /api/v1/flows/{placeholder id}` 200, no `POST /api/v1/flows/` fires, the URL keeps the same id, and the persisted flow carries the template's name and its component types |
| 1.7 | Browse more opens the gallery | from the welcome panel, `flow-builder-welcome-browse-more` makes `modal-title` visible |

## Precondition

- A running Langflow nightly at `PLAYWRIGHT_BASE_URL`, auto-login on. **No provider key and no
  network egress** — every scenario here is keyless and deterministic.
- `GET /api/v1/flows/basic_examples/` answers a non-empty array. An empty or error body is not a
  green run with zero expectations: the spec fails naming what it read (an empty listing is what a
  still-starting instance answers, and R1 records the same rule).
- The home entry point is reachable in both states (`new-project-btn` with flows,
  `new_project_btn_empty_page` without) — `openNewFlowTemplatesModal` already handles both, plus
  the #966 dead-click window and the #1865 blank-editor recovery.

## Step by step

### 1.1 All templates renders one card per registered template `[-]`

- **File:** `tests/tests-automations/regression/core-functionality/templates/templates-gallery.spec.ts`
- **Objective:** the tab that promises every template renders every template, so a card that stops
  mounting is not invisible to the suite.
- **Precondition:** listing read through `GET /api/v1/flows/basic_examples/`.
- **Step by step:**
  1. `openNewFlowTemplatesModal(page)` — New Flow → gallery.
  2. Click `side_nav_options_all-templates`.
  3. Collect every `template_<slug>` heading testid rendered.
- **Validation:** the collected set equals the listing's names mapped through
  `name.replace(/ /g, "-").toLowerCase()`. The failure names the missing and the extra slugs, and
  points at `ENABLE_KNOWLEDGE_BASES` when every missing name contains *Knowledge*.

### 1.2 Category tabs list exactly their tagged templates `[-]`

- **Objective:** the tab filter is an exact tag match, and a tab with nothing to show is not
  offered.
- **Step by step:**
  1. Open the gallery.
  2. Collect the offered `side_nav_options_*` testids.
  3. For each category tab, click it and collect its `template_<slug>` headings.
- **Validation:** per tab, headings equal the listing filtered by that tab's tag (`prompting` →
  `chatbots`, `q&a` → `q-a`); and the offered set equals `get-started` + `all-templates` + the
  category tabs whose tag at least one listed template carries.

### 1.3 Get started shows exactly the three featured cards `[-]`

- **Objective:** the default tab is the featured one, and it is exactly three cards.
- **Step by step:**
  1. Open the gallery and do **not** click any tab.
  2. Collect every `template-get-started-card-<slug>` and every `template_<slug>` heading.
- **Validation:** the featured set is exactly `basic-prompting`, `vector-store-rag`,
  `simple-agent`; no `template_<slug>` heading is rendered — which is also what proves Get started
  is the tab that opens by default, since no attribute marks the active tab.

### 1.4 Each featured card creates its template `[-]`

- **Objective:** the featured cards are not decoration — each one instantiates its template.
- **Step by step (once per featured card):**
  1. Open the gallery on Get started.
  2. Click `template-get-started-card-<slug>` while waiting for `POST /api/v1/flows/`.
  3. Read the created flow's id and name from the 201 body.
- **Validation:** status 201, `name` equal to the template's name or that name with a ` (N)`
  suffix, an id different from the New Flow placeholder's, and the editor open on that id
  (`canvas_controls_dropdown` visible).

### 1.5 Search keeps a name match and empties on nonsense `[-]`

- **Objective:** the search box filters the open tab instead of clearing it or ignoring the query.
- **Step by step:**
  1. Open the gallery, click All templates.
  2. `search-input-template` ← a template's exact name; collect headings.
  3. `search-input-template` ← a string that matches no name or description; collect headings.
- **Validation:** the first query keeps that template's own heading (inclusion — the match is
  fuzzy, so siblings may come along); the second leaves zero headings.

### 1.6 A quick pick converts the placeholder in place `[-]`

- **Objective:** the welcome panel's quick picks are the one path that does **not** create a flow,
  and the spec asserts the conversion rather than a creation that never happens.
- **Step by step (once per quick pick):**
  1. From the home page, click New Flow and wait for `flow-builder-welcome-panel` (the panel, not
     the gallery — so this path does not go through `openNewFlowTemplatesModal`, which dismisses
     it).
  2. Record the placeholder id from the New Flow `POST /api/v1/flows/` 201.
  3. Click `flow-builder-welcome-template-<slug>` while watching the writes to `/api/v1/flows`.
  4. Read the persisted flow through `GET /api/v1/flows/{placeholder id}`.
- **Validation:** a `PATCH /api/v1/flows/{placeholder id}` answered 200, **no** `POST
  /api/v1/flows/` fired during the click, the URL still carries the same id, and the persisted
  flow's name is the template's (optionally ` (N)`) with its component types equal to the
  template's in the listing.

### 1.7 Browse more opens the gallery `[-]`

- **Objective:** the panel's escape hatch to the full gallery works — the path every other
  template spec depends on through `openNewFlowTemplatesModal`.
- **Step by step:**
  1. New Flow → `flow-builder-welcome-panel`.
  2. Click `flow-builder-welcome-browse-more`.
- **Validation:** `modal-title` becomes visible (asserted as visible, never by text).

## Flow cleanup

Every scenario that opens New Flow creates a placeholder, and 1.4 creates a second flow. The spec
installs the shared tracker `trackCreatedFlows(page)` before the first navigation and deletes
every captured id in `afterEach`; ids the product already deleted (the gallery pick's placeholder)
answer 404, which the tracker treats as done. The contract is the repo's: the instance's user-flow
count is identical before and after a green run **and** after a forced-red run.

## External dependencies *(required)*

- `GET /api/v1/flows/basic_examples/` — the listing every expectation is derived from.
- `POST /api/v1/flows/` — the New Flow placeholder, and the flow a gallery pick creates.
- `PATCH /api/v1/flows/{id}` — the in-place conversion a quick pick performs.
- `GET /api/v1/flows/{id}` — the persisted flow read back in 1.6.
- Upstream surfaces (each resolves on `main`, `release-1.13.0` and `release-1.12.1`):
  `src/frontend/src/modals/templatesModal/index.tsx` (tab list, default tab),
  `src/frontend/src/modals/templatesModal/utils/template-availability.ts`
  (`FEATURED_TEMPLATE_KEYS`, `availableTemplateTabs`, `isTemplateVisible`),
  `src/frontend/src/modals/templatesModal/components/TemplateContentComponent/index.tsx`
  (exact-tag filter, Fuse search, `search-input-template`),
  `src/frontend/src/modals/templatesModal/components/navComponent/index.tsx`
  (`side_nav_options_*`, `category_title_*`, `modal-title`),
  `src/frontend/src/modals/templatesModal/components/TemplateCardComponent/index.tsx`
  (`template-<slug>`, `template_<slug>`),
  `src/frontend/src/modals/templatesModal/components/TemplateGetStartedCardComponent/index.tsx`
  (`template-get-started-card-<slug>`),
  `src/frontend/src/components/core/flowBuilderWelcome/flow-builder-welcome.tsx`
  (the welcome panel and its quick picks).
- Suite helpers: `tests/helpers/flows/open-new-flow-templates-modal.ts`,
  `tests/helpers/flows/track-created-flows.ts`, `tests/helpers/auth/get-auth-token.ts`.
- **No provider key, no egress, no external service.**

## Checklist bullet

`QA-CHECKLIST.md` → `#### 11.1 Registration and Gallery`, five bullets pointing at
`core-functionality/templates/templates-gallery.spec.ts`. The *Welcome panel quick picks* bullet
is rewritten in this PR: it said the quick picks *create* their template, and what they do is
`PATCH` the placeholder into it.

## What this spec deliberately does not do

- **Membership** — which templates are registered is R1's (`templates-registration.spec.ts`),
  against a committed baseline. This spec follows the listing.
- **Instantiation depth** — that a template builds, runs, or carries the right edges is S1's
  (#1864, `templates-instantiate.spec.ts`). Here a created flow is asserted by name, id and
  component types only.
- **The blank flow** (`blank-flow`), which is not a template.
- **A catalog policy that blocks a template**, which removes it from the listing and therefore
  from both sides of every comparison here. The governance specs that set one run in the
  `@destructive` lane.
- **The legacy `GET /api/v1/starter-projects/` listing**, which is not what the gallery reads.
- **A build with `ENABLE_KNOWLEDGE_BASES` off** — unreachable from a URL-only suite; the
  assumption is stated above instead.
