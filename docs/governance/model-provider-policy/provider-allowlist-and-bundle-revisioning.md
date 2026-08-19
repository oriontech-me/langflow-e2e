# Model Provider Policy — Allowlist Enforcement and Policy-Bundle Revisioning

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev32`)

---

## What this test validates *(required)*

Two halves of one mechanism, in one file because the second is the audit trail of
the first and they share the same expensive setup (a global policy write plus its
restore).

### 1 — The allowlist narrows what a user can pick

Model-provider governance is a **default-allow allowlist** keyed on the stable
`provider_id`, and the enforcement is not an echo of the policy — it reaches the
surfaces a user picks a model from. Measured on `1.12.0.dev32` with
`approved_provider_ids: ["openai"]`:

- `GET /api/v1/models/providers` goes from **11** provider names to exactly
  `["OpenAI"]`.
- `GET /api/v1/all` goes from **354** to **326** component types: every
  `ext:anthropic:*` type is gone (0 of them left) while the `ext:openai:*` ones
  stay (4). This is the half that matters — a policy that only filtered its own
  read-back would leave the blocked provider's components draggable.
- `registered_providers` in `GET /api/v1/model-provider-policy` still lists all
  11. That distinction is the spec's control: **the narrowing must be policy, not
  a lost distribution.** An instance that simply shipped without
  `lfx-anthropic` would show the same shortened provider list, and a spec that
  did not read `registered_providers` would call that a passing governance test
  (`docs/component-distribution-policy.md` is the standing record of how often
  packaging, not policy, is what removed a family).

Deliberately out of scope: the `get_llm` / `get_embeddings` runtime gate
(LE-1955), which is the bypass-proof one. Proving it needs a run that calls a
provider SDK with a real key, so it belongs with the credential-bearing specs,
not in this keyless file. Stated here rather than left to look like coverage.

### 2 — Every policy change is a numbered, reversible revision

The policy bundle is the audit surface an operator answers "who changed what, and
can we undo it" with. Measured contract:

- Each accepted write mints a **new revision** with `source: "api"`; nothing
  mutates a revision in place.
- `GET /api/v1/policy-bundle/history` returns them newest-first, and a fresh
  instance starts at revision 1 with `source: "migration"`, `initialized: false`.
- `POST /api/v1/policy-bundle/rollback/{revision}` requires
  `{"expected_revision": <active>}` and is **optimistically concurrent**: a stale
  value is refused **409** with `{"message":"Policy bundle revision conflict",
  "expected_revision":…, "active_revision":…}` — the body names both sides, which
  is what makes a conflict actionable instead of a retry loop.
- An accepted rollback does **not** rewind the counter: it appends a new revision
  carrying the old content, with `source: "rollback"`, `rollback_of_revision`
  pointing at the restored revision, and the caller's `reason` echoed back.
  Asserting the *content* came back while the *revision number moved forward* is
  the whole point — an implementation that reset the counter would erase the
  trail it exists to keep.

## Tags *(required)*

`@destructive` `@api` `@model-provider`

**Not `@stable`:** the policy is instance-global — narrowing providers hides
models from every worker sharing the Langflow — so this is the `@destructive`
lane (rationale in `../catalog-policy/component-blocklist-enforcement.md` →
*Tags*; `daily-stable.yml` has no destructive lane, #1010).

## Precondition *(required)*

The instance's provider allowlist and component blocklist are both empty, and at
least **two** providers are registered — with one registered provider the
allowlist cannot be shown to narrow anything and the test would be vacuous. Both
are skip conditions naming what was observed.

## Step by step *(required)*

1. Snapshot the bundle; require an empty policy and ≥2 registered providers.
2. **Control:** record `GET /api/v1/models/providers` (all names), the
   `/api/v1/all` type set, and the active revision.
3. `PUT /api/v1/model-provider-policy` with `{"approved_provider_ids":["openai"]}`
   → `200`, `approved_provider_ids` echoes exactly that.
4. `GET /api/v1/models/providers` → exactly the approved provider's display name;
   a control provider present in step 2 is gone.
5. `GET /api/v1/model-provider-policy` → `registered_providers` still contains the
   excluded provider (narrowing is policy, not packaging).
6. `GET /api/v1/all` → no `ext:<excluded provider>:` type remains, at least one
   `ext:openai:` type does, and the total type count is strictly lower.
7. `GET /api/v1/policy-bundle` → revision incremented, `source: "api"`,
   `approved_provider_ids` matching.
8. Write a second, unrelated policy change (block one component) so there are two
   revisions to move between; `GET /api/v1/policy-bundle/history` lists them
   newest-first.
9. `POST /api/v1/policy-bundle/rollback/{allowlist revision}` with a **stale**
   `expected_revision` → `409`, body naming `expected_revision` and
   `active_revision`.
10. Repeat with the active revision → `200`; the returned bundle has a **higher**
    revision than the one rolled back to, `source: "rollback"`,
    `rollback_of_revision` = the target, `reason` echoed, and the component
    blocklist from step 8 is cleared while the allowlist survives.
11. Restore the snapshot (empty allowlist, empty blocklist) and re-assert the
    provider list and the type count are back to their control values.

## Validation criterion *(required)*

Fails if the approved set does not match what was written, if a non-approved
provider's components remain in `/api/v1/all`, if `registered_providers` shrinks
with the policy (which would make the whole assertion vacuous), if a stale
`expected_revision` is accepted, if a rollback rewinds the revision counter or
loses its `rollback_of_revision` attribution, or if the instance does not return
to its control state.

## External dependencies *(required)*

- A Langflow instance on the 1.12 line. No Enterprise image, no license.
- **No API key and no network egress** — every surface here is policy metadata
  and the component catalog. `openai` is used as the allowlisted `provider_id`
  because it is always registered; whether a key exists for it is irrelevant, and
  the spec never resolves a model.

## Upstream dependencies *(source paths watched)*

Verified to resolve on `langflow-ai/langflow@release-1.12.0`:

- `src/backend/base/langflow/api/v1/model_provider_policy.py` — the allowlist
  endpoint and `registered_providers`.
- `src/backend/base/langflow/api/v1/policy_bundle.py` — revisions, history and
  the `expected_revision` conflict this spec asserts.
- `src/backend/base/langflow/services/catalog_policy/service.py` — the snapshot
  that carries both policies.
- `src/backend/base/langflow/services/catalog_policy/factory.py` — service wiring;
  a change here moves when the snapshot is refreshed.
