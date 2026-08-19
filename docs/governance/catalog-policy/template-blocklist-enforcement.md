# Catalog Policy — Template Blocklist Enforcement

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev32`)

---

## What this test validates *(required)*

The catalog policy blocks **templates** as well as components, through a second
key set (`blocked_template_keys`) and a second endpoint
(`PUT /api/v1/catalog-policy/templates`). It is a distinct enforcement path from
the component blocklist — a different filter, in a different handler, over a
different listing — so a green component spec says nothing about it.

Two listings serve templates and **both** must honour the block, because they
back different entry points:

- `GET /api/v1/starter-projects/` — 5 items on the measured build.
- `GET /api/v1/flows/basic_examples/` — 26 items; this is the one the New Flow
  templates modal reads.

A spec that checked only one of them would pass while the templates modal still
offered a template the operator removed.

**The key is the slug, not the display name — and that is the assertion this spec
exists for.** Measured on `1.12.0.dev32`: `PUT` with `"Basic Prompting"` is
accepted `200`, persists into the bundle, and filters *nothing*; `"basic_prompting"`
removes it from both listings. An operator blocking a template by the name they
see in the UI gets a green API response and no enforcement. The spec pins both
halves — the accepted-but-inert display name and the effective `name_key` — so the
day upstream starts normalising display names, this test says so instead of a
release-validation checklist quietly passing.

The escape hatch is asserted too: `?include_blocked=true` returns the blocked
template, and the handler restricts that parameter to superusers (`403`
otherwise). It is what an admin UI would use to show a blocked-but-listed state,
and it is the only way to prove the template was *filtered* rather than *gone
from the image*.

The `name_key` is read from the listing itself (both endpoints expose it) rather
than hardcoded, so the spec cannot drift from upstream's slug convention silently
— it fails on a real change instead of on a stale constant.

## Tags *(required)*

`@destructive` `@api` `@templates`

**Not `@stable`:** the policy is instance-global, so this is the `@destructive`
lane (see `component-blocklist-enforcement.md` → *Tags* for the full rationale;
`daily-stable.yml` has no destructive lane, and `@stable` without a lane is #1010).

## Precondition *(required)*

The instance's template blocklist is empty. The test skips naming the observed
state otherwise — a pre-blocked instance makes the "absent after blocking"
assertions unfalsifiable.

## Step by step *(required)*

1. Snapshot the bundle; require an empty `blocked_template_keys`, skip otherwise.
2. Resolve the target template (`SaaS Pricing`, referenced by no other spec) in
   `GET /api/v1/flows/basic_examples/` and read its `name_key` from the payload.
3. **Control:** the template is present in `basic_examples`; record both listing
   sizes.
4. `PUT /api/v1/catalog-policy/templates` with the **display name** → `200`, and
   both listings are unchanged (same size, template still present).
5. `PUT` with the resolved `name_key` → `200`.
6. `GET /api/v1/flows/basic_examples/` → the template is absent and the count
   dropped by exactly one.
7. `GET /api/v1/starter-projects/` → unchanged in this case (the target is not a
   starter project), while a starter-project target blocked the same way drops
   out of it — asserted by blocking `basic_prompting` and re-reading both
   listings, then restoring.
8. `GET /api/v1/starter-projects/?include_blocked=true` as the superuser → the
   blocked starter project is returned, proving filtering rather than absence.
9. Restore the snapshot and re-assert both listings are back to their control
   sizes.

## Validation criterion *(required)*

Fails if a blocked `name_key` still appears in either listing, if blocking by
display name silently *does* filter (the contract changed and the spec's stated
trap is stale), if `include_blocked=true` does not return the blocked template
for a superuser, or if the listings do not return to their control sizes after
the restore.

## External dependencies *(required)*

- A Langflow instance on the 1.12 line. No Enterprise image, no license, no
  provider key.
- The bundled starter templates. `SaaS Pricing` is referenced by no other spec;
  `Basic Prompting` **is** used by several, so it is blocked only inside step 7's
  narrow window and restored immediately — which is also why this file is
  `@destructive` and pinned to `workers: 1`.

## Upstream dependencies *(source paths watched)*

Verified to resolve on `langflow-ai/langflow@release-1.12.0`:

- `src/backend/base/langflow/api/v1/catalog_policy.py` — the `templates` endpoint.
- `src/backend/base/langflow/api/v1/starter_projects.py` — filters on `name_key`
  and owns the superuser-only `include_blocked` parameter.
- `src/backend/base/langflow/api/v1/flows.py` — the `basic_examples` listing,
  the second surface that must honour the same block.
- `src/backend/base/langflow/services/catalog_policy/service.py` — key
  normalisation, which is why the display name is inert.
