# A2A Server — agent discovery list: what `/api/v1/a2a/agents` does and does not enumerate

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev14`)

**Issue:** #1242 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (row **T3**) ·
**Depends on:** #1240 · **Jira:** epic `LE-1588`, registry `LE-1719`

---

## What this test validates *(required)*

`GET /api/v1/a2a/agents` is the **catalog** an orchestrator or the `A2AAgent`
component in `Internal` mode reads to find out which local flows are reachable as
A2A agents. It is authenticated and **owner-scoped** — deliberately not a
cross-user directory, because a public one would strip the per-flow card's
unguessable-id obscurity and expose other users' agents.

Its contract is a filter, and the filter is the whole point:

1. **Publishing puts a flow in the list**, with a `cardUrl` that actually resolves.
2. **A `flow_type=workflow` flow is never listed**, no matter what else is set.
3. **An `agent`-typed flow with `a2a_enabled` false is never listed** — the two
   conditions are ANDed, not ORed.
4. **Unpublishing removes it**, so the catalog reflects current state rather than
   history.

If this regresses, the failure is quiet and asymmetric: a **missing** row makes a
published agent invisible to every consumer (the `A2AAgent` dropdown goes empty),
while an **extra** row advertises a flow that answers `404` on its card — an
orchestrator wires itself to a dead endpoint.

---

## Tags *(required)*

`@api` `@a2a`

- `@api` — pure REST, no UI.
- `@a2a` — this area's functional tag (added by #1242).
- **No `@release`:** discovery is not on the critical publish path — a caller
  that already knows the flow id reaches the card directly. The card and
  `message/send` specs carry `@release`.
- **No `@stable` yet** — pending team validation.

---

## Validation criterion *(required)*

With three flows created in one test — **A** (`flow_type=agent`,
`a2a_enabled=true`), **B** (`flow_type=workflow`, `a2a_enabled=true`) and **C**
(`flow_type=agent`, `a2a_enabled=false`) — a single `GET /api/v1/a2a/agents`
returns `200` and its `id` set contains **A** and contains neither **B** nor
**C**. Fetching **A**'s `cardUrl` verbatim from the response returns `200`. After
`PATCH`ing **A** to `a2a_enabled=false`, a fresh `GET` no longer contains it.

The three flows exist **simultaneously** on purpose: asserting only "A is
present" would pass against an endpoint that lists everything, and asserting
only "B is absent" would pass against an endpoint that lists nothing.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** (#1240); enforced in-test by
  `requireA2aEnabled()`.
- **No LLM, no provider key, no external network** — three copies of the
  Chat Input → Chat Output passthrough (`createRunnableChatFlowViaApi()`).
- Auto-login superuser: under `AUTO_LOGIN` the caller and the flow owner are the
  same user, which is what makes the owner-scoped list observable at all.

---

## Preconditions *(optional)*

- A2A-enabled Langflow at `PLAYWRIGHT_BASE_URL`.
- **The assertions are set-membership, never list length.** The superuser account
  is shared and other specs may hold published agents concurrently; asserting
  `agents.length === 1` would be a cross-spec flake. Every assertion is about the
  presence or absence of *this test's* ids.

---

## Step by step *(required)*

Two tests. All flows are created by the test and deleted by id in `afterEach`.

**Test 1 — `discovery lists only agent-typed, A2A-enabled flows`**
1. `requireA2aEnabled(request)`.
2. Create flows **A**, **B**, **C** via `createRunnableChatFlowViaApi()`; keep the
   three ids.
3. `PATCH` **A** → `{ flow_type: "agent", a2a_enabled: true }`.
4. `PATCH` **B** → `{ flow_type: "workflow", a2a_enabled: true }`.
5. `PATCH` **C** → `{ flow_type: "agent", a2a_enabled: false }`.
6. `GET /api/v1/a2a/agents` → assert `200` and that the body is an array.
7. Build the id set; assert it **contains A**, **does not contain B**, **does not
   contain C**.
8. Read **A**'s row; assert its keys are exactly `id`, `name`, `description`,
   `cardUrl`, and that `cardUrl` ends in
   `/api/v1/a2a/{A}/.well-known/agent-card.json`.
9. `GET` that `cardUrl` **verbatim from the response** → assert `200`. This is
   what proves the catalog hands out a working address rather than a plausible
   string.
10. Delete A, B, C.

**Test 2 — `unpublishing removes the flow from discovery`**
1. Create and publish flow **A**; `GET /api/v1/a2a/agents` → assert **A** present.
2. `PATCH` **A** → `{ a2a_enabled: false }`.
3. `GET /api/v1/a2a/agents` → assert **A** absent.
4. `GET` **A**'s card → assert `404`, tying the catalog and the card to the same
   state (a catalog that dropped the row while the card still served would be the
   worse half-failure).
5. Delete **A**.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | filter | one `GET`: A present, B and C absent; A's row keys exact; A's `cardUrl` fetched verbatim → `200` |
| 2 | unpublish | A present → `PATCH a2a_enabled=false` → A absent **and** its card `404` |

---

## Measured behaviour worth knowing *(scout, `1.12.0.dev14`)*

- **The row serves the FLOW's name, not the card override.** A flow published with
  `a2a_card_overrides.name = "Scout Agent"` was still listed as
  `scout2-agent-068a93`. Asserting on the name would encode a bug as expected
  behaviour; the spec asserts `id` and `cardUrl`.
- Row keys are exactly `['cardUrl', 'description', 'id', 'name']` — no
  `flow_type`, no `a2a_enabled`, so the *reason* a flow is listed is not
  observable from the row. That is why the filter is proven by absence of B and C
  rather than by inspecting fields.
- The endpoint is **404 when the server flag is off** (the guard is a route
  dependency, resolved before auth, so an anonymous caller cannot tell a disabled
  route from an unmounted one). `requireA2aEnabled()` exists so this spec reports
  that as a configuration error instead of a filter failure.
