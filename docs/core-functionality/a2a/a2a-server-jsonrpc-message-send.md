# A2A Server — JSON-RPC `message/send`: round-trip and error envelopes

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev14`)

**Issue:** #1242 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T4**) ·
**Depends on:** #1240 · **Jira:** epic `LE-1588`, transport `LE-1805`,
public-endpoint hardening `LE-2081`

---

## What this test validates *(required)*

`POST /api/v1/a2a/{flow_id}/jsonrpc` is the **only** way a remote agent actually
runs a published Langflow flow. Everything else in the area — the card, the
catalog, the UI's publish switch — exists to lead a caller here. This spec proves
the endpoint honours the two halves of the JSON-RPC contract:

1. **The round-trip really executes the flow.** A `message/send` carrying a
   per-run sentinel comes back as a task in a terminal `completed` state whose
   artifact contains that sentinel. The published flow is a Chat Input → Chat
   Output passthrough, so the sentinel is echoed **verbatim** — the assertion is
   causal, not a "something came back" smoke check, and it needs no LLM.
2. **Protocol errors are JSON-RPC errors, not HTTP errors.** An unknown method,
   a malformed envelope and unparseable JSON all return **HTTP 200** with an
   `error` object carrying the spec's code. A caller that treats HTTP status as
   the verdict sees success on every one of them, so this is the half most likely
   to regress unnoticed.

If the round-trip breaks, every A2A consumer gets a task that never completes or
an artifact with the wrong content. If the error envelopes break — a `500` where
`-32600` belongs, or an HTTP `4xx` where `200` belongs — every spec-compliant
client mis-handles failure, and the public endpoint's error surface is exactly
where `LE-2081` (RCE on the public A2A endpoint) lived.

---

## Tags *(required)*

`@api` `@release` `@a2a`

- `@api` — REST/JSON-RPC only, no UI.
- `@release` — running a published agent is the feature; nothing ships if this is red.
- `@a2a` — area tag (added by #1242).
- **No `@stable` yet** — pending team validation.

---

## Validation criterion *(required)*

**Round-trip:** a `message/send` whose single text part is
`a2a-e2e-<uuid>` returns HTTP `200`, `body.result.status.state === "completed"`,
`body.result.id` a non-empty string, and the serialized result **contains that
exact sentinel**. A second run with a different sentinel returns a different
`result.id`, proving the task is per-call rather than cached.

**Error envelopes:** each of the following returns HTTP `200` with the stated
`error.code` —

| Request | `error.code` |
|---|---|
| `method: "does/notExist"` | `-32601` |
| envelope missing `method` | `-32600` |
| envelope missing `jsonrpc` | `-32600` |
| `jsonrpc: "1.0"` | `-32600` |
| `method: "message/send"` with no `params` | `-32600` |
| body that is not valid JSON | `-32700` |

Assertions are on **`error.code` only**. The `message`/`data` strings are
implementation text — the `-32700` case returns a raw Python parser message
(`Expecting property name enclosed in double quotes: line 1 column 2 (char 1)`)
and `-32600` sometimes embeds a Pydantic validation dump. Matching those would
break on any upstream dependency bump while the contract held.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network.** The flow is
  `tests/assets/flows/chat-io-ok-trace-fixture.json` via
  `createRunnableChatFlowViaApi()`; Chat Output echoes Chat Input.
- Auto-login superuser. The flow's project stays `auth_type=none`, so the
  endpoint is public and **no `x-api-key` is sent** — the authenticated variant is
  a separate spec (`a2a-server-auth-apikey`), because it needs the project's auth
  changed and a real API key.

---

## Preconditions *(optional)*

- A2A-enabled Langflow at `PLAYWRIGHT_BASE_URL`.
- **A run takes seconds, not milliseconds.** The passthrough builds a real graph;
  budget a request timeout well above the default assertion timeout rather than
  polling. `message/send` is synchronous here — it returns the finished task, so
  no `tasks/get` loop is needed (that is the lifecycle spec's job).

---

## Step by step *(required)*

Three tests. Every test creates and publishes its own flow via
`createRunnableChatFlowViaApi()` + `PATCH`, and deletes it by id in `afterEach`.

**Test 1 — `message/send runs the flow and echoes the sentinel back`**
1. `requireA2aEnabled(request)`.
2. Create the passthrough flow; `PATCH` `{ flow_type: "agent", a2a_enabled: true }`.
3. Build `sentinel = "a2a-e2e-" + randomUUID()`.
4. `POST /api/v1/a2a/{flowId}/jsonrpc` with
   `{ jsonrpc: "2.0", id, method: "message/send", params: { message: { role: "user", messageId, parts: [{ kind: "text", text: sentinel }] } } }`
   via the `postA2AJsonRpc()` helper.
5. Assert HTTP `200`; assert `body.error` is undefined; assert
   `body.result.status.state === "completed"`; assert `body.result.id` is a
   non-empty string; assert the sentinel appears in the result.
6. Delete the flow.

**Test 2 — `each call produces its own task`**
1. Publish a flow as above.
2. Send two `message/send` calls with **different** sentinels.
3. Assert both reach `completed`, each result contains **its own** sentinel and
   **not** the other's, and the two `result.id` values differ.
4. Delete the flow.

**Test 3 — `protocol errors come back as JSON-RPC errors over HTTP 200`**
1. Publish a flow as above.
2. For each row of the *Validation criterion* error table, POST that body and
   assert HTTP `200` **and** the expected `error.code`. The invalid-JSON case sends
   a raw string body with `Content-Type: application/json`, bypassing
   serialization.
3. In the same test, send one **valid** `message/send` and assert it still returns
   `result` with no `error` — a positive control, so an endpoint that answered
   `-32600` to everything cannot pass.
4. Delete the flow.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | round-trip | `200`, no `error`, `result.status.state === "completed"`, sentinel present in the result |
| 2 | per-call task | two distinct `result.id`s; each result carries only its own sentinel |
| 3 | error envelopes | 6 malformed/unknown requests → `200` + the exact `error.code`; one valid request still returns `result` |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- Every protocol error came back **HTTP 200**, including unparseable JSON. There is
  no HTTP-status signal to assert on at all.
- `-32600 "Invalid Request"` covers four distinct shapes (missing `method`,
  missing `jsonrpc`, wrong `jsonrpc` version, missing `params`), each with a
  different `data` payload — one of them a full Pydantic error dump. Hence
  code-only assertions.
- The error event's message object elsewhere in this stack carries
  `"error": false` (see `flow-error-policy.ts` in `CLAUDE.md`); do **not** infer
  failure from a truthy `error` field anywhere in the result — the JSON-RPC
  envelope's top-level `error` key is the only verdict.
- `message/send` is **synchronous on this path**: the response already carries the
  terminal state, so there is nothing to poll. `tasks/get` / `tasks/cancel` and
  the streaming variant belong to the lifecycle spec, which is a separate issue.
- The response's `result.contextId` is server-minted and is reused when passed
  back on a later call — measured, but that is row **T5**'s contract and is
  **not** asserted here.
