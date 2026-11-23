# A2A Server — Human Input pause and resume over JSON-RPC

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev35`)

**Issue:** #2549 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T8**, added by
#2549) · **Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 /
PR #1243 (`requireA2aEnabled()`, `postA2AJsonRpc`, `messageSendEnvelope`) ·
**Jira:** epic `LE-1588`

---

## What this test validates *(required)*

A published A2A agent whose flow contains a **Human Input** node does not finish in
one call. `message/send` parks the run and answers with a task in state
`input-required`. The caller answers the node with a second `message/send` on the
**same** task (`taskId` + `contextId`), and the run resumes on the branch that answer
picks. This has been part of the A2A server since langflow-ai/langflow#13831 (1.11):
`FlowAgentExecutor._execute` treats a follow-up message on an `input-required` task
as a resume, and `_resume_flow` / `_resolve_action` / `_prepare_a2a_resume_checkpoint`
in `src/backend/base/langflow/api/v1/a2a.py` restore the parked graph, match the
answer against the offered choices and re-admit the caller.

This path has its own store (`A2ACheckpointStore`, keyed by the task id) and its own
admission, separate from the Playground path that
`playground/human-input-pause-resume.spec.ts` covers (v2 workflows). That spec cannot
fail on any of the four properties below:

- **The answer routes exactly one branch.** The run completes on the chosen branch,
  and the other branch's output neither reaches the caller nor is stored. Approve and
  Reject are mirrored for the same reason as in the Playground spec: a spec that only
  ever approves cannot tell exclusive routing from "the approve branch is the only one
  wired".
- **An answer the node does not offer re-parks the task, and does not burn it.**
  `_resume_flow` returns the suspended response again instead of taking an empty
  branch, so the caller can answer again.
- **A second Human Input pauses the same task again.** The resumed graph raises
  `GraphPausedException` at the next node, which saves a new checkpoint under the same
  task id. The task goes back to `input-required` instead of completing.
- **A paused task belongs to the principal that started it.** The task store is keyed
  by the admitted principal (`_task_scope`), and the resume re-checks it
  (`_require_admitted_a2a_principal`, plus `checkpoint.user_id`). A task parked by an
  anonymous caller on a public agent is invisible to the owner's API key once the flow
  is restricted. A task parked by the owner is invisible to an anonymous caller once
  the flow is public. In both cases the pause survives the attempt and completes
  under its own principal later.

---

## Tags *(required)*

`@stable` `@api` `@a2a`

- `@api` — drives `/api/v1/a2a/{id}/jsonrpc` and `/api/v1/monitor/messages` through
  `request`; no UI.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — shipped with the spec (#2549) after `--retries=0` bursts on nightly
  `1.14.0.dev35`: **40/40** with one worker, **39/40** with two (the PR lane's
  parallelism) and **20/20** with four. The one failure, and the failing runs of a
  second four-worker burst, were 20 s client timeouts inside backend stalls of 16–25 s
  with no log line. A control burst of four sibling `@stable` A2A specs saw a 16 s
  stall too, on the same host at the same time (see *Measured behaviour*). Each test
  was force-failed by a mutation of its own (routing swapped, an offered answer where
  an unoffered one belongs, an extra `reject-branch` row, the exact terminal code, the
  second node offering `Approve`, the visible task probed where the invisible one
  belongs, the policy never changed).

---

## Validation criterion *(required)*

Every JSON-RPC call answers **HTTP 200**, errors included (the contract #1243 pinned).
The sentinel is per run, so no assertion can be satisfied by a previous run's data.

1. **Pause.** `message/send` with the sentinel → `result.status.state ===
   "input-required"`; the status message's only text part is the sentinel (the node's
   prompt, wired from Chat Input); no artifact. `tasks/get` on that id reads the same
   task, still `input-required`.
2. **Re-park.** Replying `maybe` (same `taskId` + `contextId`) → the same task id,
   still `input-required`, still no artifact.
3. **Resume on Approve.** Replying `Approve` (the label) → the same task id,
   `completed`, exactly one artifact whose only text part is
   `<sentinel> | APPROVED`. `GET /api/v1/monitor/messages?flow_id=` holds exactly
   one `Machine` row, with `sender_name === "approve-branch"` and that text, and
   **no** row from `reject-branch`.
4. **Terminal.** A further reply on the completed task → `error.code === -32004`
   (the task is in a terminal state), and `tasks/get` still reads `completed` with
   the same artifact.
5. **Resume on Reject (mirror).** On a fresh task, replying `reject` (the action
   id, not the label) → `completed` with `<sentinel> | REJECTED`. The monitor holds
   exactly one `Machine` row, from `reject-branch`, and none from `approve-branch`.
6. **Second pause.** With a second Human Input in series behind the approve branch,
   offering `Ship` / `Hold`: `Approve` → `input-required` again. `Approve` once more
   → still `input-required` (the second node does not offer it, which proves the
   second node holds the task). `Ship` → `completed` with `<sentinel> | SHIPPED`.
7. **Principal boundary.** One flow, two tasks, moved between a public project and an
   `apikey` project:
   - task **A** paused anonymously while public; task **B** paused with the owner's
     key while restricted;
   - while restricted: no key → `401`; with the key, A answers `-32001` on both
     `tasks/get` and a reply, while B reads `input-required`;
   - while public: B answers `-32001` on both, while A reads `input-required`, and
     `Approve` completes A with `<A> | APPROVED`;
   - restricted again: `Approve` with the key completes B with `<B> | APPROVED`.

   Each state has a task that is visible, so a blanket `-32001` cannot pass. Each
   state also has one that is not, so a task visible to every caller cannot pass
   either.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every lane since #1240; asserted at runtime
  by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network.** The graph is built from stock
  components of the live catalog (`createCatalogFlow`): Chat Input → Human Input →
  Combine Text per branch → Chat Output per branch. Human Input and Combine Text are
  core families (`src/lfx/src/lfx/components/flow_controls/human_input.py`,
  `src/lfx/src/lfx/components/processing/combine_text.py`), not vendor bundles.
- **The A2A executor** — `src/backend/base/langflow/api/v1/a2a_executor.py` decides
  that a message on an `input-required` task is a resume, and what the `input-required`
  status message carries.
- **A public project** (`auth_settings.auth_type = "none"`, explicit — since
  `1.14.0.dev23` every new project defaults to `apikey` under `AUTO_LOGIN=true`,
  #2412) for tests 1–3 and the public half of test 4.
- **An `apikey` project and an API key** (test 4 only), sent as `x-api-key`.
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- Every flow, project and API key is created by the test and deleted **by id** in
  `finally`, flow before project. No pre-test wipe.
- Every task a test parks is answered before the test ends. A never-answered task
  keeps its checkpoint row, and nothing reaps it on this path yet (the `_resume_flow`
  docstring).

---

## Step by step *(required)*

The flow in every test: `ChatInput-hitl` (`message`) → `HumanInput-hitl` (`prompt`).
Its `branch_approve` / `branch_reject` go to `CombineText-approve` /
`CombineText-reject` (`text1`; `text2` = `APPROVED` / `REJECTED`, `delimiter` =
` | `), and from there to `ChatOutput-approve` / `ChatOutput-reject`
(`sender_name` = `approve-branch` / `reject-branch`). The flow is created already in
its project and already published, in one `POST /api/v1/flows/` carrying
`{ folder_id, flow_type: "agent", a2a_enabled: true }`, then read back with
`GET /api/v1/flows/{id}` to assert all three were stored.

**Test 1 — `a paused task resumes on the approved branch only`**
1. `requireA2aEnabled`; create a public project; create and publish the flow there.
2. `message/send` (sentinel) → criterion 1; `tasks/get` → still `input-required`.
3. Reply `maybe` → criterion 2.
4. Reply `Approve` → criterion 3 (envelope), then the monitor read.
5. Reply `Reject` → criterion 4; `tasks/get` → still `completed`, same artifact.
6. `finally`: delete the flow, then the project.

**Test 2 — `a paused task resumes on the rejected branch only`**
1. As test 1, step 1.
2. `message/send` (sentinel) → `input-required`.
3. Reply `reject` → criterion 5 (envelope, then the monitor read).
4. `finally`: as test 1.

**Test 3 — `a second Human Input pauses the same task again`**
1. As test 1, step 1, with `HumanInput-second` (`decisions` = `Ship` / `Hold`, its
   outputs renamed `branch_ship` / `branch_hold`) between `branch_approve` and
   `CombineText-approve`, and `text2` = `SHIPPED`.
2. `message/send` → `input-required`; reply `Approve` → `input-required`, same id.
3. Reply `Approve` → still `input-required`.
4. Reply `Ship` → `completed`, `<sentinel> | SHIPPED`.
5. `finally`: as test 1.

**Test 4 — `a paused task can only be resumed by the principal that started it`**
1. `requireA2aEnabled`; create a public project, an `apikey` project and an API key;
   create the flow and publish it in the public project.
2. `message/send` (sentinel A, no key) → task A `input-required`.
3. Move the flow to the `apikey` project. With no key, a reply on A → `401`. With
   the key, `tasks/get` A and a reply on A → `-32001`. `message/send` (sentinel B,
   with the key) → task B `input-required`.
4. Move the flow back to the public project. With no key, `tasks/get` B and a reply
   on B → `-32001`. `tasks/get` A → `input-required`. Reply `Approve` on A →
   `completed`, `<A> | APPROVED`.
5. Move the flow to the `apikey` project. With the key, reply `Approve` on B →
   `completed`, `<B> | APPROVED`.
6. `finally`: delete the flow, the API key, then both projects.

Every move asserts the stored `folder_id`, because a move that silently no-ops
leaves the policy unchanged and makes step 3 or 4 vacuous.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | approved branch | `input-required` with the sentinel as prompt; `maybe` re-parks the same task; `Approve` → `completed`, one artifact `<s> \| APPROVED`; one `Machine` row from `approve-branch`, none from `reject-branch`; a later reply is `-32004` and leaves the task `completed` |
| 2 | rejected branch | `reject` → `completed`, `<s> \| REJECTED`; one `Machine` row from `reject-branch`, none from `approve-branch` |
| 3 | second pause | `Approve` → `input-required`; `Approve` again → still `input-required`; `Ship` → `completed`, `<s> \| SHIPPED` |
| 4 | principal boundary | restricted: no key `401`, A `-32001` with the key, B `input-required`; public: B `-32001`, A `input-required` then completes; restricted again: B completes |

---

## Measured behaviour worth knowing *(scout, `1.14.0.dev35`)*

- **The caller is told the prompt, not the choices.** The `input-required` status
  message carries one text part, the Human Input prompt. The offered actions (`options`,
  `allowed_decisions`) stay server-side, so an A2A client has to know the labels in
  advance. A reply the node does not offer gets the same `input-required` answer back
  with no indication that it was refused. Recorded, not asserted: it is the current
  design, and no issue tracks it.
- **Labels and action ids both resume.** `_resolve_action` first matches the reply
  against `allowed_decisions` after lowercasing and turning spaces into `_`, then
  against the option labels case-insensitively, so by the code any casing of a label
  takes the same branch. Measured: the label `Approve` and the action id `reject`.
  Tests 1 and 2 use one of each form.
- **Replies are not stored as chat messages.** After a pause, a `maybe` and an
  `Approve`, the monitor holds two rows for the session: the `User` sentinel and the
  chosen branch's `Machine` output. The session is the composite
  `<uuid>:<contextId>`, the same one `a2a-server-multi-turn-context` asserts.
- **A non-chosen branch is stopped, not emptied.** `route_branch` calls
  `self.stop("branch_<id>")` on every other action, so the other Combine Text and
  Chat Output never build. That is why the artifact has one part, and not one empty
  part per Chat Output (`_answer_parts` skips a `None` content).
- **Moving the flow is how the policy changes mid-pause.** The auth type belongs to
  the project. Flipping the shared default project would change the auth of every
  flow of the superuser under parallel specs (#1010), so the test moves its own flow
  between two projects of its own.
- **A key sent to a public agent is ignored.** In the public state, a reply on B
  carrying the owner's key also answers `-32001`. The public path admits the
  anonymous principal whatever the headers carry. Measured, not asserted (the test
  sends no key there).

- **One `POST` instead of create + publish `PATCH`.** The first version created the
  flow and then moved and published it with a `PATCH`. With four of these tests in
  parallel on SQLite, that `PATCH` answered `503 "The database is busy. Please retry
  the request."` in 2 of 20 runs, twice. The server had already retried it 8 times
  (`run_with_lock_retry`, `src/backend/base/langflow/services/database/lock_retry.py`).
  Creating the flow published removes that write, and `createFlow` retries a 5xx.
  Test 4's moves are its subject, so they stay `PATCH`es.
