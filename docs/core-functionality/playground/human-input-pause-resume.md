# Spec: Human Input pause/resume in the Playground (HITL decision card)

**Test file:** `tests/tests-automations/regression/core-functionality/playground/human-input-pause-resume.spec.ts`

**Last validated:** Langflow 1.13.x (tests 1–2 built on `1.12.0.dev10`; test 3 built and
all three measured on `1.13.0.dev29`)

---

## What this test validates

The **execution** half of the Human Input feature (HITL, Langflow 1.11.0 — upstream
`langflow-ai/langflow#13633` durable background execution + suspend/resume, `#14090`
polish; manual recipes HITL-01/02/03). Three claims, both scenarios:

1. **The run suspends.** Sending a message in the Playground does not complete the flow —
   the run parks and the decision card (`human-input-card`) renders in the transcript with
   one enabled button per configured choice.
2. **Answering resumes the run.** Clicking a decision completes the flow: the chosen
   branch's downstream Chat Output produces its message.
3. **Routing is exclusive.** The other branch produces **nothing** — the component calls
   `stop("branch_<action_id>")` on every non-chosen branch, so the counterpart Chat Output
   never emits.

Test 1 answers **Approve**, test 2 answers **Reject**. They are mirror images on purpose:
a spec that only ever approves cannot tell exclusive routing from "the approve branch is
the only one wired".

