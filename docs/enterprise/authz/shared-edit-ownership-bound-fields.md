# Enterprise — A Shared Editor Cannot Change a Flow's Ownership-Bound Fields

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

On Enterprise with RBAC, a user who does **not** own a flow can still be allowed to edit it:
the owner shares it with them at `write`, or they hold `developer` on the project it lives in.
That is a *shared edit*: the actor and the owner are different people, and the actor's write
access is real.

Some fields of a flow are not the editor's to change, because they decide who the flow belongs
to and where it lives, not what it does. The flow write paths refuse a non-owner who tries to
change any of them, with a `403` naming the field. This spec pins that refusal, the write
access it sits next to, and the fact that a refused write leaves the flow as it was.

It is the Enterprise half of #2553. On OSS a non-owner cannot load another user's flow at all
(every read and write answers `404`), so these guards are unreachable there. They only run for
a shared edit, which only exists with RBAC.

### Measured on the RBAC variant

Owner: the superuser. Editor: a role-less user holding a `write` share on the flow. The flow
lives in a project the superuser owns.

| Editor's request | `PATCH /api/v1/flows/{id}` | `PUT /api/v1/flows/{id}` (upsert) |
|---|---|---|
| `name` (control) | `200` | `200` |
| `a2a_enabled: true` (with or without `flow_type: "agent"`) | `403 Cannot change a2a_enabled of a flow you do not own.` | `403`, same detail |
| `a2a_enabled: false`, the value it already has | `200` | — |
| `a2a_card_overrides` | `403 Cannot change a2a_card_overrides of a flow you do not own.` | `403`, same detail |
| `folder_id`: another of the owner's projects | `403 Cannot change folder of a flow you do not own.` | `403`, same detail |
| `folder_id`: a project the editor owns | `403`, same detail | — |
| `fs_path` | `403 Cannot change fs_path of a flow you do not own.` | `403`, same detail |
| `user_id`: the editor | `200`, **field discarded**, owner unchanged | `403 Cannot transfer ownership of a flow you do not own.` |
| `user_id`: the owner, the value it already has | — | `200` |
| `workspace_id`: any value | `200`, **field discarded**, workspace unchanged | — |

Before the share, the same editor gets `404 Flow not found` on the flow, so the access these
requests use comes from the share. A user holding `developer` on the flow's **project** (no
share) gets the same `403`s for `a2a_enabled` and `a2a_card_overrides`: the rule is "the actor
is not the owner", not "the access came from a share".

The guards refuse a **change**, not a field. Sending a field with the value the flow already
has is accepted on both paths. A spec that asserted "any request carrying `a2a_enabled` is
refused" would fail against a correct product.

### Two guards in the code that no request reaches

The OSS code carries two more ownership messages. Both are measured as unreachable, and the
spec asserts what happens instead, because "the flow did not change" is the property that
matters:

- **`Cannot transfer ownership…` on `PATCH`.** The `PATCH` body model (`FlowUpdate`) has no
  `user_id` field, so the value is dropped while the request is parsed, before the guard runs.
  The request answers `200` and the owner is unchanged. The `PUT` body model does carry
  `user_id`, and there the guard answers `403`.
- **`Cannot change workspace…` on `PATCH`.** The route overwrites `workspace_id` with the
  workspace it resolves from the owner's folder before the guard compares it. A caller's value
  never reaches the comparison, so the request answers `200` and the workspace is unchanged.

Both `200`s are asserted exactly. If upstream adds `user_id` to `FlowUpdate`, or stops
overwriting `workspace_id`, the guard becomes reachable and the request starts answering
`403`. That is not a regression, but it changes what this spec measures, so the test fails
and names the change rather than passing on either answer.

### Why it matters

- **`a2a_enabled` and `a2a_card_overrides`** publish the flow as an A2A agent and decide what
  its public card says. An editor who could flip them would expose the owner's flow to A2A
  callers under the owner's name.
- **`folder_id`** moves the flow. Moved into the editor's own project, the editor would own
  the container the flow lives in; moved anywhere, the owner loses track of it.
- **`fs_path`** decides where the flow is written on disk, inside the owner's storage.
- **`user_id`** is the owner. Changing it is a takeover.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

All three tests gate on an instance that enforces (`authz_enabled` true, `superuser_bypass`
false). The editor is the subject shared by the whole `authz/` directory, reset before each
test through the superuser, which costs no login. Each test creates its own flow as the
superuser, in the superuser's `authz-foreign-scope` project, and deletes it at the end.

