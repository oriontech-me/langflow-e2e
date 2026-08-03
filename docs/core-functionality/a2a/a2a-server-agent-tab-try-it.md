# A2A Server — Agent tab: the "Try it" panel round-trips over the live endpoint

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev14`)

**Issue:** #1244 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **U3**) ·
**Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 / PR #1243
(`requireA2aEnabled()`, the JSON-RPC `message/send` contract) ·
**Jira:** epic `LE-1588`

---

## What this test validates *(required)*

The **"Try it" panel** is the only place inside Langflow where a user can confirm
that the agent they just published actually answers. It is not a playground clone:
it drives the *published A2A endpoint*, so it exercises the same path a remote
orchestrator takes — from the browser, with the flow's real card and URL.

#1242 already proves `message/send` end-to-end via `request.post()`. What this
spec adds is the half that HTTP-level coverage structurally cannot see: that the
**UI wires itself to that endpoint at all**, that the reply renders back into the
tab, and that the panel reaches a terminal state instead of hanging. A regression
in which the panel posts to the wrong URL, drops the response, or never leaves
"working" would leave all nine API assertions green.

The assertion is a **per-run sentinel** carried by the flow itself: the published
flow is a Chat Input → Chat Output passthrough, so the agent's reply is
deterministic — the sentinel comes back verbatim, with no LLM and no provider key
anywhere in the path. A transcript that echoes an unrelated string, or the
sentinel only once (the user turn, with no reply), fails.

---

## Tags *(required)*

`@workspace` `@ui-ux` `@a2a`

- `@workspace` — drives the flow editor.
- `@ui-ux` — the subject is what the panel renders after a send.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- **No `@release`:** publishing is the release-critical path and carries the tag
  (`a2a-server-agent-tab-publish.spec.ts`); "Try it" is a confirmation affordance,
  not a gate on shipping.
- **No `@stable` yet:** granted only after team validation (`CONTRIBUTING.md`).
  New in #1244, no daily history.

---

## Validation criterion *(required)*

After publishing the flow through the Agent tab UI and sending a per-run sentinel
from `agent-test-input` via `agent-test-send`:

`agent-transcript` contains the sentinel **twice** — once as the user turn, once
as the agent's echoed reply — **and** the state text `completed`. Measured shape on
`1.12.0.dev14`: `You <sentinel> Agent ◆ completed <sentinel>`.

The turn counter reads `1 turn` and a `Reset` control is present (neither carries
a testid; both resolve by text).

Two occurrences is the load-bearing part of the criterion: one occurrence is what a
panel that renders the user's own message and never receives a reply would produce.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240; asserted at
  runtime by `requireA2aEnabled()` so a flag-off instance names its own cause
  rather than failing on a missing tab.
- **No LLM, no provider key, no external network.** The published flow is the
  Chat Input → Chat Output passthrough from
  `tests/assets/flows/chat-io-ok-trace-fixture.json`, created with
  `createRunnableChatFlowViaApi()`. The echo is what makes the assertion
  deterministic.
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- No assumption about existing flows: the flow is created by the test and deleted
  **by id** in `afterEach`. **No pre-test wipe.**

---

## Step by step *(required)*

One test.

**`the Try it panel round-trips a sentinel over the published endpoint`**
1. `requireA2aEnabled(page.request, authHeaders)`.
2. `createRunnableChatFlowViaApi(page.request, authHeaders)` → `flowId`.
3. `openFlowById(page, flowId)`.
4. Click `sidebar-nav-agent`.
5. **Publish through the UI** — click `agent-publish-switch`, then `agent-save`;
   assert `agent-status` reads `Live`. This is deliberately the UI path and not a
   `PATCH`: the panel is only reachable from the state a user actually reaches,
   and this is the shortest route to it. The publish *mechanics* are asserted in
   `a2a-server-agent-tab-publish.spec.ts`; here `Live` is a precondition check, not
   the subject.
6. Fill `agent-test-input` with a per-run sentinel (`a2a-try-it-${Date.now()}-…`),
   click `agent-test-send`.
7. Wait for `agent-transcript` to contain `completed`, then assert it contains the
   sentinel exactly **twice** and that the reply occurrence follows the `Agent`
   label — a count taken from the transcript's text, not two `toContainText`
   calls, which one occurrence would satisfy.
8. Assert the turn counter reads `1 turn` and a `Reset` control is visible.
9. `afterEach` deletes the flow by id.

---

## Validation *(required)*

| Test | Observable |
|---|---|
| Try it round-trip | `agent-transcript` holds the sentinel **2×** plus `completed`; `1 turn` counter and `Reset` present |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- **"View JSON-RPC exchange" does not exist in the product — the i18n key has no
  call site.** #1195's row U3 asks the spec to assert that the panel exposes the
  request/response pair. It cannot, and the PLAN scout settled *why*, which the
  first scout could not:
  - After a full completed turn in the published state,
    `document.body.innerHTML.includes('JSON-RPC')` is **`false`**, and enumerating
    every `button` / `summary` / `[role=button]` / `[aria-expanded]` on the page
    turns up no candidate trigger (the only controls near the transcript are
    `Reset`, `Send`, the session menus, and the `URL` / `curl` toggle above the
    address).
  - `agentTab.viewExchange` → `"View JSON-RPC exchange"` appears **exactly once
    per locale bundle** in the shipped frontend
    (`langflow/frontend/assets/{index,de,es,fr,ja,pt,zh-Hans}-*.js`) — that single
    occurrence being the dictionary entry itself. **Zero references** from
    component code, in any bundle. The string is translated but never rendered.
  So it is **not asserted**, and not because the scout gave up: the control is
  unimplemented in `1.12.0.dev14`. The §16.1 bullet lands as `[~] partial` naming
  the gap, and the question goes upstream. This is the only part of row U3 this
  spec does not cover, and it is recorded rather than silently dropped (#1012's
  rule).
- **The transcript is a single `agent-transcript` div**, not one node per bubble —
  hence the occurrence count over its text rather than per-bubble locators. Its
  measured `innerText` after one turn is exactly
  `You\n<sentinel>\nAgent\n◆ completed\n<sentinel>`.
- **The turn counter and `Reset` carry no testid**; both resolve by text and each
  matched exactly 1 element in the scout (`getByText("1 turn", { exact: true })`,
  `getByRole("button", { name: "Reset" })`).
- **On a `Draft` flow the panel is not the surface under test:** `agent-transcript`
  renders the placeholder *"Publish the agent to test it over the live…"* instead
  of a conversation. That is why step 5 publishes first, and why `Live` is
  asserted as a precondition rather than assumed.
