# API Integrations — the capability manifest and the effective policy, cross-checked against the catalog

**File:** `tests/tests-automations/regression/api/connections/api-integrations-manifest.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev21`)

Owning issue: #1968 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order and dependencies in the #1971 comment). Seeds through
`tests/helpers/integrations/`, the helpers #1966 built.

---

## What this test validates *(required)*

`GET /api/v1/integrations` is the capability manifest (upstream INT-3 / INT-7) and
`GET /api/v1/integrations/policy/effective` is the operator ceiling. Together they decide
what a builder may place and run: a picker renders what the manifest lists, and execution
fails closed against the policy. Nothing in the suite read either one before.

The load-bearing half is the **cross-check**. The manifest's `component_ref` is a promise
that a component exists, and the saved-flow contract says its identity is
`ext:<provider_id>:<Class>@official`. `GET /api/v1/all` answers that independently.
**No upstream test crosses the two** — the manifest is covered by
`test_integrations.py`, the catalog elsewhere — so a component renamed on one side and
not the other is a node a user can place and cannot resolve, and nothing today would see
it. That assertion needs both endpoints in one process, which is what this suite is.

Measured on `langflowai/langflow-nightly:latest` = `1.13.0.dev21` before the spec was
written, and identical on `1.13.0.dev19` (the image the issue measured), so nothing
between the two moved:

| Provider | `approved` | `enabled` | `connection_count` | capabilities |
|---|---|---|---|---|
| `google` | `true` | `false` | `0` | 5 |
| `microsoft` | `true` | `false` | `0` | 8 |
| `slack` | `true` | `false` | `0` | 7 |

- The provider row carries **8** keys: `provider_id`, `display_name`, `icon`, `docs_url`,
  `approved`, `enabled`, `connection_count`, `capabilities`. Rows come back sorted by
  `provider_id`.
- The capability carries **13**: `id`, `display_name`, `policy_keys`, `risk`, `maturity`,
  `substrate`, `identity`, `auth_profile_id`, `deployment_contexts`, `component_ref`,
  `mcp_tool`, `allowed`, `blocked_policy_key`.
- `policy/effective` answers **6**: `approved_provider_ids`, `blocked_action_keys`,
  `loaded_provider_ids`, `unrestricted`, `managed_externally`, `policy_revision` —
  measured `["google","microsoft","slack"]`, `[]`, the same three, `true`, `false`, `1`.
- All **20** capabilities cross-check: `ext:<provider_id>:<component_ref>@official` is a
  key of `GET /api/v1/all`, and the entry's own `namespaced_id` is that same string.

### The enum domains are the DECLARED ones, not the measured ones

The issue states `risk ∈ {read, write}`, which is what the 20 shipped capabilities use.
Upstream declares **three** (`lfx/integrations/capabilities.py`):

| Field | Declared domain | Measured on `dev21` |
|---|---|---|
| `risk` | `read` · `write` · **`destructive`** | `read`, `write` |
| `identity` | `user_delegated` · `bot` · `service` | `user_delegated`, `bot` |
| `substrate` | `sdk` · `rest` · **`mcp`** | `sdk`, `rest` |
| `maturity` | `ga` · `preview` · `developer_preview` · `beta` · `deprecated` | `ga` |
| `deployment_contexts` | `hosted` · `self_managed` · `desktop` · `headless` | two of the four sets |

The spec asserts membership in the **declared** domain. Asserting the measured set is the
same mistake as asserting the counts the issue forbids: the first `destructive` or `mcp`
capability INT-10..12 ships would redden a test that had found nothing wrong.

### Non-vacuity — the cross-check must not be able to check nothing

`component_ref` is `str | None`: upstream's model requires
`component_ref or mcp_tool`, not `component_ref`. A loop that silently skips a `null`
`component_ref` therefore passes, having asserted nothing, the day a regression nulls the
field — #1092's silence in a new place. So the spec asserts a floor: at least one
provider, at least one capability per provider, and at least one capability actually
cross-checked. It asserts no upper bound and no total.

