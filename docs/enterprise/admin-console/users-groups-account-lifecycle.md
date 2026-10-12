# Enterprise — The Users & Groups Screen Deactivates, Promotes and Deletes for Real

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`console-tab-contract` proved every `/admin` screen resolves and loads its own data.
It says nothing about what any of them lets an operator *do*. This is the first per-tab
follow-up, and `users-groups` is first because of what its controls are: this is where an
account is **deactivated**, **promoted to superuser**, and **deleted** — and deletion is
irreversible.

Three properties, each chosen because the screen can satisfy the obvious version of it while
being wrong:

1. **The break-glass account is protected on the screen *and* at the API.** A disabled
   control over an API that accepts the write is a screen that only *looks* protective, and
   the disabled state is exactly what stops anyone from discovering it by hand.
2. **The confirm dialog is a gate, not decoration.** Confirming deletes at the API; **Cancel
   leaves the account intact**. A dialog that deletes on either button passes every test that
   only walks the happy path.
3. **The toggles change the account, not their own pixels.** `Active` and `Superuser` are read
   back from the API rather than from the control that was clicked. A toggle that flips its own
   state and sends nothing is the failure this exists to catch — and it is invisible to a test
   that asserts on the toggle.

### The screen, measured (1.13)

The table was redesigned (EE PR 493, LE-2923). Columns: *User · Groups · Role · Scope · Status ·
Action*; it pages at 12, ordered by username, with a `Search Username` box. Each row is
`tr[data-testid="user-row-<id>"]`, and its `Manage` button expands a **sibling** `<tr>` holding
`td#user-panel-<id>` — so the row's controls are not inside the row:

| Control (in the details panel) | Ordinary account | `langflow` (the signed-in break-glass account) |
|---|---|---|
| `Edit User — <u>` | opens the Edit user dialog | opens it, with both switches disabled |
| `Delete user — <u>` | opens the delete dialog | **disabled** (`aria-disabled`) — *You cannot delete your own account* |

The Edit user dialog — *Change access settings for &lt;u&gt;.* — holds two switches, `Active` and
`Superuser`, committed together by `Save Changes` as one `PATCH /api/v1/users/{id}`
(`{"is_active": false}`). On the signed-in account both switches are disabled with their own
reasons, *You cannot deactivate your own account* and *You cannot remove superuser access from
your own account*. On 1.12 the screen showed the **break-glass** reason here; since 1.13 the
**self** reason wins when the break-glass account is the one signed in, which on this lane it
always is.

