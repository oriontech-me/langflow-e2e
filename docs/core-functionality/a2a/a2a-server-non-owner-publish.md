# A2A Server — a non-owner cannot publish someone else's flow (OSS)

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev35`)

**Issue:** #2553 · **Scoped by:** #1195 → `a2a-coverage-scope.md` (the *Out of scope*
row "Non-owner publish `403`", replaced by this spec) · **Depends on:** #1240
(`LANGFLOW_A2A_ENABLED=true` on every lane), #2044 (`createThrowawayUser`) ·
**Jira:** epic `LE-1588`

---

## What this test validates *(required)*

Publishing a flow as an A2A agent is a `PATCH /api/v1/flows/{id}` that sets
`flow_type: "agent"` and `a2a_enabled: true`. Once that is done, anyone with the URL
can reach the card and the JSON-RPC endpoint, and on a public project they can run
the flow. Only the flow's owner may decide that.

The checklist assumed the refusal was the `403 "Cannot change a2a_enabled of a flow
you do not own."` in `src/backend/base/langflow/api/v1/flows_helpers.py`. On OSS that
branch is unreachable. It guards a *shared edit*, where the actor is not the owner but
can still load the flow, and on OSS nobody but the owner can load it. Measured on
`1.14.0.dev35`:

- a regular user gets `404 "Flow not found"` for the superuser's flow, on read and on
  every write;
- the superuser gets the same `404` for a regular user's flow: there is no superuser
  bypass;
- a `developer` role assigned to a regular user on the owner's project
  (`POST /api/v1/authz/role-assignments`, `domain_type: project`) changes nothing.
  The assignment is stored, but OSS does not apply it
  (`GET /api/v1/authz/capabilities` → `team_role_assignments: false`).

