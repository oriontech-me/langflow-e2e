# A2A Client — the `A2AAgent` component in Internal mode: calling a locally published agent

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev18`)

**Issue:** #1354 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **C1**) ·
**Depends on:** #1240 · **Jira:** epic `LE-1588`

---

## What this test validates *(required)*

A2A has two halves: **serving** an agent and **consuming** one. The eight specs
under `core-functionality/a2a/` cover the server. The `A2AAgent` component — the
entire client half — has **no coverage at all**, and this is its first.

`mode=Internal` is the half reachable today: it lists agents published **in the
caller flow's own project** and calls one over the same `/jsonrpc` endpoint the
server specs already prove. It does **not** depend on the loopback-SSRF question
that blocks `C2`/External (`LE-1904` class) — that constraint applies only to
pointing the component at a URL, including this instance's own.

Two things are proven, and they fail independently:

1. **Discovery into the component** — the dropdown offers the published agent. If
   this regresses the component is unusable: there is nothing to pick.
2. **The call actually executes the remote flow** — a per-run sentinel sent as the
   component's `message` comes back through the published passthrough. If this
   regresses the dropdown still looks healthy while every run returns nothing.

Because the target flow is a Chat Input → Chat Output passthrough, the sentinel
coming back is **causal evidence the other flow's graph ran** — not a
"something was returned" check, and no LLM on either side.

---

## Tags *(required)*

`@stable` `@components` `@workspace` `@a2a`

- `@components` — the subject is a component's configuration and execution.
- `@workspace` — it drives the flow editor: sidebar add, canvas wiring, playground.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — LLM-free and deterministic; enters with the tag per
  `CONTRIBUTING.md` (the standard #1349 restored for this area).
- **No `@release`:** publishing and serving is the release-critical path and
  carries the tag in the server specs. Consuming an agent is a feature, not the
  gate on shipping.
- **No `@api`:** unlike every other spec in this area, the subject here only
  exists in the UI (see below).

---

## Validation criterion *(required)*

With flow **A** published as an A2A agent under a unique per-run name, and flow
**B** holding an `A2AAgent` node in the same project:

| # | Observable | Expected |
|---|---|---|
| 1 | the `agent_name_selected` dropdown, after switching `mode` to `Internal` | contains an option whose text is **A's exact name** |
| 2 | the flow B run, via the playground | a chat message `chat-message-AI-<sentinel>` — the sentinel A's passthrough echoes verbatim |

Assertion 1 is **presence of A's name**, never option count: the superuser
account is shared and a parallel spec may hold its own published agent in the
same project.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced in-test by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network** — flow A is the Chat Input →
  Chat Output passthrough (`createRunnableChatFlowViaApi()`); flow B holds only
  `A2AAgent` → `Chat Output`.
- Auto-login superuser: the caller flow, the target flow and the agent list are
  all scoped to the same user.

---

## Preconditions *(optional)*

- A2A-enabled Langflow at `PLAYWRIGHT_BASE_URL`.
- **Flow A and flow B must live in the same project.** This is not a convenience:
  the dropdown is populated by `list_a2a_agents_by_flow_folder(user_id, flow_id)`,
  which lists agents published **in the caller flow's folder** — measured in the
  component source. Both flows are created in the default project, which the test
  does not modify.
- **Flow A's name must be unique per run.** The dropdown lists agents by *name*
  (ids live in `options_metadata`), so a fixed name would make assertion 1
  ambiguous the moment two runs overlap.

---

## Step by step *(required)*

One test. Every flow it creates is deleted by id in `finally`.

1. `requireA2aEnabled(request, headers)`.
2. Create flow **A** via `createRunnableChatFlowViaApi()`; `PATCH` it to
   `{ flow_type: "agent", a2a_enabled: true }` and rename it to a per-run unique
   name. Keep the name — it is what assertion 1 matches.
3. Create blank flow **B** and open its editor.
4. Add the `A2AAgent` node from the sidebar
   (`add-component-button-a2a-agent`).
5. Click `tab_0_internal`. **The node opens in External mode**, so this is a
   required step, not a no-op — and it is what makes the dropdown render at all.
6. Open `value-dropdown-dropdown_str_agent_name_selected` and assert an option
   with **A's name** is present; select it.
7. Fill `textarea_str_input_value` with a per-run sentinel. (The field is the
   component's `message` input; its template name is `input_value`.)
8. Add `Chat Output` from the sidebar, **separate the two nodes** (the sidebar
   drops a new node on top of the previous one), and wire
   `handle-a2aagent-shownode-response-right` →
   `handle-chatoutput-noshownode-inputs-target`.
9. Open the playground (`playground-btn-flow-io`) and press `button-send`.
10. Assert `chat-message-AI-<sentinel>` appears.
11. `finally`: delete flow B and flow A, id-scoped, each guarded.

---

## Validation *(required)*

| # | Step | Observable |
|---|---|---|
| 1 | dropdown | an option whose text equals flow A's unique name |
| 2 | run | `chat-message-AI-<sentinel>` in the playground |

---

## Measurements that shaped this spec *(measured on `1.12.0.dev18`)*

Scouted live with `playwright-cli`; every testid below was harvested from the
running instance, none invented.

- **The node opens in `External` mode.** The dropdown does not exist until
  `tab_0_internal` is clicked — a spec that assumed Internal was the default
  would fail looking for a field that is not rendered.
- **The dropdown is folder-scoped, not instance-scoped.**
  `_populate_internal_agents` calls `alist_a2a_agents_by_flow_folder`, whose
  docstring is explicit: *"List flows published as A2A agents in the same folder
  as the current flow."* A published agent in another project is invisible here.
- **The `message` input's template name is `input_value`**, so the testid is
  `textarea_str_input_value` — not `textarea_str_message`, which is what the
  component's Python input name would suggest.
- **The option testid embeds the agent name**: `{agent name}-{index}-option`.
- **`options_metadata` carries the flow id** alongside each option
  (`{id, updated_at}`), because names are not unique;
  `_selected_agent_flow_id()` resolves the pick through it.
- **The sidebar drops the second node on top of the first** — measured
  `A2AAgent` at (588,192) 320×401 and `Chat Output` at (598,202), fully
  contained. They must be separated before wiring, or the drag lands on the
  wrong element (the failure mode `separate-overlapping-nodes.ts` exists for).
- **The run takes ~48 ms** — the internal call is in-process, so this spec needs
  no generous timeout and no `--workers=1`.

### The output inspector does not show this component's output

**`output-inspection-response-a2aagent` renders "No Data Available" even after a
successful run.** Measured three times, including immediately after a run whose
`POST /api/v2/workflows` stream carried
`{"status":"success","outputs":{"response":{"message":"<sentinel>"}}}` — the data
exists, the modal does not show it. The Logs tab is empty too.

This is why **the spec asserts through a wired `Chat Output` and the playground
rather than through the node's own output modal**, which is the shorter path and
the one a reader would expect. It costs two extra steps (add Chat Output,
separate and wire) and buys an observable that reflects the run.

**Candidate product defect — the component output inspector is blind to
`A2AAgent`'s output.** Not filed; recorded here. Not yet compared against other
components, so whether it is specific to `A2AAgent` or general to the inspector
is **unknown** and deliberately not claimed.

---

## Out of scope

- **C2 / External mode** (`LE-1845`) — blocked until the loopback-SSRF question
  is answered; tracked separately.
- **C3 / the `A2AAgent` as a Tool** (`LE-1963`) — the only LLM-dependent row of
  the area; tracked separately.
- **The negative control "an agent published in another project is absent from
  the dropdown."** It is the natural sibling of assertion 1 and is genuinely
  reachable (`createProjectViaApi` from #1353 makes the second project cheap),
  but it doubles the flows and the wiring for a property the folder-scoped
  lookup already makes structural. Recorded as the first candidate if this area
  gets another pass.
- **The `api_key` input** — the component's own field for calling a *restricted*
  agent. The gate it drives is covered from the server side by
  `a2a-server-auth-apikey`; exercising it from the component means publishing A
  into a restricted project and is a spec of its own.
