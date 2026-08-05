# Spec: Human Input pause/resume in the Playground (HITL decision card)

**Test file:** `tests/tests-automations/regression/core-functionality/playground/human-input-pause-resume.spec.ts`

**Last validated:** Langflow 1.12.x (built and measured on `1.12.0.dev10`)

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

## Tags

`@stable` `@release` `@playground`

`@release` is claimed here and deliberately **not** on the sibling config spec (#1190):
this is the execution happy path of 1.11's flagship feature — if it breaks, a HITL flow
cannot be answered at all. (Measured, since an earlier draft of this doc overstated it:
exactly **one** other playground spec carries this exact set — `playground-shareable-url` —
while 11 of 23 carry `@release` alongside further tags.)
`@regression` is absent: first-time coverage of a new feature, not a previously fixed bug.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (built and measured on the nightly,
  `1.12.0.dev10`).
- **No provider credentials**, no `models.json`, no `collect-models`.
- Fixture flow `tests/assets/flows/human-input-branching-fixture.json` — Chat Input
  (`input_value` = the sentinel prompt) → Human Input (default `Approve`/`Reject`) →
  `Approved Output` / `Rejected Output`. Built by wiring it in the UI on a live nightly and
  exporting the result through `GET /api/v1/flows/{id}`, because a hand-written flow JSON
  renders empty (nodes need `type: "genericNode"` plus their full template) and an edge
  only attaches when its `sourceHandle` string matches the handle's own `data-handleid`
  verbatim (`{œdataTypeœ:œHumanInputœ,œidœ:…,œnameœ:œbranch_approveœ,…}`).
- The file is **parallel-safe** and deliberately not serial. Each test owns its flow (unique
  `${Date.now()}-${random}` name, so the backend's unique-name suffixing has nothing to
  race) and its own page, and a suspended run is flow-scoped, so the two cannot observe each
  other. The sibling fixture specs use `mode: "serial"` for that name race; inheriting it
  here would cost signal, because a flake in the first test **skips** the second and one bad
  day in the daily would lose the Reject verdict. Measured green at `--workers=2` (and
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

**afterEach**
`page.goto("/")` to unmount the editor (it polls `GET /flows/{id}/events`, which 404s once
the flow is gone), then `deleteFlow` for each created id with an explicit Bearer.

---

## Validation criterion

| Test | Criterion |
|---|---|
| `approving a Human Input pause routes only the approved branch` | `human-input-card` visible with both decisions enabled, `pending?flow_id` holding exactly **1** request, and **neither** output bubble present (the pause); after clicking `human-input-decision-approve`, `chat-message-APPROVED-<prompt>` visible, `chat-message-REJECTED-<prompt>` count `0`, `pending?flow_id` back to **0**; `-reject` removed and `-approve` disabled |
| `rejecting a Human Input pause routes only the reject branch` | the mirror: `chat-message-REJECTED-<prompt>` visible, `chat-message-APPROVED-<prompt>` count `0`, `pending?flow_id` back to **0**, `-approve` removed and `-reject` disabled |

The titles above are the `test()` titles verbatim, and neither claims the run *completes*:
what is asserted is that it **leaves the suspended state**. `pending` lists suspended jobs,
so an empty list proves the answer was accepted and the job resumed — not that it reached a
terminal state.

---

## External dependencies

- **Playground** — `playground-btn-flow-io`, `input-chat-playground`, `button-send`,
  `new-chat`, `playground-close-button`.
- **Decision card** — `human-input-card`, `human-input-decision-<action_id>` (and
  `human-input-field-<name>` for extra fields, unused here), from
  `components/core/chatComponents/HumanInputCard.tsx`. `action_id` is the slugified label
  (`_action_id()`: lowercase, spaces → underscores), so the defaults are `approve` and
  `reject`.
- **Chat bubbles** — `chat-message-${sender_name}-${text}`
  (`modals/IOModal/.../chat-message.tsx`). The suspend also renders an **empty**
  `chat-message-AI-` bubble. It is **not** the component's return value: the frontend
  synthesizes it in `injectHumanInputCard()`
  (`controllers/API/agui/human-input-card.ts` — `text: ""`, `sender: "Machine"`,
  `sender_name: "AI"`, `id: human-input-${request_id}`) purely to carry the card's content
  block, which means it appears on every pause render, including a replayed one. The spec
  ignores it and scopes every assertion to the sender-named bubbles.
- **Run/resume transport** — the run is `POST /api/v2/workflows` and the answer is
  `POST /api/v2/workflows/{job_id}/resume` (`api/v2/workflow.py` → `resume_workflow`, with
  helpers in `api/v2/hitl.py`: 422 when the `action_id` is outside `allowed_decisions`, 409
  on a stale `request_id`). Neither is asserted directly — the user path is the card click,
  and pinning the transport would couple this spec to a mechanism that moved once already
  (v1 build → v2 workflows).
- **`GET /api/v2/workflows/pending?flow_id=`** (`api/v2/workflow.py` →
  `list_pending_workflows`) — this one **is** asserted, as the server-side oracle for the
  pause and for the resume. It is flow-scoped by construction (422 without `flow_id`), so it
  can never observe another spec's run.
- **Helpers** — `helpers/flows/create-flow.ts`, `helpers/flows/delete-flow.ts`,
  `helpers/auth/get-auth-token.ts`, `helpers/ui/adjust-screen-view.ts`.

---

## What this test does not cover

- **`Enable Fallback` + `Timeout`** — the advanced pair that adds a `fallback` branch and
  reroutes a late answer to it. Needs a clock-dependent setup; a candidate of its own.
- **Custom choices at run time** — the card renders one button per configured choice, but
  editing choices is #1190's surface; this spec runs the defaults.
- **Recovering a suspended run after a reload** — durable execution outliving the tab is a
  distinct behaviour, and this spec's use of `pending?flow_id=` does **not** cover it: it
  reads the suspended state, it never reloads the page and reattaches to it. Tracked as its
  own `[ ]` bullet under §9.6 so the checklist does not imply otherwise. **The word
  "durably" was removed from that bullet for the same reason** — nothing here proves it.
- **The run reaching a terminal state.** The spec proves the run *left* the suspended state
  (`pending` → `0`), not that it finished: `pending` lists suspended jobs only. There is no
  cheap UI signal for completion on this path — `button-stop` never renders at any point in
  this flow (measured before send, at the pause, at the routed bubble and +4 s after).
- **The stale/duplicate answer guards** — resume answering twice (409) or with a
  disallowed `action_id` (422) are API-level contracts, better covered under `api/`.
- **Multiple sequential pauses** in one run, and an Agent's own tool-approval pause
  interacting with a Human Input pause.

---

## Notes

- Measured on `1.12.0.dev10`: the pause appears **~1 s** after send and the routed bubble
  **~1 s** after the decision, so the per-assertion budgets are generous rather than tight
  (30 s for the card, 30 s for the routed bubble — a saturated CI backend is the case they
  exist for).
- The absent-branch assertion is a `toHaveCount(0)` on a **sender-scoped** testid, so it
  cannot pass vacuously on a page where nothing rendered at all: the positive assertion for
  the chosen branch runs first and would fail in that case.
- Sibling references: `core-components/human-input-node-config.spec.ts` (the config half,
  #1190) and the fixture-driven pattern in
  `core-functionality/knowledge-ingestion-management/split-text-chunking.spec.ts`.
