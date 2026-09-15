# A2A Client — the `A2AAgent` as an Agent tool, through a tool-call approval

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`)

**Issue:** #1855 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **C3**) ·
**Follows:** #1354 (C1) · **Jira:** epic `LE-1588`, regression `LE-1963`, tool-call
approval `LE-1447`

---

## What this test validates *(required)*

An Agent can delegate to a published A2A agent by using the `A2AAgent` component as
a **tool** — the shape a multi-agent flow takes. The regression recorded on this path
(`LE-1963`) is **not** the plain tool call: it fired when the run **resumed after a
tool-call approval**, where `self.user_id` was `None` — `_run_target_isolated` passes
`user_id=str(self.user_id)`, and `str(None)` fed to `UUID()` is exactly the ticket's
`badly formed hexadecimal UUID string`. A spec that never pauses for approval cannot
reach it, so this one goes through the pause.

It proves five things, and they fail independently:

1. **The pause is real, and it gates the tool.** The approval card names
   `send_to_agent` with the per-run sentinel in its arguments, while the target flow
   has stored **nothing** — the tool has not run yet.
2. **Approve resumes the run and the tool call completes** — `tool-status-done`, no
   error card.
3. **The completed call executed the target flow** — the target stored the sentinel
   under the Internal-mode session `…:a2a:<target id>`. Read from the server, so it
   holds whatever the model writes afterwards.
4. **The agent's reply comes back into the run, and the run answers** — the caller's
   persisted `send_to_agent` tool call carries the sentinel as its **output** (the
   A2A agent's reply returned to the Agent), and a non-empty AI turn renders in the
   playground after the resume. How the model words that turn is deliberately not
   asserted (see *Measurements*).
5. **Nothing crashed unseen** — the fixture evaluated the run stream(s) and none
   failed (`flowErrorReport()`: `evaluated > 0` and `clean`).

**Internal mode, on purpose.** `LE-1963` lives only there: External mode never reads
`user_id`, so an as-a-tool spec built on External mode would miss the regression. It
also keeps the SSRF layer out of this spec's causes (`a2a-client-agent-external.md`
covers that half).

---

## Tags *(required)*

`@stable` `@regression` `@components` `@workspace` `@a2a` `@agents`

- `@regression` — `LE-1963`.
- `@agents` — the subject is an Agent's tool call; the spec runs a real model.
- `@components` / `@workspace` / `@a2a` — as in C1.
- `@stable` — enters with the tag per `CONTRIBUTING.md`; parametrized by the shared
  resolver with `tier: "tool-calling"`, because it depends on the model choosing to
  call the tool.

---

## Validation criterion *(required)*

Target flow **A** published under a unique per-run name; caller flow **B** = the
Simple Agent template plus an `A2AAgent` tool in Internal mode pointed at A, with
*Requires Approval* on. The playground prompt asks the Agent to call `send_to_agent`
with a sentinel.

| # | When | Observable | Expected |
|---|---|---|---|
| 1 | before any decision | `human-input-card` | visible; text contains `send_to_agent` and the sentinel; `human-input-decision-approve` enabled |
| 2 | before any decision | `GET /api/v1/monitor/messages?flow_id=<A>` | **no** message containing the sentinel |
| 3 | after Approve | tool step | `tool-status-done` visible; no `tool-status-error` |
| 4 | after Approve | `GET /api/v1/monitor/messages?flow_id=<A>` | a `User` message whose text is the sentinel, `session_id` ending in `:a2a:<A>` |
| 5 | after Approve | `GET /api/v1/monitor/messages?flow_id=<B>` | a `tool_use` block named `send_to_agent` whose `output` contains the sentinel |
| 6 | after Approve | `chat-message-AI-*` in the playground | at least one turn with non-empty text |
| 7 | end of test | `page.flowErrorReport()` | `evaluated > 0` and `clean` |

Assertion 2 is the negative control for 4: the same query, one decision apart.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced in-test by `requireA2aEnabled()`.
- **A tool-calling model and its provider key** — `resolveTestTargets({ tier:
  "tool-calling" })` over `models.json` / `providers.json` from
  `tests/collect-models.spec.ts`; an inactive provider skips with its recorded reason.
  Measured with OpenAI `gpt-4o-mini`. Run with `--workers=1` (area rule for agent
  specs).
- The target is the LLM-free passthrough (`createRunnableChatFlowViaApi()`), so the
  model is the only non-deterministic element and its reply is not what assertions
  3–4 read.
- Auto-login superuser owns both flows.

---

## Preconditions *(optional)*

- **A and B in the same project** — the Internal dropdown is folder-scoped
  (`list_a2a_agents_by_flow_folder`, measured in C1). Both land in the default project.
- **A's name unique per run** — the dropdown lists agents by name.
- **No `page.allowFlowErrors()`** — a crash on resume must fail the test through the
  fixture as well as through assertion 3.

---

## Step by step *(required)*

One test per resolved target. Flows B creates are captured by `trackCreatedFlows`
and deleted in `afterEach`; A is deleted by id.

1. Skip on the target's recorded reason / missing provider env; `requireA2aEnabled()`.
2. Create flow **A** via `createRunnableChatFlowViaApi()`; `PATCH` it to
   `{ name: <unique>, flow_type: "agent", a2a_enabled: true }`.
3. `SimpleAgentTemplatePage.load(options)` — template, model, credential-settle guard
   (`MODEL_NOT_AVAILABLE` skips).
4. **Remove the template's own tools** — delete the `URL` and `Web Search` nodes
   (select by title, Backspace) and assert both are gone. Two reasons, both measured:
   the sidebar drops the new node on top of them, and with `send_to_agent` as the
   Agent's only tool a missing approval card can only mean "the model called no tool".
5. Add the `A2AAgent` node (`add-component-button-a2a-agent`), click `tab_0_internal`,
   open `value-dropdown-dropdown_str_agent_name_selected` and pick
   `<A's name>-0-option`.
