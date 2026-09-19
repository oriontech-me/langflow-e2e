# A2A Client — the `A2AAgent` component in External mode: calling an agent by its URL

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`)

**Issue:** #1855 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **C2**) ·
**Follows:** #1354 (C1, Internal mode) · **Jira:** epic `LE-1588`, regression `LE-1845`

---

## What this test validates *(required)*

External mode is the half of the A2A client that calls an agent **by URL** — the way
a flow consumes an agent served by anything, another Langflow included. Two failures
have lived here, and they look nothing alike:

- **`LE-1845`** — `NameError: name 'call_a2a_agent' is not defined`: every External
  run crashed.
- **A failed card fetch is silent.** `_fetch_card` returns `None` on *any* failure —
  SSRF refusal, non-200, oversize body, timeout — and the card display is simply not
  rendered. No error, no toast. A regression there leaves an editor that looks
  healthy and a component nobody can point at anything.

The spec points the component at **this instance's own** published agent and proves
four things that fail independently:

1. **Card discovery** — setting `agent_url` fetches the remote card and renders it:
   the viewer is titled with the target's per-run name.
2. **The call executes the remote flow** — a per-run sentinel sent as the message
   comes back as the playground's AI turn, through a Chat Input → Chat Output
   passthrough, so no LLM is involved on either side.
3. **It really went over the wire** — the target flow stored the sentinel under a
   session minted by the **A2A server** (`<uuid>:<contextId>`), never under the
   Internal-mode namespace (`<caller session>:a2a:<target id>`). This is what makes
   the spec about External mode rather than about "an A2A call happened".
4. **The card's security surfaces, and the key reaches a restricted agent** — once
   the target moves into an `auth_type=apikey` project, the refreshed card carries
   `Requires an API key`, and a run with the owner's key in the component's
   `api_key` still returns a sentinel. The **same flow id** crosses the boundary, so
   the chip cannot be attributed to anything but the project.

**Why this was out of reach until now.** The scope doc parked this row on "a loopback
self-call is refused by Langflow's SSRF layer (`LE-1904` class)". On the 1.13 nightly
`_call_external_agent` validates `agent_url` with the **connector** policy, which
exempts a literal loopback host whenever `connector_ssrf_allow_loopback` is on — and
it defaults to `True`. Measured end to end below.

---

## Tags *(required)*

`@stable` `@regression` `@components` `@workspace` `@a2a`

- `@regression` — `LE-1845`.
- `@components` / `@workspace` — as in C1: a component's configuration and execution,
  driven through the flow editor (sidebar add, canvas wiring, playground).
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true`.
- `@stable` — LLM-free and deterministic; enters with the tag per `CONTRIBUTING.md`.
- **No `@release` / no `@api`** — same reasoning as C1: consuming an agent is a
  feature, not the shipping gate, and the subject only exists in the UI.

---

## Validation criterion *(required)*

With target flow **A** published under a unique per-run name and caller flow **B**
holding an `A2AAgent` node in External mode:

| # | Observable | Expected |
|---|---|---|
| 1 | the card viewer, after `agent_url` is set to A's card URL | dialog text contains **A's exact name**, and does **not** contain `Requires an API key` |
| 2 | the flow B run, via the playground | `chat-message-AI-<sentinel>` |
| 3 | `GET /api/v1/monitor/messages?flow_id=<A>` | a `User` message whose text is the sentinel, with a `session_id` that is two UUIDs joined by `:` — the A2A server's composite — and does **not** contain `:a2a:` |
| 4 | the card viewer, after A moves into an `auth_type=apikey` project and `agent_url` is re-pointed at A's base URL | dialog text contains `Requires an API key` |
| 5 | the flow B run with the owner's key in `api_key` | `chat-message-AI-<sentinel2>`, and A stored `sentinel2` |

Assertions 1 and 4 are the same flow, one project apart: 1 is the negative control
that makes 4 mean something.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced in-test by `requireA2aEnabled()`.
- **The connector loopback exemption at its default.** The component's
  `_call_external_agent` and `_fetch_card` validate with
  `validate_and_resolve_connector_url` (`src/lfx/src/lfx/utils/ssrf_protection.py`), which
  returns early for a literal `localhost` / `127.0.0.0/8` / `::1` when
  `connector_ssrf_allow_loopback` is on (`src/lfx/src/lfx/services/settings/groups/security.py`,
  default `True`). No lane overrides it.