1. **Publishing as an A2A agent.**
   1. Before any share, the editor's `PATCH` of `name` answers `404`: no access yet.
   2. The superuser shares the flow with the editor at `write`. The editor's `PATCH` of `name`
      answers `200`: write access is real.
   3. The editor's `PATCH` of `{flow_type: "agent", a2a_enabled: true}` answers `403` with the
      `a2a_enabled` detail, asserted exactly.
   4. The editor's `PATCH` of `a2a_card_overrides` answers `403` with its own detail.
   5. The same two changes through `PUT` (the upsert path) answer the same two `403`s.
   6. The editor's `PATCH` of `a2a_enabled: false`, the value the flow already has, answers
      `200`.
   7. The owner reads the flow back: `a2a_enabled` false, `flow_type` unchanged,
      `a2a_card_overrides` unchanged.
   8. The share is deleted, and the editor's `PATCH` of `name` is back to `404`. The editor is
      then given `developer` on the flow's project instead: `PATCH` of `name` answers `200`,
      and of `a2a_enabled: true` answers the same `403`.
   9. Positive control: the owner's identical `PATCH` of
      `{flow_type: "agent", a2a_enabled: true}` answers `200`, and the read-back shows
      `a2a_enabled` true. Without it, a `403` could mean the body was invalid.
2. **Moving the flow or its storage path.** With the `write` share in place, and a second
   project created by the superuser for this test:
   1. The editor's `PATCH` of `folder_id` to the owner's second project answers `403` with the
      `folder` detail.
   2. The editor's `PATCH` of `folder_id` to a project the editor owns answers the same `403`.
   3. The editor's `PATCH` of `fs_path` answers `403` with the `fs_path` detail.
   4. The editor's `PUT` of `folder_id` and of `fs_path` answer the same two `403`s.
   5. The editor's `PATCH` of `workspace_id` to a random id answers `200`.
   6. The owner reads the flow back: `folder_id`, `fs_path` and `workspace_id` unchanged.
   7. Positive control: the owner's identical `PATCH` of `folder_id` to the second project
      answers `200`, and the read-back shows the new folder.
3. **Taking ownership.** With the `write` share in place:
   1. The editor's `PUT` with `user_id` set to the editor answers `403` with the
      `Cannot transfer ownership…` detail.
   2. The editor's `PUT` with `user_id` set to the owner, the value it already has, answers
      `200`. This is also the control that the `PUT` body is valid: it differs from step 1 only
      in that value.
   3. The editor's `PATCH` with `user_id` set to the editor answers `200`.
   4. The owner reads the flow back: `user_id` is still the owner.

## Validation criterion *(required)*

Fails when a non-owner editor can change any of `a2a_enabled`, `a2a_card_overrides`,
`folder_id`, `fs_path` or `user_id` on a flow shared with them, through `PATCH` or `PUT`; when
a refused write changes the flow anyway; when the refusal message changes; or when the editor
loses ordinary write access (the `name` control), which would make every `403` meaningless.
Also fails when `PATCH` starts answering differently for `user_id` or `workspace_id`, which
means one of the two unreachable guards has become reachable and the spec needs updating.

## External dependencies *(required)*

- The Enterprise RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, with `PLAYWRIGHT_BASE_URL`
  pointed at `http://localhost:7891`. On the 1.13 line the script sets
  `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`; without a licence the project
  creation this spec depends on answers `503` (#2259).
- **Zero or one** login per run, shared with the rest of the `authz/` directory (see
  `ownership-team-and-api-key.md`).
- `src/backend/base/langflow/api/v1/flows_helpers.py` — the guards, in OSS: `_patch_flow` for
  `PATCH` and `_update_existing_flow` for the `PUT` upsert.
- `src/backend/base/langflow/api/v1/flows.py` — `update_flow`, the `PATCH` route that replaces
  `workspace_id` before the guard compares it.
- `src/backend/base/langflow/services/database/models/flow/model.py` — `FlowUpdate`, the
  `PATCH` body model, which has no `user_id` field.
- No LLM provider and no network egress.

## Not covered

- **Hidden fields in a shared graph.** A non-owner's `data` goes through
  `restore_redacted_flow_values`, which answers `400 Cannot change hidden fields or executable
  graph data in a shared flow.` when the editor changes the metadata that hid one of the
  owner's secret values. It needs a flow holding a secret-marked field with a value, and it is
  part of the contract for what a shared editor can see, not of ownership. It belongs in its
  own spec.
- **A team share at `write`.** A direct share and a project role are measured; a team share
  reaches the same code (the actor is still not the owner) and is not repeated here.
