# API Integrations — the capability manifest and the effective policy, cross-checked against the catalog

**File:** `tests/tests-automations/regression/api/connections/api-integrations-manifest.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #1968 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order and dependencies in the #1971 comment). Seeds through
`tests/helpers/integrations/`, the helpers #1966 built. Revised for #2074, when the body
grew a second top-level key — see *The top-level `deployment_context`* below — and for
#2310, when every capability grew two scope fields — see *The scope fields* below — and
for #2317, when test 3 moved to a reader of its own — see *Whose rows the count holds*
below.

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
| `slack` | `true` | `false` | `0` | 7 on `dev21`, **11** on `dev26` |

- The body carries **2** top-level keys on `dev26` — `providers` and `deployment_context`
  (only `providers` on `dev21`/`dev23`; see the #2074 section below).
- The provider row carries **8** keys: `provider_id`, `display_name`, `icon`, `docs_url`,
  `approved`, `enabled`, `connection_count`, `capabilities`. Rows come back sorted by
  `provider_id`. From `1.14.0.dev4` it carries a 9th, `manual_token_profiles`; see the #2336
  section below.
- The capability carries **15** on `dev47` (13 until then): `id`, `display_name`,
  `policy_keys`, `risk`, `maturity`, `substrate`, `identity`, `auth_profile_id`,
  `deployment_contexts`, `component_ref`, `mcp_tool`, `allowed`, `blocked_policy_key`, and
  since #2310 `required_scopes` and `conditional_scopes`.
- `policy/effective` answers **6**: `approved_provider_ids`, `blocked_action_keys`,
  `loaded_provider_ids`, `unrestricted`, `managed_externally`, `policy_revision` —
  measured `["google","microsoft","slack"]`, `[]`, the same three, `true`, `false`, `1`.
- All **24** capabilities cross-check (20 on `dev21`): `ext:<provider_id>:<component_ref>@official`
  is a key of `GET /api/v1/all`, and the entry's own `namespaced_id` is that same string.
  The 24 reference **22** distinct components — each Slack trigger component backs two
  capabilities, one per transport.

### The top-level `deployment_context` (#2074)

Between `1.13.0.dev23` and `1.13.0.dev26` the body grew a second top-level key, and all
five tests failed 3/3 at the first line of `readManifest`, which asserted the key set was
exactly `["providers"]`. Root-caused upstream, **not a product regression**: an intended,
documented contract addition.

- **Where it came from.** `langflow-ai/langflow#15333` (*Slack message and reaction
  triggers on the Events API and Socket Mode*, commit `2cdf8109bb`, 2026-09-24, on
  `release-1.13.0`) added `deployment_context: Literal["self_managed", "hosted", "desktop"]`
  to `IntegrationListRead`, with a `Field` description, a default of `self_managed`, and an
  upstream unit test (`test_list_integrations_reports_the_deployment_context`) parametrized
  over all three values. The value is `deployment_context()` in
  `services/connection/oauth/config.py`: `LANGFLOW_CONNECTION_OAUTH_CONTEXT`, and
  `self_managed` when that configuration is unset or unreadable.
- **Why the key is load-bearing, not decorative.** The Connections page hands it to the
  add-connection dialog, and `offersSlackToken()` offers the *paste a Slack app-level token*
  method only when it is **present and not `hosted`** — a deployment that has not said what
  it is yet offers nothing. So the key vanishing, or a default instance reading `hosted`,
  silently removes the only way a self-managed user connects Slack Socket Mode. The upstream
  unit test always *sets* the variable, so the **unset default** — which is what every lane
  of this suite runs — is covered by nothing upstream.
- **What the spec now asserts.** The body's key set is **exactly**
  `["deployment_context", "providers"]` — still an exact set, for the reason the provider and
  capability rows are: this endpoint sits next to the connection store, and a per-key check
  would pass a body that grew one. `deployment_context` is inside its **declared** top-level
  domain `{self_managed, hosted, desktop}` on every read — note it is narrower than the
  capability-level `DeploymentContext`, which also has `headless`. And test 5 asserts the
  instance reads `self_managed`, as a precondition in the same sense as test 4's
  `unrestricted`: no lane sets `LANGFLOW_CONNECTION_OAUTH_CONTEXT`, so anything else is either
  a configuration change this file should surface or a broken default.
