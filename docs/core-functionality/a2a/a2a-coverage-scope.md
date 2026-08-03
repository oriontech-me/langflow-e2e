# A2A Protocol — surface map, testability decision record and spec batch scope

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev14`; first measured on
`1.12.0.dev10` and re-checked on `dev14` with **no drift** — same three routes, same
`a2a_enabled: false` default, same `404`-when-off behavior, same card fields and
constants, same four Agent-tab testids, byte-identical UI copy)

**Issue:** #1195 (Wave 5 — 1.11.0 feature coverage, scoping issue) ·
**Upstream:** `langflow-ai/langflow#13831`, docs PR `#14143` ·
**Jira:** epic `LE-1588` (+ `LE-1599` UI, `LE-1600` conformance, `LE-1601`/`LE-1725` docs)

---

## What this test validates *(required)*

**This document ships no `.spec.ts`.** #1195 is a scoping issue: its deliverable
is the named `QA-CHECKLIST.md` bullets (§16.1 / §16.2, under
`### core-functionality/a2a/`) plus this record, which the Wave 6 A2A spec issues
consume as their input contract. What it validates is
therefore the **scope decision itself** — that every A2A behavior reachable from a
decoupled, URL-only Playwright suite is either (a) claimed by a named bullet with a
concrete observable, or (b) written down as out of scope with the reason.

It covers three surfaces, all measured live on the nightly (see *Surface map*):

1. **A2A server, API level** — the per-flow agent card, the owner-scoped discovery
   list, and the JSON-RPC transport (`message/send`, `message/stream`, `tasks/get`,
   `tasks/cancel`, `tasks/resubscribe`), including the folder-derived auth gate.
2. **A2A server, UI level** — the flow editor's **Agent** tab: eligibility gate,
   publish switch, status, address block, card editor, and the "Try it" panel that
   calls the live JSON-RPC endpoint.
3. **A2A client** — the `A2AAgent` component in `Internal` and `External` mode,
   including its use as a Tool by a Langflow agent.

If the resulting batch is wrong, the failure mode is silent: A2A ships behind a
flag that is **off in every lane today**, so nothing in this area can fail a run —
which is exactly how `LE-1845` (External mode `NameError`), `LE-1963` (A2A-as-tool
resume crash), `LE-2007` (UI exposed but not enablable) and `LE-2081` (public
endpoint RCE, in QA at the time of writing) reached QA without a red spec.

---

## Tags *(required)*

This doc carries no test, so it carries no tag of its own. The batch it authorizes
uses:

| Planned area | Cross-cutting | Functional |
|---|---|---|
| `a2a-server-*` API specs | `@api` `@release` (card/send happy path), `@regression` on the auth gate | `@a2a` |
| `a2a-server-agent-tab-*` UI specs | `@workspace` `@release` | `@a2a` `@ui-ux` |
| `a2a-client-*` component specs | `@components`, `@regression` (LE-1845, LE-1963) | `@a2a` (+ `@agents` on the as-a-Tool spec) |

**`@a2a` is a new functional tag** and must be added to the tag table in
`CLAUDE.md` by the first spec issue of the batch. `@stable` is deliberately **not**
pre-assigned: it is granted per spec after team validation, per `CONTRIBUTING.md`.

---

## Validation criterion *(required)*

The scoping deliverable is satisfied when all four hold:

1. `QA-CHECKLIST.md` contains a `### core-functionality/a2a/ — Agent-to-Agent
   Protocol` section — the last subsection of `## core-functionality/`, before
   `## flow-functionality/` — with `#### 16.1 A2A Server` and `#### 16.2 A2A
   Client`, whose bullets name a **concrete observable** each (a card field, an
   HTTP status, a JSON-RPC error code, a testid, a rendered string) — never "A2A
   works".
2. Every bullet maps to exactly one row of the *Planned spec inventory* below, and
   every row of that inventory maps to at least one bullet.
3. Each out-of-scope item is listed under *Out of scope* with the reason it cannot
   be reached from this suite, so a future reader does not re-litigate it.