The delete dialog — *Delete User*, *Are you sure you want to delete this user? This action
cannot be undone.*, `Cancel` / `Delete` — is unchanged, and `DELETE /api/v1/users/{id}` now
answers **`202`** and erases the account in the background (langflow-ai/langflow#15470).

## Locator traps on this screen

- **The Edit user dialog's accessible name is "Dialog"**: a hidden heading precedes the visible
  *Edit user*. `getByRole("dialog", { name: "Edit user" })` matches nothing, so it is found by its
  visible heading.
- **The details panel is a sibling row.** Scoping a control to the account's row finds nothing.
- **Disabled is `aria-disabled`, not the native attribute**, on the self-delete control —
  `toBeDisabled()` honours both; a check on the `disabled` attribute would not.

## Two locator traps on this screen

Both were measured, and each produces a spec that looks correct:

- **The confirm control carries `data-testid="replace-button"`.** It is a shared modal
  component, so that testid says nothing about deletion and would silently follow the
  component into some other dialog. Addressed by role and name instead.
- **Two controls read `Cancel`.** `getByText("Cancel")` is a strict-mode violation waiting for
  the second one to render; the dialog is scoped first, then the control taken by role.

## "Still there" is not assertable by reading the state once

The obvious version of the Cancel test — dismiss the dialog, then read the listing — is
**racy in the exact direction that matters**, and the force-fail is what proved it rather than
review. Swapping this test's `Cancel` for the `Delete` control left it **green**: the account
was genuinely deleted, and the listing was read while that request was still in flight.

An assertion that a destructive action did *not* happen cannot be a single read taken
immediately after the moment it would have happened. So the claim is made directly: a request
listener armed before the dialog opens records every non-`GET` for that account's path, and
`Cancel` must produce none. The listing read stays alongside it — it states the outcome an
operator cares about — but it is the network assertion that makes the test non-racy.

Waiting longer would not have fixed this. It would have made the race less likely to be
observed, which is worse than leaving it visible.

## An attribute is not an accessible name

Recorded on 1.12 and still the rule: the accessibility tree is the authority, not
`getAttribute("aria-label")` — a name can live on a descendant. This spec locates by role and
name throughout for that reason.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

Same three as the shell spec it extends. Not `@authz`: the sibling `access-control-ui` owns
the authorization screen, and this one is account lifecycle — who exists and whether they are
active — which the authorization model consumes but does not define.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

1. Authenticate once and require the **RBAC variant**, as § 22.7 does.
2. Seed the browser session from the cached token. The form is
   `enterprise/auth/login-surface`'s subject, and the instance rate-limits `/api/v1/login` to
   5 per minute for the whole machine.
3. **Protection.** Search for `langflow`, expand its details: `Delete user — langflow` is
   disabled and describes *You cannot delete your own account*; in its Edit user dialog both
   switches are disabled, each describing its reason. Then assert the API refuses all three
   operations, **as two different guards**: `PATCH is_active:false` → `403` *You can't
   deactivate your own user account* and `PATCH is_superuser:false` → `409` *You cannot remove
   superuser access from your own account* (self-protection; on 1.12 the demote was refused by
   the break-glass guard), while `DELETE` → `409` *The break-glass account cannot be deleted*.
   And the account survives all three.
4. **Cancel.** Create a subject through the API, search for it, open its delete dialog, assert
   the copy names the action as irreversible, dismiss with **Cancel**, then assert **no
   non-`GET` request was issued for that account**, and that it is still listed.
5. **Delete.** On a subject, confirm the dialog: the `DELETE` answers `202`, the API stops
   listing it (polled — the erase is asynchronous), and after a fresh load the row is gone.
6. **Toggles.** On a fresh subject, open Edit user, flip `Active`, `Save Changes`, and read
   `is_active` back from the API; likewise `Superuser` and `is_superuser`.

Every subject is created and removed through the API, so the spec spends **no** login budget
of its own. It touches the superuser row only to assert that it cannot be touched.

## Validation criterion *(required)*

Fails when the signed-in break-glass account becomes operable from the screen or at the API
(or the two guards collapse into one); when `Cancel` deletes, or confirming does not; or when
either switch changes the control without changing the account.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`.
- A browser.
- No LLM provider, no network egress, no licence, and no additional login. On the 1.13 line the
  script sets `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`; without it creating the
  subjects answers `503` (#2259).
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`, so
  there is none to name. Every sibling under `docs/enterprise/` is in the same position.

## Notes

**The delete dialog does not name the user it is about, and the edit dialog on the same screen
does.** Edit user reads *Change access settings for **&lt;username&gt;**.*; deleting reads *Delete
User → …this **user**…* (still true on 1.13). So the pattern exists and is implemented here — it is applied to the
**reversible** action and omitted from the **irreversible** one. An operator is named the
account when nothing is at stake and told *this user* when the row is about to be deleted
permanently.

This spec asserts the copy that exists rather than the copy that arguably should — the gap is
recorded in #1633 for a product decision, and a spec that failed on it today would be
asserting an opinion. If the dialog is later changed to name its subject, this note and the
assertion move together.

`GET /api/v1/auto_login` → `403` occurs on every page load of this console and is already
exempt; see the shell spec's
notes, including the measurement trap that the fixture prints `Backend Error` on **stdout**.
