# Enterprise — The Users & Groups Screen Deactivates, Promotes and Deletes for Real

**Last validated:** Langflow Enterprise 1.12.0 (image built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`console-tab-contract` proved all seven `/admin-ee` screens resolve and load their own data.
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

### The screen, measured

Columns: `Id`, `Username`, `Active`, `Superuser`, `Created At`, `Updated At`, `Actions`. The
`Users` / `Teams` sub-tabs are plain text with neither `role` nor `data-testid`.

There are **no per-row testids**. Every per-row control is named `"<Control> — <username>"`,
and that is the entire locator story here:

| Row | `Active` | `Superuser` | `Delete` |
|---|---|---|---|
| an ordinary account | enabled, `[pressed]` | enabled, not pressed | enabled |
| `langflow` (break-glass) | **disabled** — *You cannot deactivate your own account* | **disabled** — *break-glass … cannot be deactivated, demoted, or deleted* | **disabled**, same reason |

**Both** control groups confirm, and the two dialogs differ in a way that matters:

| Control | Reversible? | Dialog |
|---|---|---|
| `Active` / `Superuser` | yes | **Edit** → **the username** → *Attention!* → *Are you completely confident about the changes you are making to this user?* → `Confirm` / `Cancel` |
| `Delete` | **no** | **Delete** → *Delete User* → *Attention!* → *Are you sure you want to delete this user? This action cannot be undone.* → `Delete` / `Cancel` |

The toggle path is real end to end — click → `Confirm` → `PATCH /api/v1/users/{id}` →
`is_active` reads back `false` — so the toggle tests must drive the confirmation, not just
the switch.

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

Worth recording, because the wrong version of it was one step from being filed as an
accessibility finding: the delete button's `aria-label` **attribute** is `null` on ordinary
rows and set on the protected one. Read that way it looks like the button you cannot press is
announced while the one that deletes an account is not.

It is not. The name lives on a descendant, and the accessibility tree computes
`button "Delete — <username>"` on **both** rows. `getByRole("button", { name: /Delete/ })`
finds one on each. The tree is the authority; `getAttribute("aria-label")` is not, and this
spec locates by role and name throughout for that reason.

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
3. **Protection.** Open the screen and assert the three controls on the `langflow` row are
   disabled, each exposing its reason. Then assert the API refuses all three operations, **and
   that it refuses them as two different guards**: `PATCH is_active:false` answers `403` *You
   can't deactivate your own user account* (self-protection) while `PATCH is_superuser:false`
   and `DELETE` answer `409` naming the break-glass account. The screen shows two distinct
   tooltips; asserting only "it was refused" would pass against a build that collapsed them.
4. **Cancel.** Create a subject through the API, open its delete dialog, assert the copy names
   the action as irreversible, dismiss with **Cancel**, then assert **no non-`GET` request was
   issued for that account**, and that it is still listed.
5. **Delete.** Reopen the dialog on the same subject, confirm, and assert the API no longer
   lists it — the row disappearing is a render, the listing is the state.
6. **Toggles.** On a fresh subject, click `Active`, confirm in the **Edit** dialog, and read
   `is_active` back from the API; likewise `Superuser` and `is_superuser`.

Every subject is created and removed through the API, so the spec spends **no** login budget
of its own. It touches the superuser row only to assert that it cannot be touched.

## Validation criterion *(required)*

Fails when the break-glass account becomes operable from the screen or at the API; when
`Cancel` deletes, or confirming does not; or when either toggle changes the control without
changing the account.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`.
- A browser.
- No LLM provider, no network egress, no licence, and no additional login.
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`, so
  there is none to name. Every sibling under `docs/enterprise/` is in the same position.

## Notes

**The delete dialog does not name the user it is about, and the edit dialog on the same screen
does.** The toggles open *Edit → **the username** → Attention!*; deleting opens *Delete → Delete
User → …this **user**…*. So the pattern exists and is implemented here — it is applied to the
**reversible** action and omitted from the **irreversible** one. An operator is named the
account when nothing is at stake and told *this user* when the row is about to be deleted
permanently.

This spec asserts the copy that exists rather than the copy that arguably should — the gap is
recorded in #1633 for a product decision, and a spec that failed on it today would be
asserting an opinion. If the dialog is later changed to name its subject, this note and the
assertion move together.

`GET /api/v1/auto_login` → `403`, `POST /api/v1/refresh` → `401` and `GET /api/v1/store/tags`
→ `500` occur on every page load of this console and are already exempt; see the shell spec's
notes, including the measurement trap that the fixture prints `Backend Error` on **stdout**.
