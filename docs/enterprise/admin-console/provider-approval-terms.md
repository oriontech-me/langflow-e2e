# Enterprise — Approving a Provider Writes the Terms the Screen Displayed

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`/admin/providers` is where an operator decides **which model providers this installation may
use at all**. One click changes that for every workspace, and nothing covered it.

It is an **approval** surface, not a configuration one — which is why this tab came before
`models`, and why the whole spec runs without a single credential.

### The dialog states the alias before the click — and only the alias (1.13)

On 1.12 each recommended provider was a **card** stating its terms — *All workspaces*, *All
environments*, credential alias `openai` — with an `Approve` button. The 1.13 console removed the
cards (EE PR 326). Approval is now the header's `Add provider` button, opening
`dialog "Add provider"`:

| Field | Shown |
|---|---|
| `Provider / API` (combobox) | pick *OpenAI* |
| `Credential alias` (textbox) | prefilled `openai` once the provider is picked |
| `Owner / team` (textbox) | empty |
| `Observability required` (switch) | on |

The alias is still the term the write must carry, and that pairing is the one no API test can
make: a screen that shows one alias and keys the policy on another is wrong in a way only a
browser test sees. It is read with `toHaveValue` — it is an input, and `toContainText` does not
read inputs.

The **scope is no longer displayed**. The dialog writes it as a hidden default — `workspaces:
["all"]`, all three environments, `data_policy: "internal"`, `production_requirement:
"noApproval"` — and the Models screen later shows it as *All workspaces / All environments*. So
the scope is pinned at the API: a narrower default would silently not apply where an operator
approving "globally" expects. Whether an approval should show its scope before it is made is a
product question, recorded in #2259.

### Approving is one submit and one write

```
POST /api/v1/model-provider-governance  ->  201
```

after which `GET /api/v1/model-provider-policy` reports `approved_provider_ids: ["openai"]` and
the governance record carries `credential_alias: "openai"`, `workspaces: ["all"]`,
`environments: ["dev","production","staging"]`, `status: "active"`, `approved_by`, `approved_at`.

### Approved is not usable, and the screen says so

The provider leaves **Recommended providers** and appears under **Needs attention** as `Pending` —
*"Configure credentials to finish setting up this provider."* — and in **Available Providers**
with Status `Pending`.

That distinction is the reason test 2 exists. Approval is a policy act; it does not make a single
model callable. A screen reporting *Approved / ready* here would tell an operator their platform
can use OpenAI when nothing can authenticate to it.

### `Dismiss` is a third act, and it is not revocation

Measured: clicking `Dismiss <Provider>` on the attention card issues **no API write at all**,
leaves `approved_provider_ids` unchanged, and the provider remains listed under *Available
Providers*. It dismisses the reminder, not the approval.

Both directions of that are worth pinning. A build where `Dismiss` silently revoked the approval
would surprise an operator into an outage; one where it also dropped the *Available* row would
hide an approved provider from the only screen that lists it.

**This was very nearly filed as a defect.** The first measurement looked at the Recommended list
only, saw the card vanish while the policy still said `["openai"]`, and read as *"the screen
forgets an approval it made"*. A full re-read of the panel showed the provider sitting in
*Available Providers* exactly as it should. Recorded because the wrong version of this observation
was one step from an issue, and because it is the third time in this area that a partial read of a
screen produced a confident wrong conclusion.

## Teardown, which is part of the contract here

Approval is **instance-global**: the spec must restore what it found, or every later spec inherits
an approved provider.

The path the product intends is:

```
DELETE /api/v1/model-provider-governance/{provider_id}
       body {"expected_revision": <revision from GET /api/v1/policy-bundle>}   ->  204
```

`expected_revision` is optimistic concurrency over the whole policy bundle — the removal refuses
to act on a bundle that moved under it.

**The obvious alternative leaves the instance inconsistent, and this is recorded so nobody
"simplifies" the teardown into it:** `PUT /api/v1/model-provider-policy` with an empty
`approved_provider_ids` answers `200` and clears the policy **while the governance record stays
`active`**. The two surfaces then disagree about whether the provider is approved. That is not a
product defect — the UI never takes that path, it was a cleanup shortcut — but it is exactly the
state a careless teardown hands to the next spec.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

Not `@governance`: that tag is always paired with `@destructive` for the OSS lane, and
`@destructive` and `@enterprise` are mutually exclusive lane selectors — a test carrying both
would be unrunnable in every lane (`tests/fixtures/lane.ts`). The instance-global mutation is
contained by the Enterprise lane's own isolation (`workers: 1`, a dedicated instance) plus the
teardown above.

No `@stable`: there is no scheduled Enterprise lane (#1010).

## Step by step *(required)*

1. Authenticate once, require the **RBAC variant**, seed the browser session from the cached
   token.
2. Record the governance records and `approved_provider_ids` as found, so teardown restores rather
   than wipes.
3. Open `/admin/providers`, click `Add provider`, pick the target provider in `Provider / API`,
   and read the dialog's `Credential alias`.
4. Submit `Add Provider`, then assert the governance record carries that alias, `workspaces: ["all"]`,
   `status: "active"` and the approving user's id — and that `approved_provider_ids` gained exactly
   that provider.
5. Assert the screen reports it `Pending` under *Needs Attention*, naming credentials as what is
   missing, and lists it as `provider-row-<alias>` under *Available Providers*.
6. Click `Dismiss`, assert no write was issued, the policy is unchanged, and the provider is still
   listed under *Available Providers*.
7. Restore: delete the governance record with the current bundle revision.

## Validation criterion *(required)*

Fails when approving writes an alias other than the one the dialog displayed or a scope other
than the documented default, when an approved
provider is reported as ready rather than pending credentials, or when dismissing the reminder
changes the approval — in either direction.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`. On the 1.13 line the script sets
  `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`: the governance and model-policy routes
  this screen reads and writes are tier-gated and answer `503` without a licence (#2259).
- A browser.
- **No credential of any kind**, no LLM provider, no network egress, no licence, and no additional
  login. Keeping it keyless is deliberate: it is what makes this runnable on any Enterprise
  instance, and it is why this tab was covered before `models`, whose screen reads *No model
  providers available* until one is configured.
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`.

## Notes

The non-2xx responses the console fires on every page load — `auto_login` `403`, and (on 1.12) `refresh`
`401`, `store/tags` `500` — are covered in the shell spec's notes, including the measurement trap
that the fixture prints `Backend Error` on **stdout**.