- **An address Langflow reaches ITSELF on.** The node needs a loopback URL *from
  Langflow's point of view*, which is not necessarily the address the test uses. The
  spec derives it from the Playwright `baseURL` origin; `A2A_SELF_BASE_URL` overrides
  it for an instance published on a remapped port (a local container mapped
  `7871→7860` must set `A2A_SELF_BASE_URL=http://localhost:7860`). In every CI lane
  the two coincide at `http://localhost:7860` — `daily-stable.yml` forwards that port
  into its job container precisely so `PLAYWRIGHT_BASE_URL` stays on it.
- **No LLM, no provider key, no external network** — A is the Chat Input → Chat
  Output passthrough (`createRunnableChatFlowViaApi()`); B holds `A2AAgent` → `Chat
  Output`.
- Auto-login superuser: the two flows, the project and the API key share one owner,
  which is the only owner whose key the A2A gate accepts.

---

## Preconditions *(optional)*

- A2A-enabled Langflow at `PLAYWRIGHT_BASE_URL`.
- **A's name must be unique per run** — assertion 1 matches it in the viewer.
- **B stays in the default project while A moves.** External mode is not
  folder-scoped (unlike C1's Internal dropdown); only A's project decides its card's
  security.

---

## Step by step *(required)*

One test. Every flow, key and project it creates is deleted in `finally`.

1. `requireA2aEnabled(request, headers)`.
2. Create flow **A** via `createRunnableChatFlowViaApi()`; `PATCH` it to
   `{ name: <unique>, flow_type: "agent", a2a_enabled: true }`.
3. Create, up front, the project the restricted half needs (`createProjectViaApi` with
   `auth_settings: { auth_type: "apikey" }`) and an API key for the owner
   (`createApiKey`). Up front on purpose: both are non-idempotent POSTs, and issued
   mid-test after a UI step they landed in the idle window where a reused keep-alive
   socket is dropped (see *Measurements*). Idempotent reads and the move `PATCH` are
   re-dialled once on a dropped connection instead (`retryOnDroppedConnection`).
4. Create blank flow **B** via the API and open its editor (`openFlowById`).
5. Add the `A2AAgent` node (`add-component-button-a2a-agent`) and assert
   `popover-anchor-input-agent_url` is visible **without touching the mode tabs** —
   the node opens in External mode.
6. Fill `popover-anchor-input-agent_url` with
   `<self>/api/v1/a2a/<A>/.well-known/agent-card.json` — the card URL the Agent tab
   hands out — and blur.
7. Assert `data_display_data_display_agent_card` appears (the timeout covers the
   `POST /api/v1/custom_component/update` round trip that fetches the card); open the
   viewer (`data_display_data_display_data_display_agent_card`); assert assertion 1;
   close it.
8. Fill `textarea_str_input_value` with a per-run sentinel.
9. Add `Chat Output`, separate the two nodes, and wire
   `handle-a2aagent-shownode-response-right` →
   `handle-chatoutput-noshownode-inputs-target` (one edge).
10. Open the playground (`playground-btn-flow-io`), press `button-send`, assert
    `chat-message-AI-<sentinel>`.
11. Poll `GET /api/v1/monitor/messages?flow_id=<A>` for assertion 3.
12. Close the playground (`playground-close-button`), `PATCH` A's `folder_id` into the
    restricted project and assert the move.
13. Re-point `agent_url` at A's **base** URL `<self>/api/v1/a2a/<A>`. The component
    accepts both forms (`_agent_base_url` normalises them); the value change is what
    makes it fetch the card again.
14. Open the viewer and assert assertion 4; close it.
15. Select the node, open its Parameters panel (`parameters-button`), add the advanced
    `api_key` field to the node (`inspector-add-api_key`) and fill
    `popover-anchor-input-api_key` with the owner's key. Fill
    `textarea_str_input_value` with a second sentinel.
16. Run from the playground and assert assertion 5.
17. `finally`, each guarded: leave the editor; delete B, then A, then the API key,
    then the project — after its flow is gone, since a project holding flows is a
    different delete path and `deleteProject` also removes the key the backend issues
    for an `auth_settings` project.

---

## Validation *(required)*

| # | Step | Observable |
|---|---|---|
| 1 | card viewer (public) | A's unique name; no `Requires an API key` |
| 2 | run | `chat-message-AI-<sentinel>` |
| 3 | monitor | the sentinel under an A2A-server session (`<uuid>:<uuid>`, no `:a2a:`) |
| 4 | card viewer (restricted) | `Requires an API key` |
| 5 | keyed run | `chat-message-AI-<sentinel2>`, and A stored it |

---

## Measurements that shaped this spec *(measured on `1.13.0.dev12`)*

Scouted live with `playwright-cli`; every testid was harvested from the running
instance, none invented.

- **The self-call completes under `LANGFLOW_WORKERS=1`.** A run in which the instance
  calls its own `/jsonrpc` mid-build returned the sentinel in **~3 s** (public) and
  **~2 s** (keyed) — the single worker every lane pins does not deadlock on it.
- **The card URL stays on the same origin.** The card's `url` is built from
  `request.base_url` (`langflow/api/v1/a2a.py`), so a card fetched from
  `http://localhost:7860/…` advertises its `/jsonrpc` on that same origin, and
  `build_a2a_client`'s request hook returns early for same-origin hops — the strict
  off-origin validator never runs on this path.
- **External is the default mode.** `tab_0_internal` / `tab_1_external` render, and
  `popover-anchor-input-agent_url` is present before any tab is clicked.
- **The display renders only when a card came back.** After the fill,
  `title-agent card` + `data_display_data_display_agent_card` appear; the button
  inside is `data_display_data_display_data_display_agent_card` ("View agent card").
- **The viewer dialog carries no testids.** Its text, measured in order: the name, the
  version (`v1.13.0.dev12` — the instance version, not a card override), the chips
  (`Requires an API key` only when restricted, then `Streaming`, `Push
  notifications`, `JSONRPC`, `A2A 0.3.0`), then *Description*, *Sends*
  (`input_value`, `session_id`) and *Skills*. Hence text assertions on the dialog.
- **The restricted chip needs a refetch.** Moving A does not update an
  already-rendered display; changing `agent_url` (card URL → base URL) did, and the
  chip appeared.
- **`api_key` is an advanced field.** It is not on the node until added from the
  Parameters panel (`inspector-param-api_key` → `inspector-add-api_key`), after which
  `title-api key` and `popover-anchor-input-api_key` render on the node.
- **The node is 481 px tall in External mode with the card display** (401 px in
  Internal, per C1), and the sidebar drops `Chat Output` inside it — the separation
  step must exceed that height.
- **Session namespaces tell the two modes apart.** External: `<uuid>:<contextId>`,
  minted by the A2A server (measured, e.g.
  `b99120e7-…-8992690ee53f:ef8681bc-…-5166084354b3`). Internal:
  `<caller session>:a2a:<target id>` (`_isolated_sub_session`; measured on the C3
  scout).

- **A dropped keep-alive socket is an environment failure, not a verdict.** A
  force-fail run of this spec died on `apiRequestContext.post: socket hang up` at
  `POST /api/v1/api_key/`, issued ~2 s after the previous API call while the test was
  driving the UI — the idle window in which the local nightly (reached through
  Colima's port forward) closes a reused socket under the request context. The two
  POSTs moved to the API block before the UI; the reads and the move `PATCH`, which
  are safe to repeat, are re-dialled once through `retryOnDroppedConnection` (#1562),
  which retries only a THROWN request and passes any response through untouched.

### A negative control measured and deliberately not asserted

With A restricted and **no** key on the node, the run renders `error-card` →
*"Failed to call A2A agent at http://localhost:7860/api/v1/a2a/<A>: HTTP Error: 401"*
and A stores nothing. It is not asserted: the gate is `a2a-server-auth-apikey`'s
subject; the keyed run (assertion 5) already fails if the component stops forwarding
the key; and provoking it would need `page.allowFlowErrors()`, which switches the
fixture's run-stream gate off for every later run in the test.

---

## Out of scope

- **The no-key 401 from the client side** — above.
- **A genuinely remote agent, and card-declared off-origin RPC URLs.** Both need a
  second origin the runner does not have; the off-origin path is also the one that
  keeps the strict validator plus its toggle-independent floor, which is upstream
  unit-test territory.
- **The `timeout` input** and **`message/stream`** — the component calls
  `message/send`.
