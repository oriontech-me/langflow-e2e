# Enterprise — The Admin UI Renders the Read-Only State for an Externally Managed Policy

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`/admin-ee/catalog` is the screen an operator uses to decide what the platform's users
may place. When the policy belongs to the deployment rather than to this screen, the
screen has to say so and stop offering to edit it — otherwise the operator is invited to
make a change that either does nothing or, worse, quietly overrides what the deployment
declared.

The frontend implements that state, and it gates all of it on a single API field,
`managed_externally`. Three things change when it is true, measured:

| Surface | `managed_externally: false` | `managed_externally: true` |
|---|---|---|
| Banner (`role="note"`) | absent | *Managed by deployment configuration — This policy is read-only here.* |
| **MANAGED IN** row, per bundle | `Admin › Catalog` | `External policy source` |
| **Edit Catalog Policy** button | enabled | **disabled** |

The button is the load-bearing one. A banner is a statement; a disabled control is the
thing that actually prevents the edit, and a build that kept the banner while re-enabling
the button would look correct in a screenshot and be wrong in every way that matters.

## Why two tests, one mocked and one not

They answer different questions, and the pair is diagnostic in a way neither is alone.

**The mocked test asks whether the UI honours the field.** It intercepts the policy reads
and flips `managed_externally` to `true`, then asserts the three surfaces above. This is a
frontend contract test and it is deliberately independent of what the backend currently
reports.

It exists because the alternative is no coverage at all: on current builds the backend
reports `managed_externally: false` even for a policy the deployment declared, so the
read-only path is unreachable from a real instance. A refactor that dropped the field
would be invisible to a suite that only ever exercises the reachable half — the dead-gate
failure mode this repo has been bitten by before.

**The unmocked test asks whether an operator actually sees it**, against an instance
started with the policy declared in its environment. That is the user-facing consequence,
not a restatement of the API assertion: the operator is looking at an editable screen for
a policy they declared in the deployment.

Reading the pair:

| Mocked | Live | Meaning |
|---|---|---|
| pass | fail | the UI is correct and the API misreports the field — **the state today** |
| fail | fail | the UI dropped the contract; fixing the API would not fix the screen |
| pass | pass | correct end to end |

> **Known state.** The live test is **expected to fail** on current Enterprise builds, for
> the same product finding its API sibling `environment-policy-authority` records — tracked
> outside this repository. Do not relax it to make the lane green. The mocked test is
> expected to pass, and a failure there is a real frontend regression.

## Tags *(required)*

`@enterprise` `@regression` `@governance`

No `@api` — this is the browser-facing half, and its API counterpart is a separate spec.
No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

1. Sign in through the login form with the Enterprise lane password.
2. Require the instance to block the component in its **environment** — skip, naming the
   start command, otherwise. The gate reads the deployment's own bundle revision, so it is
   unaffected by any earlier write.
3. Open `/admin-ee/catalog` and wait for the bundle list to render — a screen that has not
   loaded satisfies every "absent" assertion below while proving nothing.
4. Expand the first bundle (`button[aria-controls^="catalog-bundle-"]`).
5. Assert the three surfaces:
   - the `role="note"` banner naming deployment configuration,
   - the **MANAGED IN** row reading the external source rather than this screen,
   - the **Edit Catalog Policy** button disabled.
6. The mocked test does the same with `managed_externally` forced to `true` on the policy
   reads; the live test does it with no interception at all.

## Validation criterion *(required)*

The mocked test fails when the frontend stops honouring `managed_externally` — no banner,
a provenance row still pointing at this screen, or an edit control that remains usable.
The live test fails when an operator viewing a deployment-declared policy is offered an
editable screen.

## External dependencies *(required)*

- A Langflow **Enterprise** instance started with the component blocked:
  `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText ./scripts/start-langflow-enterprise.sh`
- A browser. This is the only spec in `enterprise/governance/` that is not API-only.
- No LLM provider and no network egress.

## Notes

`GET /api/v1/auto_login` answers `403` on this password-first instance on every page load.
That is correct behaviour, not a defect, and the HTTP error policy already exempts auth
endpoints — so it neither fails nor pollutes the advisory log.