So the OSS contract is **owner-only visibility**, and the property this spec guards is
the one that matters to the agent: **a non-owner's attempt to publish leaves the flow
unpublished**. Both directions are covered, because the privileged one (the superuser
on someone else's flow) is where a bypass would most plausibly live. The `403`
belongs to Enterprise with RBAC, where a shared flow exists. It is tracked in #2554
(see *Out of scope*).

---

## Tags *(required)*

`@stable` `@api` `@a2a` `@auth`

- `@api` — drives `/api/v1/flows/*` and `/api/v1/a2a/*` through `request` contexts;
  no UI.
- `@a2a` — functional area; requires `LANGFLOW_A2A_ENABLED=true` (`CLAUDE.md`).
- `@auth` — a second real user and an ownership boundary.
- `@stable` — shipped with the spec (#2553) after `--retries=0` bursts on nightly
  `1.14.0.dev35`: **10/10** with one worker and **10/10** with two, no backend error,
  no leaked user, flow or project. Each assertion family was force-failed: the owner
  standing in for the non-owner (test 1, and the regular user's credentials in test
  2's superuser step), a publish slipped in before the unchanged check, the owner's
  discovery read where the regular user's belongs, and an invalid `flow_type` in the
  publish body (see *Measured behaviour*).

---

## Validation criterion *(required)*

1. **A regular user cannot publish the superuser's flow.** For a flow the superuser
   owns, in a public project, not yet published:
   - the regular user's `GET /api/v1/flows/{id}` → `404`, `detail: "Flow not found"`;
   - their `PATCH` with `{ flow_type: "agent", a2a_enabled: true }` → `404`, same
     detail;
   - their `PATCH` with `{ a2a_card_overrides: { name: <sentinel> } }` → `404`, same
     detail;
   - afterwards the owner reads `flow_type`, `a2a_enabled` and `a2a_card_overrides`
     **unchanged** from before the attempts, `a2a_enabled` is `false`, the card is
     `404`, and the owner's `GET /api/v1/a2a/agents` does not list the flow.
   - **Positive control:** the owner's own `PATCH` with the identical body → `200`, and
     the card → `200`. The body is valid and the card endpoint answers a published
     flow, so the `404`s above are the ownership boundary and not a malformed request.
   - Once it is published, the regular user's `GET /api/v1/a2a/agents` still does not
     list it: discovery is owner-scoped.
2. **The superuser cannot publish a regular user's flow.** For a flow the regular user
   owns, not yet published:
   - the superuser's `GET` and `PATCH { flow_type: "agent", a2a_enabled: true }` →
     `404`, `detail: "Flow not found"`;
   - afterwards the owner reads the three fields unchanged, and the card is `404`;
   - **Positive control:** the owner's own identical `PATCH` → `200`, and the card →
     `200`.

---

## External dependencies *(required)*

- **`LANGFLOW_A2A_ENABLED=true`** on the instance under test — set by
  `scripts/start-langflow-docker.sh` and every lane since #1240; asserted at runtime
  by `requireA2aEnabled()`.
- **A second real user.** `createThrowawayUser` (#2044) creates it through the
  superuser's API, activates it, logs it in through a request context of its own (so
  no cookie reaches the superuser's `request`) and deletes it at the end. One
  `POST /api/v1/login` per test: OSS limits logins to 5 per minute per IP, and
  `postLogin` waits out a refused window.
- **No LLM, no provider key, no external network.** The flows are the Chat Input →
  Chat Output passthrough (`createRunnableChatFlowViaApi`).
- Auto-login superuser (`getAuthToken()`).

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL` with A2A enabled, OSS build.
- Each flow lives in a public project (`auth_type: "none"`) its owner creates
  (`createRunnableChatFlowInPublicProject`), so that once the owner publishes it the
  card answers a request with no key. A flow left in a default project would sit in
  an `apikey` project (#2412), and from langflow-ai/langflow#16538 (1.13.4, not yet in
  1.14, #2548) an anonymous card request there is `404`, which would break the
  positive controls.
- Every flow, project and user is deleted by id in `finally`. The regular user's flow
  and project are deleted through the regular user's own context before the user is
  deleted.

---

## Step by step *(required)*

**Test 1 — `a regular user cannot read or publish the superuser's flow`**
1. `requireA2aEnabled`; the superuser creates the passthrough flow in a public
   project of its own, and reads `flow_type`, `a2a_enabled` and
   `a2a_card_overrides`.
2. Create the throwaway user.
3. As the user: `GET`, `PATCH` publish, `PATCH` overrides → each `404 "Flow not
   found"`.
4. As the superuser: the three fields are unchanged, `a2a_enabled === false`, the card
   is `404`, `GET /api/v1/a2a/agents` does not list the flow.
5. As the superuser: the identical publish `PATCH` → `200`; the card → `200`.
6. As the user: `GET /api/v1/a2a/agents` does not list the flow.
7. `finally`: delete the flow and its project, then the user.

**Test 2 — `the superuser cannot publish a regular user's flow`**
1. `requireA2aEnabled`; create the throwaway user. As the user, create the passthrough
   flow in a public project of the user's own, and read the three fields.
2. As the superuser: `GET`, `PATCH` publish → each `404 "Flow not found"`.
3. As the user: the three fields are unchanged; the card is `404`.
4. As the user: the identical publish `PATCH` → `200`; the card → `200`.
5. `finally`: delete the flow and its project as the user, then the user.

---

## Validation *(required)*

| # | Test | Observable |
|---|---|---|
| 1 | regular user → superuser's flow | `404 "Flow not found"` ×3; the flow unchanged and unpublished (card `404`, not in discovery); the owner's identical `PATCH` → `200` and card `200`; still absent from the user's discovery |
| 2 | superuser → regular user's flow | `404 "Flow not found"` ×2; the flow unchanged, card `404`; the owner's identical `PATCH` → `200` and card `200` |

---

## Measured behaviour worth knowing *(scout, `1.14.0.dev35`)*

- **The `404` is the same as for a flow id that does not exist.** `GET` and `PATCH` on
  `00000000-0000-4000-8000-000000000000` answer the identical `404 {"detail":"Flow not
  found"}`, so a non-owner cannot tell "not yours" from "not there". It is the same
  choice the A2A routes make for an unpublished card.
- **Ownership is checked before the body, which is why the positive control exists.**
  A `name`-only `PATCH` by the non-owner is also `404`. More to the point, so is a
  `PATCH` whose `flow_type` is not a valid value. Force-failed with
  `flow_type: "not-a-type"`, the non-owner's three `404`s still passed, and only the
  owner's identical `PATCH` caught it (`422`, "Input should be 'workflow' or
  'agent'"). Without the owner's control, the spec would pass on a body the server
  could never have applied.

### Out of scope

- **The Enterprise `403`** (`"Cannot change a2a_enabled of a flow you do not own."`,
  and its siblings for `a2a_card_overrides`, folder, `fs_path`, workspace and owner
  transfer). It is reachable only where a non-owner can edit a shared flow, i.e.
  Enterprise with RBAC (`@enterprise @authz`, `LANGFLOW_EE_RBAC=1
  ./scripts/start-langflow-enterprise.sh`). Tracked in #2554.
- Role assignments on OSS. Asserting that OSS ignores them would pin a pass-through
  as a contract, and the day OSS starts applying them is a product decision this spec
  should not fight.
