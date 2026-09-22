# Connections — row actions and the non-interactive opt-in

**File:** `tests/tests-automations/regression/core-functionality/integrations/connections-row-actions.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev19`)

Owning issue: #1970 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order in the #1971 comment). Seeds through `tests/helpers/integrations/` from #1966.

---

## What this test validates *(required)*

The row menu of `/settings/connections` — where a user acts on a connection — and, above
all, the **non-interactive opt-in** it carries: *"Allow scheduled and deployed runs"*.
That toggle is the control behind upstream's risk #8 (*user connections exercised by
callers who are not their owners*), and upstream's acceptance text for it
(`frontend-surfaces.md`, B1/B10) is literal: the toggle persists through the connection
API, is **off by default**, and the page must **show state set through the API too**.
A default flipped to on is a silent privilege grant, so that is the first assertion.

Upstream proves the connection routes in-process; its GA checklist
(`design/dedicated-integrations/ga-checklist.json`) leaves the Connections UI itself
(`connections-ui-a11y-i18n`, surfaces B1–B5) `pending-signoff`. This is the black-box,
user-reachable half.

Measured on `langflowai/langflow-nightly:latest` = `1.13.0.dev19` before the spec was
written, on a connection seeded with a planted credential (`status: "ready"`):

| Row action | Request | Toast (exact) | Observable afterwards |
|---|---|---|---|
| open `connection-menu-<name>` | — | — | six `role=menuitem`, no `data-testid`: `Check credential`, `Reconnect`, `Rename`, `Allow scheduled and deployed runs`, `Revoke`, `Delete`. **`Delete` is disabled** (`aria-disabled="true"`) while the connection holds a credential |
| the opt-in's switch, off → on | `PATCH {allow_non_interactive: true}` → `200` | *Scheduled and deployed runs may use this connection.* | switch `aria-checked="true"`; the menu stays open; the API reads `true` |
| … on → off | `PATCH {allow_non_interactive: false}` → `200` | *Scheduled and deployed runs may no longer use this connection.* | switch `aria-checked="false"`; the API reads `false` |
| `PATCH` through the API, then reload | — | — | the switch reads the API's value |
| `Rename` | a native `window.prompt` (message `Rename`, prefilled with the current display name) → `PATCH {display_name}` | *Connection renamed.* | the row shows the new name; the API agrees |
| `Check credential` | `POST /api/v1/connections/{id}/test` → `200` | *Credential checked.* | the *Last check* cell leaves `Never`; `health_checked_at` is stamped |
| `Revoke` | `POST /api/v1/connections/{id}/revoke` → `200` | *Connection revoked.* | badge `Revoked`; `status: "revoked"`, `has_credentials: false`; now `Check credential` and `Revoke` are disabled and **`Delete` is enabled** |
| `Delete` | `DELETE /api/v1/connections/{id}` → `204` (no confirmation step) | *Connection deleted.* | the row is gone; the list no longer carries the id |

### Where the measurement disagrees with the issue

- **The opt-in's state IS programmatically readable.** The issue measured the menu
  item — a plain `role=menuitem` with `aria-checked: null` — but the item contains a
  **`role=switch`** carrying `aria-checked`, `data-state` (`checked` / `unchecked`),
  `aria-label="Allow scheduled and deployed runs"` and
  `data-testid="unattended-<name>"`. So the spec reads the UI state from the switch,
  which is stronger than the issue's fallback ("an icon-bearing indicator, without
  claiming which state it is"), and still reads the API and the toast as well.
- **`Rename` is `window.prompt`, not a dialog component.** The spec handles the native
  dialog and asserts it is a prompt prefilled with the current display name.
- **`Check credential` calls `/test`, not `/health`.** Both stamp
  `health_checked_at`, but `/test` sits on the login-sized **5/minute** bucket.
- **`Delete` is gated on the credential being gone** (`status` `pending` or `revoked`),
  so the order is revoke, then delete — and the gate itself is asserted.
