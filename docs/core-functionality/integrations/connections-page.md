# Connections — the `/settings/connections` page

**File:** `tests/tests-automations/regression/core-functionality/integrations/connections-page.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev19`)

Owning issue: #1969 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order in the #1971 comment). Seeds through `tests/helpers/integrations/` from #1966. The
row menu and the non-interactive opt-in are #1970's
(`connections-row-actions.spec.ts`); this file is the page around them.

---

## What this test validates *(required)*

The page itself — upstream surface **B1**, one of the two GA items still
`pending-signoff` (`connections-ui-a11y-i18n`) in
`design/dedicated-integrations/ga-checklist.json`. It is where the question *"can a user
reach the feature at all?"* is answered: the API can be perfect and the page still
unreachable, unreadable, or showing a connection in the wrong place.

Five things, each black-box and each on the image the daily runs:

1. **Reachable.** The Settings nav carries the entry and it lands on the page, whose
   subtitle states the secret boundary verbatim — the user-facing half of #1967.
2. **An empty view says so and offers the way forward.**
3. **A row carries what the account is**: display name, handle, owner, account, status,
   and the granted scopes as a count **and** as a list.
4. **Each tab holds only its ownership kind**, and a superuser's `Mine` does not hold
   other users' private connections — a real defect upstream fixed in
   **langflow#15182** (merged into `release-1.13.0` on 2026-09-18). Upstream's own test
   for it renders the page over a **mocked** list; this is the same claim against the
   real backend, whose superuser listing is unfiltered by owner.
5. **Search narrows by what its placeholder promises, and the badge follows the
   connection's state.**

Measured on `langflowai/langflow-nightly:latest` = `1.13.0.dev19` before the spec was
written:

| Surface | Measured |
|---|---|
| Settings nav | the account menu (`user-profile-settings` → `menu_settings_button`) lands on `/settings/general`; `sidebar-nav-Connections` is an `<a href="/settings/connections">` reading *Connections* (icon `Plug`), among ten `sidebar-nav-*` entries, and carries `data-active="true"` once its page is open. The page renders no `settings_menu_header` |
| The page | document title `Connections \| Langflow`; heading *Connections*; subtitle *"Accounts your flows act through. Tokens stay on the server; only metadata is shown here."*; `add-connection` reads *Add connection* |
| Tabs | a `role=tablist` named *Connection views* holding three `role=tab` (no testid): `Mine` (selected by default), `Instance`, `Other users` — the last rendered for a superuser only (source; the UI here is always the superuser) |
| Search | `connections-search`, placeholder *Search name, handle, or account*; filters **client-side** (no request), matching the display name, the handle `<provider_key>/<name>`, the account display and the account id; the value is kept across a tab switch |
| Columns | `Connection` · `Owner` · `Account` · `Status` · `Scopes` · `Last check` · `Actions` (the last `sr-only`) |
| A seeded `ready` row | `E2E <name>` over the handle `google/<name>` · `You` · the account display · `Ready` · `2 scopes` plus an `sr-only` `gmail.send, drive.file` · an `sr-only` `Not checked` plus `Never` |
| Status cell | `ready` → `Ready`, no action; `pending` → `Pending` + `authorize-<name>` reading *Authorize*; `expired` → `Expired` + *Reconnect*; `revoked` → `Revoked` + *Reconnect*; `error` → `Error` + a reason line (source only — not reachable, see below) |
| Owner cell | `You` for one's own row, `Instance` for an instance row, `Shared` for another user's |
| Account cell | the account display (or its id); with no account, *Signed in, account not shared* when the connection holds a credential and *Not signed in yet* when it does not |
| Empty view | `connections-empty` reading *"No connections yet."*; the table is not rendered; `add-connection` stays in the page header |

### Where the measurement disagrees with the issue

