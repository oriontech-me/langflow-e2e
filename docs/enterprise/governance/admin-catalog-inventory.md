# Enterprise — The Admin Catalog Inventory Agrees With the Declared Policy

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`GET /api/v1/enterprise-admin/catalog/components` is the Enterprise-only endpoint
an administrator's catalog screen reads. It answers one question — *what can I
block, and what is blocked?* — and it is the only surface that answers it, so a
wrong answer there is not cosmetic: it is the operator choosing policy from a
list that does not describe the instance.

It is deliberately **not** the palette. The palette is what policy already
filtered; the inventory is what policy can be written *about*, so it must keep
listing a component after that component has been blocked — otherwise blocking
one would remove it from the screen used to unblock it.

That gives an exact relationship rather than a vague one, and the spec asserts it
in both directions:

- **`inventory ⊇ palette`** — nothing a user can place is missing from the
  administrator's list. A component absent here cannot be governed at all.
- **`inventory − palette` = exactly the declared blocklist** — the difference is
  the policy and nothing else. A component that is in the inventory, absent from
  the palette and *not* in the policy is one being hidden by something the
  operator never declared.

Measured on the 1.12 reference instance: 161 inventory types, 160 palette types; on 1.13
(`bbbec5fb`): **194** and **193** — in both, the difference is the single blocked component and
the reverse difference empty.

Since the 1.13 line the palette (`GET /api/v1/all`) is also filtered by **integration** policy
(langflow-ai/langflow#14947), and the inventory is not. On a fresh instance integration policy
is empty and unrestricted, so the equality still holds — but it now has a precondition. The
test asserts it first (`approved_integration_provider_ids` and `blocked_integration_action_keys`
both empty on the bundle) and fails naming them, rather than reporting an integration filter as
an undeclared hiding mechanism.

### `policy_candidates` — the answer to a trap this area already has

Each entry carries `policy_keys`, and the payload carries a `policy_candidates`
map resolving **every accepted spelling** to the canonical type — `Combine Text`,
`CombineTextComponent` and `CombineText` all resolve to `CombineText`.

That map is what makes a declared key verifiable instead of hopeful, and this
product area needs it: `governance/catalog-policy/template-blocklist-enforcement`
measures that blocking a *template* by its display name is accepted and enforces
nothing. Components resolve aliases; templates do not. An operator has no way to
know which behaviour they are getting except by reading this endpoint, so the
spec asserts that the key the deployment declared resolves through it.

A blocklist entry that resolves to nothing is the silent-no-op failure mode in its
purest form: accepted at boot, echoed by the bundle, enforcing nothing, with no
error anywhere.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@governance`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here
would silently never run (#1010).

## Step by step *(required)*

1. Authenticate with password login.
2. Require the instance to block the component in its environment — skip, naming
   the start command, otherwise.
3. `GET /api/v1/enterprise-admin/catalog/components` → `200`, with a non-empty
   `components` map and a non-empty `policy_candidates` map. An empty payload
   would satisfy every set relation below and prove nothing, so it is refused
   first.
4. The blocked component is **present** in the inventory, with the declared key
   among its `policy_keys`.
5. `GET /api/v1/all` → the same component is **absent** from the palette.
6. Every palette type appears in the inventory (`palette − inventory` is empty).
7. `inventory − palette` equals exactly the set of blocked component keys the
   bundle reports.
8. Every declared blocklist key resolves through `policy_candidates` to a type
   the inventory lists.

## Validation criterion *(required)*

Fails when the administrator's inventory disagrees with the instance it
describes: a blocked component missing from it (ungovernable), a palette type
missing from it (invisible to policy), a component hidden from the palette that
the declared policy does not account for, or a declared key that resolves to
nothing.

## External dependencies *(required)*

- A Langflow **Enterprise** instance started with the component blocked:
  `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText ./scripts/start-langflow-enterprise.sh`
- No LLM provider and no network egress.
- On the 1.13 line the script sets `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`: the
  policy routes are tier-gated and answer `503` without a licence (#2259).

## Notes

Unlike its sibling `environment-policy-authority`, this spec is **expected to
pass**. It asserts an agreement that holds today, and it exists so that a future
change to either side of it — the inventory or the enforcement — cannot move one
without the other silently.
