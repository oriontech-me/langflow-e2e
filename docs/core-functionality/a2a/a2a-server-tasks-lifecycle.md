# A2A Server — task lifecycle: read back, cancel, and fail closed

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev18`)

**Issue:** #1247 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T6**) ·
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
  with no leaked flow and no backend error logged.

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

5. **Cancelling a running task terminates it.** A `message/stream` run started with
   a large payload is cancelled the moment its `submitted` frame yields the task
   id: the `tasks/cancel` response carries `result.status.state === "canceled"`,
   and a subsequent `tasks/get` reads back `canceled`.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240; asserted at
  runtime by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network.** Both flows are the Chat Input →
  Chat Output passthrough (`createRunnableChatFlowViaApi()`).
- Auto-login superuser (`getAuthToken()`).
- **A ~2 MB text payload** on the cancel test only — see below. It costs the run
  about 2.7 s of CPU and no network.

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- The cross-flow test needs **two** published flows; both are created by the test
  and deleted **by id** in `finally`. **No pre-test wipe.**

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
1. `requireA2aEnabled`; create + publish flow A.
2. `POST message/stream` with a sentinel **prefixed to ~2 MB of filler** (see
   *Measured behaviour* — this is what makes the run long enough to cancel
   deterministically). Read the SSE stream only until the first frame carrying
   `result.id`.
3. Immediately `tasks/cancel` that id → assert
   `result.status.state === "canceled"`.
4. Stop reading the stream; `tasks/get` → `canceled`.
5. `finally`: delete the flow by id.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | read back + refused cancel | identical `id`/`contextId`/`artifactId`/`timestamp` + sentinel; unknown id `-32001`; terminal cancel `-32002`; state and timestamp unchanged after |
| 2 | cross-flow isolation | `-32001` through flow B (not `-32002`/`-32004`), while flow A still reads the task `completed` |
| 3 | live cancel | `tasks/cancel` returns `state: "canceled"` and `tasks/get` confirms it |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- **The exact wire values**, measured, not inferred:
  `{"code":-32001,"message":"Task not found","data":null}` and
  `{"code":-32002,"message":"Task cannot be canceled","data":null}`, both under
  `HTTP 200`.
- **The 2 MB payload is margin, not a requirement — and the force-fail proved it.**
  Measured: a 1 KB run completes in ~121 ms while the task id reaches the client at
  52–182 ms, so a cancel issued the instant the id appears wins by only 20–36 ms.
  It wins **anyway**, 3/3 by hand and again when a force-fail attempt deliberately
  shrank the payload back to 1 KB — that mutation was **rejected** for not making
  the test fail, which is the evidence that the narrow window still passes locally.
  Run time scales with the payload (1 KB → 121 ms, 200 KB → 423 ms, **2 MB →
  2687 ms**), so the 2 MB message buys a ~2.4 s margin (cancel landing at
  121–259 ms) instead of 20 ms. It is kept because a 20 ms margin is not something
  a shared CI lane should be asked to reproduce on a loaded runner — not because
  the assertion needs it here. Either way it is the deliberate alternative to a
  `waitForTimeout` racing the run.
- **Not-reading the SSE stream does not park the task.** Measured: leaving the
  stream unconsumed for 3 s still ends in `completed`, then `-32002` — so
  backpressure is not a way to widen the window, and the payload is.
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
