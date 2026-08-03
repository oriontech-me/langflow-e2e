# A2A Server — Agent tab: eligibility gate, publishing, and the card editor

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev14`)

**Issue:** #1244 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **U1**) ·
**Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 / PR #1243
(`requireA2aEnabled()`, the API-side card assertions) ·
**Jira:** epic `LE-1588`, `LE-2007` (A2A surfaced in the UI but impossible to enable)

---

## What this test validates *(required)*

The **Agent tab** is the only way a user publishes a flow as an A2A agent. #1242
proved the backend contract — the card, discovery, the JSON-RPC endpoint — by
driving `PATCH /api/v1/flows/{id}` directly. None of those nine assertions touches
the surface a user actually operates, and that is precisely where `LE-2007` lived:
A2A was visible in the UI and **could not be enabled from it**. A suite that only
PATCHes the flow row cannot see that failure, because the row is exactly what the
broken UI never wrote.

This spec covers the three states of that journey:

1. **The eligibility gate is real and it explains itself.** A flow with no chat
   input/output cannot serve A2A. The tab must say so — `agent-status` reads
   `Unavailable`, `agent-publish-switch` is `disabled`, and the copy names the
   remedy — and the API must agree: the card `404`s for the same flow. Adding
   Chat Input + Chat Output on the canvas must lift the gate **without a reload**.
2. **Publishing from the UI produces a live endpoint.** Toggling the switch and
   saving must flip `agent-status` to `Live` **and** make the address the tab
   advertises answer. The URL is read out of `agent-card-url` and fetched inside
   the test: a tab that renders a dead address is the same class of defect as a
   tab that cannot publish at all.
3. **The card editor edits the advertisement, not just the DOM.** Changing the
   name and adding a tag, then pressing `agent-save`, must change what
   `GET /api/v1/a2a/{id}/.well-known/agent-card.json` serves to a remote
   orchestrator. Asserting only that the header text changed would pass on a UI
   that never persists.

The through-line: **every UI assertion here is paired with an API observable**, so
the spec cannot degrade into a DOM echo of itself.

---

## Tags *(required)*

`@release` `@workspace` `@ui-ux` `@a2a`

- `@release` — publishing a flow as an agent is the happy path of the whole A2A
  feature; if this breaks, A2A is unusable regardless of how healthy the API is.
- `@workspace` — drives the flow editor and canvas (component add, tab switch).
- `@ui-ux` — the assertions are about what the interface renders and enables.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- **No `@stable` yet:** granted only after team validation (`CONTRIBUTING.md`).
  New in #1244, no daily history.

---

## Validation criterion *(required)*

**Test 1 — eligibility gate.** On a blank flow, `agent-status` reads exactly
`Unavailable`, `agent-publish-switch` is disabled, the text
*"Add a chat input and output to serve this flow."* is visible, and
`GET /api/v1/a2a/{flowId}/.well-known/agent-card.json` returns `404`. After adding
Chat Input and Chat Output from the sidebar, and **with no page reload**,
`agent-publish-switch` becomes enabled and `agent-status` reads `Draft`.

**Test 2 — publish.** Clicking `agent-publish-switch` moves it to
`data-state="checked"` and enables `agent-save`; after clicking `agent-save`,
`agent-status` reads `Live`, and the value of `agent-card-url` is a URL whose path
is exactly `/api/v1/a2a/{flowId}/.well-known/agent-card.json`, which — fetched
with `request.get()` inside the test — returns `200` with
`skills[0].id === flowId`. The same URL is asserted `404` **before** the save, so
the `200` proves the publish and not merely that the route exists.

**Test 3 — card editor.** After editing the Name field to a per-run sentinel and
adding one tag, `agent-save` becomes enabled; after clicking it, the card served by
the API carries `name === sentinel`, `skills[0].name === sentinel` **and**
`skills[0].tags` equal to `[tag]` — while `card.url` and `card.protocolVersion` are
unchanged, proving the editor edited the advertisement and not the endpoint. Then,
**after a page reload**, `agent-card-name` renders the sentinel: the header does
**not** refresh from a save (measured — see *Measured behaviour*), so the reload is
what proves the override round-trips back into the UI rather than only into the
database.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240, and asserted
  at runtime by `requireA2aEnabled()` (`tests/helpers/a2a/require-a2a-enabled.ts`)
  so a flag-off instance fails naming its own cause instead of on a missing tab.
- **No LLM, no provider key, no external network.** Tests 2 and 3 build their flow
  from `tests/assets/flows/chat-io-ok-trace-fixture.json` via
  `createRunnableChatFlowViaApi()`; Test 1 starts from a blank flow
  (`setupBlankFlow`) and adds the two components from the sidebar.
- Auto-login superuser (`getAuthToken()`) for the API half of every assertion.

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- Nothing about existing flows matters: every flow is created by the test and
  deleted **by id** in `afterEach`. **No pre-test wipe** — a shared-instance wipe
  destroys other workers' flows (#515/#588).

---

## Step by step *(required)*

Three independent tests. Each creates its own flow and deletes it by id in
`afterEach`, so a mid-test failure still cleans up.

**Test 1 — `blank flow cannot be published until it has a chat input and output`**
1. `requireA2aEnabled(page.request, authHeaders)`.
2. `setupBlankFlow(page)` → `flowId`; the helper lands on the canvas.
3. Open the Agent tab: click `sidebar-nav-agent`.
4. Assert `agent-status` has text `Unavailable`, `agent-publish-switch` is
   `disabled`, and the ineligible copy *"Add a chat input and output to serve this
   flow."* is visible.
5. **API cross-check:** `GET /api/v1/a2a/{flowId}/.well-known/agent-card.json`
   → `404`. The UI's "cannot publish" and the API's "nothing published" must be
   the same fact.
6. Return to the canvas (`sidebar-nav-components`) and add both components with
   `addComponentFromSidebar(page, "Chat Input", "add-component-button-chat-input")`
   and the Chat Output equivalent. **No edge is drawn** — eligibility is decided by
   the presence of the two node types, measured at PLAN (see *Measured behaviour*).
7. Re-open the Agent tab **without reloading**: assert `agent-publish-switch` is
   now enabled and `agent-status` reads `Draft`.
8. `afterEach` deletes the flow by id.

**Test 2 — `publishing from the Agent tab serves a card at the advertised URL`**
1. `requireA2aEnabled`.
2. `createRunnableChatFlowViaApi(page.request, authHeaders)` → `flowId`.
3. `openFlowById(page, flowId)`.
4. Click `sidebar-nav-agent`; assert `agent-status` reads `Draft`, `agent-save`
   is disabled (nothing changed yet) and the card URL the tab already advertises
   answers `404` — the tab renders the address while still in `Draft`, so this
   negative control is what makes step 8's `200` mean "published".
5. Click `agent-publish-switch`; assert its `data-state` is `checked` and
   `agent-save` is now enabled.
6. Click `agent-save`; assert `agent-status` reads `Live`.
7. Read the `value` of `agent-card-url`, parse it, and assert the **path** matches
   the flow id — never string-matched on host, which differs between local and CI.
8. `request.get()` that URL → `200`, and `skills[0].id === flowId`.
9. `afterEach` deletes the flow by id.

**Test 3 — `the card editor changes what the API serves`**
1. `requireA2aEnabled`; create the runnable flow; publish it via
   `PATCH /api/v1/flows/{flowId}` `{ flow_type: "agent", a2a_enabled: true }` —
   the publish path itself is Test 2's subject, so this test starts from the
   published state instead of re-proving it.
2. `openFlowById` → `sidebar-nav-agent`; assert `agent-status` reads `Live`
   (the tab reflects a flow published outside it).
3. Fill the Name input — resolved through its `Name` label, since `agent-card-name`
   is a read-only `span` — with a per-run sentinel.
4. Add one tag: click the button whose accessible name is **`Add tag`** (the
   testid `input-list-plus-btn_-0` is shared with the examples list; the
   `aria-label` is what separates them) and fill `agent-tags_0` with a per-run
   tag value.
5. Assert `agent-save` is enabled; click it.
6. `GET /api/v1/a2a/{flowId}/.well-known/agent-card.json` → `200`, `name` **and**
   `skills[0].name` equal the sentinel, `skills[0].tags` equals `[tag]`, and
   `protocolVersion` / `url` are unchanged.
7. Reload the page, re-open the Agent tab, and assert `agent-card-name` renders the
   sentinel — the override survives a round-trip back into the UI. The header is
   asserted **after** the reload, never before: it does not refresh from a save.
8. `afterEach` deletes the flow by id.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | eligibility gate | `Unavailable` + switch disabled + remedy copy + card `404` → after adding Chat I/O, switch enabled + `Draft`, no reload |
| 2 | publish | advertised URL `404` while `Draft` → switch `data-state=checked` → `agent-save` enabled → `Live` → same URL fetches `200` with `skills[0].id === flowId` |
| 3 | card editor | the API card carries the new `name`, `skills[0].name` and `skills[0].tags === [tag]`, with `url`/`protocolVersion` untouched — **and** `agent-card-name` shows the sentinel after a reload |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

Each of these would have produced a wrong or flaky assertion if written from the
i18n bundle instead of the live DOM (harvested in #1244's scout):

- **The entry point is `sidebar-nav-agent`** — a left-sidebar nav item, sibling of
  `sidebar-nav-components` / `sidebar-nav-mcp`. Not a modal, not the Publish
  dropdown.
- **`agent-publish-switch` keeps its state in `data-state`** (`unchecked` /
  `checked`) and `aria-checked`. Its `value` is the fixed string `"on"` — asserting
  on `value` would pass in both states.
- **`agent-card-name` is a read-only `span`**, the header *display* of the name.
  The editor inputs have no testids: Name and Version resolve by label, and
  Description's testid is literally `"textarea"` — too generic to trust.
- **Add-tag and add-example share the testid `input-list-plus-btn_-0`.** Any
  locator for either must be scoped to its container or it is ambiguous.
- **The ineligible state is `Unavailable`, not `Off`,** and the rendered copy is
  `agentTab.publishIneligible` → *"Add a chat input and output to serve this
  flow."* — **not** the `agentTab.ineligible` string ("…so this flow can receive
  and reply to messages over A2A.") that #1195 quoted from the bundle.
- **The "Agent updated" toast is transient** — gone in under 3 s. #1195's row U1
  proposed asserting it; that would be a flake by construction. The durable
  observables are `agent-status` flipping to `Live` and the card the API serves,
  which is what this spec asserts instead. The checklist bullet is amended to
  match.

### Settled by the PLAN scout *(both questions this doc left open at SPECIFY)*

- **Eligibility needs the two nodes, not the edge.** Measured: a blank flow with
  Chat Input and Chat Output added from the sidebar and **left unconnected**
  (`.react-flow__edge` count `0`) already flips `agent-status` from `Unavailable`
  to `Draft` and enables the switch, with no reload and no explicit save. Test 1
  therefore does not wire the components — adding an edge would test the
  drag-and-drop helper, not the gate.
- **`agent-card-url` holds the `.well-known` card URL**, not the JSON-RPC
  endpoint: `…/api/v1/a2a/{flowId}/.well-known/agent-card.json`. So the in-test
  check is a `GET` expecting `200`. Note the asymmetry worth not tripping over:
  the *card's own* `url` field (the endpoint a remote client POSTs to) is the
  `…/jsonrpc` path, so the tab's URL and the card's URL are deliberately
  different addresses.

### Further measurements from the same scout

- **The tab renders the card URL while still in `Draft`** — the input is populated
  before anything is published, and that URL `404`s. A test that only asserted the
  URL's *text* would pass against a flow that was never published; hence the
  `404 → 200` pair in Test 2.
- **`agent-save` returns to `disabled` after a successful save**, so "enabled" is a
  dirty-state signal, not a permanent affordance.
- **The Name / Version / Description inputs carry no usable identifier** — no
  testid (Description's is the generic `"textarea"`), no `id`, no `aria-label`,
  and their `<label>` has no `htmlFor`, so `getByLabel()` does **not** resolve
  them. The measured-working locator is the label's own container:
  `page.locator("div").filter({ has: page.locator('label:text-is("Name")') }).last().locator("input, textarea").first()`
  → resolves to exactly 1 element for Name, Version and Description.
  (The Name input's `placeholder` mirrors the flow name, which is a second, more
  fragile handle — not used.)
- **The shared `input-list-plus-btn_-0` testid is separated by accessible name:**
  `Add tag` vs `Add example`, each resolving to exactly 1 button. That is a better
  discriminator than container scoping, which #1244's issue body proposed.
- **A name override replaces `skills[0].tags` wholesale** — after adding one tag,
  `skills[0].tags` is `["<tag>"]`, not `["langflow", "<tag>"]`. Asserting
  "contains" would hide a wipe of the default; the spec asserts equality.
- **The name override lands in two places** — `card.name` and `skills[0].name`
  (same as the API-side finding in `a2a-server-agent-card.md`).
- **The save has no DOM completion signal — it is waited on by its request.**
  `agent-status` flips to `Live` optimistically and the header never moves, so
  nothing in the tab marks the end of a save. `agent-save` fires
  `PATCH /api/v1/flows/{id}`; a card fetched before that response comes back in the
  PREVIOUS state — observed once in a 3-run burst (`card.name` still the flow
  name), i.e. a genuine race, not a slow server. Both specs therefore wrap the
  click in `page.waitForResponse(PATCH /api/v1/flows/{flowId} → 200)`. That is the
  product's own completion signal; a `waitForTimeout` here would be a flake with a
  number on it.
- **`agent-card-name` does not refresh after a save — it is mount-time state.**
  Measured on `1.12.0.dev14` with a flow published via the API and then edited in
  the tab: `agent-save` persists correctly (`a2a_card_overrides` is written and the
  served card carries the new `name` and `tags` within the same second), the Name
  input keeps the typed value, and the header **keeps showing the flow name** — 2.5 s
  after the save, and still after a second save in the same session. A page reload
  renders the override. This is why the spec asserts the API card first and the
  header only after a reload; asserting the header live is what a spec written from
  the issue body would have done, and it fails against a product that persists the
  edit correctly. **Candidate product finding** (stale header, cosmetic — the
  advertisement itself is correct), raised with the team rather than silently
  encoded as a wait.
- **Leaving a canvas with unsaved node additions raises a `beforeunload` dialog.**
  Test 1 never navigates away (the flow is deleted by API in teardown), but any
  future test that adds nodes and then goes elsewhere must handle it.
