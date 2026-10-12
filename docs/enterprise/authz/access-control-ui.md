# Enterprise — The Access Control Operator Screen

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`enterprise/authz/` holds eight API specs and none of them opens a browser. This is the
screen an operator actually uses to grant and revoke access, and the four properties below
are the ones that decide whether what the operator sees is what the instance enforces.

### Where the screen is

In the admin console since 1.13 (EE PR 326): the **Access control** tab of `/admin`, with a
sub-navigation (`navigation "Access Control"`) of two links. `/settings/access-control` and
`/admin-ee/access-control` are legacy redirects to it.

| Route | Sub-tab |
|---|---|
| `/admin/access-control` | **Roles** (default) |
| `/admin/access-control/assignments` | **Assignments** |

What the screen reads (measured on `bbbec5fb`): `GET /api/v1/authz/roles?limit=200&offset=0`,
`GET /api/v1/authz/admin/role-assignments?limit=200&offset=0`,
`GET /api/v1/authz/admin/team-role-assignments?limit=200&offset=0`, and — once, at page
load — `GET /api/v1/users/?skip=0&limit=200` for the subject picker (1.12 read
`/authz/admin/users`; a test still waiting on that read never sees it).

Its writes go through the OSS routes since 1.13: `POST /api/v1/authz/role-assignments` to
create an assignment and `DELETE /api/v1/authz/role-assignments/{id}` to revoke one; editing
an assignment is `PATCH /api/v1/authz/admin/role-assignments/{id}`.

### 1 — A system role offers no way to change it, on the screen and at the API

The Roles table has seven columns — *Name · Type · Inherits from · Permissions · Providers ·
Description · Actions* (the sortable headers carry an sr-only "Not sorted", so their
accessible text is e.g. `Name Not sorted`) — and gives each row a `System` or `Custom` badge
and a **different action set**:

| Row | Badge | Actions offered |
|---|---|---|
| `admin` · `developer` (shown as **Editor**) · `viewer` | System | a `View <Role>` button (e.g. `View Viewer`), opening a read-only *Role details* dialog |
| any custom role | Custom | an `Actions <name>` menu trigger whose items are `Edit <name>` and `Delete <name>` |

Rows are addressable by name — `role-row-admin`, `role-row-viewer`, `role-row-<custom>`.

The badge is a label; the **absence** of the two controls is what prevents the edit. And the
absence is only honest if the API refuses too — measured, both do:

```
PATCH /api/v1/authz/roles/<system-id>  ->  400 {"detail":"System roles cannot be modified"}
DELETE /api/v1/authz/roles/<system-id> ->  400 {"detail":"System roles cannot be deleted"}
```

A build that kept the badge and restored the buttons would look right in a screenshot. One
that hid the buttons over an API that accepted the write would be a read-only screen that
is not read-only. The test asserts both halves, and it asserts the custom row **positively**
in the same breath: without that, a screen that rendered no action buttons at all would
satisfy every "system rows have no Edit" assertion while proving nothing.

### 2 — The Assignments tab lists a grant held by another user

The screen reads `/authz/admin/role-assignments`. Its sibling `/authz/role-assignments`
returns only **the caller's own** assignments, and on an instance with a single admin the
two responses are byte-identical — so a regression onto the caller-scoped endpoint would
show the operator their own grant, look entirely correct, and hide every other user's
access.

This is not a hypothetical failure mode. A helper in this repository shipped with exactly
that misreading — its docstring claimed "every role assignment the instance holds" — and
the mistake leaked a grant onto the shared instance before it was caught.

So the test seeds a grant for a **different** user through the API and asserts the screen
shows it, with its user, role, scope and source. One admin's own row is not evidence.

Columns: *Assignee (sortable) · Role · Scope · Sources · Actions*. A manual assignment's row
offers an `Actions <username>` menu trigger whose items are `Edit assignment <username>` and
`Revoke <username>`; rows carry no testid, so a row is found by its username.

### 3 — Assigning at project scope lands as a project-scoped assignment