### Where the measurement disagrees with the issue

- **29 catalog entries, not 23.** `ext:(google|microsoft|slack):…@official` resolves 29
  times across the three categories; **20** of them are what the manifest references. The
  remainder are pre-existing, non-integration components that live in the same bundle
  category — `ext:google:GoogleGenerativeAIComponent@official`,
  `ext:google:GoogleSearchAPICore@official`, `ext:google:GoogleOAuthToken@official` and
  six more. The cross-check runs manifest → catalog and never the other way, so the
  surplus is expected and is not asserted in either direction.
- **`risk` has a third value upstream** — see the table above.

### Recorded, not asserted

- **`policy_keys` is exactly `["integrations." + capability.id]`, 20 of 20.** The contract
  upstream enforces is weaker — each key must parse as
  `integrations.<provider_id>.<action>` and sit inside the owning provider's namespace —
  and `policy_keys` is a list precisely so a capability may declare several. Asserting the
  measured 1:1 identity would redden a legitimate manifest, so the spec asserts the
  grammar and the namespace, which is what governance actually blocks on.
- **The catalog entry's `display_name` equals the capability's, 20 of 20** — the picker
  label and the canvas node label agree today. Not asserted: nothing upstream promises it,
  and a copy edit on one side is not a defect this file should own.
- **Every referenced component sits under the category named after its own provider**
  (`google`, `microsoft`, `slack`). The spec asserts presence under *a* category and
  reports which one on failure, per the issue's wording: `files_and_knowledge` is this
  repo's own record of a reparenting that was legitimate, so pinning the category would
  add a failure mode the issue did not ask for.
- **A credential-free connection still counts.** A `pending` row (created without
  `credentials`) raises `connection_count` and flips `enabled` just as a `ready` one does —
  `enabled = approved and connection_count > 0`, with no reference to credential state.
  Whether a provider with only unusable connections should read `enabled` is an upstream
  question; this file makes no claim and always seeds a `ready` row.

### Not in scope

- **Blocking a provider or an action.** Integration policy is instance-global, so a spec
  that blocks one blocks it for every worker sharing that Langflow — the
  `@governance @destructive` lane, and a separate issue. This file asserts the
  *unrestricted* baseline and the agreement between the two endpoints, which is what makes
  a future policy change visible instead of silently one-sided.
- **Enforcement at execution** (upstream `policy-enforcement`) — needs the blocking above
  plus a flow run.
- **`include_blocked=true`**, the superuser-only operator view: it only ever adds rows the
  unrestricted baseline already omits nothing from.

## Preconditions and parallel safety

- **The instance is unrestricted.** No integration policy bundle and no
  `managed_externally` ceiling. Test 4 fails rather than skips if that stops being true:
  an instance-global configuration change is exactly what this file should surface, and a
  skip would report it as coverage.
