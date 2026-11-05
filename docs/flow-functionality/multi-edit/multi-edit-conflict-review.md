# Multi-edit safety — the conflict banner and the *Review Version Changes* dialog

**File:** `tests/tests-automations/regression/flow-functionality/multi-edit/multi-edit-conflict-review.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev7`)

Owning issue: #2342 (Wave 11 — Multi-edit, instance migration & integrations; tracker #2356).
Upstream feature: multi-edit safety, `langflow-ai/langflow#14903`, follow-up `#15824`. The
API contract underneath it is pinned by `api/flows/flow-version-precondition.spec.ts` (#2341).

---

## What this test validates *(required)*

When another session saves a flow first, the open editor has to say so before its own
save is lost. It does that with a banner on the canvas and a *Review Version Changes*
dialog that lists the incoming changes per component. This is the first thing a person
sees of multi-edit safety.

Every row below was measured on `1.14.0.dev7` with a live scout before any assertion
was written:

| Observation | Measured |
|---|---|
| Opening a flow | issues **no** `PATCH` (12 s idle, zero writes) |
| What raises the banner | the editor's **own** autosave `PATCH` answering `409`, about 5 s after its edit (the debounce). There is **no polling**: `use-check-flow-version.ts` reads `version-state` only before a run |
| Banner (same user) | `flow-conflict-banner`: *"A newer version of this flow is available"* / *"Review changes before saving."*, plus `flow-conflict-frame` on the canvas |
| *Review changes* | `flow-conflict-review-button` opens *Review Version Changes* with the sections *Your changes* and *Available changes* |
| A row | one per component, `conflict-change-{mine\|theirs}-{node:<id>\|edge:<id>}`: component label, one sentence per change, and a badge (*Added* / *Removed* / *Modified*) |
| Sentences | *"New node added to the flow."*, *"Node removed from the flow."*, *"Input Text updated from hello to from the other session."*, *"Moved on the canvas."*, *"Chat Input to Chat Output link added."* |
| Opening version history | `sidebar-nav-versions` fetches `GET /versions/` and issues **no** `PATCH`, including after returning to the components panel |
| Run after someone else saved, with no edit of one's own | `version-state` is read, the newer version is **adopted silently** with the notice *"{user} updated this flow. The canvas now shows the latest version — run again to execute it."*, and **no** banner appears |

### Facts that shape the design

- **The other session is an API write**, through the test's own `request` context.
  That is a second session to the server (its own token, its own `If-Match`-less write),
  and it is how upstream's own specs stage the collision. Writing from inside the
  page would be *this* session, because the app intercepts the page's `fetch`. A
  second browser context would add a second canvas whose only job is to issue that
  same `PATCH`, with a 5 s debounce more of nondeterminism.
- **The banner needs an edit of the viewer's own.** If the viewer has not edited,
  a stale flow is adopted silently and no banner appears, by design
  (`checkFlowVersion`: *"Someone who has made no edits of their own has nothing to
  resolve"*). The issue's step "B edits, A shows the banner" therefore needs A to
  edit too. Test 1 does that by dragging a node no one else touches.
- **Two different users cannot share a flow on OSS.** The issue asks to measure
  whether the OSS build lets two different users open one flow, which is where the
  banner would name the other person (*"{name} saved a newer version of this
  flow"*). It does not: measured on `1.14.0.dev7` (#2341), a second user's `GET` or
  `PATCH` on someone else's flow answers `404 {"detail":"Flow not found"}`, in both
  directions. Only the same-user wording is reachable here. The named variant needs
  an Enterprise share, which is a different lane.
- **The `409` is deliberate.** It is the mechanism under test, so test 1 declares
  exactly that response, `PATCH /api/v1/flows/{id}` → `409`, with
  `page.expectKnownHttpError()`, not `page.allowHttpErrors()`. The declaration
  quiets only that response, so any other error stays visible, and it is verified
  both ways: if the `409` stops firing, the test fails. Tests 2–4 declare
  nothing, so a stray `409` there is reported as a `🚨 Backend Error` on top of
  failing their own assertions.
- **Grouping is upstream's documented design** (`ChangeRow.tsx`: *"One component, one
  checkbox, however many things changed inside it"*). A move and a field change on the
  same component share one row. Test 1 asserts that shape on *Chat Input*, and asserts
  a pure move on *Chat Output* separately.
- **The version-history regression is "faking an edit".** Upstream fixed it inside
  #14903: opening version history swapped the canvas, the next autosave recorded the
  viewer as an editor, and from then on a newer version raised a conflict instead of
  being adopted. Test 3 reproduces exactly that path: open history, return, someone
  else saves, run. With the bug, the run raises the banner. Without it, the run
  adopts.

---

## Tags *(required)*

`@workspace` `@database` `@ui-ux`

**No `@stable` yet.** The spec is LLM-free, but it is a new UI spec with a 5 s debounce
in its critical path, so it waits for team validation before promotion.

---

## Step by step *(required)*

Every test builds its flow over the API from the live component catalog
(`createCatalogFlow`), so node ids and positions are fixed. Each test opens the flow
with `openFlowById`, and an id-scoped `afterEach` deletes it. Waits key on network
responses for this flow, never on time.

The other session's write is called **B** below. It reads the flow, rebuilds its
graph from the catalog with the changes listed, keeps every other node where it was,
and `PATCH`es it with no `If-Match`. It must answer `200`.

1. **Banner and dialog list every kind of incoming change.**
   - Flow: *Chat Input* (`input_value: "hello"`), *Chat Output*, and two Prompt
     Template nodes, *Doomed Prompt* and *Mine Prompt*. Prompt Template is used
     rather than Text Input because Text Input is `legacy: true` on `1.14.0.dev7`,
     with Chat Input as its replacement, so it may leave the catalog.
   - B's write, in one `PATCH`:
     - *Chat Input*: `input_value` becomes `"from the other session"`, and the node
       is moved;
     - *Chat Output*: moved only;
     - *Doomed Prompt*: removed;
     - *Arrived Prompt*: a new Prompt Template node;
     - a new edge, *Chat Input* → *Chat Output*.
   - The viewer drags *Mine Prompt*. Its autosave `PATCH` answers `409`.
   - The banner reads *"A newer version of this flow is available"* and *"Review
     changes before saving."*, and the canvas frame is attached.
   - *Review changes* opens *Review Version Changes*, which lists *Available changes*.
   - Under *Available changes*:

     | Row | Badge | Sentence(s) |
     |---|---|---|
     | `theirs-node:<Arrived Prompt>` | *Added* | *"New node added to the flow."* |
     | `theirs-node:<Doomed Prompt>` | *Removed* | *"Node removed from the flow."* |
     | `theirs-node:<Chat Input>` | *Modified* | *"Moved on the canvas."* **and** *"Input Text updated from hello to from the other session."*, in one row |
     | `theirs-node:<Chat Output>` | *Modified* | only *"Moved on the canvas."* |
     | `theirs-edge:<id>` | *Added* | *"Chat Input to Chat Output link added."* |

   - Under *Your changes*: `mine-node:<Mine Prompt>` reads *"Moved on the canvas."*.
   - No other row is listed on either side.

2. **Only the viewer edits: no banner across several autosave cycles.**
   - Drag *Mine Prompt* three times, each time waiting for its autosave `PATCH` to
     answer `200`.
   - Open version history (wait for `GET /versions/`) and return to components.
   - Drag again and wait for the `PATCH` to answer `200`.
   - Every `PATCH` for this flow answered `200`, and the banner never appeared.

3. **Browsing version history is not an edit (regression guard for upstream's fix).**
   - Open the flow without editing.
   - Open version history (wait for `GET /versions/`) and return to components.
   - B writes `input_value: "from the other session"`.
   - Click *Chat Output*'s run button.
   - The adopt notice appears, *"langflow updated this flow… run again to execute
     it."* (using the logged-in username), and no banner appears.
   - *Chat Input*'s `textarea_str_input_value` now reads `"from the other session"`.
   - The viewer issued **no** flow `PATCH` from opening the flow to that notice.

4. **Reloading with no server change shows no banner.**
   - Open the flow and reload the page.
   - Drag *Mine Prompt*; its autosave `PATCH` answers `200`.
   - The banner is absent. The successful save is what makes the absence meaningful:
     the editor really was holding the current token.

---

## Validation criterion *(required)*

- All four tests pass three consecutive times at `--retries=0 --workers=1` on the
  current nightly.
- Each test fails under a mutation of its load-bearing assertion, run in isolation:
  - expect the *Removed* badge on *Arrived Prompt*;
  - expect *Chat Output*'s row to also list a field change;
  - expect a `409` among test 2's writes;
  - expect the banner after the history round-trip in test 3;
  - expect the banner after test 4's reload.
- Zero flows left behind.
- Zero `🚨 Backend Error` lines. Test 1's `409` is declared, so it is reported as
  expected.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the superuser.
- `src/frontend/src/components/core/flowConflict/ConflictBanner.tsx`: banner, frame and review-button testids, and the same-user / named wording.
- `src/frontend/src/components/core/flowConflict/CanvasBanner.tsx`: the banner shell that carries `flow-conflict-banner`.
- `src/frontend/src/components/core/flowConflict/ChangeRow.tsx`: `conflict-change-{side}-{targetKey}`, one row per component, the badge.
- `src/frontend/src/utils/flow-diff.ts`: the sentences, the 60-character inline limit, and moves counted as changes.
- `src/frontend/src/hooks/flows/use-check-flow-version.ts`: silent adopt when the viewer has not edited.
- `src/frontend/src/hooks/flows/use-save-flow.ts`: the `409` handler that registers the conflict.
- `src/frontend/src/stores/flowStore.ts`: the pre-run version check and its notices.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/FlowVersionSidebar/index.tsx`: the version history panel.
- `src/frontend/src/locales/en.json`: the `multiEdit.*` strings.
- No provider key, no model, no network egress.