Test 3 (issue #2050, QA-CHECKLIST §9.6) covers **durability**: a suspended run outlives the
tab that started it. It suspends the run exactly as test 1 does, **reloads the page**, and
then claims:

4. **The same run is still parked.** After the reload the backend still holds exactly one
   suspended request for the flow, and it belongs to the **same** `job_id` as before the
   reload. A reload that started a fresh run, or lost the suspended job, fails here.
5. **The decision is offered again, from both places it is stored.** The canvas shows the
   paused Human Input node's badge and decision popover, which come from the pending-job
   list. The Playground transcript shows the user's message and the decision card, which
   come from the persisted chat message. Both decisions are enabled, and no branch has
   emitted.
6. **Approving it completes the original run.** Approving the recovered card produces the
   approved branch's bubble and none from the reject branch. The pending list empties, and
   the original `job_id` reaches the terminal status `completed`.
7. **The answer is durable too.** A second reload renders the card **resolved**: the
   reject decision is gone, approve is disabled, and the approved bubble is still in the
   transcript. Nothing in the tab carries that state across the reload, so it can only come
   from the answer persisted on the server.

**Configuration is out of scope** — the default handles, adding a choice live and
persistence across reload are covered by `core-components/human-input-node-config.spec.ts`
(issue #1190, merged). This spec never edits the node.

No LLM provider is involved: the flow is Chat Input → Human Input → two Chat Outputs, and
`route_branch()` returns the prompt text itself.

---

## Two design decisions the live scout forced

**Both branches must be wired, or the run never pauses.** `_has_downstream_consumer()`
(`lfx/components/flow_controls/human_input.py`) returns `False` when the node has no
outgoing edge, and the component then **skips the pause entirely** — status
`"Skipped: no connected outputs"` — because suspending a whole run for a decision that
routes nowhere would strand it. So the two Chat Outputs are a **precondition of the
behaviour under test**, not scenery.

Which is why the setup asserts the **edge count**, not just the node titles: React Flow
renders nodes independently of edges, so a fixture that lost a branch edge still shows
`title-Approved Output` and `title-Rejected Output` (measured — both visible with both
branch edges stripped). Without the edge assertion that defect surfaces 30 s later as
"the decision card never appeared", i.e. a wiring problem reported as a card-UI failure.
One nuance worth carrying: on the skip branch the component calls **no** `stop()`, so a
`successor_map` regression *with* the edges present fires **both** branches rather than
merely skipping the pause — which is what the exclusivity assertion below catches.

**The two branches carry identical text, so routing needs a distinguishable sink.**
`route_branch()` returns `Message(text=self._rendered_prompt())` on *whichever* branch
wins, so both Chat Outputs would emit the same string and "which branch ran" would be
invisible in the chat. The fixture therefore gives each Chat Output a distinct
`sender_name` (`APPROVED` / `REJECTED`) and a distinct display name (`Approved Output` /
`Rejected Output`). The Playground bubble testid is
`chat-message-${sender_name}-${text}`, which turns the routing claim into an exact
locator: `chat-message-APPROVED-<prompt>` must exist and `chat-message-REJECTED-<prompt>`
must have count `0`.

---

## What survives a reload, and where it lives (test 3)

Measured on `1.13.0.dev29` and read from the shipped source. Two separate server-side
stores keep the pause, and each one drives a different surface after the reload:

| Store | Written by | Read back by | Surface after reload |
|---|---|---|---|
| The **suspended job** (`Job.status = suspended`, plus its pending request) | the run itself, on suspend | `GET /api/v2/workflows/pending?flow_id=` (polled every 5 s by `useRestoreCanvasHitl`) | the canvas: `human-input-node-badge` on the Human Input node and its auto-opened popover `human-input-card` |
| A **chat message** carrying a `human_input` content block (`request_id` + `job_id`) | `persist_human_input_card()` on suspend; `mark_card_answered()` stamps `submitted_action` on resume | `GET /api/v1/monitor/messages?flow_id=&session_id=` | the Playground transcript: the user bubble plus the `human-input-card`, interactive while `submitted_action` is unset and resolved once it is set |

The two stores fail independently, which is why test 3 asserts both surfaces rather than
one:

- A lost suspended job breaks the canvas badge and the server checks.
- A missing card message breaks the Playground transcript, even with the job still parked.
- A missing `submitted_action` stamp re-offers a decision that is already answered. A click
  on that card would 409 against the completed job.

Three measurements back the design:

- **A reload cannot be served from the tab.** `localStorage` holds no message or card. The
  only HITL-adjacent `sessionStorage` key, `langflow_local_sessions_<flowId>`, is a list of
  local session ids, not messages. The recovered state therefore has to come from the
  server. A fresh browser context, with no storage at all, recovers identically. It was
  measured, and it is not asserted because the issue asks for a reload.
- **The canvas and the Playground never show the card at the same time.**
  `useAwaitingHumanInput()` hides the badge while the Playground is open, so exactly one
  `human-input-card` is mounted at any moment. Each assertion is still scoped: the canvas
  card to the Human Input node, the Playground card to the transcript (`role="log"`, name
  `Chat messages`). An unscoped locator would let either surface stand in for the other.
- **The resolved card is a strong claim here, and a weak one in tests 1–2.** In tests 1–2
  the card's "only the chosen action remains, disabled" state is set synchronously from the
  card's local React state, so it proves only the UI. After a reload that local state is
  gone, and the same rendering can only come from the persisted `submitted_action`.

**"The run completes" has a direct oracle on this path.** `GET /api/v2/workflows?job_id=`
returns `status: "suspended"` while the run is parked and `status: "completed"` once the
resumed run reaches its terminal state. It reported the same `job_id` before and after the
reload, and `completed` within the first poll after the approved bubble rendered. Tests 1–2
stop at "the run left the suspended state". Test 3 asserts the terminal status, because
completion is the claim the issue makes.

---

## Tags

Tests 1–2: `@stable` `@release` `@playground`

`@release` is claimed here and deliberately **not** on the sibling config spec (#1190):
this is the execution happy path of 1.11's flagship feature — if it breaks, a HITL flow
cannot be answered at all. (Measured, since an earlier draft of this doc overstated it:
exactly **one** other playground spec carries this exact set — `playground-shareable-url` —
while 11 of 23 carry `@release` alongside further tags.)
`@regression` is absent: first-time coverage of a new feature, not a previously fixed bug.

Test 3: `@stable` `@database` `@playground`

`@database` is the cross-cutting tag for "tests with persistent saved state". That is the
whole claim of test 3: the pause and the answer both live in the database, not in the tab.
`@release` is not claimed. Recovering after a reload is a robustness path, not the happy
path a deploy must clear. Tests 1–2 already carry `@release` for that path in this file.
`@stable` enters with the test, per `CONTRIBUTING.md`. The test needs no provider and no
lane selector, so no exception applies.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (built and measured on the nightly,
  `1.12.0.dev10` for tests 1–2 and `1.13.0.dev29` for test 3).
- **No provider credentials**, no `models.json`, no `collect-models`.
- Fixture flow `tests/assets/flows/human-input-branching-fixture.json` — Chat Input
  (`input_value` = the sentinel prompt) → Human Input (default `Approve`/`Reject`) →
  `Approved Output` / `Rejected Output`. Built by wiring it in the UI on a live nightly and
  exporting the result through `GET /api/v1/flows/{id}`, because a hand-written flow JSON
  renders empty (nodes need `type: "genericNode"` plus their full template) and an edge
  only attaches when its `sourceHandle` string matches the handle's own `data-handleid`
  verbatim (`{œdataTypeœ:œHumanInputœ,œidœ:…,œnameœ:œbranch_approveœ,…}`). Node ids
  survive `POST /api/v1/flows/` unchanged — the pending request's `request_id` is
  `<HumanInput node id>:<job_id>` — so test 3 scopes the canvas badge to the fixture's own
  Human Input node id.
- The file is **parallel-safe** and deliberately not serial. Each test owns its flow (unique
  `${Date.now()}-${random}` name, so the backend's unique-name suffixing has nothing to
  race) and its own page, and a suspended run is flow-scoped, so the tests cannot observe
  each other. The sibling fixture specs use `mode: "serial"` for that name race; inheriting
  it here would cost signal, because a flake in the first test **skips** the others and one
  bad day in the daily would lose the Reject verdict. Measured green at `--workers=2` (and
  faster: ~7 s against ~10 s serial).

---

## Step by step

**Per test (shared helper)**
1. Read the fixture, `POST /api/v1/flows/` with a unique name (`createFlow` + explicit
   Bearer), keep the id for teardown.
2. `page.goto('/flow/{id}')`, wait for `title-Human Input`, both output titles, and
   **`.react-flow__edge` count `3`** (the wiring precondition — see above), then
   `adjustScreenView(page)`.
3. Open the Playground (`playground-btn-flow-io`) and assert `input-chat-playground` is
   pre-filled with the fixture's sentinel prompt — the node's value, not typed text (typing
   into that field races the template default, `authoring-conventions.md`).

**Test 1 — Approve**
4. Click `button-send`.
5. Assert the run **suspended**, on both sides:
   - UI — `human-input-card` visible, containing the sentinel prompt, with both
     `human-input-decision-approve` and `human-input-decision-reject` **enabled**;
   - server — `GET /api/v2/workflows/pending?flow_id={id}` holds exactly **one** suspended
     request. This is what separates "the card is on screen" from "the run is parked";
   - and no branch output has emitted yet (both sender-scoped bubbles count `0`) — a pause,
     not a slow completion.
6. Click `human-input-decision-approve`.
7. Assert `chat-message-APPROVED-<prompt>` becomes visible.
8. Assert `chat-message-REJECTED-<prompt>` has count `0` — exclusive routing.
9. Assert the run **left the suspended state**: `pending?flow_id={id}` polls to `0`. The
   routed bubble arrives through the message-query invalidation, independent of the run's
   own event stream, so without this a resume that never completed would pass step 7.
10. Assert the card's affordance followed the answer: `human-input-decision-reject` is
    **gone** and `-approve` is **disabled**. Deliberately a weak claim — the card sets this
    from local state synchronously (measured 45 ms after the click, before the request is
    sent) and keeps it locked on an error too, so it pins the UI, never that the backend
    accepted anything. Step 9 is what does that.

**Test 2 — Reject**
Same, mirrored: click `human-input-decision-reject`, expect
`chat-message-REJECTED-<prompt>`, `chat-message-APPROVED-<prompt>` count `0`, the
`pending` list back to `0`, the `-approve` button gone and `-reject` disabled.

**Test 3 — the suspended run survives a page reload**
4. Click `button-send` and assert the run suspended, exactly as test 1 step 5. Record the
   one pending request's `job_id`, and assert `GET /api/v2/workflows?job_id=<job_id>`
   reports `status: "suspended"`.
5. `page.reload()`, then wait for `title-Human Input` on the canvas. The Playground is
   closed after a reload.
6. Assert the server still holds the **same** run: `pending?flow_id={id}` lists exactly
   **one** request, its `job_id` equals the one recorded in step 4, and the status endpoint
   still reports `suspended` for it.
7. Assert the canvas re-offers the decision: inside the fixture's Human Input node,
   `human-input-node-badge` is visible, and the auto-opened popover's `human-input-card`
   contains the sentinel prompt with `human-input-decision-approve` and `-reject` both
   enabled.
8. Open the Playground (`playground-btn-flow-io`). Assert the transcript (`role="log"`,
   name `Chat messages`) was restored from the server: `chat-message-User-<prompt>` is
   visible, and the transcript's `human-input-card` contains the sentinel prompt with both
   decisions enabled. Neither sender-scoped branch bubble is present: the reload did not
   complete or replay the run.
9. Click the transcript card's `human-input-decision-approve`.
10. Assert `chat-message-APPROVED-<prompt>` becomes visible, and then that
    `chat-message-REJECTED-<prompt>` has count `0`.
11. Assert the run left the suspended state and then **completed**: `pending?flow_id={id}`
    polls to `0`, and `GET /api/v2/workflows?job_id=<job_id>` polls to
    `status: "completed"`. This is the same `job_id`, so the run that finished is the one
    started before the reload.
12. `page.reload()` again, wait for the canvas, and open the Playground. Assert the answered
    card is rendered **resolved** from persisted state. The transcript's `human-input-card`
    is visible, `human-input-decision-reject` has count `0`, and
    `human-input-decision-approve` is **disabled**. `chat-message-APPROVED-<prompt>` is
    still in the transcript, and `chat-message-REJECTED-<prompt>` has count `0`.

**afterEach**
`page.goto("/")` to unmount the editor (it polls `GET /flows/{id}/events`, which 404s once
the flow is gone), then `deleteFlow` for each created id with an explicit Bearer.

---

## Validation criterion

| Test | Criterion |
|---|---|
| `approving a Human Input pause routes only the approved branch` | `human-input-card` visible with both decisions enabled, `pending?flow_id` holding exactly **1** request, and **neither** output bubble present (the pause); after clicking `human-input-decision-approve`, `chat-message-APPROVED-<prompt>` visible, `chat-message-REJECTED-<prompt>` count `0`, `pending?flow_id` back to **0**; `-reject` removed and `-approve` disabled |
| `rejecting a Human Input pause routes only the reject branch` | the mirror: `chat-message-REJECTED-<prompt>` visible, `chat-message-APPROVED-<prompt>` count `0`, `pending?flow_id` back to **0**, `-approve` removed and `-reject` disabled |
| `a suspended Human Input run survives a page reload and completes on approval` | after `page.reload()`: `pending?flow_id` holds exactly **1** request with the **same** `job_id` as before the reload, and its status is still `suspended`; the Human Input node shows `human-input-node-badge`, and its popover card holds the prompt with both decisions enabled; the Playground transcript shows `chat-message-User-<prompt>` and a card with both decisions enabled, with **no** branch bubble. Approving that card gives `chat-message-APPROVED-<prompt>` visible, `-REJECTED-` count `0`, `pending` back to **0** and the original `job_id` at `status: "completed"`. After a second reload, the transcript card has `-reject` count `0` and `-approve` disabled, and the approved bubble is still present |

The titles above are the `test()` titles verbatim. Tests 1–2 do not claim the run
*completes*: they assert only that it **leaves the suspended state**. `pending` lists
suspended jobs, so an empty list proves the answer was accepted and the job resumed, not
that it reached a terminal state. Test 3 does claim completion, and asserts it through the
job status endpoint.

---

## External dependencies

- **Playground** — `playground-btn-flow-io`, `input-chat-playground`, `button-send`,
  `new-chat`, `playground-close-button`. The transcript is the `role="log"` region named
  `Chat messages`. Test 3 uses it to tell the Playground card apart from the canvas card.
- **Decision card** — `human-input-card`, `human-input-decision-<action_id>` (and
  `human-input-field-<name>` for extra fields, unused here), from
  `src/frontend/src/components/core/chatComponents/HumanInputCard.tsx`. `action_id` is the slugified label
  (`_action_id()`: lowercase, spaces → underscores), so the defaults are `approve` and
  `reject`.
- **Canvas pause affordance (test 3)** — `human-input-node-badge` and its non-portaled
  popover reusing `HumanInputCard`, from
  `src/frontend/src/CustomNodes/GenericNode/components/HumanInputNodeBadge/index.tsx`. It
  renders only while the Playground is closed (`useAwaitingHumanInput`) and auto-opens on
  every new `request_id`. Its state comes from
  `src/frontend/src/controllers/API/agui/use-restore-canvas-hitl.ts`, which derives the
  pending card from `GET /api/v2/workflows/pending` (polled every 5 s, LE-1603) so that it
  "survives the live run and the reload alike". The node is scoped through React Flow's
  `rf__node-<node id>` testid.
- **Chat bubbles** — `chat-message-${sender_name}-${text}`
  (`src/frontend/src/modals/IOModal/components/chatView/chatMessage/chat-message.tsx`). The suspend also renders an **empty**
  `chat-message-AI-` bubble. It is **not** the component's return value: the frontend
  synthesizes it in `injectHumanInputCard()`
  (`src/frontend/src/controllers/API/agui/human-input-card.ts` — `text: ""`, `sender: "Machine"`,
  `sender_name: "AI"`, `id: human-input-${request_id}`) purely to carry the card's content
  block, which means it appears on every pause render, including a replayed one. The spec
  ignores it and scopes every assertion to the sender-named bubbles. After a reload the same
  empty `AI` bubble is the **persisted** card message, written with the same
  sender and sender name by `persist_human_input_card()`.
- **Run/resume transport** — the run is `POST /api/v2/workflows` and the answer is
  `POST /api/v2/workflows/{job_id}/resume` (`src/backend/base/langflow/api/v2/workflow.py` → `resume_workflow`, with
  helpers in `src/backend/base/langflow/api/v2/hitl.py`: 422 when the `action_id` is outside `allowed_decisions`, 409
  on a stale `request_id`). Neither is asserted directly — the user path is the card click,
  and pinning the transport would couple this spec to a mechanism that moved once already
  (v1 build → v2 workflows).
- **Card persistence (test 3)** — `persist_human_input_card()` and `mark_card_answered()`
  in `src/backend/base/langflow/api/v2/hitl.py`. The first stores the pause as a chat
  message whose content block carries `request_id` and `job_id`. The second stamps the
  chosen action on that message in place on resume, "so a reloaded session renders it as
  resolved instead of re-offering the decision" (module docstring). Test 3 observes both
  only through the UI after a reload.
- **`GET /api/v2/workflows/pending?flow_id=`** (`src/backend/base/langflow/api/v2/workflow.py` →
  `list_pending_workflows`) — this one **is** asserted, as the server-side oracle for the
  pause and for the resume. It is flow-scoped by construction (422 without `flow_id`), so it
  can never observe another spec's run. Test 3 also reads each row's `job_id`.
- **`GET /api/v2/workflows?job_id=`** (`src/backend/base/langflow/api/v2/workflow.py` →
  `get_workflow_status`) — asserted in test 3 only, as the terminal-state oracle:
  `status: "suspended"` while the run is parked, `status: "completed"` once the resumed run
  finishes. Only `status` is read. The response's `outputs` map is deliberately not
  asserted: the UI bubbles already pin routing, and `outputs` has regressed to `{}` on a
  sibling path before (#1575). Also exercised by `api/flows/workflows-v2-job-lifecycle.spec.ts`.
- **Helpers** — `helpers/flows/create-flow.ts`, `helpers/flows/delete-flow.ts`,
  `helpers/auth/get-auth-token.ts`, `helpers/ui/adjust-screen-view.ts`,
  `helpers/flows/unmount-editor-for-cleanup.ts`.

---

## What this test does not cover

- **`Enable Fallback` + `Timeout`** — the advanced pair that adds a `fallback` branch and
  reroutes a late answer to it. Needs a clock-dependent setup; a candidate of its own.
- **Custom choices at run time** — the card renders one button per configured choice, but
  editing choices is #1190's surface; this spec runs the defaults.
- **Answering from the canvas popover.** Test 3 asserts that the canvas re-offers the
  decision after a reload, but it approves from the Playground. The canvas card reuses the
  same self-resuming `HumanInputCard`, so its resume is a separate claim.
- **Reject after a reload.** Exclusive routing is tests 1–2's claim. Test 3 approves only,
  and asserts the reject branch stays silent as a by-product.
- **Recovery in a fresh browser context, after a backend restart, or across users.** A fresh
  context was measured to recover identically and is not asserted. A backend restart while
  suspended is a different durability claim: the job store must outlive the *process*, not
  just the tab. Cross-user visibility of a pending run belongs to the serving-identity lane.
- **A reload while the resumed run is still in flight.** On this flow the resume completes
  in ~1 s, so there is no window to reload into.
- **Tests 1–2 reaching a terminal state.** Both prove only that the run *left* the suspended
  state (`pending` → `0`). There is no cheap UI signal for completion on this path:
  `button-stop` never renders at any point in this flow (measured before send, at the pause,
  at the routed bubble and +4 s after). Test 3 closes that gap for its own run through
  `GET /api/v2/workflows?job_id=`.
- **The stale/duplicate answer guards** — resume answering twice (409) or with a
  disallowed `action_id` (422) are API-level contracts, better covered under `api/`.
- **Multiple sequential pauses** in one run, and an Agent's own tool-approval pause
  interacting with a Human Input pause.

---

## Reading a red in test 3 — rule out #1921 first

#1921 (open) records the VM lane failing a **different** resume path. On the VM, the
approved `send_to_agent` tool call of `a2a-client-agent-as-tool` never completes after
approval (9/9 attempts), while Actions passes it. That path is an Agent's tool-approval
pause in A2A Internal mode. Test 3 has no Agent, no A2A, and no provider. On the same VM
runs, tests 1–2 of this file pass.

The file is laid out so that a red in test 3 carries its own control. Tests 1–2 run the
identical pause and resume **without** a reload, in the same file, so they share test 3's
shard and instance. Read a red in this order before calling it a durability defect:

1. **The failing step is before the reload** (send, pause): the failure is not about
   durability, and tests 1–2 will normally be red at the same step.
2. **Tests 1–2 are red at the resume step in the same run**: the resume path is broken in
   general, and that is the #1921 class if it reproduces only on the VM. A reload is not
   the cause.
3. **Only test 3 is red, at step 6–8 or step 12, with tests 1–2 green**: this is the
   durability claim failing. The failing step names the store that lost the state, per the
   table above. Steps 6 and 7 point at the job store, step 8 at the persisted card message,
   and step 12 at the `submitted_action` stamp.

---

## Notes

- Measured on `1.12.0.dev10`: the pause appears **~1 s** after send and the routed bubble
  **~1 s** after the decision, so the per-assertion budgets are generous rather than tight
  (30 s for the card, 30 s for the routed bubble — a saturated CI backend is the case they
  exist for).
- Measured on `1.13.0.dev29` (test 3): the canvas badge and popover render **~2 s** after
  the reload. The Playground transcript card renders within **~3 s** of opening the
  Playground. The job status read `completed` on the **first** poll after the approved
  bubble. The pending list carries one row per suspended job, keyed by `job_id`, with
  `request_id` = `<Human Input node id>:<job_id>`.
- The absent-branch assertion is a `toHaveCount(0)` on a **sender-scoped** testid, so it
  cannot pass vacuously on a page where nothing rendered at all: the positive assertion for
  the chosen branch runs first and would fail in that case. In test 3's step 8, the positive
  assertions are the user bubble and the transcript card, both from the same message query.
- Sibling references: `core-components/human-input-node-config.spec.ts` (the config half,
  #1190) and the fixture-driven pattern in
  `core-functionality/knowledge-ingestion-management/split-text-chunking.spec.ts`.
