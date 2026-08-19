# Catalog Policy — Component Blocklist Enforcement

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev32`)

---

## What this test validates *(required)*

Catalog governance is an **OSS surface on 1.12**, not an Enterprise one. Measured
on `langflowai/langflow-nightly:latest` (`1.12.0.dev32`): `catalog-policy`,
`model-provider-policy` and `policy-bundle` all answer, and the block is
*enforced* — 25 of the EE build's 55 governance routes ship in OSS, and the ones
missing there (`sso/*`, `authz/status`, `authz/check`, `authz/admin/*`,
`enterprise-admin/catalog`) are all 404 on the nightly. What Enterprise adds on
top is the admin **UI** and the ability to declare the policy from the
environment; the OSS instance is driven through the API, which is what this spec
does.

With one component blocked, the block must hold on **both** the read surface and
the write surface. The pairing is the point: a component that disappears from the
palette but still saves into a flow is the exact defect class LE-1933 / BUG-02
recorded, and a spec that only checked the palette would have passed through it.

Surfaces asserted here, all measured on `1.12.0.dev32`:

- **policy echo** — `PUT /api/v1/catalog-policy/components` answers `200` with the
  blocked set it stored.
- **config flag** — `GET /api/v1/config` flips `catalog_governance_enabled`
  `false → true`. This is what a client gates its restricted states on, and it is
  a *derived* value: nobody sets it, so it is the cheapest proof the policy was
  actually adopted rather than merely persisted.
- **palette** — `GET /api/v1/all` drops the blocked type (354 → 352 types on the
  measured build) while an unrelated control type stays present. The count is
  asserted as a **decrease with the control surviving**, never as a literal
  number: the catalog moves with the image (`component-catalog-drift.ts` exists
  for that reason).
- **sidebar** — the blocked component is not findable in the flow-editor sidebar
  search. The palette is rendered from `/api/v1/all`, so this cannot disagree with
  the API — it is here because "the operator blocked it and the user can still
  see it" is the failure a reader of this spec will care about.
- **write path** — `POST /api/v1/flows/` carrying the blocked type is refused
  `400` with `Flow build blocked: catalog policy blocks components: <type>`.
  The refusal must name the component; a generic `400` and a `500` are both
  failures, since the refusal is a policy decision, not a crash.
- **stored work survives** — a flow saved **before** the block stays readable and
  its nodes unmodified (LE-1948). A policy change must never corrupt, delete or
  silently rewrite work that predates it.

## Tags *(required)*

`@destructive` `@api` `@governance`

**Not `@stable`, and the reason is the lane, not the test's maturity.** The
policy is global to the instance — there is no per-user or per-project scope — so
blocking a component is visible to every worker sharing that Langflow. That is
the `@destructive` contract (`playwright.config.ts` `grepInvert`s it out of every
normal run and `PW_DESTRUCTIVE=1` runs it alone at `workers: 1`), and
`daily-stable.yml` has no destructive lane, so `@stable` here would be a test
that silently never runs (#1010). It does run in `pr-validation.yml`'s destructive
step whenever the import graph selects it.

## Precondition *(required)*

The instance's catalog policy is **pristine** — no blocked components. The test
skips, naming the state it found, when it is not: a pre-blocked instance makes
every "absent after blocking" assertion unfalsifiable, and stomping a policy
someone configured on purpose is worse than not running.

## Step by step *(required)*

1. Snapshot the current bundle (`GET /api/v1/policy-bundle`) and require an empty
   component blocklist; skip with the observed state otherwise.
2. **Control:** `GET /api/v1/all` lists `DynamicCreateData`; `GET /api/v1/config`
   reports `catalog_governance_enabled: false`; a flow carrying a
   `DynamicCreateData` node saves `201`. Keep its id.
3. `PUT /api/v1/catalog-policy/components` with
   `{"blocked":["DynamicCreateData"]}` → `200`, echoing the blocked set.
4. `GET /api/v1/config` → `catalog_governance_enabled: true`.
5. `GET /api/v1/all` → `DynamicCreateData` absent, the control component
   (`ChatInput`) still present, total type count strictly lower than in step 2.
6. Open a flow in the editor, type the component's display name into
   `sidebar-search-input` → the sidebar shows its empty state and lists no
   draggable card.
7. `POST /api/v1/flows/` with a `DynamicCreateData` node → `400`, and the body
   names `DynamicCreateData`.
8. `GET /api/v1/flows/{id}` for the flow from step 2 → `200`, still carrying its
   `DynamicCreateData` node.
9. Restore: `PUT` the snapshot back, then re-assert `DynamicCreateData` is in
   `/api/v1/all` and the config flag is `false` again.

## Validation criterion *(required)*

Fails if the blocked component is still listed in the palette or findable in the
sidebar, if `catalog_governance_enabled` does not track the policy, if a flow
carrying the blocked component can be saved (or is refused with a `500` or a
message that does not name it), or if a flow that predates the block stops being
readable.

**The restore is also an assertion, not a teardown convenience.** A failed
restore leaves the shared instance with a component missing, which would redden
unrelated specs for the rest of the run — so the spec verifies the catalog came
back and fails loudly if it did not.

## External dependencies *(required)*

- A Langflow instance on the 1.12 line. No Enterprise image, no license, no
  provider key, no network egress.
- `DynamicCreateData` (`Dynamic Create Data`, core `processing` family) — chosen
  on two properties, both measured on `1.12.0.dev32`. It is referenced by **no**
  other spec or doc in the repo, so the blocked window cannot collide with
  another test's fixture; and it is **not** `legacy`, which the sidebar
  assertion depends on. The obvious first pick, `CombineText`, is `legacy: true`
  and therefore already absent from the sidebar on a pristine instance — the UI
  step would have passed without the policy doing anything, the exact
  unfalsifiable-assertion shape this area is full of.

## Upstream dependencies *(source paths watched)*

Verified to resolve on `langflow-ai/langflow@release-1.12.0` (a path that does not
exist is silent in a `git log` watch — the #1092 failure mode):

- `src/backend/base/langflow/api/v1/catalog_policy.py` — the `components` /
  `templates` read+write endpoints.
- `src/backend/base/langflow/services/catalog_policy/service.py` — the snapshot
  the palette filter and the write-path check both read.
- `src/lfx/src/lfx/utils/flow_validation.py` — raises the `Flow build blocked:
  catalog policy blocks components: …` refusal this spec asserts by message.
- `src/backend/base/langflow/api/v1/policy_bundle.py` — the bundle the policy is
  persisted into.