- **Its interaction with tests 4 and 5**, which #2074 asked to check. None with the
  effective policy (test 4): the ceiling and the deny-list never read the deployment
  context. With the per-capability `deployment_contexts` (test 5), it is the value those
  lists are compared against — and on the `self_managed` instance the lanes run, **all 24**
  capabilities declare `self_managed`, so nothing is excluded here.

### `manual_token_profiles` on the 1.14 line (#2336)

`1.14.0.dev4` turned test 1 red on the daily of 2026-10-26: every provider row carried a key the
exact set did not list. Upstream #15947 (*"feat(triggers): support provider-owned connection and
source runtimes"*, merged into `release-1.14.0` on 2026-10-23) added to `IntegrationProviderRead`
`manual_token_profiles: list[ManualTokenProfileRead]`, default `[]`. It lists the `api_key`
auth profiles whose credential the provider itself validates, each one exactly
`{id, identity, required_scopes, requires_expiry}`.

The change is intended, and the set stays exact. But the 1.13 line never gets the key, and the
on-demand runs validate 1.13.x patch releases with this same suite. So the expected set is
chosen by the **served version** (`tests/helpers/other/served-version.ts`): 9 keys from
`1.14.0.dev4`, 8 before. The version decides, never the presence of the key, which would let a
1.14 build that lost it pass. On the 1.14 side the value must be a list, and for `google`,
`microsoft` and `slack` it must be `[]`. A profile is listed only for a trigger provider loaded
from the `langflow.trigger_providers` entry points, and that registry refuses the built-in ids
(`_BUILTINS` in `services/triggers/providers/registry.py`), so on every lane the list is empty
(measured on `1.14.0.dev6`: no entry point in that group). From `1.14.0.dev7` there is one: upstream
#15957 registers `github` in that group (#2360), and it lists one profile, `github-installation`
(identity `service`, no scopes, `requires_expiry: true`). A built-in that starts listing a
profile is therefore a change of contract. Any profile that does appear, from a provider
installed through an entry point, is asserted to carry exactly those four keys, an `id` in the
auth-profile pattern, an `identity` in the declared domain, a list of scopes and a boolean
expiry flag. On the 1.13 line no lane exercises that check; from `1.14.0.dev7` GitHub's profile does.

### The scope fields (#2310)

`1.13.0.dev47` turned test 1 red: every capability carried two keys the exact set did not
list. Upstream #15810 (`2cf2b5d14b`, *"fix(connections): explain OAuth scopes and action
risks"*, merged into `release-1.13.0` on 2026-10-16) added to `IntegrationCapabilityRead`:

- `required_scopes: list[str]`, the scopes every run of the action needs;
- `conditional_scopes: list[ConditionalScopeRequirement]`, each one a scope that an input
  switches on.

The change is intended. The exact key set is what caught it, as it caught
`deployment_context` in #2074, so it stays exact at 15.

The shapes come from `lfx/integrations/capabilities.py`, which declares more than the
manifest uses:

| Field | Declared | Measured on `dev47` |
|---|---|---|
| `required_scopes` | unique, non-blank strings; **may be empty** (default `()`) | all 30 capabilities non-empty |
| `conditional_scopes` | may be empty; each entry exactly `{scope, role, condition}`, `extra="forbid"` | 4 capabilities, 2 entries each |
| `role` | `optional` · `alternative` | `optional` |
| `condition` | exactly `{kind, input}`, `extra="forbid"` | — |
| `condition.kind` | `input_present` · `input_truthy` | `input_truthy` |
| `condition.input` | `^[a-z][a-z0-9_]*$` | `drive_id`, `site_id`, `channel_is_private`, `resolve_names` |

