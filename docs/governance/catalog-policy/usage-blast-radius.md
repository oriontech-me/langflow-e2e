# Catalog Policy — Usage Reports the Blast Radius of a Block

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev28`)

---

## What this test validates *(required)*

Before an operator blocks a component, `GET /api/v1/catalog-policy/usage` and
`GET /api/v1/catalog-policy/usage/flows?component=<key>` are how they find out
what the block will break. The report is only worth anything if it is **the same
set the block then refuses** — a report that under-counts lets an operator break
flows they were never told about, and one that over-counts talks them out of a
block that was safe. So this spec asserts the report twice: once against the flows
it created, and once against what the block actually does to them.

Surfaces asserted here, all measured on `1.13.0.dev28`:

- **exact membership** — `usage/flows` names every flow the spec saved with the
  target component and nothing the instance did not already report before the spec
  wrote anything. A control flow that does not use the component must be absent.
- **one count per flow** — `usage.components` agrees with the number of flows
  `usage/flows` names from the same scan, so a flow carrying the component on
  **two** nodes counts once, as the schema promises ("a flow is counted once per
  component").
- **aliases resolve to the canonical key** — a node stored under the component's
  Python class name (`MockDataGeneratorComponent`) is counted under
  `MockDataGenerator`, never under its own key, and querying `usage/flows` **by
  the alias** returns the same set. This is the same resolution the write-path
  enforcement applies, which is the whole reason it is asserted: the refusal
  names the canonical key even for the alias node.
- **instance-wide scope** — a flow owned by **another user** is in the report. The
  policy is instance-global, so a report scoped to the operator's own flows would
  under-count by construction. Measured, and not asserted because it is a
  flows-API authorization fact rather than a governance one: the superuser gets
  `404` on `GET /api/v1/flows/{id}` for that flow, so this report is the **only**
  surface on which the operator can see it at all.
- **superuser-only** — a regular user calling `usage` is refused `403`. The
  report names every user's flows, so reading it is an admin act.
- **`total` is the full count** — `limit=1` truncates `flows` to one entry while
  `total` still reports every match. An operator paging a large blast radius must
  not be told it is one flow wide.
- **the report survives the policy write** — after the block is applied,
  `usage/flows` still names the same set. Usage is a property of the stored flows,
  not of the policy, and an operator checking what they just broke needs it
  unchanged.
- **reported ⇔ refused** — with the block applied, re-saving each flow the spec
  created **as its owner, with its own stored data** is refused `400` naming
  `MockDataGenerator` for exactly the reported flows (the other user's included),
  while the control flow saves `200`. Every refused flow stays readable by its
  owner (`200`) — the block restricts writes, it does not delete work.
- **the refusal was the policy's** — after the policy is cleared, the same
  re-saves that were refused are accepted `200`.

Measured and deliberately **not** asserted: with the block applied, **any** write
to an affected flow is refused — a name-only or description-only `PATCH` gets the
same `400`, so an affected flow cannot even be renamed. That is a product choice
upstream may reasonably revisit; the spec re-saves the flow's own data, which is
what the editor's save sends and the refusal a user actually meets.

### The report lags writes by up to 30 s — by contract

Both endpoints serve one flow-table scan from a process-local cache for
`USAGE_SCAN_CACHE_TTL_SECONDS = 30.0` ("counts may lag flow writes by up to this
window"). Measured: flows created right after a read appeared in the report after
**30 s** exactly. The spec therefore **polls** for the expected set, bounded at
**45 s** (the TTL plus margin). That is the documented contract, not a retry to
make a flake pass: a report that never converges — a cache that stopped expiring
— fails the poll, and the poll's failure message prints what the report said.

The same cache decides how the **baseline** may be used. It is read before the
spec writes anything, and it can be a scan up to 30 s old — so it may still name
flows **deleted** since. Measured: a back-to-back re-run's baseline carried the
previous run's four flows, deleted seconds earlier, and a first version of this
spec that expected `baseline ∪ created` exactly waited 45 s for flows that were
correctly gone. The baseline is therefore an **upper bound** on what else the
converged report may contain, never an exact expectation: the report must hold
every created flow and nothing outside `baseline ∪ created`. On a fresh instance
the baseline is empty and the two readings coincide.

## Tags *(required)*

`@destructive` `@api` `@governance`

**Not `@stable`, and the reason is the lane, not the test's maturity** — the same
as `component-blocklist-enforcement.md`. Blocking a component is visible to every
worker sharing the instance, which is the `@destructive` contract
(`playwright.config.ts` `grepInvert`s it out of every normal run; `PW_DESTRUCTIVE=1`
runs it alone at `workers: 1`), and `daily-stable.yml` has no destructive lane, so
`@stable` would make a test that silently never runs (#1010). It runs in
`pr-validation.yml`'s destructive step whenever the import graph selects it.

## Precondition *(required)*

- The instance's catalog policy is **pristine** — nothing blocked, no provider
  allowlist. The spec skips naming what it found otherwise: on a pre-blocked
  instance the "refused only after the block" assertion is unfalsifiable, and
  stomping a policy configured on purpose is worse than not running.
- `POST /api/v1/users/` is available to the superuser and the created user can
  log in once (`POST /api/v1/login`, limited to 5/min per client IP —
  `createThrowawayUser` waits out a refused window).

## Step by step *(required)*

The three tests share one setup and each one can run on its own — `--grep` on any
single title reaches its assertions with everything it needs. That is deliberate:
a test that only works after its predecessor cannot be force-failed alone, since
it would fail for want of state whether or not anything was mutated.

**Setup (`beforeAll`)**

1. Snapshot the policy bundle (`GET /api/v1/policy-bundle`) and require it
   pristine; skip with the observed state otherwise.
2. `GET /api/v1/all` lists `MockDataGenerator` — without it the queries below would
   resolve an unknown key to itself and prove nothing.
3. Record the baseline: the ids `usage/flows?component=MockDataGenerator` reports
   (normally none — no starter project uses it; possibly flows deleted within the
   last 30 s, see the cache note above).
4. Create, as the superuser: **single** (one `MockDataGenerator` node), **double**
   (two `MockDataGenerator` nodes plus a `ChatInput`), **alias** (one node stored
   as `MockDataGeneratorComponent`) and **control** (`ChatInput` only). Create a
   throwaway user and, as that user, **foreign** (one `MockDataGenerator` node).

**Converged report** — used by tests 1 and 2: poll
`usage/flows?component=MockDataGenerator` (≤ 45 s) until its ids contain
{single, double, alias, foreign} and nothing outside baseline ∪ those four.

**Test 1 — the report names exactly the flows that use the component**

5. Wait for the converged report; assert **control** is absent and `total` equals
   the number of flows returned.
6. `GET /usage` → `components.MockDataGenerator` equals the number of flows step 5
   named (double once, alias under the canonical key) and there is no
   `MockDataGeneratorComponent` key.
7. `usage/flows?component=MockDataGeneratorComponent` → the same id set as step 5.
8. `usage/flows?component=MockDataGenerator&limit=1` → one flow, `total` unchanged.
9. The throwaway user calls `GET /usage` → `403`.

**Test 2 — blocking refuses exactly the reported set**

10. Wait for the converged report.
11. `PUT /api/v1/catalog-policy/components` `{"blocked":["MockDataGenerator"]}` →
    `200`, echoing the blocked set.
12. `usage/flows?component=MockDataGenerator` still reports the step-10 set.
13. Re-save each created flow as its owner (`PATCH /api/v1/flows/{id}` with its
    own stored `data`): single, double, alias and foreign → `400` naming
    `MockDataGenerator`; control → `200`. The refused set must equal the reported
    set restricted to the spec's flows. Each refused flow still reads `200` for its
    owner.

**Test 3 — clearing the policy lifts the refusal**

14. Apply the block (idempotent when test 2 already did) and confirm **single**'s
    re-save is refused `400` — without that, a lifted refusal proves nothing.
15. Restore the snapshot and verify the bundle's component blocklist is back to
    the snapshot; re-save single, double, alias and foreign again → `200` each.

## Validation criterion *(required)*

Fails if the usage report omits a flow that uses the component — including one
saved under an alias or owned by another user — names a flow that does not use it,
counts a flow with two such nodes twice, reports the alias under its own key,
answers an alias query with a different set, lets `total` follow `limit`, is
readable by a non-superuser, changes when the policy is applied, or does not
converge within the documented 30 s lag (polled to 45 s). Fails, too, if the set
the block refuses differs from the set the report named — a reported flow that
still saves, an unreported flow that is refused, a refusal that is a `500` or does
not name the component, a refused flow that stops being readable, or a refusal
that outlives the policy.

**The restore is an assertion, not a teardown convenience**: a failed restore
leaves the shared instance with a component blocked for the rest of the lane.

## Cleanup

Every flow is deleted by id in `afterAll` — the superuser's through the superuser
token, **foreign** through the throwaway user's own context — and the user is then
deleted. Measured: deleting a user cascades to its flows (`usage` drops them after
the TTL), so the user delete alone would not leak; the explicit flow delete is
there so cleanup does not rest on that cascade.

## External dependencies *(required)*

- A Langflow instance on the 1.13 line (the endpoints exist on 1.12 too). No
  Enterprise image, no license, no provider key, no network egress.
- `MockDataGenerator` (`Mock Data`, core `data_source` family, so it survives the
  M4 shim deletion — `docs/component-distribution-policy.md`). Chosen because it is
  used by **no** starter project (baseline count 0 on a fresh instance), referenced
  by no other spec or doc (only the catalog-drift baseline JSON), and is neither
  `legacy` nor `beta` — `Notify`, the first candidate, measured identically but is
  `beta: true`. `DynamicCreateData` was excluded on purpose: it is
  `component-blocklist-enforcement.spec.ts`'s target, and the two specs run in the
  same lane.

## Upstream dependencies *(source paths watched)*

Verified to resolve on `langflow-ai/langflow@main` and `@release-1.13.0`:

- `src/backend/base/langflow/api/v1/catalog_policy.py` — the `usage` /
  `usage/flows` endpoints, the 30 s scan cache and the superuser gate.
- `src/backend/base/langflow/api/v1/schemas/catalog_policy.py` — the response
  schemas (`components`, `flows_scanned`, `total`, `flows`).
- `src/lfx/src/lfx/utils/component_aliases.py` — `ComponentIdentityIndex`, the
  alias resolution both the report and the enforcement use.
- `src/lfx/src/lfx/utils/flow_validation.py` — `collect_catalog_component_keys`
  and the `Flow build blocked: catalog policy blocks components: …` refusal.
- `src/lfx/src/lfx/components/data_source/mock_data.py` — the target component.
