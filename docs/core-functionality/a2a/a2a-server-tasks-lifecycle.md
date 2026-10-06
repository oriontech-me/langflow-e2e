# A2A Server — task lifecycle: read back, cancel, and fail closed

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev34`)

**Issue:** #1247 (Test 3 redesigned by #2196) · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T6**) ·
**Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 / PR #1243
(`requireA2aEnabled()`, `postA2AJsonRpc`, `messageSendEnvelope`) ·
**Jira:** epic `LE-1588`

---

## What this test validates *(required)*

`message/send` is only half of the task surface. A caller that lost the connection
has to **read the task back**; a caller that changed its mind has to **cancel** it;
and a caller asking about a task that is not theirs must be told *nothing*. This
spec covers those three, plus the error contract they answer with.

The error codes are the point. The product ships a shim —
`_SpecErrorAdapter` in `langflow/api/v1/a2a.py` — whose entire job is to stop the
SDK's catch-all from wrapping every failure in `InternalError` (**-32603**), which
would make *"no such task"* indistinguishable from *"the agent broke"*. It maps
`TaskNotFoundError` → **-32001**, `TaskNotCancelableError` → **-32002**,
`UnsupportedOperationError` → **-32004**, `InvalidParamsError` → **-32602**. **That
shim is the regression surface this spec exists to guard**: a test that accepted
"an error" would stay green the day it breaks and a conforming client starts
receiving -32603 for everything.

Two behaviours are safety properties rather than conveniences:

- **Cancelling a finished task is refused (-32002), not absorbed.** The handler
  explicitly declines to clobber a real `COMPLETED` with `CANCELED` — so the spec
  asserts both the refusal *and* that the stored state is unchanged afterwards.
- **Task ids do not leak across flows.** The in-memory registry is keyed by task id
  alone, so the handler gates on a flow-scoped store first and returns
  *"not found"* for a task belonging to another flow — the code comments that it
  must "never reveal that it exists under another flow". Asserting **-32001** (and
  not -32002) through a second flow's endpoint is what pins that.

---

## Tags *(required)*

`@stable` `@api` `@regression` `@a2a`

- `@api` — drives `/api/v1/a2a/{id}/jsonrpc` through `request`; no UI.
- `@regression` — the spec-code mapping is a **fix** that can regress to -32603,
  and the cross-flow gate is a leak that was closed deliberately.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — validated by the team and promoted in #1349: the batch ran
  **51/51 green** (17 tests × 3, `--retries=0`) on nightly `1.12.0.dev18`,
  with no leaked flow and no backend error logged. The daily removed it from
  Test 3 on 2026-10-06 (#2196 — the test raced the run it was cancelling, see
  *Measured behaviour*); the redesign restored it.

---

## Validation criterion *(required)*

All four over **HTTP 200** — JSON-RPC errors are not HTTP errors on this endpoint
(the contract #1243 pinned for -32601/-32600):

1. **Read-back.** `tasks/get` on the id `message/send` returned gives the *same*
   task: same `id`, same `contextId`, same `artifacts[0].artifactId`, the same
   `status.timestamp`, state `completed`, and the sentinel still at
   `artifacts[0].parts[0].text`. Identity of the artifact id and timestamp is what
   distinguishes a read-back from a silent re-run.
2. **Unknown id.** `tasks/get` for a random UUID → `error.code === -32001`,
   `error.message === "Task not found"`.
3. **Terminal cancel is refused, and harmless.** `tasks/cancel` on the completed
   task → `error.code === -32002` (`"Task cannot be canceled"`), and a following
   `tasks/get` still reports `completed` with the **same** `status.timestamp` — the
   refusal did not touch stored state.
4. **Cross-flow isolation.** The same task id, cancelled through a **second**
   published flow's endpoint → `error.code === -32001`, never -32002 or -32004:
   flow B must not be able to tell that the task exists at all.

And the live path:

5. **Cancelling a running task terminates it.** A `message/stream` run whose flow
   **waits** 10 s inside a node is cancelled while it is provably in flight:
   - **precondition** — a `tasks/get` sent right before the cancel reads `working`,
     so the cancel targets a live task (it does not replace the wait: see
     *Measured behaviour*);
   - the `tasks/cancel` response carries `result.status.state === "canceled"`;
   - the open stream then **ends**, its last status frame is `canceled`, and no
     frame ever carries `completed` or an artifact — the subscriber saw the run
     stop, not finish;
   - a subsequent `tasks/get` reads back `canceled`.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240; asserted at
  runtime by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network.** Tests 1–2 use the Chat Input →
  Chat Output passthrough (`createRunnableChatFlowViaApi()`).
- **`LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`** (Test 3 only) — its flow is Chat Input
  → a `CustomComponent` that sleeps 10 s → Chat Output, built from the live catalog.
  Every lane sets the flag (`scripts/start-langflow-docker.sh`, `daily-stable.yml`,
  `manual.yml`, `scripts/run-e2e.sh`); with it off the catalog omits
  `CustomComponent` and the builder throws naming the cause.
- **An API-key project** (Test 3 only) — a project created with
  `auth_settings.auth_type = "apikey"` plus a fresh API key sent as `x-api-key`. The
  public (`auth_type: none`) path cannot run this flow; see *Measured behaviour*.
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- The cross-flow test needs **two** published flows; both are created by the test
  and deleted **by id** in `finally`. **No pre-test wipe.**
- The cancel test creates one flow, one project and one API key, and deletes all
  three **by id** in `finally`.

---

## Step by step *(required)*

**Test 1 — `a task can be read back and refuses a cancel it cannot honour`**
1. `requireA2aEnabled`; create + publish flow A.
2. `message/send` with a per-run sentinel → capture `taskId`, `contextId`,
   `artifacts[0].artifactId`, `status.timestamp`.
3. `tasks/get` → assert every field of criterion 1.
4. `tasks/get` with a random UUID → `-32001`.
5. `tasks/cancel` on `taskId` → `-32002`; then `tasks/get` again → still
   `completed`, same `status.timestamp`.
6. `finally`: delete the flow by id.

**Test 2 — `a task id is invisible to another flow`**
1. `requireA2aEnabled`; create + publish flows A **and** B.
2. `message/send` on A → `taskId`.
3. `tasks/cancel` `{ id: taskId }` posted to **B's** endpoint → `-32001`.
4. Positive control in the same test: `tasks/get` on **A** still returns the task
   `completed` — so a blanket "everything is -32001" bug cannot pass this.
5. `finally`: delete both flows by id.

**Test 3 — `cancelling a running task moves it to canceled`**
1. `requireA2aEnabled`; create a project with `auth_type: "apikey"` and an API key;
   create the Chat Input → *sleep 10 s* → Chat Output flow, move it into that project
   and publish it.
2. `POST message/stream` with `x-api-key`; read the SSE stream only until the first
   frame carrying `result.id`.
3. `tasks/get` that id → `working` (the precondition of criterion 5).
4. `tasks/cancel` that id → `result.status.state === "canceled"`.
5. Read the rest of the stream to its end → last status `canceled`, no `completed`,
   no artifact.
6. `tasks/get` → `canceled`.
7. `finally`: close the stream; delete the flow, the API key and the project by id.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | read back + refused cancel | identical `id`/`contextId`/`artifactId`/`timestamp` + sentinel; unknown id `-32001`; terminal cancel `-32002`; state and timestamp unchanged after |
| 2 | cross-flow isolation | `-32001` through flow B (not `-32002`/`-32004`), while flow A still reads the task `completed` |
| 3 | live cancel | `tasks/get` reads `working` before the cancel; `tasks/cancel` returns `state: "canceled"`; the stream ends on `canceled` with no `completed`/artifact frame; `tasks/get` confirms `canceled` |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- **The exact wire values**, measured, not inferred:
  `{"code":-32001,"message":"Task not found","data":null}` and
  `{"code":-32002,"message":"Task cannot be canceled","data":null}`, both under
  `HTTP 200`.
- **#2196 — the 2 MB "margin" never existed, and the redesign is why Test 3 is a
  wait rather than a payload.** The first version made the run long by sending
  ~2 MB of filler and assumed that bought a ~2.4 s window. It did not: the run was
  long because it was **CPU-bound**, and the cancel request contends with it on the
  same worker. Measured on `1.13.0.dev34`, a `tasks/get` sent mid-run took ~700 ms to
  answer, and the window a cancel actually had was the ~100 ms before the run's
  first CPU-heavy stretch. A cancel delayed by one in-flight request was refused
  (`-32002`, task `completed`) in **6 of 11** runs on a native install that
  resolves dependencies freely (as the VM lane does) with `a2a-sdk` 1.2.2, and in
  **0 of 6** with only the SDK swapped back to 1.2.1. On the image (lock: 1.1.2) it
  was 0 of 12, and still 0 of 4 with the image's SDK patched to 1.2.2 — so the
  outcome moves with the SDK *and* the environment together, which is what a race
  looks like rather than a regression. The VM lane picked up 1.2.2 with
  `1.13.0.dev34` and went **3/3 red** on 2026-10-06; the unmodified spec, which
  cancels the instant the id arrives, did not fail locally in any configuration
  (10/10 on the native 1.2.2 install), so the VM's exact timing is not reproduced
  here — the mechanism is. The dev33→dev34 diff touches nothing on the A2A path,
  and a refused cancel was the correct answer each time: served after the run
  finished, it is refused and leaves `completed` untouched, as criterion 3
  requires.
- **One delayed cancel contradicted the store, once.** On the image (`a2a-sdk`
  1.1.2), 1 of 12 cancels sent mid-run behind a `tasks/get` answered `canceled`
  while the `tasks/get` right after it read `completed`. It did not recur in the
  other 11, nor in 21 runs on 1.2.x. It lives in the cancel-vs-completion race this
  redesign deliberately avoids, so no test here can see it; it is recorded so a
  later report of the same shape has a first data point.
- **A wait keeps the window open on any machine.** The 10 s node does not use the
  CPU, so the run stays `working` for 10 s while the cancel is served in
  ~100–500 ms, and a faster machine does not shrink the margin. Measured: during
  the sleep `/api/v1/version` answers in ~3–15 ms — the node's `time.sleep` runs
  off the event loop — and the cancel was answered 96–515 ms into the run,
  `canceled` every time, on `a2a-sdk` 1.1.2 (image) and 1.2.2 (native).
- **The stream ends on cancel.** Measured: within 1–4 ms of the cancel response the
  stream closes, having carried `submitted → working → canceled → canceled` and
  nothing else. Left alone — force-failed by never sending the cancel — the same
  stream runs ~10 s and ends `submitted → working → artifact-update → completed`,
  which is what step 5 catches.
- **A short run reproduces the VM symptom exactly.** Force-failed with the node
  sleeping 0 s, the precondition still read `working`, the run ended in the
  milliseconds before the cancel, and the cancel answered
  `-32002 "Task cannot be canceled"` — the 2026-10-06 error, verbatim. The `working`
  read proves the cancel targets a live task; only the wait makes it still live
  when the cancel lands.
- **Why Test 3 runs behind an API key.** A public agent (`auth_type: none`) runs
  under the public code policy, which replaces a `CustomComponent`'s code with the
  server's stock copy: measured, the sleeping flow answered
  `{"value": "Hello, World!"}` in ~20 ms. The API-key path runs the flow's own code.
  Cancellation goes through the same handler on both paths — only admission and
  the task's owner scope differ — and Tests 1–2 keep covering the public path.
- **Not-reading the SSE stream does not park the task.** Measured: leaving the
  stream unconsumed for 3 s still ends in `completed`, then `-32002` — so
  backpressure is not a way to widen the window.
- **Streaming errors still collapse to -32603**, stated in the product's own
  docstring ("fixing that means reimplementing that generator, tracked
  separately"). So no spec code is asserted on a `message/stream` /
  `tasks/resubscribe` **error** frame — only on the non-streaming `tasks/*`
  responses. Test 3 asserts the *cancel response*, which is non-streaming.
- **`tasks/resubscribe` requires a `WORKING` durable state *and* a live registry
  entry**, otherwise `-32004` by design, with `tasks/get` as the documented way to
  read a terminal task. Not covered here: proving the negative would assert a
  design decision, and proving the positive re-races the same window Test 3 already
  covers from the cancel side.