6. Select the node (`title-A2A Agent`) and click `tool-mode-button`; assert
   `tool_send_to_agent`.
7. **Wait for the node's update round trips to settle** (`waitForComponentUpdateSettled`),
   wire `handle-a2aagent-shownode-toolset-right` → `handle-agent-shownode-tools-left`,
   **settle again**, and assert exactly one edge leaves the `A2AAgent` node and reaches
   the Agent — asserted after the second settle, so an edge a late response undid
   fails here rather than as a missing tool call two minutes later.
8. Open the node's actions editor (`button_open_actions`, scoped to the `A2AAgent`
   node) with a single click, flip `requires-approval-toggle` (`aria-checked="true"`),
   let the row commit, settle, close with Escape, then poll the persisted flow until
   the node's `send_to_agent` action carries an `approval_actions` list containing
   `approve`.
9. Re-assert the tool edge is still on the canvas (the playground runs the canvas, not
   the saved flow), open the playground and send `Use the 'send_to_agent' tool with
   the message: <sentinel>`.
10. Assert criterion 1, then criterion 2. While waiting for the card, a run that
    finishes without it is reported by cause — no tool call at all, or the tool ran
    without pausing (the approval requirement did not reach the run).
11. Click `human-input-decision-approve`.
12. Assert criteria 3 and 4.
13. Assert criteria 5 and 6.
14. Wait for the run to leave the pending list and the Stop control to go away;
    assert criterion 7.

---

## Validation *(required)*

| # | Step | Observable |
|---|---|---|
| 1 | pause | approval card naming `send_to_agent` + the sentinel |
| 2 | pause | target stored nothing |
| 3 | resume | `tool-status-done`, no `tool-status-error` |
| 4 | resume | target stored the sentinel under `…:a2a:<A>` |
| 5 | resume | the persisted `send_to_agent` output carries the sentinel |
| 6 | resume | a non-empty AI turn in the playground |
| 7 | end | run streams evaluated and clean |

---

## Measurements that shaped this spec *(measured on `1.13.0.dev12`)*

Scouted live with `playwright-cli`, `gpt-4o-mini`; every testid harvested from the
running instance.

- **`LE-1963` does not reproduce on this build.** Approve resumed the run and the tool
  call completed in **~4 s**, with no error card. The spec is therefore a passing
  guard for the regression, not a `test.fail` gate.
