# A2A Server — agent card: spec-valid fields, overrides and publication gating

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev18`)

**Issue:** #1242 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T2**) ·
**Depends on:** #1240 (`LANGFLOW_A2A_ENABLED=true` on every lane) ·
**Jira:** epic `LE-1588`, card generation `LE-1717` (explicit `protocolVersion`)

---

## What this test validates *(required)*

The **agent card** is A2A's entire discovery contract: it is the single document a
remote orchestrator (watsonx Orchestrate is the driver behind `LE-1588`) fetches to
decide whether it can talk to a Langflow flow at all, and how. It is served
**unauthenticated by spec** at `GET /api/v1/a2a/{flow_id}/.well-known/agent-card.json`.

This spec covers three things:

1. **The card is spec-valid and points at the right endpoint** — every field a
   caller depends on: `protocolVersion`, the `url` it must POST to,
   `capabilities`, the input/output modes, and the single `skills[0]` entry whose
   `id` is the flow id and which carries the flow's input contract as
   `inputSchema`.
2. **`a2a_card_overrides` changes exactly what it advertises** — all five
   overridable fields (`name`, `version`, `description`, `tags`, `examples`),
   and nothing else.
3. **Publication is a gate, not a suggestion** — the card `404`s for a flow that
   is not `flow_type=agent`, for one whose `a2a_enabled` is false, and for an
   unknown id. A `404` here is deliberately indistinguishable from an unmounted
   route (`langflow/api/router.py`), which is exactly why it must be asserted:
   nothing else in the product distinguishes "not published" from "no such
   feature".

If this fails, remote agents either cannot discover a published Langflow flow, or
they discover the **wrong** contract — a `url` that does not answer, a
`protocolVersion` no client negotiates, or an unpublished flow leaking its card.

---

## Tags *(required)*

`@stable` `@api` `@release` `@a2a`

- `@api` — drives `/api/v1/flows/` and `/api/v1/a2a/*` via `request`, no UI.
- `@release` — the card is the happy path of publishing a flow as an agent; a
  broken card breaks A2A wholesale.
- `@a2a` — new functional tag for this area, added to `CLAUDE.md` by #1242.
- `@stable` — validated by the team and promoted in #1349: the batch ran
  **51/51 green** (17 tests × 3, `--retries=0`) on nightly `1.12.0.dev18`,
  with no leaked flow and no backend error logged.

---

## Validation criterion *(required)*

A published flow's card is `200` and carries **all** of:
`protocolVersion === "0.3.0"`; `url` ending in
`/api/v1/a2a/{flowId}/jsonrpc`; `capabilities.streaming === true` and
`capabilities.pushNotifications === true`; `defaultInputModes` and
`defaultOutputModes` both `["application/json"]`; `skills` of length 1 with
`skills[0].id === flowId`, `skills[0].tags === ["langflow"]`, and
`skills[0].inputSchema` an object whose keys include `type`, `properties` and
`required`.

Then, with `a2a_card_overrides` set: `card.name`, `card.version`,
`card.description`, `skills[0].tags` and `skills[0].examples` equal the values
sent — **and** `card.url` and `card.protocolVersion` are unchanged by the
override, proving the override edits the advertisement rather than the endpoint.

Then each gate returns exactly `404`: `a2a_enabled=false`,
`flow_type=workflow`, and a random UUID.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test. Set by
  `scripts/start-langflow-docker.sh` and every CI lane since #1240; asserted at
  runtime by `requireA2aEnabled()` so a flag-off instance fails with the cause
  named instead of a bare `404`.
- **No LLM, no provider key, no external network.** The published flow is the
  Chat Input → Chat Output passthrough from
  `tests/assets/flows/chat-io-ok-trace-fixture.json`, built via
  `createRunnableChatFlowViaApi()`.
- Auto-login superuser (`getAuthToken()`), as every `api/` spec uses.

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled.
- Nothing about existing flows matters: every flow is created by the spec and
  deleted by id in teardown. **No pre-test wipe.**

---

## Step by step *(required)*

Four independent tests. Each creates its own flow via
`createRunnableChatFlowViaApi()` and deletes it by id in `afterEach`, so a
failure mid-test still cleans up.

**Test 1 — `published agent flow serves a spec-valid card`**
1. `requireA2aEnabled(request)`.
2. Create the passthrough flow via `POST /api/v1/flows/` → keep `flowId`.
3. `PATCH /api/v1/flows/{flowId}` with `{ flow_type: "agent", a2a_enabled: true }`;
   assert the response echoes both.
4. `GET /api/v1/a2a/{flowId}/.well-known/agent-card.json` → assert `200`.
5. Assert every field of the *Validation criterion*'s first paragraph.
6. `GET` the advertised `card.url`'s **path** is exactly
   `/api/v1/a2a/{flowId}/jsonrpc` — parsed from the URL, not string-matched on
   the host, since the base URL differs between local and CI.
7. Delete the flow.

**Test 2 — `card overrides change exactly what the card advertises`**
1. Create + publish as in Test 1, but `PATCH` with `a2a_card_overrides` carrying
   all five fields (`name`, `version`, `description`, `tags`, `examples`) with
   values distinctive enough not to collide with the flow's own
   (e.g. a `version` of `9.9.9-e2e`).
2. `GET` the card → assert `name`, `version`, `description` equal the overrides;
   `skills[0].tags` and `skills[0].examples` equal the arrays sent.
3. Assert `card.protocolVersion` is still `"0.3.0"` and `card.url` still ends in
   `/api/v1/a2a/{flowId}/jsonrpc` — the override must not move the endpoint.
4. Delete the flow.

**Test 3 — `card is 404 while the flow is not published`**
1. Create the flow; **do not** publish. `GET` the card → `404`.
2. `PATCH` `{ flow_type: "agent", a2a_enabled: true }` → `GET` → `200`
   (positive control in the same test, so a blanket-404 bug cannot pass it).
3. `PATCH` `{ a2a_enabled: false }` → `GET` → `404`.
4. `PATCH` `{ flow_type: "workflow", a2a_enabled: true }` → `GET` → `404`.
5. Delete the flow.

**Test 4 — `card is 404 for an unknown flow id`**
1. `GET /api/v1/a2a/{random UUID}/.well-known/agent-card.json` → `404`.
2. Assert the body is the generic `{"detail":"Not Found"}` — an unknown id must
   not be distinguishable from an unpublished one, or the endpoint becomes a
   flow-existence oracle.

---

## Validation *(required)*

Each test's single pass condition:

| # | Test | Observable |
|---|---|---|
| 1 | spec-valid card | `200` + all 8 card assertions + `url` path `=== /api/v1/a2a/{flowId}/jsonrpc` |
| 2 | overrides | 5 overridden values present; `protocolVersion` and `url` unchanged |
| 3 | publication gate | `404 → 200 → 404 → 404` across the four states, in one test |
| 4 | unknown id | `404` with the generic `Not Found` body |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- `protocolVersion` is `"0.3.0"`, set explicitly (`A2A_PROTOCOL_VERSION` in
  `langflow/api/v1/a2a_utils.py`) rather than inherited from the SDK — `LE-1717`.
- The **`name` override lands in two places**: `card.name` **and**
  `skills[0].name`. Asserting only the former would miss half the change.
- `securitySchemes` and `security` are **absent** from the card while the flow's
  project is `auth_type=none` — `model_dump(exclude_none=True)` drops them. This
  spec must **not** assert their presence; that belongs to the auth-gate spec,
  which sets the project to `apikey` first.
- A flow whose graph cannot be built still serves a card, with an **empty input
  contract** rather than a `500` (`build_agent_card` catches and degrades). Not
  asserted here — it needs a deliberately broken flow — but it is why
  `inputSchema` is asserted as *shape*, not as an exact schema.