`Assign role` opens `dialog "Assign role"` with three comboboxes; choosing `Project` or
`Workspace` reveals a fourth, **Scope target**:

```
Users and groups -> a MULTI-select: opens a nested, unnamed popover dialog with a search box
                    and a listbox of usernames. It stays open after a pick; Escape closes
                    the popover and leaves the Assign role dialog open.
Role             -> "Admin (System)" | "Editor (System)" | "Viewer (System)" | <custom>
Scope            -> "Global" | "Workspace" | "Project"
Scope target     -> appears only for Workspace/Project; "<name> — <owner_username>"
Assign Role      -> POST /api/v1/authz/role-assignments
                    {"role_id","domain_type":"project","domain_id","user_id"}  -> 201
```

Because the popover is itself a `dialog`, the Assign role dialog is addressed by its name.

Scope is the axis the deny matrix turns on, and #1532 already recorded three API surfaces
disagreeing about scoped access. A picker that submitted `global` regardless would hand
instance-wide access to an operator who asked for one project.

The assertion is therefore on the created assignment's `domain_type` and `domain_id` at the
API, compared against the id of a project **this test created** — not on the row's own text.
Two reasons the test owns its project rather than picking an existing one: the stock
instance carries two projects both named `Starter Project` (different owners, disambiguated
in the picker only by the ` — <owner>` suffix), and comparing against an id the test minted
turns a text match into an equality.

### 4 — Revoke on the screen removes the assignment at the API