4. `MODULES` in `scripts/coverage-summary.ts` gains a `core-functionality/a2a/`
   entry positioned between `core-functionality/templates/` and
   `flow-functionality/` — without it, every A2A bullet is silently counted under
   `core-functionality/templates/` (each module runs to the next module's
   `sectionStart`).

**Why §16 and not §11.6.** Part II's `#### N.M` numbers are area-scoped and already
run 1 → 15 in document order; the new area takes the next free top-level number,
**16**, rather than renumbering §12–§15 (which would invalidate every `§N.M`
reference in `docs/`, closed issues and PR bodies). The numbers are therefore
non-monotonic at this one point in the file; `scripts/coverage-summary.ts` keys off
`MODULES` order, not the numbers, so nothing breaks.

---

## External dependencies *(required)*

| Dependency | Needed by | State today |
|---|---|---|
| **`LANGFLOW_A2A_ENABLED=true`** on the Langflow container | everything except the disabled-state case | **Off everywhere.** Measured on both `dev10` and `dev14`: `GET /api/v1/config` (authed) → `a2a_enabled: false`; `GET /api/v1/a2a/agents` → `404`. `scripts/start-langflow-docker.sh` set no A2A env at all. **Rolled out in #1240** — both start scripts plus the **six** workflows that run a Langflow service container for specs: `adaptive-impacted.yml`, `daily-stable.yml`, `manual.yml`, `nightly.yml`, `pr-validation.yml`, `weekly-stable.yml`. Six, not the five this row first named: `adaptive-impacted.yml` also starts one and is absent from `CLAUDE.md`'s workflow list. `scripts/a2a-flag-lanes.test.mjs` fails if any lane loses it |
| A project with `auth_type=apikey` + a Langflow API key owned by the flow owner | the auth-gate spec | Reachable — the same surface `mcp/server/mcp-server-tab.spec.ts` already drives; key creation via `tests/helpers/mcp/add-new-api-keys.ts` |
| SSRF allowance for loopback (`connector_ssrf_allow_loopback` class of setting) | `External`-mode client spec calling this instance's own card URL | **Unverified.** Langflow's SSRF layer blocks loopback outright (`LE-1904`, `LE-1898`); a self-call is the only way to exercise External mode without leaving the runner's network |
| A provider key (Anthropic/OpenAI) + `models.json` | the A2A-as-a-Tool spec only | Available, but that spec is the one expensive row of the batch — `--workers=1` |
| `a2a-sdk >= 1.1.0` inside the image | all | Present on the nightly (the JSON-RPC dispatch is the SDK's) |

No external network egress is required: every A2A spec talks to the instance under
test, including the External-mode self-call.

---

## Surface map (measured on `1.12.0.dev10`, confirmed on `1.12.0.dev14`)

### Server — HTTP

The router is **always mounted**; a per-request guard returns `404` when the flag
is off, so a disabled server is indistinguishable from an unmounted one
(`langflow/api/router.py:90`, `_require_a2a_enabled` in `api/v1/a2a.py:100`).

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/v1/a2a/agents` | authenticated, **owner-scoped** | Returns `[{id, name, description, cardUrl}]` for the caller's own `flow_type=agent` **and** `a2a_enabled` flows. Not a cross-user directory by design |
| `GET /api/v1/a2a/{flow_id}/.well-known/agent-card.json` | **public by spec** | `404` when the flag is off, the flow is missing, `flow_type != agent`, or `a2a_enabled` is falsy |
| `POST /api/v1/a2a/{flow_id}/jsonrpc` | folder-derived (below) | `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, `tasks/pushNotificationConfig/{set,get,list,delete}`. JSON-RPC-level errors return **HTTP 200** with an error envelope |

**Flag surface for the UI:** `GET /api/v1/config` carries `a2a_enabled` — but only
in the **authenticated** (`type: "full"`, 30 keys) response; the anonymous
(`type: "public"`, 13 keys) one omits it.

**Agent card shape** (`build_agent_card`, `api/v1/a2a_utils.py:180`): `name`,
`description`, `url` (the flow's `/jsonrpc`), `version`, `protocolVersion`
(`A2A_PROTOCOL_VERSION = "0.3.0"`, explicit — `LE-1717`), `capabilities`
(`streaming: true`, `pushNotifications: true`), `defaultInputModes` /
`defaultOutputModes` (`["application/json"]`), `securitySchemes` / `security`
(derived from the folder), and one `skills[0]` whose `id` is the flow id, `tags`
default to `["langflow"]`, and which carries an injected `inputSchema` built from
the flow graph. Overrides for `name`, `version`, `description`, `tags` and
`examples` come from the flow's `a2a_card_overrides`. A flow whose graph cannot be
built degrades to an empty input contract rather than a 500.

**Auth model** (`_enforce_a2a_auth`, `api/v1/a2a.py:111`) — derived from the
**folder/project** `auth_type`, exactly like the MCP transport:

- `none` / no folder → public agent;
- `apikey` / `oauth` → a Langflow API key in **`x-api-key`** that belongs to the
  **flow owner**; missing → `401 "API key required"`, invalid *or* another user's
  valid key → `401 "Invalid API key"` (same message on purpose);
- anything else → `403`, fail-closed.

The flow always runs **as its owner**, which is why the gate exists.

### Server — flow model

Migration `9f1d1d602aa3` adds `flow_type` (`workflow` | `agent`), `a2a_enabled`
(bool) and `a2a_card_overrides` (JSON) to `flow`. Publishing is a `PATCH
/api/v1/flows/{id}`. A non-owner flipping `a2a_enabled` gets
`403 "Cannot change a2a_enabled of a flow you do not own."`
(`api/v1/flows_helpers.py:481`).

### Server — UI (flow editor **Agent** tab)

73 `agentTab.*` i18n keys; confirmed testids `agent-publish-switch`, `agent-save`,
`agent-card-name`, `agent-card-url`. The exact entry point (tab trigger) is the one
item still to be scouted live — the PLAN phase of the first UI spec issue does that
with `playwright-cli`, once the flag is on.

- **Eligibility:** requires a chat input (`ChatInput` or `HumanInput`) **and** a
  `ChatOutput`; otherwise `"Add a chat input and a chat output so this flow can
  receive and reply to messages over A2A."` (plus input-only / output-only
  variants, and `"This flow no longer has a chat input and output, so it can't
  serve. Turn off serving, or add them back."` for an already-published flow).
- **Publish:** switch `"Serve as an A2A agent"` → `"Off. Nobody can reach it yet."`
  / `"Turn on, then save to publish."` / `"Live. Reachable at the address below."`;
  status chips `Live` / `Draft` / `Off` / `Unavailable`.
- **Exposure line:** `"Callable by anyone with the URL"` vs
  `"Requires an API key (x-api-key)"` — the card's security, surfaced in the UI.
- **Address:** copy `URL` / copy `curl`, `"Copied to clipboard"`.
- **Card editor:** Name, Version, Description, Tags, Examples → `agent-save` →
  toast `"Agent updated"` (`"Could not save the agent"` on failure). Persists to
  `a2a_card_overrides`.
- **Input contract:** `"Input contract"` / `"what a caller sends"` /
  `"No inputs. Callers send a message and a session id."` / `required` / `optional`.
- **Try it:** posts to the real `/jsonrpc` (`usePostA2AMessage`, `x-api-key` header
  when restricted); states `idle` / `working` / `completed` / `failed` /
  `canceled` / `needs input`; `"View JSON-RPC exchange"`; turn counter;
  `"A2A is off on this server, so there is nothing to call yet."` when disabled.
- **Server disabled:** `"A2A is turned off on this server. Set
  LANGFLOW_A2A_ENABLED=true to publish and test agents."`

### Client — `A2AAgent` component

`lfx/components/models_and_agents/a2a_agent.py`: `display_name = "A2A Agent"`,
`name = "A2AAgent"`, `icon = "bot"`. Inputs: `mode` (TabInput
`Internal` | `External`), `agent_name_selected` (Dropdown, refreshable, populated
from local published agents), `agent_url` (External), `agent_card`
(DataDisplayInput — renders the fetched card as chips, including
`"Requires an API key"`), `message` (Multiline, `tool_mode=True` → usable as a
Tool), `api_key` (SecretStr), `timeout` (Int seconds). One output: `Response`.

---

## Testability decision record

### In scope — the Wave 6 batch

The batch lives in **`regression/core-functionality/a2a/`** — flat, like every other
`core-functionality/` area — with the server/client split of the epic carried by the
filename prefix (`a2a-server-*` / `a2a-client-*`) instead of a subdirectory. Docs
mirror the path under `docs/core-functionality/a2a/`.

#### Planned spec inventory

Every path below is relative to `tests/tests-automations/regression/` (specs) and to
`docs/` (docs), i.e. `core-functionality/a2a/<name>.spec.ts` ↔
`core-functionality/a2a/<name>.md`.

| ID | Spec / doc basename | What proves it (concrete observable) |
|---|---|---|
| **T2** | `a2a-server-agent-card` | PATCH a Chat Input→Chat Output flow to `flow_type=agent, a2a_enabled=true` → `GET …/agent-card.json` is `200` with `protocolVersion="0.3.0"`, `url` ending in `/api/v1/a2a/{id}/jsonrpc`, `capabilities.streaming=true`, `defaultInputModes=["application/json"]`, `skills[0].id === flowId`, `skills[0].tags=["langflow"]`, and an `inputSchema` object; setting `a2a_card_overrides.name/description/tags/examples` changes exactly those fields; `a2a_enabled=false` → `404`; `flow_type=workflow` → `404` |
| **T3** | `a2a-server-discovery` | `GET /api/v1/a2a/agents` lists the published flow's id with a `cardUrl` that resolves `200`; a second `flow_type=workflow` flow and an `agent` flow with `a2a_enabled=false` are both absent; unpublishing removes the row |
| **T4** | `a2a-server-jsonrpc-message-send` | `message/send` with a per-run sentinel returns a task whose state is `completed` and whose artifact text contains that sentinel (Chat Output echoes Chat Input — no LLM); an unknown method returns JSON-RPC `-32601` over **HTTP 200**; a malformed envelope returns `-32600`/`-32700` |
| **T5** | `a2a-server-multi-turn-context` | The first `message/send` response carries a server-minted `contextId`; a second `message/send` reusing it lands in the same session (same `session_id` in `GET /api/v1/monitor/messages`), while a fresh call without it gets a different `contextId` |
| **T6** | `a2a-server-tasks-lifecycle` | `tasks/get` on the id returned by `message/send` returns the same task in a terminal state; `tasks/cancel` on a run started via `message/stream` moves it to `canceled`; `tasks/get` for an unknown id is a JSON-RPC "task not found" error, not a 500 |
| **T7** | `a2a-server-auth-apikey` | With the project's `auth_type=apikey`: the card advertises the `x-api-key` scheme in `securitySchemes`; `POST …/jsonrpc` with no header → `401 "API key required"`; with a syntactically valid but wrong key → `401 "Invalid API key"`; with the owner's key → `200` + `completed`. `@regression` — this is the gate `LE-2081` lives behind |
| **U1** | `a2a-server-agent-tab-publish` | On a blank flow the Agent tab shows the ineligible copy and `agent-publish-switch` cannot publish; after adding Chat Input + Chat Output it can; publishing → status `Live` + an `agent-card-url` equal to the real card URL (fetched `200` in-test); editing Name/Description → `agent-save` → toast `"Agent updated"` **and** `GET …/agent-card.json` returns the new values |
| **U3** | `a2a-server-agent-tab-try-it` | "Try it" sends a per-run sentinel over the live endpoint; the agent bubble renders the echoed sentinel, the state reaches `completed`, the turn counter increments, and `"View JSON-RPC exchange"` exposes the request/response pair |
| **C1** | `a2a-client-agent-internal` | In a second flow, an `A2AAgent` node with `mode=Internal` lists the published agent in its dropdown; running it produces a `Response` containing the sentinel the published passthrough flow echoes — no LLM on either side |
| **C2** | `a2a-client-agent-external` | `mode=External` pointed at **this instance's own** card URL renders the card in the `agent_card` display (name chip; `"Requires an API key"` when restricted) and a run returns the echoed sentinel. `@regression` for `LE-1845` (`NameError: name 'call_a2a_agent' is not defined`). **Gated on the loopback-SSRF dependency above** |
| **C3** | `a2a-client-agent-as-tool` | An Agent with the `A2AAgent` wired as a Tool (`tool_mode`) calls the published agent and the reply reaches the playground; `@regression` for `LE-1963` (`self.user_id is None` → `badly formed hexadecimal UUID string` on tool-approval resume). The only LLM-dependent row — `--workers=1`, `models.json` |

**Shared preconditions for the batch.** `createRunnableChatFlowViaApi`
(`tests/helpers/flows/create-runnable-chat-flow-via-api.ts`) already builds the
exact LLM-free Chat Input→Chat Output passthrough these specs publish, and returns
a teardown callback — so every row above can assert on a **per-run sentinel** that
the flow echoes verbatim, and every flow the batch creates is deleted id-scoped
(`trackCreatedFlows` / `deleteFlow`), never by a wipe. A reusable
`postA2AJsonRpc()` helper belongs next to `tests/helpers/mcp/mcp-streamable-client.ts`
(same shape of problem) and is a planned task of the first API spec issue, not an
inline improvisation.

### Out of scope — and why

| Behavior | Why it cannot be reached from this suite |
|---|---|
| Disabled-server state (`404` on all three routes; the `serverDisabled` / `testServerOff` copy) | The flag decision for #1195 is **on in every lane**, and an off-lane cannot coexist with it in the same run. Revisit only if a `@destructive`-style dedicated lane (`PW_A2A_OFF=1`) is judged worth the CI minutes |
| Push notifications (`tasks/pushNotificationConfig/*` + delivery) | Setting a config is testable, but proving **delivery** needs a receiver with an inspectable inbox; the self-hosted `go-httpbin` echo endpoint has no such inbox (`LE-1706`) |
| JWS-signed agent cards (`LE-1718`) | No product surface exposes the signature to a URL-only client; verification is a cryptographic unit concern |
| gRPC / REST transports | Out of scope upstream (JSON-RPC only in this epic) |
| `lfx serve` runtime (`LE-1699`, `LE-1700`) | A different runtime from the Langflow instance the suite points at |
| `a2a_tasks` / `a2a_checkpoints` TTL + reaper (`LE-1705`), encryption at rest | Time- and storage-level behavior with no URL observable inside a test's lifetime |
| Rate limiting on the public endpoints (`LE-1701`) | Relies on global v1 limits; driving it would make every parallel lane flaky |
| SSRF prefix blocking (`LE-1898`: 6to4 `2002::/16`, NAT64 `64:ff9b::/96`) | Needs synthetic address families the runner cannot route; belongs to upstream unit tests |
| Cross-worker durability of task state (`LE-1706`) | The lanes run `LANGFLOW_WORKERS=1` on purpose (#922/#927) |
| Non-owner publish `403` | Needs two real users; per-test user isolation is impossible under `AUTO_LOGIN` (measured, #1010) |
| i18n coverage of the Agent tab (`LE-1796`) | Locale switching is not a surface this suite drives |

---

## Follow-up work this scoping creates

1. **Flag rollout (blocking, first Wave 6 issue):** `LANGFLOW_A2A_ENABLED=true` in
   `scripts/start-langflow-docker.sh`, `scripts/start-langflow-pip.sh` and the five
   workflow service containers — same shape as the
   `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` rollout (#668/#746), and with the same
   failure mode if forgotten: every spec in the area passes-by-skipping or 404s.
2. **`@a2a` tag** added to the functional tag table in `CLAUDE.md`.
3. **`MODULES` entry** for `### core-functionality/a2a/` in
   `scripts/coverage-summary.ts`, in document order — between
   `core-functionality/templates/` and `flow-functionality/` (the script fails
   loudly on a misordered array — that is the guard, not a warning).
4. **Loopback-SSRF question** answered before `C2` is scheduled: if a self-call
   cannot be allowed on the runner, External mode drops to out of scope and
   `LE-1845` stays uncovered — a conscious gap, recorded here.
5. **Live scout of the Agent tab entry point** (`playwright-cli`) as the PLAN step
   of the first UI spec issue, once the flag is on.