- **The pause gates execution server-side.** The approval card rendered **~5 s** after
  send with the text *"Waiting for Human Input — Tool execution requires approval —
  Tool: send_to_agent Args: {'input_value': '<sentinel>'} — Approve / Reject"*; A held
  **0** messages with the sentinel. After Approve, A held **2** (`User`, `Machine`)
  under `<caller flow id>:a2a:<A id>`.
- **The final wording is the model's, not the product's.** With the same prompt and
  model, one run answered *"The response from the agent is: <sentinel>…"* and the
  next two answered *"The message has been sent successfully."* — the tool had run
  and returned the sentinel both times. An assertion on the reply text measures the
  model; the persisted tool output (criterion 5) measures the A2A call, which is why
  the sentinel is read there and the playground turn only has to exist.
- **The card is the shared HITL card.** Same `human-input-card` /
  `human-input-decision-approve` / `human-input-decision-reject` testids as the Human
  Input node (`human-input-pause-resume.spec.ts`); after Approve,
  `human-input-decision-approve` stays in the DOM and `…-reject` is gone.
- **Tool Mode reshapes the node.** The `message` field disappears (it becomes the
  tool's `input_value` argument) and `title-actions`, `div-tools_tools_metadata`,
  `button_open_actions`, `tool_send_to_agent` and
  `handle-a2aagent-shownode-toolset-right` appear.
- **The template's tools are in the way.** The Simple Agent template ships URL and Web
  Search already in Tool Mode (an unscoped `button_open_actions` matches three
  nodes), and the sidebar drops the `A2AAgent` node on top of both — measured at
  (670, 274) 183×232 against URL at (667, 129) 183×171 and Web Search at (655, 406)
  183×121. Removing them costs two deletions and leaves the approval gate on the only
  tool the Agent has.
- **In-flight node updates undo canvas work — so the spec waits them out.** Tool Mode
  and the new edge each fire `POST /api/v1/custom_component/update` round trips that
  re-render the node. Instrumented: a `button_open_actions` click issued while one
  was in flight (it finished 174 ms later, followed by two more and an autosave)
  opened nothing for 5 s, and the same click once they had settled opened the editor
  in 156 ms; on another run the handle drag created no edge. A first version repeated
  the lost click and moved on — and over a burst of four, the **two** runs where the
  repeat fired were exactly the two where the Agent then made no tool call, one
  answering that the tool was *"not available in my current environment"*. The repeat
  had hidden the symptom of wiring a late response undid. Hence the settle barrier
  before and after wiring, a single click on the editor, and the edge re-asserted
  after the settle and again before the run. (The barrier was local to
  `core-components/edit-tools.spec.ts`, whose comment asked for it to move to
  `tests/helpers/flows/` on a second caller; this spec is that caller.)
- **The approval toggle persists as a list.** The node's `tools_metadata` held
  `{ name: "send_to_agent", approval_actions: ["approve", "reject"] }` after the
  editor closed — the edits apply on close (#1519), which is why the persisted flow is
  polled rather than assumed.
- **Dropped keep-alive sockets end API polls early.** Two runs of an early version
  failed on `apiRequestContext.get: socket hang up` inside `expect.poll` — a thrown
  poller is not retried, so the poll ended on the transport error instead of on its
  condition. Measured against the local nightly behind Colima's port forward: the
  socket is dropped at an idle gap of ~2 s, which the `[500, 1000, 2000]` intervals
  hit exactly. Every API poll here keeps its intervals under 2 s, and the reads — all
  idempotent — are re-dialled once through `retryOnDroppedConnection` (#1562), which
  retries only a thrown request and passes any response through untouched.
- **The new edge embeds both node ids** — `…A2AAgent-<id>…-Agent-<id>…` — so the
  Agent end is matched on `-Agent-` (with the leading dash), which the `A2AAgent-` id
  on the other end cannot satisfy.

---

## Out of scope

- **The Reject decision** — the natural sibling (the tool must not run, the target
  must store nothing), reachable with this same setup; not taken here because it
  doubles the model spend for a path `LE-1963` does not touch. First candidate for a
  second pass.
- **The `A2AAgent` tool in External mode** — `LE-1963` does not live there (above).
- **The `edit` / `respond` decisions** — not offered by *Requires Approval*, which
  writes `approve` + `reject` only.