- **There is no `GET /api/v1/connections/{id}`** (#1966's finding): a `GET` on the item
  path answers `404` for a *live* connection, so it cannot prove a removal. Removal is
  re-read from the list.

### Recorded, not asserted

- `health` becomes `healthy` for a planted **fake** token: `/test` checks the local
  envelope and scopes, not the provider. So the spec pins the transition — *Last check*
  leaves `Never`, `health_checked_at` is stamped, `health` leaves `unknown` — and never
  claims the credential works.
- A revoked connection keeps its `allow_non_interactive` value (measured `true` after a
  revoke). It holds no credential, so there is nothing to exercise; not asserted.

### The write budget

Connection writes share one **per-user** bucket of 30/minute and the suite shares one
superuser (see `docs/api/connections/api-connections-lifecycle.md`). A UI action cannot
be retried, so a `429` there would surface as the *"That did not work"* toast and fail
the test. The spec therefore spends **9 writes per run** — two connections, each
carrying one journey — which keeps three back-to-back runs (the validation burst) under
the bucket even if they all land in one window. The seeding and teardown helpers absorb
a `429` once; the UI actions under test are never retried.

---

## Tags *(required)*

`@integrations` `@settings` `@stable`

`@stable`: no provider key, no model, no network egress — the planted credential never
leaves the instance, and `/test` does not call the provider. `@stable` enters in this PR.

---

## Step by step *(required)*

Two tests, each seeding its own connection through `createConnectionViaApi` (planted
credential → `ready`; `allow_non_interactive` **not sent**, so its value is the
server's default) and each locating everything by the connection's unique `name`:
`connection-row-<name>`, `connection-menu-<name>`, `unattended-<name>`. The page is
`/settings/connections`, reached directly (navigation is #1969's subject). Toasts are
matched by their exact text inside the page's `role=status` region. `afterEach` deletes
what the test left, id-scoped, through `deleteConnection`.

**Test 1 — `the non-interactive opt-in is off by default, and every change to it shows on the switch and in the API`**
1. The `201` of the seed reads `allow_non_interactive: false`, and so does the list row.
2. Open the page and the row menu → the `Allow scheduled and deployed runs` item is
   there and its switch reads `aria-checked="false"`.
3. Click the switch → toast *"Scheduled and deployed runs may use this connection."* →
   the switch reads `true` → the API reads `true`.
4. Click it again → toast *"Scheduled and deployed runs may no longer use this
   connection."* → the switch reads `false` → the API reads `false`.
5. Close the menu, `PATCH {allow_non_interactive: true}` through the API, reload, open
   the menu → the switch reads `true` (upstream's *"show state set through the API
   too"*).

**Test 2 — `Rename, Check credential, Revoke and Delete each act on the row, and the API agrees`**
1. Open the page → the row shows the seeded display name, a `Ready` badge and `Never` in
   *Last check*.
2. Open the menu → `Delete` is disabled and `Revoke` is enabled.
3. `Rename` → a `prompt` dialog prefilled with the current display name → accept a new
   name → toast *"Connection renamed."* → the row shows it → the API reads it.
4. `Check credential` → toast *"Credential checked."* → *Last check* no longer reads
   `Never` → the API's `health_checked_at` is a timestamp and `health` has left
   `unknown` (no claim that it is `healthy`).
5. `Revoke` → toast *"Connection revoked."* → the row's badge reads `Revoked` → the API
   reads `status: "revoked"`, `has_credentials: false`.
6. Open the menu → `Revoke` is disabled and `Delete` is enabled → `Delete` → toast
   *"Connection deleted."* → the row is gone → the list no longer carries the id.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev19`, with the opt-in's state asserted on the **switch's `aria-checked`**, on
the **direction-specific toast** and on the **API** at every change — including a
change made through the API alone — and every other row action asserted on its exact
toast, its row observable and the API. After the run, `GET /api/v1/connections` carries
no row with this spec's names.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with the
  default rate limits.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionRowMenu.tsx`
  — the six items, the switch and its testid, and the gates on `Check credential`,
  `Revoke` and `Delete`.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionsTable.tsx`
  — the row testid and the *Last check* cell.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionStatusBadge.tsx`
  — the `Ready` / `Revoked` badges.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/index.tsx` — the action
  handlers, the `window.prompt` rename and the toast per action.
- `src/frontend/src/controllers/API/queries/connections/api.ts` — which route each
  action calls.
- `src/backend/base/langflow/api/v1/connections.py` — the routes and their rate-limit
  buckets.
- `tests/helpers/integrations/create-connection.ts` and
  `tests/helpers/integrations/delete-connection.ts` — seeding and teardown (#1966).
- The upstream paths resolve on `release-1.13.0` and not on `main`, so the
  doc-dependency guard reports a `::notice::`. No provider key, no model, no network
  egress.