- **`microsoft` is this file's provider and `slack` is its untouched control.** Every
  other spec in the batch seeds `google` (the helper's default), so `connection_count` for
  `google` is contended between workers and is never asserted here. Test 3 asserts
  `microsoft`'s count moves by exactly one and `slack`'s does not move at all — which is
  what proves the derivation is per provider and not a global flag. A future spec seeding
  `microsoft` or `slack` breaks that reservation, and the failure names the contention.
- **No assertion reads a list length, a position, or a total.** The invariant
  `enabled === (approved && connection_count > 0)` is asserted on every row of every read
  and cannot race; the round trip is asserted as a delta against a baseline read taken
  inside the same test.
- **Budget.** The two integration routes share the connections **metadata-read** bucket
  (60/min per user, `get_metadata_read_limit()`); this file issues 9 reads per run. Writes
  come from the shared **write** bucket (30/min per user) and this file spends **2** — one
  create and one delete, both in test 3.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model, no run, no network egress — the planted credential
never leaves the instance, and the only write is one connection this file deletes.
`@stable` enters in this PR rather than after a seasoning period.

---

## Step by step *(required)*

Five tests over the `request` fixture, each declaring its operations through
`apiCoverage`. Only test 3 writes; it registers its connection name before sending it and
`afterEach` deletes the row by that marker, reading the list once so no write is spent on
a row that is already gone.

**Test 1 — `every provider row and every capability declares its full field set, with each enum-valued field inside its declared domain`**
1. `GET /api/v1/integrations` → `200`, a body whose only key is `providers`.
2. `providers` is a non-empty array, sorted by `provider_id`, with unique ids each
   matching `^[a-z0-9][a-z0-9._-]*$`.
3. Each provider row's key set equals the 8 above; `display_name` is non-empty;
   `connection_count` is an integer `>= 0`; `approved` is `true` (a blocked provider is
   omitted from the default listing, so a `false` here would mean the omission broke);
   `enabled === (approved && connection_count > 0)`; `capabilities` is non-empty.
4. Each capability's key set equals the 13 above, asserted per capability so the message
   names the one that drifted.
5. Per capability: `id` matches `^[a-z0-9][a-z0-9._-]*$` **and** starts with
   `<provider_id>.`; ids are unique within the provider; `display_name` is non-empty;
   `auth_profile_id` matches `^[a-z0-9][a-z0-9_-]*$`; `risk`, `identity`, `substrate` and
   `maturity` are each inside their declared domain.
6. Per capability: `component_ref` or `mcp_tool` is a non-empty string — the execution
   target upstream's model refuses to build without — and `substrate: "mcp"` implies
   `mcp_tool`.
7. Capabilities sharing an `auth_profile_id` declare the **same** `identity` — the
   observable shadow of upstream's profile↔identity check, and what makes the
   `slack.bot.*` / `slack.user.*` split (`bot` against `user_delegated`) asserted rather
   than ignored, without hardcoding that slack has both.

**Test 2 — `every capability's component_ref resolves to a catalog entry that identifies itself by the same namespaced id`**
1. `GET /api/v1/integrations` → `200`; `GET /api/v1/all` → `200`.
2. Index the catalog over its category objects, **excluding `component_display_names`** —
   a metadata map keyed by the lowercased type name, not a category (its keys are
   `ext:google:gmailsendcomponent@official`, so counting it would let a cross-check pass
   on a component the canvas cannot place).
3. For each capability carrying a `component_ref`, build
   `ext:<provider_id>:<component_ref>@official` and assert it is a key of some category;
   the failure message names the capability, the expected id and the categories searched.
4. That entry's own `namespaced_id` equals the same string — the entry identifies itself
   by the id the manifest promised, so a catalog keyed off a stale mapping is caught too.
5. At least one capability was cross-checked (the non-vacuity floor), and every capability
   that carried a `component_ref` was.

**Test 3 — `a provider's enabled flag and connection count are derived from its connections, and only its own`**
1. `GET /api/v1/integrations` → baseline `connection_count` for `microsoft` (`c0`) and the
   whole `slack` row (the control); the derivation invariant holds on every row.
2. Seed one `ready` connection for `microsoft` through `createConnectionViaApi`
   (`providerKey: "microsoft"`), registering its name for teardown first.
3. `GET /api/v1/integrations` → `microsoft` reads `connection_count === c0 + 1` and
   `enabled === true`; the `slack` row is unchanged; the invariant still holds on every
   row.
4. Delete it through `deleteConnection`, which throws on anything that is not `2xx` or
   `404` and waits out one `429`. The status is deliberately **not** the assertion: a
   write's `2xx` precedes the commit and a `DELETE`'s does not prove removal
   (#1759/#1777/#1807), and the manifest re-read in step 5 is the proof.
5. `GET /api/v1/integrations` → `microsoft` reads `connection_count === c0` and
   `enabled === (c0 > 0)`; the `slack` row is still unchanged — so the flip followed the
   connection in both directions and touched no other provider.

**Test 4 — `the manifest and the effective policy agree that the instance is unrestricted`**
1. `GET /api/v1/integrations/policy/effective` → `200`, a key set equal to the 6 above.
2. `unrestricted === true`, `blocked_action_keys` is empty, `managed_externally === false`,
   `policy_revision` is an integer or `null`.
3. `approved_provider_ids` is non-empty, sorted, and deep-equals `loaded_provider_ids` —
   which is what `unrestricted` means, asserted rather than trusted.
4. `GET /api/v1/integrations` → the provider ids it lists deep-equal
   `approved_provider_ids`: the manifest advertises the approved set and nothing else.
5. Every capability of every provider reads `allowed === true` and
   `blocked_policy_key === null`. The two endpoints are therefore asserted as **agreeing**:
   a ceiling that appears on one side and not the other fails here whichever side moves.

**Test 5 — `every capability is governable — its policy keys use the grammar for its own provider, and its deployment contexts are declared`**
1. `GET /api/v1/integrations` → `200`.
2. Per capability, `policy_keys` is non-empty and free of duplicates.
3. Each key, case-folded, starts with `integrations.<provider_id>.`, splits into at least
   three non-empty segments, and uses only `[a-z0-9._-]` — the grammar
   `normalize_integration_policy_key` enforces, and the reason a key outside it is a
   manifest bug: an operator could never block that action.
4. `deployment_contexts` is non-empty, free of duplicates, and a subset of
   `{hosted, self_managed, desktop, headless}`.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev21`, with: every provider row asserted as the exact 8-key set and every
capability as the exact 13-key set; every enum-valued field asserted against its
**declared** domain rather than the measured one; all 20 capabilities cross-checking to a
`GET /api/v1/all` entry whose `namespaced_id` is the same `ext:…@official` string, with
`component_display_names` excluded from the index and a non-vacuity floor proving the loop
ran; `microsoft`'s `connection_count` moving `c0 → c0+1 → c0` around one seeded connection
while `slack`'s row does not move and `enabled === (approved && connection_count > 0)`
holds on every row of every read; `policy/effective` reporting `unrestricted: true` with
an empty `blocked_action_keys` and `approved_provider_ids` deep-equal to both
`loaded_provider_ids` and the manifest's provider ids; and no count, total or list length
asserted anywhere. `GET /api/v1/connections` reads back **zero** rows carrying this file's
marker after the run, and the declared coverage — `GET /api/v1/integrations`,
`GET /api/v1/integrations/policy/effective`, `GET /api/v1/all`,
`POST /api/v1/connections`, `DELETE /api/v1/connections/{connection_id}` — matches what
the fixture recorded.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser,
  **unrestricted**: no integration policy bundle and no externally managed ceiling.
- `src/backend/base/langflow/api/v1/integrations.py` — both routes under test, the
  `IntegrationProviderRead` / `IntegrationCapabilityRead` / `EffectiveIntegrationPolicyRead`
  shapes asserted here, the `enabled = approved and connection_count > 0` derivation, and
  the omission of blocked providers and actions from the default listing.
- `src/backend/base/langflow/services/integration_policy_discovery.py` — how the ceiling
  and the action deny-list are resolved for the caller.
- `src/backend/base/langflow/api/v1/connections.py` — the create and delete test 3 drives,
  and the per-user write bucket its budget is sized against.
- `src/lfx/src/lfx/integrations/capabilities.py` — the declared enum domains
  (`IntegrationIdentity`, `ExecutionSubstrate`, `CapabilityMaturity`, `DeploymentContext`,
  `risk`), the `component_ref or mcp_tool` requirement, and the provider-namespace checks
  on capability ids, policy keys and auth profiles.
- `src/lfx/src/lfx/services/integration_policy/base.py` —
  `normalize_integration_policy_key`, the `integrations.<provider_id>.<action>` grammar
  test 5 asserts.
- `tests/helpers/integrations/create-connection.ts` and
  `tests/helpers/integrations/delete-connection.ts` — the seeding and teardown helpers.
- These upstream paths resolve on `release-1.13.0` and **not** on `main`, which does not
  carry the feature yet, so the doc-dependency guard reports a `::notice::`, not a
  failure. No provider key, no model, no network egress.
