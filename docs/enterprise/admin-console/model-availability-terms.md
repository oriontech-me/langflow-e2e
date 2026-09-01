# Enterprise — Approved Is Not Available, and Three Surfaces Have to Say So

**Last validated:** Langflow Enterprise 1.12.0 (image built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`/admin-ee/models` is where an operator decides which models the platform may offer. It is the
last of the four per-tab follow-ups to the console shell, and it was scheduled last on an
assumption that turned out to be **wrong**: that it needed a provider credential.

Measured: approving a provider — itself keyless, as `provider-approval-terms` established —
populates this screen with **44 models** and no key anywhere. The assumption is recorded because
it is why this tab waited, and because the same assumption would send the next person looking for
an API key they do not need.

### The chain this screen exists to keep honest

With a provider approved and no credentials configured:

```
Provider | Models    | Status  | Builder visibility | Action
OpenAI   | 44 models | Pending | Hidden             | Review
```

and `GET /api/v1/model-availability-policy` reports `enabled_model_keys: []`, with all 44 models
present under `providers[].models[]`. Expanding the row shows each of them marked **Disabled**.

**Approved is not available**, and three surfaces have to agree about it: the row's `Hidden`, the
models' `Disabled`, and the policy's empty `enabled_model_keys`. A build where any one drifted —
a provider reported `Visible` while nothing is enabled, or models reading `Enabled` against an
empty policy — would tell an operator the platform is offering models it cannot call.

That chain is the point of the screen, and none of it needs a key.

### The empty state is the state most instances are in

With nothing approved the screen is not blank — it names the cause and links the fix:

> No model providers available — You must **add a provider** before managing m…

with the link pointing at `/admin-ee/providers`. That is the only guidance an operator gets on a
fresh instance, so it is asserted rather than assumed.

## What is deliberately not asserted

**`Edit Models`, filed as #1659.** It is an enabled `<button>` that opens nothing: no dialog, no
menu, no navigation, and the panel text shrinks from 1645 to 1295 characters — it collapses the
expanded row instead.

Left unasserted in **either** direction on purpose. Asserting that it opens an editor would pin a
defect; asserting that it collapses the row would pin a behaviour nobody has said is intended. The
provider is `Pending`, so an unavailable editor is a defensible product state — but then the
control should say so, which is exactly what its neighbours on this screen do. That distinction
needs a credential to settle, and this spec is keyless by design.

`Edit provider access` and the `Configure` credential flow are out for the same reason the
provider spec left them out: keeping this runnable on any Enterprise instance is worth more than
the coverage they would add.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

Not `@governance`: that tag is always paired with `@destructive`, and `@destructive` /
`@enterprise` are mutually exclusive lane selectors — a test carrying both is unrunnable in every
lane. The instance-global mutation is contained by the Enterprise lane's isolation plus the
teardown below.

No `@stable`: there is no scheduled Enterprise lane (#1010).

## Step by step *(required)*

1. Authenticate once, require the **RBAC variant**, seed the browser session from the cached
   token.
2. Revoke the provider approval **before** asserting anything, rather than assuming a clean
   instance — a previous run that died between its approval and its teardown would otherwise make
   the empty-state test read the wrong way round.
3. **Empty state.** Open `/admin-ee/models` with nothing approved and assert it names the missing
   providers and links to `/admin-ee/providers`.
4. **Populate.** Approve the provider through `/admin-ee/providers`, return, and assert the row
   appears reporting a model count.
5. **The chain.** Assert the row reads `Pending` and `Hidden` while the policy's
   `enabled_model_keys` is empty.
6. **The expansion.** `Review` the row and assert the governance terms it inherited from the
   approval — *All workspaces*, *All environments* — and that models are listed `Disabled`.
7. Restore: `DELETE /api/v1/model-provider-governance/{provider_id}` carrying
   `{"expected_revision": <revision from GET /api/v1/policy-bundle>}` → `204`.

## Validation criterion *(required)*

Fails when the empty state stops naming what is missing, when approving no longer populates the
catalog, when the screen reports availability the policy does not hold, or when the expanded row
stops stating the governance terms the approval set.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`.
- A browser.
- **No credential of any kind**, no LLM provider, no network egress, no licence, no additional
  login.
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`.

## Notes

The teardown is the one `provider-approval-terms` established, and the warning there applies here
unchanged: `PUT /api/v1/model-provider-policy` with an empty list clears the policy while leaving
the governance record `active`, so the two surfaces disagree afterwards. Use the `DELETE` with
`expected_revision`.

The three non-2xx responses the console fires on every page load — `auto_login` `403`, `refresh`
`401`, `store/tags` `500` — are covered in the shell spec's notes, including the measurement trap
that the fixture prints `Backend Error` on **stdout**.
