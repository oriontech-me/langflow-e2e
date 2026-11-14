# A2A Server — Agent tab: the "Try it" panel on a restricted (API-key) agent

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev26`, #2433)

**Issue:** #2433 · **Follow-up of:** #2412 · **Public sibling:**
`a2a-server-agent-tab-try-it.md` · **Depends on:** #1240
(`LANGFLOW_A2A_ENABLED=true` on every lane) · **Jira:** epic `LE-1588`

---

## What this test validates *(required)*

From Langflow `1.14.0.dev23` (also `release-1.13.2` / `1.13.3`), upstream #16186 and
#16151 make every project created under `AUTO_LOGIN=true` default to
`auth_type: "apikey"`, and switch existing projects with no auth to `apikey` at
startup, the default project included. An agent published from the default project
is therefore **restricted by default**. The restricted "Try it" panel is now the
first one a user reaches.

For a restricted agent the panel shows an extra field, `agent-test-apikey`. The
public sibling spec runs in an explicitly public project and never fills it
(#2412). This spec covers the restricted panel:

1. **The key typed in the panel is forwarded.** The `message/send` request the panel
   issues carries the typed key as `x-api-key`, the endpoint answers `200`, and the
   reply renders: the same per-run sentinel round-trip as the public spec.
2. **A missing or wrong key fails visibly instead of hanging.** With no key, `Send`
   is disabled and no request leaves the browser. With an unknown key, the panel
   sends, the endpoint answers `401 Invalid API key`, and the transcript shows the
   turn as `failed` with that message. It never shows `completed` and never echoes
   the sentinel.

The API half of the gate (the card advertises `x-api-key`; no header gives `401 API
key required`; an unknown key gives `401 Invalid API key`; the owner's key runs) is
asserted at HTTP level in `a2a-server-auth-apikey.spec.ts`. HTTP-level coverage
cannot see whether the **panel** reads the field and puts it on the wire, or what
it renders on a `401`. A panel that dropped the key, sent it under another header
name, or kept spinning on a `401` would leave every assertion of that spec green.

---

## Tags *(required)*

`@stable` `@workspace` `@ui-ux` `@a2a` `@auth`

- `@workspace`, `@ui-ux`, `@a2a`: as the public sibling (drives the flow editor;
  the subject is what the panel renders; A2A functional area).
- `@auth`: the subject is how the panel carries API-key authentication.
- **No `@release`:** same reasoning as the public sibling. "Try it" is a
  confirmation affordance, not a gate on shipping.
- `@stable`: added after the validation burst recorded in the PR (#2433).

---

## Validation criterion *(required)*

**Owner key (positive).** After publishing from an `apikey` project, filling
`agent-test-apikey` with a key minted for the owner and sending a per-run sentinel:

- the `POST /api/v1/a2a/{flow_id}/jsonrpc` request issued by the panel carries
  header `x-api-key` equal to the typed key, and its response is `200`;
- `agent-transcript` contains the sentinel **exactly twice** (user turn + the
  agent's echo, the echo after the `Agent` label) **and** `completed`;
- the turn counter reads `1 turn`.

**Missing / unknown key (negative).** On the same kind of agent:

- with the message filled and `agent-test-apikey` empty, `agent-test-send` is
  **disabled**; typing any key into `agent-test-apikey` **enables** it. The second
  half is the control: it proves that the key, and not the message, is what keeps
  `Send` disabled.
- with an unknown key, the panel's `jsonrpc` request carries that key as
  `x-api-key` and the response is `401` with `detail: "Invalid API key"`;
- `agent-transcript` then contains `failed` and `Invalid API key`, contains the
  sentinel **exactly once** (the user turn, no reply), and does **not** contain
  `completed`.

Measured on `1.14.0.dev26`, the negative transcript is exactly
`You\n<sentinel>\nAgent\n◆ failed\nInvalid API key`.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test, asserted at runtime
  by `requireA2aEnabled()`.
- **No LLM, no provider key, no external network.** The published flow is the
  Chat Input → Chat Output passthrough from
  `tests/assets/flows/chat-io-ok-trace-fixture.json`
  (`createRunnableChatFlowViaApi()`), so the echo is deterministic.
- Auto-login superuser (`getAuthToken()`). Each test creates its **own** project
  with an **explicit** `auth_type: "apikey"` (`createProjectViaApi()`), and does
  not rely on the default project. The default project is `apikey` only on
  `1.14.0.dev23+` builds, and it is shared by every parallel spec.
- An API key minted for the owner via `POST /api/v1/api_key/` (`createApiKey()`).
  The key Langflow mints for an `auth_settings` project is not used: its plaintext
  is never returned. `deleteProject` sweeps that key on teardown.
- The deliberate `401` is reported by the fixture's HTTP monitor unless declared,
  so the negative test calls `page.allowHttpErrors()` before sending.

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- No assumption about existing flows: the flow, its project and the owner key are
  created by each test and deleted **by id** in `afterEach`. **No pre-test wipe.**

---

## Step by step *(required)*

Two tests. Steps 1–5 are shared.

1. `requireA2aEnabled(page.request, authHeaders)`.
2. `createProjectViaApi(..., { authSettings: { auth_type: "apikey" } })`, then
   `createRunnableChatFlowViaApi(..., { folderId })` → `flowId`.
3. `openFlowById(page, flowId)`.
4. Click `sidebar-nav-agent`, click `agent-publish-switch`, click `agent-save` and
   wait for its `PATCH /api/v1/flows/{id}` → `200`; assert `agent-status` reads
   `Live`.
5. Assert `agent-test-apikey` is visible. This is the restricted panel: the field
   exists only for an agent whose project requires a key.

**`the Try it panel forwards the typed key and round-trips a sentinel on a restricted agent`**

6. `createApiKey()` → owner key. Fill `agent-test-apikey` with it and
   `agent-test-input` with a per-run sentinel (`a2a-try-it-key-${Date.now()}-…`).
7. Click `agent-test-send` while waiting for the `POST …/jsonrpc` response. Assert
   the request header `x-api-key` equals the owner key and the status is `200`.
8. Wait for `agent-transcript` to contain `completed`. Assert the sentinel occurs
   exactly twice, the reply after the `Agent` label.
9. Assert the turn counter reads `1 turn`.

**`the Try it panel blocks a keyless send and renders the 401 for an unknown key`**

6. `page.allowHttpErrors()`. Fill `agent-test-input` with a per-run sentinel and
   leave `agent-test-apikey` empty. Assert `agent-test-send` is disabled.
7. Fill `agent-test-apikey` with an unknown key
   (`sk-e2e-definitely-not-a-real-key-…`). Assert `agent-test-send` is now enabled.
8. Click `agent-test-send` while waiting for the `POST …/jsonrpc` response. Assert
   the request header `x-api-key` equals the unknown key, the status is `401` and
   the body's `detail` is `Invalid API key`.
9. Wait for `agent-transcript` to contain `failed`. Assert it contains
   `Invalid API key`, the sentinel exactly once, and no `completed`.

Both tests: `afterEach` leaves the editor (`unmountEditorForCleanup`), then
deletes newest-first what the test registered: the owner key (positive test), the
flow, then the project. Each delete is guarded so one failure does not skip the
rest, and the first failure is rethrown. `afterEach` rather than `finally`: it runs
while the page fixture is still alive, a test timeout included.

---

## Validation *(required)*

| Test | Observable |
|---|---|
| Owner key round-trip | `jsonrpc` request carries `x-api-key` = typed key → `200`; transcript holds the sentinel **2×** + `completed`; `1 turn` |
| Missing / unknown key | `Send` disabled with no key and enabled once a key is typed; unknown key sent as `x-api-key` → `401 Invalid API key`; transcript shows `failed` + `Invalid API key`, the sentinel **1×**, no `completed` |

---

## Measured behaviour worth knowing *(scout, `1.14.0.dev26`)*

- **The panel is restricted by the project, not by a panel setting.** On an
  `apikey` project the panel renders `agent-test-apikey` (`<input type=password>`,
  placeholder `x-api-key for this agent`) between the transcript and
  `agent-test-input`. The public sibling's panel has no such field.
- **Without a key the panel never sends.** `agent-test-send` stays `disabled` with a
  message typed, and no `jsonrpc` request is issued. The panel does not send and
  render the `401 API key required`. This answers the issue's open question, and
  it is why the negative test asserts the disabled control rather than a rendered
  `API key required`. It also explains the `1.14.0.dev25` symptom in #2412: the
  unmodified public spec timed out clicking a disabled `agent-test-send`.
- **The panel fetches the card without the key.** Its
  `GET …/.well-known/agent-card.json` carries no `x-api-key` and answers `200`.
  The card stays public on a restricted agent, as `a2a-server-auth-apikey` asserts
  at API level. Only the `jsonrpc` call carries the key.
- **An unknown key gives a failed turn, not a hang.** The `401` body
  (`{"detail":"Invalid API key"}`) is rendered as the agent's turn:
  `◆ failed` followed by the detail text.
