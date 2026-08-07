# A2A Server — the API-key gate on the JSON-RPC endpoint: what a restricted project changes

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev18`)

**Issue:** #1353 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T7**) ·
**Depends on:** #1240 · **Jira:** epic `LE-1588`, gate `LE-2081`

---

## What this test validates *(required)*

`POST /api/v1/a2a/{flow_id}/jsonrpc` is the only endpoint in this suite's reach
that **runs a flow as its owner** on behalf of an unauthenticated caller. That is
the entire reason an auth gate exists on it: an ungated run is a run under
somebody else's identity.

Authorization derives from the **project (folder)**, not from the flow —
`folder_auth_type()` reads `auth_settings.auth_type` off the flow's folder, and
the same value feeds both halves of the contract:

- `resolve_card_security()` decides what the **card advertises**, and
- `_enforce_a2a_auth()` decides what the **endpoint enforces**.

They are deliberately driven by one source so they cannot drift, and this spec
asserts **both** — a card that advertises a scheme the endpoint does not enforce
is a lie that tells a caller it is protected when it is not, and an endpoint that
enforces a scheme the card never advertises is unusable by a spec-compliant
client.

The seven specs promoted in #1349 all run against an **unrestricted** project, so
the authenticated path had never been exercised. A regression that turns `401`
into `200` publishes every restricted agent to anyone holding the URL, and
nothing in the suite would see it.

**The test's causal control is a move, not a comparison.** The same flow — same
id, same graph, same publication — is asserted **before and after** it changes
project. Two separate flows would leave "the gate follows the project" as an
assumption; one flow crossing the boundary proves it, and rules out the flow, the
graph, the server flag and the environment as the cause of the `401`.

---

## Tags *(required)*

`@stable` `@api` `@regression` `@a2a`

- `@api` — drives `/api/v1/projects/`, `/api/v1/flows/`, `/api/v1/api_key/` and
  `/api/v1/a2a/*` through `request`; no UI.
- `@regression` — `LE-2081` is a **fixed** gate, and the failure mode of its
  regression is silent: the endpoint answers `200` and the run succeeds, so only
  an explicit assertion on the `401` catches it.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@stable` — LLM-free and deterministic; enters with the tag per
  `CONTRIBUTING.md` (the standard #1349 restored for this area).
- **No `@release`:** publishing and running a **public** agent is the release
  happy path and already carries the tag (`a2a-server-agent-card`,
  `a2a-server-jsonrpc-message-send`). This spec covers the restricted variant.

---

## Validation criterion *(required)*

One flow — the Chat Input → Chat Output passthrough, published as an agent —
observed in **two project states**, with a per-run sentinel:

**State A, the default (unrestricted) project.** The card carries **no**
`securitySchemes` and **no** `security`, and `message/send` with **no**
`x-api-key` header returns `200`, `status.state === "completed"`, and the
sentinel echoed back.

**State B, after `PATCH`ing the flow's `folder_id` to a project created with
`auth_settings.auth_type = "apikey"`** — nothing else about the flow changes:

| Call | Expected |
|---|---|
| `GET …/.well-known/agent-card.json` | `securitySchemes.apiKey` = `{type:"apiKey", in:"header", name:"x-api-key"}` and `security` = `[{apiKey: []}]` |
| `POST …/jsonrpc`, no header | HTTP **401**, `detail === "API key required"` |
| `POST …/jsonrpc`, `x-api-key` = a syntactically valid but unknown key | HTTP **401**, `detail === "Invalid API key"` |
| `POST …/jsonrpc`, `x-api-key` = the owner's real key | HTTP **200**, `status.state === "completed"`, sentinel echoed |

The last row is the **positive control**, and it is not optional: a gate that
rejected everything — including the owner — would satisfy all three rows above it
while making the feature unusable. Asserting the sentinel rather than only the
status is what proves the authenticated call actually **ran the graph** instead of
returning an empty accepted task.

State A is the **negative control** on the other side: without it, a card that
never advertises security and an endpoint that always `401`s would be
indistinguishable from a working gate.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced in-test by
  `requireA2aEnabled()`, which reads the **authenticated** `/api/v1/config` (the
  anonymous response omits `a2a_enabled` entirely).
- **No LLM, no provider key, no external network** — the Chat Input → Chat Output
  passthrough (`createRunnableChatFlowViaApi()`), same fixture the rest of the
  area publishes.
- Auto-login superuser: the caller, the flow owner and the API key's owner are
  the same user. This is what makes the owner-scoped branch observable with one
  account.

---

## Preconditions *(optional)*

- A2A-enabled Langflow at `PLAYWRIGHT_BASE_URL`.
- **The restricted project is created by the test and deleted by it.** The
  default project is never modified: flipping its `auth_type` would restrict
  every flow of the shared superuser and break unrelated specs running in
  parallel — a cross-spec wipe of the #1010 class. The flow is *moved* into a
  throwaway project instead.
- **The API key is minted by the test and deleted by it**, id-scoped, in the same
  `finally` as the flow and the project.

---

## Step by step *(required)*

One test, `the api-key gate follows the project the flow lives in`. Everything it
creates is deleted by id in `finally`.

1. `requireA2aEnabled(request, headers)`.
2. Create the passthrough flow via `createRunnableChatFlowViaApi()`; keep its id
   and its `folder_id` (the default project).
3. `PATCH /api/v1/flows/{id}` → `{ flow_type: "agent", a2a_enabled: true }`.
   Publication is the *only* change; the flow stays in the default project.
4. **Negative control — unrestricted:** `GET` the card and assert
   `securitySchemes` and `security` are both absent. `POST …/jsonrpc` with no
   `x-api-key`, carrying sentinel S₁ → assert `200`, `completed`, S₁ echoed.
5. `POST /api/v1/projects/` with `{ auth_settings: { auth_type: "apikey" } }`;
   keep the project id.
6. `PATCH /api/v1/flows/{id}` → `{ folder_id: <project id> }`. Assert the response
   carries the new `folder_id` — the move is a precondition for everything below,
   so a silent no-op must fail here rather than three assertions later.
7. **The card now advertises the scheme:** `GET` the card → assert
   `securitySchemes.apiKey.type === "apiKey"`, `.in === "header"`,
   `.name === "x-api-key"`, and `security` contains an `apiKey` entry.
8. **No header:** `POST …/jsonrpc` → assert HTTP `401` and
   `detail === "API key required"`.
9. **Wrong key:** `POST …/jsonrpc` with `x-api-key: <valid-shape, unknown>` →
   assert HTTP `401` and `detail === "Invalid API key"`.
10. **Owner key (positive control):** `POST /api/v1/api_key/` to mint a key; keep
    its id and raw value. `POST …/jsonrpc` with `x-api-key: <raw>` carrying
    sentinel S₂ → assert `200`, `status.state === "completed"`, S₂ echoed.
11. `finally`: delete the API key, delete the flow, delete the project — each
    id-scoped, each guarded so one failure does not skip the rest.

---

## Validation *(required)*

| # | Step | Observable |
|---|---|---|
| 1 | unrestricted card | no `securitySchemes`, no `security` |
| 2 | unrestricted run | `200` + `completed` + S₁ echoed, with **no** header |
| 3 | move | `PATCH` response `folder_id` equals the new project's id |
| 4 | restricted card | `securitySchemes.apiKey` = `{type:"apiKey", in:"header", name:"x-api-key"}`; `security` contains `apiKey` |
| 5 | no header | `401` + `"API key required"` |
| 6 | wrong key | `401` + `"Invalid API key"` |
| 7 | owner key | `200` + `completed` + S₂ echoed |

---

## Measurements that shaped this spec *(measured on `1.12.0.dev18`)*

- **The message is identical for a wrong key and another user's valid key**, by
  design (`_enforce_a2a_auth`: *"Same message for invalid and wrong-owner: don't
  reveal a key is valid for another user"*). The spec therefore asserts the
  `"Invalid API key"` text for the unknown-key case only, and never claims the two
  cases are distinguishable.
- **The gate reads `x-api-key`, not `Authorization: Bearer`.** A bearer token —
  which every other spec in this area uses — does **not** satisfy it.
- **`AUTO_LOGIN` does not defeat the gate.** The route calls
  `authenticate_api_key` directly rather than `api_key_security`, precisely
  because the latter returns the superuser for a *missing* key under auto-login,
  which would silently bypass the check. Measured: no header → `401`, on an
  auto-login instance. Without that implementation detail this spec would not be
  automatable at all here.
- **`PATCH folder_id` moves a published flow and the gate follows it** —
  measured `200` → `401` on the same flow id, with no other change. This is what
  makes the one-flow design possible, and it is why the move is asserted rather
  than assumed.
- **A flow created with `data: {nodes: [], edges: []}` answers `200` with an empty
  artifact text.** An early scout used one and the "sentinel echoed" assertion was
  vacuous. The real passthrough fixture is required for the positive control to
  mean anything.
- **The scheme key is `apiKey`** (`A2A_APIKEY_SCHEME_NAME`), the object is
  `{description, in, name, type}`, and `security` is `[{"apiKey": []}]`.
- **Discovery still lists the flow under a restricted project** — the catalog is
  owner-scoped and unaffected by `auth_type`. Not asserted here (it belongs to
  `a2a-server-discovery`), recorded so a future reader does not assume otherwise.
- **Creating a project *with* `auth_settings` makes Langflow mint an API key of
  its own**, named `MCP Project <project name> - default` — and
  `DELETE /api/v1/projects/{id}` answers `204` while **leaving that key behind**.
  Measured in both directions on `1.12.0.dev18`: a project created *without*
  `auth_settings` mints no key at all, so the trigger is the auth settings rather
  than project creation. This is not a property of the spec but of the product;
  it is caught here because the first run of this test left one orphan key on the
  shared account, and the daily would have added one per day forever.
  `createProjectViaApi`'s teardown therefore sweeps keys matching the project's
  (unique) generated name. **Candidate product defect — a project-scoped
  credential outliving its project — not filed; recorded here.**

---

## Out of scope

- **Another user's valid key → `401`.** Needs a second real user; per-test user
  isolation is impossible under `AUTO_LOGIN` (measured in #1010), the same
  constraint that keeps the non-owner-publish bullet unautomatable.
- **`oauth` mode.** It takes the same owner-scoped `x-api-key` at this transport,
  so it would assert the same four observables through a second setup path — no
  added signal for the cost.
- **The `403` fail-closed branch** for an `auth_type` A2A does not understand:
  not reachable through the public API, which accepts only the known values.
- **JWS-signed cards** (`LE-1718`) — already recorded as out of scope in
  `a2a-coverage-scope.md`.