The spec asserts the **declared** shape (the #1968 lesson), so neither list is required to
be non-empty per capability. Two floors keep the loops from passing having checked nothing:
at least one capability declares a required scope, and at least one conditional entry was
checked.

The four capabilities with conditional scopes are `microsoft.files.list`,
`microsoft.files.fetch`, `microsoft.trigger.file` and `slack.bot.list_channel_members`. The
issue asked to confirm one detail. `microsoft.trigger.file` keys **both** of its scopes
(`Files.Read.All` and `Sites.Read.All`) on `site_id`, while `files.list` and `files.fetch`
key `Files.Read.All` on `drive_id`. This is deliberate upstream: the trigger component has
no `drive_id` input, and its `site_id` help text reads *"A SharePoint site also requires
Files.Read.All and Sites.Read.All."* It is recorded here and not asserted.

What a scope **does** is out of scope for this file: a missing one being refused before any
provider call is #2296's and #2306's.

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

- **`policy_keys` is exactly `["integrations." + capability.id]`, 20 of 20 on `dev21` —
  and 20 of 24 on `dev26`.** The contract upstream enforces is weaker — each key must parse
  as `integrations.<provider_id>.<action>` and sit inside the owning provider's namespace —
  and `policy_keys` is a list precisely so a capability may declare several. Asserting the
  measured 1:1 identity would redden a legitimate manifest, so the spec asserts the
  grammar and the namespace, which is what governance actually blocks on. `dev26` proved
  the point: the four Slack trigger capabilities (`slack.trigger.{message,reaction}.
  {events_api,socket_mode}`) share **one** key per event across both transports
  (`integrations.slack.trigger.message`, `integrations.slack.trigger.reaction`), so an
  operator blocks an event, not a transport — and a 1:1 assertion would have failed on a
  correct manifest.
- **The server does not omit a capability whose `deployment_contexts` exclude the
  instance's context**, whatever the `deployment_context` field's own description says (*"A
  capability or auth profile whose deployment contexts exclude it is not offered here"*).
  Measured on `dev26` started with `LANGFLOW_CONNECTION_OAUTH_CONTEXT=hosted`: the body read
  `deployment_context: "hosted"` and still listed all **24** capabilities, including
  `slack.trigger.message.socket_mode` and `slack.trigger.reaction.socket_mode`, which
  declare `["self_managed", "desktop"]`. `list_integrations` has no context filter, and the
  only client consumer found (`offersSlackToken`) gates the token *method*, not the
  capabilities. Not asserted: no lane runs `hosted`, and on `self_managed` every shipped
  capability declares it, so an "every listed capability declares the instance's context"
  check would be vacuously true here and would redden a legitimately hosted-only capability
  the day one ships. Whether the omission is owed by the server or by the picker is an
  upstream question; this file makes no claim.
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
- **The instance runs in the default `self_managed` deployment context** —
  `LANGFLOW_CONNECTION_OAUTH_CONTEXT` unset, which is how every lane and start script of this
  repo runs it. Test 5 fails rather than skips otherwise, for the same reason.
- **`microsoft` is this file's provider and `slack` is its untouched control.** Test 3
  asserts `microsoft`'s count moves by exactly one and `slack`'s does not move at all —
  which is what proves the derivation is per provider and not a global flag.
- **Whose rows the count holds (#2317).** `connection_count` is
  `ConnectionService.count_for_user`, which counts the rows `_list_visible_rows` returns for
  the **caller**. For a superuser that query has no owner clause, so the superuser's
  manifest counts **every user's** connections. For anyone else it counts the caller's own
  rows plus every `ownership_mode: "instance"` row, whoever owns it. That is the OSS rule,
  where the authorization service is pass-through. With an authorization plugin that
  supports cross-user fetch, rows shared with the caller count too, which no lane this spec
  runs on has. Measured on `1.13.0.dev47`:

  | Row created | `slack` / `google` / `microsoft` read by the superuser | read by a throwaway user |
  |---|---|---|
  | `slack`, user mode, owned by the superuser | `slack` 0 → 1 | `slack` stays 0 |
  | `google`, instance mode | `google` 0 → 1 | `google` 0 → 1 |
  | `microsoft`, owned by the throwaway user | `microsoft` 0 → 1 | `microsoft` 0 → 1 |

  The control used to be read as the superuser, so any spec's `slack` row moved it, even one
  owned by another user. #2306's `xapp-` row (`api-connections-resolution-non-interactive`,
  test 5) is exactly that: a `slack` row of a throwaway owner, created and deleted in a few
  seconds. On one backend with two workers it could land between test 3's baseline and its
  last read and fail the test, and the failure would say nothing about the derivation. Test
  3 therefore seeds **and reads** as a throwaway owner of its own
  (`createConnectionsOwner`, #2295), and only two kinds of row can move what that owner
  reads: its own, and instance rows. The instance half of the reservation is held by the
  **suite**, not by the product: every instance seed in the suite is `google` (the helper's
  default). The product refuses only part of it. On `1.13.0.dev47`, a `slack` row that
  carries a token is checked live against Slack's `auth.test` (an `xapp-` token excepted),
  so a planted token is refused (`Slack rejected this token`), and an `xapp-` token is
  refused in instance mode (`must be your own connection`). But a `slack` instance row with
  **no** credentials is accepted as `pending` (measured: `201`, `owner_id: null`), and
  `count_for_user` counts it whatever its status; `microsoft` takes a planted token in any
  mode. A future spec seeding an **instance** row for `microsoft` or `slack`, with or
  without credentials, would break the reservation, and the failure would name the
  contention. `google` is still never asserted here, because instance rows of it are seeded
  all the time.
- **No assertion reads a list length, a position, or a total.** The invariant
  `enabled === (approved && connection_count > 0)` is asserted on every row of every read
  and cannot race; the round trip is asserted as a delta against a baseline read taken
  inside the same test.
- **Budget.** The two integration routes share the connections **metadata-read** bucket
  (60/min per user, `get_metadata_read_limit()`); this file issues 9 reads per run
  (unchanged by #2074 — the new checks read the bodies the tests already fetch). Writes
  come from the **write** bucket (30/min per user) and this file spends **2**, one create
  and one delete, both in test 3. Since #2317 they are charged to test 3's throwaway owner
  rather than to the superuser. The owner costs one `POST /api/v1/login`, which OSS limits
  to 5/min per client IP; `createThrowawayUser` waits a refused window out rather than
  failing.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model, no run, no network egress — the planted credential
never leaves the instance, and the only write is one connection this file deletes.
`@stable` enters in this PR rather than after a seasoning period.

---

## Step by step *(required)*

Five tests over the `request` fixture, each declaring its operations through
`apiCoverage`. Only test 3 writes, and it writes and reads as a throwaway owner it creates
itself, with the owner's token sent on the test's own `request` so `apiCoverage` still
records every call. `afterEach` deletes that owner, which takes any row it still owns with
it (measured in #1969, and again on `1.13.0.dev47` for #2317).

**Test 1 — `every provider row and every capability declares its full field set, with each enum-valued field inside its declared domain`**
1. `GET /api/v1/integrations` → `200`, a body whose key set is exactly
   `["deployment_context", "providers"]`, with `deployment_context` inside its declared
   domain `{self_managed, hosted, desktop}`. Every read of the manifest in every test goes
   through this check.
2. `providers` is a non-empty array, sorted by `provider_id`, with unique ids each
   matching `^[a-z0-9][a-z0-9._-]*$`.
3. Each provider row's key set equals the 8 above; `display_name` is non-empty;
   `connection_count` is an integer `>= 0`; `approved` is `true` (a blocked provider is
   omitted from the default listing, so a `false` here would mean the omission broke);
   `enabled === (approved && connection_count > 0)`; `capabilities` is non-empty.
4. Each capability's key set equals the 15 above, asserted per capability so the message
   names the one that drifted.
5. Per capability: `id` matches `^[a-z0-9][a-z0-9._-]*$` **and** starts with
   `<provider_id>.`; ids are unique within the provider; `display_name` is non-empty;
   `auth_profile_id` matches `^[a-z0-9][a-z0-9_-]*$`; `risk`, `identity`, `substrate` and
   `maturity` are each inside their declared domain.
6. Per capability: `component_ref` or `mcp_tool` is a non-empty string — the execution
   target upstream's model refuses to build without — and `substrate: "mcp"` implies
   `mcp_tool`.
7. Per capability, the scope fields:
   - `required_scopes` is a list of non-blank strings with no duplicate;
   - each `conditional_scopes` entry has exactly the keys `{scope, role, condition}`, a
     non-blank `scope` and a declared `role`;
   - its `condition` has exactly the keys `{kind, input}`, a declared `kind`, and an `input`
     matching `^[a-z][a-z0-9_]*$`.

   Floors: at least one capability declares a required scope, and at least one conditional
   entry was checked.
8. Capabilities sharing an `auth_profile_id` declare the **same** `identity` — the
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
1. Create a throwaway owner (`createConnectionsOwner`). Every call below carries its token,
   so the counts are the ones that owner can see: its own rows and instance rows, never
   another user's (*Whose rows the count holds*).
2. `GET /api/v1/integrations` → baseline `connection_count` for `microsoft` (`c0`) and the
   whole `slack` row (the control); the derivation invariant holds on every row.
3. Seed one `ready` connection for `microsoft` through `createConnectionViaApi`
   (`providerKey: "microsoft"`), owned by that owner.
4. `GET /api/v1/integrations` → `microsoft` reads `connection_count === c0 + 1` and
   `enabled === true`; the `slack` row is unchanged; the invariant still holds on every
   row.
5. Delete it through `deleteConnection`, which throws on anything that is not `2xx` or
   `404` and waits out one `429`. The status is deliberately **not** the assertion: a
   write's `2xx` precedes the commit and a `DELETE`'s does not prove removal
   (#1759/#1777/#1807), and the manifest re-read in step 6 is the proof.
6. `GET /api/v1/integrations` → `microsoft` reads `connection_count === c0` and
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
5. The body's `deployment_context` — the value those lists are compared against — is
   `self_managed`: the default a lane that never sets `LANGFLOW_CONNECTION_OAUTH_CONTEXT`
   must read, and the one under which the add-connection dialog offers the Slack token
   method. A precondition that fails rather than skips, like test 4's `unrestricted`.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev47`, with: every manifest read asserting the body's exact key set
`["deployment_context", "providers"]` and `deployment_context` inside
`{self_managed, hosted, desktop}`, and test 5 asserting it reads `self_managed`; every
provider row asserted as the exact 8-key set and every capability as the exact 15-key set; every enum-valued field asserted against its
**declared** domain rather than the measured one, the scope fields included; all 24 capabilities cross-checking to a
`GET /api/v1/all` entry whose `namespaced_id` is the same `ext:…@official` string, with
`component_display_names` excluded from the index and a non-vacuity floor proving the loop
ran; `microsoft`'s `connection_count` moving `c0 → c0+1 → c0` around one seeded connection
while `slack`'s row does not move and `enabled === (approved && connection_count > 0)`
holds on every row of every read, all three reads made as test 3's throwaway owner;
`policy/effective` reporting `unrestricted: true` with
an empty `blocked_action_keys` and `approved_provider_ids` deep-equal to both
`loaded_provider_ids` and the manifest's provider ids; and no count, total or list length
asserted anywhere. `GET /api/v1/connections` reads back **zero** rows carrying this file's
marker after the run, and the declared coverage — `GET /api/v1/integrations`,
`GET /api/v1/integrations/policy/effective`, `GET /api/v1/all`,
`POST /api/v1/connections`, `DELETE /api/v1/connections/{connection_id}` — matches what
the fixture recorded. And, since #2317, the control cannot be moved by another spec's
rows: a `--workers=2` run of `api/connections/` together with
`core-functionality/integrations/` on one backend passes three consecutive times.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser,
  **unrestricted**: no integration policy bundle and no externally managed ceiling.
- `src/backend/base/langflow/api/v1/integrations.py` — both routes under test, the
  `IntegrationListRead` / `IntegrationProviderRead` / `IntegrationCapabilityRead` /
  `EffectiveIntegrationPolicyRead` shapes asserted here (including `IntegrationListRead`'s
  `deployment_context` literal and its absence of any context filter), the `enabled = approved and connection_count > 0` derivation, and
  the omission of blocked providers and actions from the default listing.
- `src/backend/base/langflow/services/integration_policy_discovery.py` — how the ceiling
  and the action deny-list are resolved for the caller.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `deployment_context()`
  and `OAuthSettings.context`, the `self_managed` default test 5 asserts.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/slack-token.ts` —
  `offersSlackToken()`, the client consumer that makes the key's presence load-bearing.
- `src/backend/base/langflow/api/v1/connections.py` — the create and delete test 3 drives,
  and the per-user write bucket its budget is sized against.
- `src/lfx/src/lfx/integrations/capabilities.py` — the declared enum domains
  (`IntegrationIdentity`, `ExecutionSubstrate`, `CapabilityMaturity`, `DeploymentContext`,
  `risk`), the `component_ref or mcp_tool` requirement, the provider-namespace checks
  on capability ids, policy keys and auth profiles, and since #2310
  `ConditionalScopeRequirement` and `ScopeCondition`.
- `src/lfx/src/lfx/services/integration_policy/base.py` —
  `normalize_integration_policy_key`, the `integrations.<provider_id>.<action>` grammar
  test 5 asserts.
- `src/backend/base/langflow/services/connection/service.py` — `count_for_user` and
  `_list_visible_rows`, which decide whose rows `connection_count` holds: every user's for
  a superuser, the caller's own plus instance rows for anyone else.
- `tests/helpers/integrations/create-connection.ts`,
  `tests/helpers/integrations/delete-connection.ts` and
  `tests/helpers/integrations/connections-owner.ts` — the seeding, deletion and owner
  helpers.
- These upstream paths resolve on `release-1.13.0` and **not** on `main`, which does not
  carry the feature yet, so the doc-dependency guard reports a `::notice::`, not a
  failure. No provider key, no model, no network egress.
