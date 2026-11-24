# A2A Server — push-notification config and its webhook guard

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev35`)

**Issue:** #2551 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T9**, added by
#2551; the *Out of scope* push row narrowed to delivery) · **Depends on:** #1240
(`LANGFLOW_A2A_ENABLED=true` on every lane), #1242 / PR #1243 (`requireA2aEnabled()`,
`postA2AJsonRpc`, `messageSendEnvelope`) · **Jira:** epic `LE-1588`, `LE-1706`

---

## What this test validates *(required)*

Every A2A agent card advertises `capabilities.pushNotifications: true`, and the
JSON-RPC endpoint routes `tasks/pushNotificationConfig/{set,get,list,delete}`: a
caller registers a webhook on a task, and the server would POST the task's updates to
it. This spec covers the registration half. The delivery half is still out of reach
(see *Out of scope*).

Two things are asserted:

- **The config API works as a store.** `set` echoes what it stored (the token
  included). A config sent without an `id` is stored under the task id. `get` reads
  one back, `list` returns all of them, and `delete` removes exactly one. A config is
  reachable only through the flow that owns the task, like every other `tasks/*`
  method (`a2a-server-tasks-lifecycle.spec.ts` pins the same isolation for
  `tasks/cancel`).
- **The registration refuses any webhook that resolves to a non-public address, and
  stores nothing.** The endpoint is public and the webhook URL is caller-controlled,
  so registering one is a server-side request on someone else's behalf.
  `_SafePushConfigStore.set_info` (`src/backend/base/langflow/api/v1/a2a.py`) runs
  `validate_webhook_url` (`src/backend/base/langflow/api/v1/a2a_utils.py`) before
  storing. That check is a hard floor: http/https only, then it resolves the host and
  refuses it if **any** resolved address is blocked, whatever
  `LANGFLOW_SSRF_PROTECTION_ENABLED` says. The spec drives the encodings an attacker
  would try (decimal, hex, IPv4-mapped IPv6, a userinfo prefix) and asserts the
  **resolved** address the error names. A guard that compared the literal string
  instead of resolving it would pass the plain `127.0.0.1` case and fail those.

---

## Tags *(required)*

`@stable` `@api` `@a2a`

- `@api` — drives `/api/v1/a2a/{id}/jsonrpc` through `request`; no UI.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — shipped with the spec (#2551) after `--retries=0` bursts on nightly
  `1.14.0.dev35`: **20/20** with one worker and **20/20** with two, no backend error,
  no leaked flow or project. Each test was force-failed by a mutation of its own: a
  config sent with an `id`, a `list` in place of the `delete`, the owning flow probed
  where the other one belongs, a private URL as the accepted webhook, and a public URL
  added as a refused row (caught by that row and by the final `list`).

---

## Validation criterion *(required)*

Every call answers **HTTP 200**, errors included (the contract #1243 pinned). The
webhook URLs that must be accepted are public IP literals (`1.1.1.1`, `1.0.0.1`), so
the floor passes them without a DNS lookup.

1. **Round trip.** On a completed task:
   - `list` → `[]`;
   - `set` `cfg-1` (with a token) and `cfg-2` → each `result` echoes its
     `pushNotificationConfig` and the `taskId`; `set` with no `id` → the stored `id` is
     the task id;
   - `get` `cfg-1` → the same `url`, `token` and `id`;
   - `list` → exactly those three ids;
   - `delete` `cfg-1` → no error; `list` → exactly the other two; `get` `cfg-1` → an
     error and no `result`.
2. **Flow isolation.** `list` and `get` for that task through a **second** published
   flow's endpoint → `-32001`, while the first flow still lists the configs.
3. **Guard.** On a completed task with one accepted public config already stored,
   each URL below is refused with `error.code === -32602` and the exact message
   shown, and afterwards `list` still returns exactly the one accepted config.

   | URL | Message |
   |---|---|
   | `http://127.0.0.1/…` | `webhook url resolves to a blocked address: 127.0.0.1` |
   | `http://[::1]/…` | `… blocked address: ::1` |
   | `http://[::ffff:127.0.0.1]/…` | `… blocked address: ::ffff:127.0.0.1` |
   | `http://2130706433/…` | `… blocked address: 127.0.0.1` |
   | `http://0x7f.0.0.1/…` | `… blocked address: 127.0.0.1` |
   | `http://1.1.1.1@127.0.0.1/…` | `… blocked address: 127.0.0.1` |
   | `http://0.0.0.0/…` | `… blocked address: 0.0.0.0` |
   | `http://10.0.0.1/…` | `… blocked address: 10.0.0.1` |
   | `http://172.16.0.1/…` | `… blocked address: 172.16.0.1` |
   | `http://192.168.1.10/…` | `… blocked address: 192.168.1.10` |
   | `http://100.64.0.1/…` | `… blocked address: 100.64.0.1` |
   | `http://169.254.169.254/…` | `… blocked address: 169.254.169.254` |
   | `http://[fe80::1]/…` | `… blocked address: fe80::1` |
   | `http://[fd00::1]/…` | `… blocked address: fd00::1` |
   | `https://192.0.2.10/…` | `… blocked address: 192.0.2.10` |
   | `ftp://1.1.1.1/…` | `webhook url must be http or https` |
   | `http:///…` | `webhook url has no host` |

   The accepted config in the same test is what keeps a guard that refused
   everything from passing. A refused URL that is also stored is caught by the
   final `list`.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every lane since #1240; asserted at runtime
  by `requireA2aEnabled()`.
- **`LANGFLOW_A2A_ALLOW_PRIVATE_WEBHOOKS` unset (the default).** With it on,
  `validate_webhook_url` returns before resolving anything and every guard row would
  be accepted. No lane or starter sets it.
- **No LLM, no provider key, no outbound call.** The tasks come from the Chat Input →
  Chat Output passthrough in a project with an explicit `auth_type: "none"`
  (`createRunnableChatFlowInPublicProject()`). The configs are set on a task that has
  already completed, so no event follows and the server never POSTs to the webhook
  (measured: no dispatch in the server log). The accepted URLs are IP literals, so
  the floor resolves them without DNS.
- **In-memory store, one worker.** `_SafePushConfigStore` extends
  `InMemoryPushNotificationConfigStore`: configs live in the worker that stored them
  and are gone on restart. Every lane runs `LANGFLOW_WORKERS=1` (#922/#927); with
  several workers, a `list` could land on a worker that never saw the `set`.
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- Each test creates its flows in public projects of their own and deletes them by id
  in `finally`. The configs need no cleanup: they live in the worker's memory and are
  keyed by the task, which is deleted with the flow.

---

## Step by step *(required)*

**Test 1 — `push notification configs round-trip on a task, through its own flow only`**
1. `requireA2aEnabled`; create flows A and B, each in its own public project, and
   publish both.
2. `message/send` on A (sentinel) → a `completed` task T.
3. `list` T on A → `[]`.
4. `set` `cfg-1` (`https://1.1.1.1/e2e-a2a-push`, token), `cfg-2`
   (`https://1.0.0.1/e2e-a2a-push-2`), and one with no `id` → criterion 1.
5. `get` `cfg-1`, `list` → criterion 1.
6. `list` and `get` T through **B** → `-32001`; `list` on A still returns three.
7. `delete` `cfg-1` → `list` returns two, `get` `cfg-1` → error.
8. `finally`: delete both flows and their projects.

**Test 2 — `a webhook that resolves to a non-public address is refused and nothing is stored`**
1. `requireA2aEnabled`; create flow A in a public project and publish it.
2. `message/send` → a `completed` task T; `set` one accepted config
   (`https://1.1.1.1/e2e-a2a-push`).
3. For each row of criterion 3: `set` → `-32602` with that message (soft assertion
   per row, so one run names every regressed row).
4. `list` T → exactly the accepted config.
5. `finally`: delete the flow and its project.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | round trip + isolation | set echoes, no-`id` → task id, get = set, list = 3 ids, delete removes one; B → `-32001` while A still lists |
| 2 | guard | 17 URLs refused `-32602` naming the resolved address (or the scheme / host reason); the accepted public config stays the only one stored |

---

## Measured behaviour worth knowing *(scout, `1.14.0.dev35`)*

- **A deleted config reads back as `-32001 "Task not found"`.** The task exists. It is
  the config that is gone, and the SDK raises `TaskNotFoundError` for it. The spec
  asserts only that `get` errors with no `result` and lets `list` prove the deletion,
  so a future, more precise error does not break it.
- **`delete` is idempotent and answers with no `result` member.** Both the first and
  a repeated `delete` return `{"jsonrpc":"2.0","id":…}`: no `result`, no `error`.
  JSON-RPC 2.0 requires one of the two on a response. Recorded, not asserted.
- **`get` with no `pushNotificationConfigId` → `-32602 "Validation failed"`.** The v0.3
  shape lets a client omit it. This server requires it. Recorded, not asserted.
- **The floor runs before the shared SSRF framework.** CGNAT (`100.64.0.1`) is refused
  by the floor (`is_ip_blocked`) with the same "resolves to a blocked address" wording,
  so the second layer (`validate_and_resolve_url`, the allowlist and `is_global`
  extras) is never what answers for these rows. The allowlist in
  `LANGFLOW_SSRF_ALLOWED_HOSTS` does **not** open a webhook: every lane allows the
  RFC-1918 ranges there for the echo container, and `10.0.0.1` / `172.16.0.1` /
  `192.168.1.10` are still refused.
- **Isolation by principal is the task's.** `_push_config_scope` keys configs by the
  admitted principal and the flow, but a task is already invisible under another
  principal (`-32001`, `a2a-server-hitl-pause-resume.spec.ts` test 4), so the push
  methods cannot reach a config under one either. Not asserted separately.

### Out of scope

- **Delivery.** Proving that the server POSTs a task update needs a receiver whose inbox
  the test can read. `go-httpbin` keeps none (`LE-1706`), and every receiver a lane can
  run lives on a private address, which this guard refuses. Opening it takes
  `LANGFLOW_A2A_ALLOW_PRIVATE_WEBHOOKS=true`, which disables the guard test 2 asserts.
- The dispatch-time re-check (`_SafePushNotificationSender`, DNS rebinding). It needs
  a host whose resolution changes between registration and dispatch.
- Configs passed inline on `message/send` (`configuration.pushNotificationConfig`).
  The task would not be terminal yet, so an accepted webhook would be called.
