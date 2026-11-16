# Governance — integration deny-all through the v2 policy bundle

**File:** `tests/tests-automations/regression/governance/integration-policy-v2.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2451. The integration policy itself (an approved provider set, blocked actions,
enforcement at discovery, mutation and run time) is `docs/governance/integration-policy-enforcement.md`
(#2299), which drives the v1 bundle only. The trigger-kind half of the same bundle is the sibling
`docs/governance/trigger-policy-enforcement.md`. Upstream: #16227 (first tag `v1.14.0.dev21`); the
picker's inline *Add connection* is #16332 (`v1.14.0.dev23`).

---

## What this test validates *(required)*

On 1.13 an empty `approved_integration_provider_ids` meant unrestricted, so an operator had no way to
deny every integration. 1.14 makes the field tri-state on `/api/v2/policy-bundle` and keeps v1's meaning
for older clients. The contract under test:

1. **In v2, `[]` denies every integration and `null` is unrestricted.** With `[]`,
   `GET /api/v1/integrations` answers `providers: []`; back to `null`, it lists the same providers as
   before.
2. **v1 keeps its old meaning.** v1 reads deny-all as the reserved marker
   `["langflow-reserved.integration-policy.deny-all"]`. A v1 write of `[]` is unrestricted, and only the
   marker denies all. v2 refuses the marker with `422`.
3. **Other writers keep the deny-all.** Editing the model-provider part of the bundle
   (`PUT /api/v1/model-provider-policy`) leaves `approved_integration_provider_ids: []` in place.
4. **The v2 bundle is revisioned like v1:**
   - its history keeps `[]` and `null` apart;
   - a stale `expected_revision` answers `409`, naming both revisions;
   - a rollback appends a new revision whose content is enforced;
   - a rollback to a missing revision answers `404`.
5. **The connection picker explains the refusal.** Under deny-all, a connector node's picker reads *"This
   integration is unavailable. An administrator controls which providers and actions can be used."*, its
   *Add connection* button is disabled, and the palette no longer offers the provider's actions.

### Measured on `1.14.0.dev28`

- **On a pristine instance the two versions read differently.** Both read revision 1,
  `source: "migration"`, with every list set empty and `approved_trigger_kinds: null`. v2 reads
  `approved_integration_provider_ids: null` and v1 reads `[]`, which is v1's encoding of unrestricted.
- **`GET /api/v1/integrations` lists 12 providers unrestricted** (`confluence`, `discord`, `github`,
  `gitlab`, `google`, `jira`, `microsoft`, `salesforce`, `servicenow`, `slack`, `telegram`, `whatsapp`,
  by `provider_id`) and `[]` under deny-all. The spec compares the set before and after rather than this
  list, which grows as providers ship.
- **The marker through v2:** `422` at `["body", "approved_integration_provider_ids"]`, *"Value error, The
  integration policy marker is reserved; use an empty list to deny all integrations in API v2"*.
- **The conflict body:** `{"detail": {"message": "Policy bundle revision conflict", "expected_revision":
  N, "active_revision": M}}`.
- **A missing rollback target:** `404` *"Policy bundle revision 99999999 is missing"*.
- **A model-provider write mints its own revision** (reason *"Replace approved model providers"*) and
  carries the integration deny-all forward.
- **The picker under deny-all.** The popover still lists the user's connections, then shows the
  sentence above under a disabled *Add connection*. The sidebar's search for *gmail* finds no row. After
  the policy is lifted and the page reloaded, the sentence is gone and *Add connection* is enabled.

### What is not covered here, and why

- An approved subset of providers and blocked actions, and their enforcement at mutation and run time.
  `governance/integration-policy-enforcement.spec.ts` covers them through v1. v2 shares the same store,
  and this file asserts only what v2 adds.
- An externally managed integration ceiling (`managed_externally: true`, `409` on write). It needs a
  policy plugin, which the OSS build does not register.

---

## Tags *(required)*

`@destructive` `@api` `@integrations` `@governance`, plus `@components` on the picker test.

`@destructive`: the policy bundle is instance-global, so deny-all hides every integration from every
worker sharing the instance. No `@stable`: no scheduled lane runs `@destructive` (#1010). The file refuses
to run, with a skip naming what it found, unless the bundle is pristine, and puts the bundle back from its
snapshot in `afterAll`. Tests 1–3 skip below `1.14.0.dev21`, and the picker test below `1.14.0.dev23`.

---

## Step by step *(required)*

Every test runs as the superuser. v2 writes go through `tests/helpers/governance/policy-state.ts`, which
sends the whole bundle with the current `expected_revision`. v1 writes send the six v1 sets.

### 1. An empty v2 list denies every integration, which v1 reads as the reserved marker

1. Record the providers `GET /api/v1/integrations` lists (at least `google`).
2. Write `approved_integration_provider_ids: []` through v2. Expect `200` and `[]`.
3. Expect `GET /api/v1/integrations` to answer `providers: []`, and
   `GET /api/v1/policy-bundle` to read `["langflow-reserved.integration-policy.deny-all"]`.
4. Write `PUT /api/v1/model-provider-policy` with the current approved model providers. Expect `200`,
   v2 still `[]`, and `providers: []`.
5. Write the marker through v2. Expect `422` with the reserved-marker message.
6. Write `null` through v2. Expect the providers recorded in step 1 back.

### 2. v1 reads an empty list as unrestricted and writes deny-all only as the marker

1. Write `approved_integration_provider_ids: []` through v1. Expect v1 to answer `[]`, v2 to read
   `null`, and the recorded providers listed.
2. Write the marker through v1. Expect v1 to answer the marker, v2 to read `[]`, and `providers: []`.
3. Write `null` through v2.

### 3. v2 history keeps deny-all apart from unrestricted, a stale write conflicts, and rollback appends

1. Write deny-all (revision A), then `null` (revision B), through v2.
2. Expect `GET /api/v2/policy-bundle/history?limit=2` to list B (`null`) then A (`[]`), with their
   reasons, and a `next_before_revision`.
3. Write with `expected_revision: B - 1`. Expect `409` with `expected_revision: B - 1` and
   `active_revision: B`.
4. Roll back to A with `expected_revision: B`. Expect `200`, a revision above B, `source: "rollback"`,
   `rollback_of_revision: A` and `[]`, and `providers: []`.
5. Roll back to revision `99999999`. Expect `404` *"Policy bundle revision 99999999 is missing"*.
6. Write `null` through v2.

### 4. Under deny-all, the connection picker says the integration is unavailable and offers no Add connection

1. Create a flow holding a *Gmail: Send Email* node (`ext:google:GmailSendComponent@official`). Write
   deny-all through v2.
2. Open the flow and the node's connection picker. Expect *"This integration is unavailable. An
   administrator controls which providers and actions can be used."* and `add-connection-…` disabled.
3. Close the picker. Expect the sidebar's search for *gmail* to find no row.
4. Write `null` through v2 and reload. Open the picker. Expect the sentence gone and *Add connection*
   enabled.

---

## Validation criterion *(required)*

Tests 1–4 pass three consecutive times at `--retries=0 --workers=1` with `PW_DESTRUCTIVE=1` against
`1.14.0.dev28`, with:

- deny-all asserted by what `GET /api/v1/integrations` lists, not only by the bundle that stores it;
- each v1/v2 reading asserted from both sides of the same write;
- the bundle back to its snapshot after the file, checked by reading it back;
- zero `🚨 Backend Error`: the `422`, `409` and `404` are driven through the `request` fixture;
- no flow left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev21` or later; `1.14.0.dev23` for the picker) at
  `PLAYWRIGHT_BASE_URL`, auto-login, with a pristine policy bundle and the Google bundle installed (the
  nightly ships it).
- `src/backend/base/langflow/api/v1/policy_bundle.py` — the v1 and v2 routes, the marker's encoding and
  refusal.
- `src/backend/base/langflow/api/v2/policy_bundle.py` — the v2 router.
- `src/backend/base/langflow/services/policy_bundle.py` — the bundle store, history and rollback.
- `src/lfx/src/lfx/integrations/policy_constants.py` — the deny-all marker.
- `src/backend/base/langflow/api/v1/integrations.py` — the provider listing the policy filters.
- `src/backend/base/langflow/api/v1/model_provider_policy.py` — the model-provider writer.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/index.tsx`
  — the picker, its *Add connection* button and the unavailable sentence.
- `src/frontend/src/locales/en.json` — `connections.picker.providerUnavailable`.
- `tests/helpers/governance/policy-state.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/open-flow-by-id.ts`, `tests/helpers/flows/unmount-editor-for-cleanup.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
