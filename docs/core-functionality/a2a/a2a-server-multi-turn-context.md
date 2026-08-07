# A2A Server — multi-turn context: a conversation keeps its thread

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev18`)

**Issue:** #1247 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T5**) ·
**Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 / PR #1243
(`requireA2aEnabled()`, `postA2AJsonRpc`, `messageSendEnvelope`) ·
**Jira:** epic `LE-1588`

---

## What this test validates *(required)*

A2A is a **conversation** protocol, not a request/response one: a remote
orchestrator sends a turn, gets a `contextId` back, and quotes it on the next turn
to stay in the same thread. #1242 proved a single `message/send` round-trips. It
says nothing about the second turn — and the second turn is where the feature
either exists or does not.

Three things have to hold, and each one alone is insufficient:

1. **The server mints a `contextId`** when the caller sends none. A client cannot
   invent one; if the response omits it there is no way to continue a conversation
   at all.
2. **Reusing it lands in the same session.** Asserted where it actually matters —
   `GET /api/v1/monitor/messages`, i.e. the stored conversation, not merely the
   response envelope. An echoed id that never reached storage would satisfy a
   response-only check while leaving every turn in its own thread.
3. **Omitting it starts a new one.** The negative control. Without it, a server
   that funnels every call into one global session passes tests 1 and 2 perfectly
   — and silently leaks one user's turn into another's context.

---

## Tags *(required)*

`@stable` `@api` `@a2a`

- `@api` — drives `/api/v1/a2a/{id}/jsonrpc` and `/api/v1/monitor/messages` through
  `request`; no UI.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — validated by the team and promoted in #1349: the batch ran
  **51/51 green** (17 tests × 3, `--retries=0`) on nightly `1.12.0.dev18`,
  with no leaked flow and no backend error logged.

---

## Validation criterion *(required)*

For one published Chat Input → Chat Output passthrough flow, three `message/send`
calls with per-run sentinels:

- **Turn 1** (no `contextId` sent) → `result.contextId` is a non-empty UUID the
  **server** chose, and `result.status.state === "completed"`.
- **Turn 2** (`message.contextId` = turn 1's) → the response echoes the **same**
  `contextId` and a **different** task `id` (same thread, new task).
- **Turn 3** (no `contextId`) → a `contextId` **different** from turn 1's.

Then, in `GET /api/v1/monitor/messages?flow_id={flowId}`:

- turns 1 and 2 share **one** `session_id`, and turn 3 has a different one;
- each `session_id` **ends with** `:{contextId}` — measured shape is the composite
  `<flow-scoped uuid>:<contextId>`, so equality against the bare `contextId` would
  be wrong;
- that shared session carries **both** sentinels, each as a `User` row and a
  `Machine` row (the passthrough echoes verbatim) — which is what proves the
  turns were stored together rather than merely answered together.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240; asserted at
  runtime by `requireA2aEnabled()` so a flag-off instance names its own cause
  instead of failing on a `404`.
- **No LLM, no provider key, no external network.** The flow is the Chat Input →
  Chat Output passthrough from `tests/assets/flows/chat-io-ok-trace-fixture.json`
  via `createRunnableChatFlowViaApi()`; the echo is what makes the stored-text
  assertions deterministic.
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- Nothing about existing flows matters: the flow is created by the test and deleted
  **by id** in `finally`. **No pre-test wipe** — the instance is shared with other
  workers (#515/#588).
- `GET /api/v1/monitor/messages` is filtered by `flow_id`, so a parallel spec's
  traffic cannot contaminate the rows this test reads.

---

## Step by step *(required)*

One test, three turns — deliberately one test rather than three: the assertions are
*relations between* the turns (same id, different id), which separate tests could
not express without sharing state.

**`a conversation keeps its thread only while the caller quotes the contextId`**
1. `requireA2aEnabled(request, headers)`.
2. `createRunnableChatFlowViaApi()` → `flowId`; `PATCH` it to
   `{ flow_type: "agent", a2a_enabled: true }`.
3. Turn 1: `postA2AJsonRpc(message/send)` with sentinel A and **no** `contextId` →
   assert `completed`, capture `contextId` and the task `id`.
4. Turn 2: same call with sentinel B and `message.contextId = ctx1` → assert the
   response's `contextId` equals `ctx1` and its task `id` differs from turn 1's.
5. Turn 3: sentinel C, **no** `contextId` → assert the response's `contextId`
   differs from `ctx1`.
6. `GET /api/v1/monitor/messages?flow_id={flowId}` → group the rows by
   `session_id` and assert: exactly two sessions; the one ending in `:${ctx1}`
   holds sentinels A and B (each as `User` + `Machine`); the one ending in
   `:${ctx3}` holds only sentinel C.
7. `finally`: delete the flow by id.

---

## Validation *(required)*

| Turn | Observable |
|---|---|
| 1 | `contextId` present and server-minted; state `completed` |
| 2 | same `contextId`, different task `id` |
| 3 | different `contextId` |
| stored | 2 sessions; `session_id` ends with `:{contextId}`; turns 1+2 together with both sentinels as `User`/`Machine` pairs; turn 3 alone |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- **`session_id` is a composite, not the `contextId`.** Measured value:
  `c993ba94-086d-5336-bf37-cd3e6c67fbaa:1a7f7429-37d6-461a-b410-4d9ca2ac6ee9` —
  a stable prefix plus the `contextId`. Asserting `session_id === contextId`
  would fail against a healthy server; the spec anchors on the suffix.
- **Each turn produces exactly two monitor rows** — `sender: "User"` and
  `sender: "Machine"`, both carrying the sentinel verbatim, because Chat Output
  echoes Chat Input. Six rows for three turns.
- **The `contextId` goes inside `message`**, not beside it, in the `message/send`
  params — which is why `messageSendEnvelope()` (from #1243) already takes it there.
- The response `result` is a task object (`kind: "task"`) carrying `artifacts`,
  `contextId`, `id` and `status`; the reply text lives at
  `artifacts[0].parts[0].text`.
