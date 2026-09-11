# Project Management – Home Listing and Flow Search

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev9`)

---

## What this test validates *(required)*

Two home-page listing behaviours that no other spec asserts, both scoped to the
**default project** rather than to a named folder:

1. **A flow created over the REST API appears on the home listing.** The flow is
   created with `POST /api/v1/flows/` and no `folder_id`, so it lands in the
   default project; the home grid must show it by name after a reload. This is the
   read path of the listing — a regression that scoped the grid to some other
   source, or that cached it past a reload, would leave the flow invisible in a UI
   that reports no error at all.
2. **Searching by name filters the listing.** With two uniquely-named flows
   present, typing one name into the home search box must leave that flow listed
   and remove the other. QA-CHECKLIST §10.2 *"Search flow by name filters results
   correctly"* — the bullet had no spec reference until this promotion.

The assertion that carries the second test is the **negative** one: the other
flow reaching `toHaveCount(0)`. Asserting only that the searched flow is still
visible would pass identically against a search box that filters nothing, since
the flow was already listed before a single character was typed.

Setup is API-first for determinism: both flows are created through
`request.post` with `Date.now()`-unique names, so each `getByText` is unambiguous
under `fullyParallel` and neither test depends on what the instance already holds.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

---

## Step by step *(required)*

### Test 1 — flows created via API appear on the home listing

1. Bootstrap the session with `awaitBootstrapTest(page, { skipModal: true })` —
   the **home page** is the subject, so the templates modal must not be opened
   (see *The bootstrap variant is load-bearing* below).
2. Create one flow via `POST /api/v1/flows/` with a unique
   `nav-test-flow-<timestamp>` name and no `folder_id`; assert `201` and capture
   its id.
3. Wait for `[data-testid="mainpage_title"]`.
4. `page.reload()`, then wait for `mainpage_title` again — the reload is what
   makes the listing re-fetch rather than re-render a cached store.
5. Assert `getByText(flowName)` is visible.
6. **Cleanup:** delete the captured id, **plus every flow the page created**.

### Test 2 — searching flows by name filters results correctly

1. Bootstrap with `{ skipModal: true }`.
2. Create two flows via `POST /api/v1/flows/`: `unique-search-test-<timestamp>`
   and `other-flow-<timestamp>`; assert `201` on both.
3. `page.reload()`, wait for `mainpage_title`.
4. Fill the home search input with the first flow's full name.
5. Assert the searched flow is **visible** and the other flow reaches
   `toHaveCount(0)` — the count form absorbs the input's debounce.
6. **Cleanup:** delete both ids, **plus every flow the page created**.

---

## Validation criterion *(required)*

- **Test 1:** after a reload, the API-created flow's name is visible on the home
  grid. A listing that ignored flows it did not create through the UI, or that
  served a stale cache across the reload, fails here.
- **Test 2:** with the search box holding flow A's name, flow A is visible **and**
  flow B is absent (`toHaveCount(0)`). A search box that filters nothing fails on
  the second half only, which is why both halves are asserted.
- Neither test may leave a flow behind: the instance's flow count is unchanged
  across a run.

---

## External dependencies *(required)*

- Home page testids: `mainpage_title` (the listing's own entry barrier) and the
  home search input, resolved by its `Search…` placeholder.
- `tests/helpers/other/await-bootstrap-test.ts` — specifically its `skipModal`
  option, which decides whether the session ends on the home page or inside a
  newly-created flow.
- REST API: `POST`/`DELETE /api/v1/flows/` (auth via `getAuthToken`).
- No LLM or provider API key required (model-independent).

---

## What this test does not cover *(optional)*

- Folder-to-folder navigation and listing scope — `flow-navigation-between-folders.spec.ts`.
- A folder listing the flows it contains — `folder-drag-drop-flow.spec.ts`.
- Folder CRUD — `folder-crud.spec.ts`.
- Moving a flow between folders — `folder-drag-drop-flow.spec.ts`.
- Search over components or the store — this is the **flow** listing's search only.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.

---

## Notes *(optional)*

### The bootstrap variant is load-bearing, and the wrong one is silent

Both tests were measured `0/3 green` by the #1784 triage table, failing at
`waitForSelector('[data-testid="mainpage_title"]')` — test 1 before its reload,
test 2 after it. Reproduced locally 2/2 on `1.13.0.dev9`, and the captured page
snapshot names the cause: the breadcrumb reads `Starter Project / New Flow (1)`
and the page holds an `application "Flow canvas"`. **The tests were inside the
flow editor, not on the home page**, so the home-page barrier they wait for could
never appear and the 30 s timeout was the only symptom.

The cause is the bootstrap call. `awaitBootstrapTest(page)` with no options runs
the modal branch, whose job is to leave the templates modal open for a spec that
is about to pick a template; on this instance the "New Flow" click it issues
**navigates to a freshly-created flow** instead — a behaviour the helper's own
source comments on — and the retry loop then creates another flow per attempt.
Every spec here wants the opposite: the home page, untouched. The sibling
`flow-navigation-between-folders.spec.ts` already calls
`awaitBootstrapTest(page, { skipModal: true })` and is green and `@stable`.

Nothing about this failure points at the bootstrap: the error names
`mainpage_title`, a home-page testid, and reads as a home-page regression. That
is what made it worth writing down rather than fixing quietly.

### The flows the API-created ids do not account for

The same measured run left the instance **four flows heavier** — `New Flow`,
`Basic Prompting`, `New Flow (1)`, `New Flow (2)` — with every id the spec
created through `request.post` deleted. They come from the bootstrap branch
above, so the ids were never known to the `finally` that was supposed to delete
them, and the spec's cleanup was id-scoped over the wrong set: correct about what
it knew, false about the instance.

Fixing the bootstrap removes the two `addFlowToTestOnEmptyLangflow` flows and the
per-attempt ones alike, but the page-side capture stays: it is the repo's
standing pattern (`trackCreatedFlows`, #1108), it costs nothing when the page
creates none, and a cleanup that depends on no future UI path ever creating a
flow is a cleanup that breaks silently. The API setup issues its creates through
`request.post`, a separate `APIRequestContext`, so the page-side capture cannot
double-count them — the two sets are disjoint by construction.

Never a global sweep: the suite runs `fullyParallel`, so deleting anything this
run did not create would wipe a concurrent worker's flow.