`Revoke <username>` (the row's `Actions` menu item) opens `dialog "Revoke <Role>?"` — *"&lt;user&gt; will lose the permissions this role
grants."* — with its own `Revoke` button. A row disappearing is a render; the state is what
`/authz/admin/role-assignments` says afterwards, so that is what the test reads.

## Tags *(required)*

`@enterprise` `@regression` `@authz`

No `@api`: this is the browser-facing half, and the API surface has eight specs of its own.
No `@stable` — there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

Shared setup, once per file: authenticate with the lane's cached superuser token; require an
instance that enforces authorization **and** reports the caller an RBAC admin (skip naming
the start command otherwise — the screen is gated on `me/rbac-admin`); resolve the `viewer`
role id; take the shared RBAC subject as the "other user".

**Test 1 — the system-role read-only contract.**
1. Create a custom role through the API, so the table has one row of each kind.
2. Open `/admin/access-control` and wait for `role-row-viewer` — an unrendered table
   satisfies every absence assertion below. Assert the seven headers in order.
3. On the system row: the badge reads `System`, `View Viewer` is present, and there is no
   `Actions` menu trigger (nor any `Edit`/`Delete` control).
4. On the custom row: the badge reads `Custom`, its `Actions <name>` trigger opens a menu
   offering `Edit <name>` and `Delete <name>`; Escape closes it without choosing.
5. At the API: `PATCH` and `DELETE` on the system role both answer `400`, and a re-read
   shows the role unchanged.

**Test 2 — another user's grant is listed.**
1. Assign `viewer` globally to the subject through the API.
2. Open the Assignments tab and locate the row by the subject's username.
3. The row reads the subject, `Viewer`, `Global`, `Manual`; its `Actions <username>` menu
   offers `Revoke <username>`.

**Test 3 — a project-scoped assignment made on the screen.**
1. Create a project through the API with a name unique to this run.
2. Open the Assignments tab (waiting for its `GET /api/v1/users/` read, which the picker is
   built from), click `Assign role`.
3. In `Users and groups` pick the subject and press Escape to close the popover; pick
   `Viewer (System)`, switch Scope to `Project`, and pick the created project in
   `Scope target`.
4. Submit `Assign Role`.
5. At the API, the subject now holds exactly one new assignment, and it carries
   `domain_type: "project"` with `domain_id` equal to the created project's id.
6. The row on the screen reads `Project: <name>`.

**Test 4 — revoking on the screen removes it.**
1. Assign `viewer` globally to the subject through the API and reload the tab.
2. Open **that row's** `Actions <username>` menu, choose `Revoke <username>`, then confirm
   with `Revoke` inside the dialog.
3. At the API the subject holds no assignment.

## Validation criterion *(required)*

- **1** fails when a system role becomes editable from the screen (an `Edit`/`Delete`
  control appears on a `System` row), when a custom role loses them, or when the API accepts
  a write to a system role.
- **2** fails when a grant belonging to another user is missing from the tab — the signature
  of the screen reading the caller-scoped listing.
- **3** fails when the created assignment is not project-scoped, or is scoped to a project
  other than the one picked.
- **4** fails when the assignment survives a confirmed revoke.

## External dependencies *(required)*

- The **RBAC** Enterprise variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`
  (defaults to `http://localhost:7891`). The gate skips rather than fails on anything else.
- A browser. This is the first spec in `enterprise/authz/` that is not API-only.
- No LLM provider, no network egress, no licence key — but on the 1.13 line the script must
  set `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true` (custom-role and project creation
  answer `503` without a licence), and it does (#2259). The UI session is seeded with the
  cached access **and** refresh tokens (`seedEnterpriseUiSession`).

## Notes

**Selector traps encoded here.**

- The revoke confirm dialog has its own `Revoke` button and the row's menu item is
  `Revoke <username>`; every reference is scoped to the row, the menu or the dialog, and the
  dialog's button is matched exactly.
- Two dialogs are open while the subject picker is: the Assign role dialog and its unnamed
  popover. `getByRole("dialog")` is strict-mode ambiguous then, so the Assign role dialog is
  always addressed by name.
- The `Scope target` options read `<project name> — <owner username>`, because two stock
  projects share the name `Starter Project`. The test sidesteps the ambiguity by creating
  its own project instead of relying on the suffix.
- The role picker labels system roles `Admin (System)`, `Editor (System)`, `Viewer (System)`
  — display names, not the API's `admin` / `developer` / `viewer`. `developer` renders as
  **Editor**.
- `permissionMatrix` renders `{{selected}} of {{total}} selected`. #1460 is that same shape
  — an sr-only "N of M" counter that broke two specs reading an option's own text — so
  nothing here asserts on option text inside that matrix.

**A dropped connection is not a verdict.** Every test here reads the API right after
several seconds of driving the screen, and one such read failed with `socket hang up` —
which aborted the `expect.poll` around it, because `expect.poll` propagates a throw from
its poller. The drop itself is **not attributed**: the container never restarted, its
cgroup reports `oom_kill 0` with no memory limit, there is no gunicorn worker to respawn
(`LANGFLOW_WORKERS=1`) and nothing in its log; and the obvious explanation is refuted —
uvicorn does close an idle keep-alive connection at ~5 s (measured: 4 s survives, 6 s reads
empty), but `APIRequestContext` absorbs that and answers `200` at 2/4/6/8 s. It is
load-dependent: 10 consecutive local runs never reproduced it while a loaded machine hit it
on the first.

So the reads are wrapped in `retryOnDroppedConnection`, which re-dials **once** on a thrown
request and passes a response that arrived straight through, whatever its status — no
assertion is softened by it. It is pinned by unit test rather than by a green run
(`tests/helpers/api/retry-on-dropped-connection.test.ts`), because the mechanism does not reproduce on
demand and because the risk in a retry helper is not that it fails to retry but that it
quietly retries a real product refusal.

**Cleanup.** Every artifact is id-scoped and removed in `afterEach`: the custom role, the
project, and every assignment the test or the screen created. The subject's assignments are
reset before each test as well, so a test that dies mid-way cannot hand the next one a
grant it did not make. The shared subject account itself is deliberately persistent — it is
cached across runs to stay inside EE's 5-logins-per-minute budget.

**`GET /api/v1/auto_login` answers `403`** on every page load of a password-first instance.
Correct behaviour, and the HTTP error policy already exempts auth endpoints, so it neither
fails the test nor pollutes the advisory log.