- **"With no connections" is not a state a shared superuser can reach — but the page has
  only one empty state, and it is reachable.** The page renders `connections-empty`
  whenever the current view is empty (`visible.length === 0`, where `visible` is the list
  filtered by tab **and** search), with a single copy key, `connections.empty`. Every
  worker drives the same superuser, and a parallel spec seeds connections at any moment,
  so an empty list is never guaranteed; and the UI cannot be moved to a fresh user,
  because under `auto_login` the app overwrites any injected token on mount (#690 —
  re-measured on `1.13.0.dev19`: with a throwaway user's `access_token_lf` injected, the
  page fires `GET /api/v1/auto_login` and `whoami` answers `langflow`). So
  the spec reaches the empty view through a search no row can match — the same element,
  the same copy, the real list behind it — rather than by mocking the list endpoint.
- **The abbreviated scope list is screen-reader text.** The row shows `2 scopes` and
  carries `gmail.send, drive.file` in an `sr-only` span; the full scope URLs appear only
  in a hover tooltip. The spec asserts the count and the `sr-only` list exactly.
- **Four of the five badge states are reachable from outside**, not two:
  - `ready` — a planted credential (#1966's harness);
  - `pending` — a connection created with no credential;
  - `expired` — a planted credential whose `expires_at` is in the past, then
    `POST /api/v1/connections/{id}/health`. A planted token carries no OAuth binding, so
    the check skips the refresh and compares `expires_at` with the clock, raising
    `AuthExpiredError` (`services/connection/service.py`, `_credential_from_row`);
  - `revoked` — `POST /api/v1/connections/{id}/revoke`.
  - **`error` is not reachable.** It needs a credentialed status whose stored secret is
    gone (`credential-missing`) — and no route removes a secret without also setting
    `revoked`, which is credential-free by definition — or a secret that no longer
    decrypts (`credential-undecryptable`), which takes a change of the instance's secret
    key, i.e. a restart. Its badge and reason lines are **not** asserted here.
- **The tab assertion covers all three tabs, not two.** The issue asks for `Mine` and
  `Instance`; the spec also seeds a connection owned by a throwaway second user, because
  `Other users` is exactly where langflow#15182's defect sent rows it should not have,
  and a tab asserted to *exist* but never to *hold* anything cannot catch that.

### Recorded, not asserted

- **The Owner cell reads `Shared` for another user's private connection**, which nobody
  shared: `ownerKindOf` knows only `you | instance | shared`, and `ConnectionRead` carries
  an `owner_id` but no username, so the page cannot name the owner. The spec asserts that
  row's **tab**, not its Owner text — pinning `Shared` would make a fix read as a failure.
- **The scope counter has a single plural form** (`connections.scopes.count` =
  `{{count}} scopes`), so a one-scope row reads `1 scopes`. The spec seeds **two** scopes,
  so its count assertion holds before and after a pluralisation fix.
- **Upstream's B1 surface list names two things the shipped page does not show**: a
  *connected-at* (the page shows *Last check*, the health check's time, not when the
  account was connected) and a *visible enabled badge* for the non-interactive opt-in (a
  connection seeded with `allow_non_interactive: true` renders a row identical to one
  without). The list is marked *draft*, so these are gaps against a draft, not defects;
  not asserted either way.
- **The search box has no label** — its accessible name falls back to the placeholder.
  a11y auditing is out of scope (upstream ships its own axe baseline for settings
  routes).
- **A credential planted already past its expiry reads `ready` until a check runs**:
  status is persisted and re-evaluated by `/test` and `/health`, never derived at read
  time. So the `expired` state is asserted after the check, not at creation.
- **A regular user gets no `Other users` tab** (upstream's second unit test). Not
  reachable here: the UI is always the `auto_login` superuser.
- **Deleting a user removes that user's connections** (measured: the row is gone from
  the superuser's list afterwards), although the model's comment warns that SQLite does
  not enforce the foreign key's `ON DELETE CASCADE`. The teardown deletes the second
  user's connection explicitly first anyway, and re-reads the list.

### The write budget

Connection writes share one **per-user** bucket of 30/minute, and the suite shares one
superuser (`docs/api/connections/api-connections-lifecycle.md`). A UI action cannot be
retried, so the spec keeps three back-to-back runs under the bucket even inside one
window: **9 superuser writes per run** — test 1 none; test 2 three seeds and three
deletes; test 3 one seed, one revoke and one delete. The second user's create and delete
fall in **that user's own** bucket, fresh every run. `/health` sits on its own
login-sized bucket (5/minute) and is called once per run. The seeding, the revoke, the
health check and the teardown are preconditions, not the subject, so each absorbs one
`429` by waiting out `retry-after`; nothing the page renders is ever retried.

### The Settings navigation, and the one frame it tripped on

Test 1 walks the suite's verified Settings navigation (`navigateSettingsPages`, #1696),
and this page is the first headerless target it reaches every run. That exposed a race
in the helper, not in Langflow: the URL commits before the page being left unmounts,
so for one frame (~10 ms, measured in 10 navigations out of 10 from
`/settings/general`) the pathname is already `/settings/connections` while General's
`settings_menu_header` is still mounted. A 200 ms poll landing in that frame counted
General's header as the target's, latched "this section has a header", and a page that
renders none could then never settle — `SETTINGS_SECTION_UNCONFIRMED` after 20 s, in
one of the first three validation runs. The helper now counts a header as the target's
only when it names the target, the same test it already settles on; the measured frame
sequence is pinned in `tests/helpers/ui/go-to-settings.test.ts`.

### Parallel safety

Every locator is derived from a name the test itself generated
(`connection-row-<name>`, `authorize-<name>`, and the handle `google/<name>`), because the
page lists every connection the shared superuser can see. No assertion reads the list's
length or a row's position, and "gone" is asserted on the test's own row only.

---

## Tags *(required)*

`@integrations` `@settings` `@ui-ux` `@stable`

`@stable`: no provider key, no model, no network egress — planted credentials never leave
the instance, and `/health` on a planted token compares its expiry locally without
calling the provider. The second user exists only for the duration of test 2 and is
deleted in teardown. `@stable` enters in this PR.

---

## Step by step *(required)*

Every connection is seeded through `createConnectionViaApi` (provider `google`), and
`afterEach` removes what the test left: one list read, then an id-scoped
`deleteConnection` per survivor; the second user deletes its own connection and is then
deleted by the superuser.

**Test 1 — `Settings navigation reaches the Connections page, and an empty view says so while still offering Add`**
1. Open `/` and reach the page the way a user does — account menu, *Settings*, then
   `sidebar-nav-Connections` — through the suite's verified Settings navigation
   (`navigateSettingsPages`, #1696). Its last hop is confirmed by the entry's own `href`,
   since this page renders no `settings_menu_header`.
2. The entry reads *Connections*, links to `/settings/connections` and is marked active
   (`data-active="true"`); the URL is `/settings/connections` and the document title is
   `Connections | Langflow`.
3. The heading *Connections* and the subtitle *"Accounts your flows act through. Tokens
   stay on the server; only metadata is shown here."* render verbatim; `add-connection`
   reads *Add connection*.
4. The tablist *Connection views* holds `Mine`, `Instance` and `Other users`, with `Mine`
   selected.
5. Type into `connections-search` a sentinel no connection can match →
   `connections-empty` reads *"No connections yet."*, no table is rendered, and
   `add-connection` is still visible.

**Test 2 — `a seeded row shows what the account is, each tab holds only its ownership kind, and search narrows by name, account and handle`**
1. Seed, all with unique names: **A** — user-owned, planted credential, two scopes
   (`https://www.googleapis.com/auth/gmail.send`,
   `https://www.googleapis.com/auth/drive.file`), account `{id, display}` with a unique
   display; **P** — user-owned, no credential (`pending`); **C** — `ownership_mode:
   "instance"`, planted credential. Then create a throwaway user through
   `POST /api/v1/users/`, activate it with `PATCH`, log it in with `postLogin`, and seed
   **F** as that user.
2. Open `/settings/connections` → A's row renders; the table's columns include
   `Connection`, `Owner`, `Account`, `Status`, `Scopes`, `Last check` and `Actions`.
3. Row A, cell by column: the display name over the handle `google/<A>`; `You`; the
   account display; `Ready` with no `authorize-<A>`; `2 scopes` and an `sr-only`
   `gmail.send, drive.file`; `Never`.
4. Row P: `Pending` with `authorize-<P>` reading *Authorize*; *Not signed in yet*;
   *No scopes granted*.
5. `Mine` holds A and P, and neither C nor F.
6. `Instance` holds C, whose Owner reads `Instance`, and none of A, P or F.
7. `Other users` holds F, and none of A, P or C (langflow#15182).
8. Back on `Mine`, search A's unique name → A stays and P is gone; search A's account
   display → A stays and P is gone; search P's handle `google/<P>` → P stays and A is
   gone. (The account probe and the handle probe each match a field the display name
   does not contain.)

**Test 3 — `the status badge follows the connection's state: expired and revoked each offer Reconnect`**
1. Seed **X** with a planted credential whose `expires_at` is `2020-01-01T00:00:00Z`.
2. `POST /api/v1/connections/{id}/health` → `200`, `status: "expired"`.
3. Open the page → X's status cell reads `Expired`, with `authorize-<X>` reading
   *Reconnect*.
4. `POST /api/v1/connections/{id}/revoke` → `200`, `status: "revoked"`,
   `has_credentials: false`; reload → X's status cell reads `Revoked`, with
   `authorize-<X>` reading *Reconnect*.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev19`, with: the nav entry, the title, the heading, the subtitle and the empty
copy asserted **verbatim**; seeded row A asserted **cell by column**, its scopes as the
count **and** the exact `sr-only` list; each of the three tabs asserted to **hold** its
own seeded row and **not** to hold the other three; the three search probes each
asserted as *"the other row is gone"*, never as a total; and the `Pending`, `Expired` and
`Revoked` badges each asserted with the exact label of their inline action. After the
run, `GET /api/v1/connections` carries no row with this spec's names and the throwaway
user is gone from `GET /api/v1/users/`.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with the
  default rate limits (login 5/minute per client IP, connection writes 30/minute per
  user).
- `src/frontend/src/pages/SettingsPage/index.tsx` — the `Connections` nav entry and its
  `/settings/connections` route.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/index.tsx` — the subtitle,
  the three tabs and the superuser-only `Other users`, the tab filter (`viewOf`), the
  search filter and its fields, and the single empty state.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionsTable.tsx`
  — the row testid, the columns, `ownerKindOf`, and the account, scope and last-check
  cells.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionStatusBadge.tsx`
  — the badge per status and its inline `authorize-<name>` action.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/scopes.ts` —
  `shortScope`, which turns a scope URL into the listed `gmail.send`.
- `src/frontend/src/controllers/API/queries/connections/api.ts` — the one list request
  the page makes; `src/frontend/src/controllers/API/queries/connections/index.ts` —
  `connectionHandle`.
- `src/frontend/src/locales/en.json` — every string asserted here (`connections.*`,
  `settings.nav.connections`).
- `src/backend/base/langflow/services/connection/service.py` — the superuser's
  owner-unfiltered listing (`_list_visible_rows`), the `expired` transition in
  `check_health`, and `revoke`.
- `src/backend/base/langflow/api/v1/connections.py` — the list, `/health` and `/revoke`
  routes and their rate-limit buckets.
- `src/backend/base/langflow/api/v1/users.py` — creating, activating and deleting the
  throwaway user.
- `tests/helpers/integrations/create-connection.ts`,
  `tests/helpers/integrations/delete-connection.ts`,
  `tests/helpers/auth/login-request.ts` and `tests/helpers/ui/go-to-settings.ts` —
  seeding, teardown, the one login and the Settings navigation.
- The upstream paths resolve on `release-1.13.0` and not on `main`, so the
  doc-dependency guard reports a `::notice::`. No provider key, no model, no network
  egress.