- **Backend stalls on the local host are environmental.** During the four-worker and
  two-worker bursts, the server went 16–25 s without a single log line, and requests
  in flight timed out at 20 s (`DELETE` of a flow or project, `POST` of a flow, a move
  `PATCH`). A control burst of `a2a-server-tasks-lifecycle`, `-multi-turn-context`,
  `-auth-apikey` and `-discovery` saw a 16 s stall in the same window and passed only
  because none of its calls crossed 20 s. The host was a Colima VM with 6 CPUs running
  five other Langflow containers, at a load average of 13–16. The A2A SDK's
  `Task was destroyed but it is pending` (`EventQueueSource._dispatch`) and OpenTelemetry's
  `Failed to detach context` errors in the server log are not related: they appear 64
  times over the session, in isolated runs as well.

### Out of scope

- The Human Input `timeout` / fallback reroute (`reroute_decision_on_timeout`). Its
  smallest unit is minutes, so the timeout cannot elapse within a test.
- A pause over `message/stream`. Streaming errors still collapse to `-32603`
  (`a2a-server-tasks-lifecycle.md`), and the pause itself is the same executor branch
  `message/send` takes.
- Two workers racing one resume (`claim_by_run_id`). The lanes run
  `LANGFLOW_WORKERS=1` (#922/#927).
