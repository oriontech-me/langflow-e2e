# Templates — the registered set, against a committed baseline (`GET /api/v1/flows/basic_examples/`)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-registration.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`, `langflowai/langflow-nightly:latest`,
measured 2026-09-15)

Owning issue: #1862 (row **R1** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Related:** #1744 (*Research Translation Loop* is not registered), #1234 (a template
disappearing was only noticed because a component spec used it as a fixture),
#1084 (an exemption must not expire silently), #1400 (browser locale)

---

## What this test validates *(required)*

`GET /api/v1/flows/basic_examples/` is the listing the New Flow gallery reads. This spec
owns **which templates are in it**: the registered set must be exactly the set a committed
baseline expects, in three branches with three different severities.

Nothing in the suite gives that signal today. `api/flows/api-flows-public-and-metadata.spec.ts`
asserts the endpoint's **shape** — a non-empty array whose entries carry a `name`, a
`description` and `data.nodes`, and which contains *Simple Agent* — and that is all it
asserts about membership. When the image stops registering a template it leaves the gallery
and nothing goes red; #1234 surfaced only because a Loop component spec happens to use that
template as its fixture. This spec is the missing gate, and it is the one **S1**
(`templates-instantiate`, #1864) parametrizes over.

### Why a template disappears at all, measured

At startup `filter_starter_projects_by_available_components`
(`src/backend/base/langflow/initial_setup/setup.py`) drops any starter project one of whose
node types is absent from the live component registry — aliases resolved
(`flatten_components_with_aliases`), and with one exemption: a node carrying its own
`template.code` and no `metadata.module` is an embedded custom component and is never
counted as missing.

Measured on `1.13.0.dev12`:

| Fact | Value |
|---|---|
| Template JSONs upstream ships (`main`, `release-1.13.0`, `release-1.12.1`) | **27** |
| `GET /api/v1/flows/basic_examples/` returns | **26** |
| The one dropped | *Research Translation Loop* — `Skipping starter project 'Research Translation Loop'; unavailable components: ArXivComponent` |
| Registered **despite** an absent component | *Meeting Summary* — `AssemblyAITranscriber` is not in `GET /api/v1/all`, but its node embeds its own code |

*Meeting Summary* is why the baseline is derived from **the listing** and never from the
component catalog: a catalog-derived expectation would call it missing on every run.

### The identity is `name_key`, not `name` — measured

This is the finding that shaped the whole design. The endpoint is **localized by
`Accept-Language`** (#1400): the same 26 entries answer with translated `name` and
`description`, while `name_key` is unchanged.

| `Accept-Language` | `name` | `name_key` |
|---|---|---|
| `en-US` | `Basic Prompting` | `basic_prompting` |
| `pt-BR` | `Sugestões básicas` | `basic_prompting` |
| `en-US` | `Custom Component Generator` | `custom_component_generator` |
| `pt-BR` | `Gerador de componentes personalizados` | `custom_component_generator` |

`name_key` is a persisted column on the flow model — *"Stable i18n key derived from the
original English name"* (`services/database/models/flow/model.py`), produced by
`safe_flow_key(name)` (`utils/i18n_keys.py`, `[^a-zA-Z0-9]+` → `_`, lowercased). It is also
the key upstream's own catalog blocklist filters on
(`_filter_basic_examples_by_catalog_policy`) and the key `FEATURED_TEMPLATE_KEYS` uses.

So the **set comparison keys on `name_key`**. A name-keyed comparison would report all 26 as
missing plus 26 as extra under a `PW_LOCALE=pt-BR` run — which the suite explicitly supports
(`tests/fixtures/locale.ts`) — i.e. it would be an environment-dependent assertion of the
kind this repo has been bitten by. The English `name` is still recorded in the baseline and
still asserted, under an explicitly pinned `Accept-Language: en-US` header, because **S1
clicks the card by its display name**: if the backend stopped honouring the pin, S1 would
start clicking the wrong heading and this spec is where that must show.

### The three branches, and why their severities differ

1. **An undeclared absence FAILS**, naming the missing `name_key`(s) and their recorded
   English names. This is the #1234 gate.
2. **A declared absence is checked in both directions and a stale declaration FAILS**,
   naming the declaration to delete and the issue to close. *Research Translation Loop* is
   declared absent with its reason (`ArXivComponent` is not in the image) and its issue
   (#1744). The day the image ships that component the template comes back, and an
   exemption whose justification expired must not pass silently — #1084's rule, which the
   repo applies to `expectKnownHttpError`, to the `@stable`-orphan exemptions and here.
3. **An extra template is REPORTED, not failed.** A new upstream template costs nobody a
   test (#980's trade). It is printed and pushed as a test annotation; accepting it is a
   reviewed baseline refresh (`npm run templates:baseline`).

### Two decisions this spec records

**A missing template is diagnosed, not just reported.** A catalog policy that blocks a
template removes it from this listing (`_filter_basic_examples_by_catalog_policy`,
`src/backend/base/langflow/api/v1/flows.py`) — so "missing" has two causes with opposite
remedies. The governance specs that block a template run in the `@destructive` lane and
restore the policy, so no scheduled lane sees a block; a **local** run sharing an instance
with one would. On the failing branch only, the spec re-reads the listing with
`?include_blocked=true` (superuser-only, measured `403` without a credential) and says which
world it is in: *present when blocked templates are included* ⇒ a catalog policy is active on
this instance, not a registration loss. That is cheaper and far more actionable than naming
the possibility in prose, and it costs nothing on a green run because the probe only runs
when the assertion is already lost.

**A declaration does not key on the image version — #1862's open question, answered.**
On a `manual.yml` dispatch against an image that *does* register *Research Translation Loop*,
branch 2 fails. That is deliberate and it is the right answer for that image too: the message
names both remedies ("close #1744 and delete the declaration" *or* "this image is not the
nightly — refresh the baseline against it"). Keying declarations on a version was rejected
because the nightly's version changes every day, so every declaration would expire daily and
the mechanism would be noise; reporting instead of failing was rejected because it is exactly
the silent expiry #1084 was raised about. `manual.yml` is a supervised dispatch, never a
scheduled lane, so the cost is one attributed red that a human is already reading.

### Layering

`tests/helpers/other/registered-templates-drift.ts` holds everything that decides, is pure,
and **cannot throw**; the spec holds nothing but I/O and assertions. That split is copied
from `component-catalog-drift.ts` and `api-surface-drift.ts` because it is what made their
guarantee unit-testable rather than asserted — and because `globalSetup`'s catalog comparison
once threw out of an unguarded branch and aborted a whole run with zero tests executed.
There is no fourth verdict state: a listing the parser cannot read is **UNKNOWN with the
reason named**, never clean (#1012). Specifically, a body that is not an array, an empty
array (what a still-starting instance answers, and which would otherwise diff as *all 26
removed*), and an entry with no usable `name_key` each yield UNKNOWN.

---

## Tags *(required)*

`@stable` `@release` `@api` `@templates`

Per the scope doc's planned-spec table (`@api` `@release` · `@templates`). `@stable` is
carried from this spec's own PR: it is keyless, egress-free, read-only, creates no flow and
measures well under a second, so it costs the daily's shards almost nothing.

Not `@destructive`: the spec only reads. It does, however, **share the blocklist surface**
with the `@destructive` governance specs, which is what the `include_blocked` diagnosis
exists for.

---

## Validation criterion *(required)*

The spec passes when, on a nightly whose baseline is current:

1. `GET /api/v1/flows/basic_examples/` answers `200` with a JSON array, and the set of
   `name_key` values it carries is **exactly** the baseline's `templates[].nameKey` — no
   missing entry, and any extra reported rather than failed.
2. Every entry present carries the baseline's recorded English `name` under a pinned
   `Accept-Language: en-US`.
3. Every `declaredAbsences[].nameKey` is **still absent** from the listing.

It fails, with the template named in the message, when any of:

- a `name_key` the baseline expects is not in the listing and is not a declared absence
  (with the `include_blocked=true` probe's verdict appended);
- a declared absence is in the listing (naming the declaration and its issue);
- a present template's English name differs from the baseline's;
- the listing cannot be read at all (non-2xx, not an array, empty, or an entry with no
  `name_key`).

**Falsifiability, executed before merge** (one per branch, from #1862's *Done when*):

| Mutation | Expected |
|---|---|
| Add a fictional template to `templates[]` | RED — reported as an undeclared absence, naming it |
| Declare an absence for a template that *is* registered | RED — reported as a stale declaration, naming the declaration and its issue |
| Remove a real template from `templates[]` | **GREEN**, with the extra reported in the output and in the annotation |

---

## Precondition

A running Langflow the suite can log into (`PLAYWRIGHT_BASE_URL`). No provider key, no
network egress, no fixture flow. The instance must not have an active catalog-policy
template block — if it does, the failure names that as the cause rather than leaving it to
be guessed.

---

## Step by step

### 1.1 The registered template set matches the committed baseline

**File:** `.../templates-registration.spec.ts`

**Objective:** prove the image registers exactly the templates the baseline expects, so a
template leaving the gallery is a red test rather than a silent coverage loss.

1. `GET /api/v1/flows/basic_examples/` with `Authorization` and `Accept-Language: en-US`.
2. Assert `200`.
3. Parse the listing into `{nameKey, name}` pairs; a body the parser cannot read is UNKNOWN
   and fails with its reason.
4. Compute the verdict against `tests/assets/templates/registered-templates-baseline.json`.
5. Assert **no missing** template. On that branch only, probe `?include_blocked=true` and
   append its verdict to the message.
6. Assert every present template's English `name` equals the baseline's.
7. Report any **extra** template: print it and push a `templates-extra` annotation. Do not
   fail.

**Validation:** `verdict.missing` is empty, `verdict.renamed` is empty, and the comparison
actually ran (`verdict.kind !== "unknown"`, `verdict.comparedCount === 26` on this image).

### 1.2 Every declared absence is still absent

**File:** `.../templates-registration.spec.ts`

**Objective:** prove the declared-absence exemption has not expired — #1084's rule, in the
direction that is easy to forget.

1. Read the same listing (one request per test; the backend caches it for 300 s).
2. For each `declaredAbsences[]` entry, assert its `nameKey` is **not** in the listing.
3. The failure message names the declaration, its reason, its issue, and both remedies
   (close the issue and delete the declaration · or refresh the baseline if this is not the
   nightly).

**Validation:** with the baseline as committed, *Research Translation Loop*
(`research_translation_loop`) is absent and there is at least one declaration to check — a
run where `declaredAbsences` is empty asserts nothing and says so.

---

## The baseline and its refresh script

`tests/assets/templates/registered-templates-baseline.json`, written by
`npm run templates:baseline` (`scripts/update-registered-templates-baseline.ts`). Same shape
and the same contract as its two siblings — `tests/assets/catalog/component-catalog-baseline.json`
(`npm run catalog:baseline`) and `tests/assets/api/api-surface-baseline.json`
(`npm run api:baseline`): a **committed** file plus a refresh script, so accepting drift is a
reviewed diff and never a self-update. A self-updating baseline would make every registration
change invisible exactly once, which is the failure mode #1040 was raised about and the one
#1234 actually paid.

```jsonc
{
  "version": "1.13.0.dev12",          // report line only; never asserted
  "templates": [
    { "nameKey": "basic_prompting", "name": "Basic Prompting" }
    // … 26
  ],
  "declaredAbsences": [
    {
      "nameKey": "research_translation_loop",
      "name": "Research Translation Loop",
      "reason": "ArXivComponent is not shipped by this image, so filter_starter_projects_by_available_components drops the template at startup.",
      "issue": "#1744",
      "unavailableComponents": ["ArXivComponent"]
    }
  ]
}
```

The writer **refuses more than it accepts**, following `update-component-catalog-baseline.ts`:

- unreachable instance, or non-2xx on `/api/v1/version` or the listing → exit 1;
- a listing that is not a readable array, or fewer than `--min-templates` (default **20**;
  measured 26) → exit 1, because a still-starting instance's short listing committed as the
  baseline turns every later run's real listing into spurious extras and hides every real
  absence. `--force` overrides it, for the legitimate case of baselining a deliberately
  minimal image;
- **a declared absence that the live listing now registers → exit 1.** The declarations are
  carried across a refresh (a refresh must not silently drop #1744's justification), so the
  writer will not emit a file that contradicts itself; removing an expired declaration stays
  a deliberate, reviewed edit.

---

## External dependencies *(required)*

Resolved on `origin/main` and `origin/release-1.13.0`.

- `src/backend/base/langflow/api/v1/flows.py` — `read_basic_examples`, the endpoint under
  test, its `include_blocked` superuser gate, its per-locale 300 s cache, and
  `_filter_basic_examples_by_catalog_policy`, which removes blocked templates by `name_key`.
- `src/backend/base/langflow/initial_setup/setup.py` —
  `filter_starter_projects_by_available_components`, the startup rule that decides the
  registered set, its embedded-custom-component exemption, and the warning text it logs.
- `src/backend/base/langflow/initial_setup/starter_projects/` — the 27 shipped template
  JSONs. A file added, removed or renamed here moves the baseline.
- `src/backend/base/langflow/services/database/models/flow/model.py` — `name_key`, the
  stable i18n key this spec compares on.
- `src/backend/base/langflow/utils/i18n_keys.py` — `safe_flow_key`, which derives `name_key`
  from the original English name.
- `src/lfx/src/lfx/utils/component_aliases.py` — `flatten_components_with_aliases`, why
  legacy node types in the JSONs still count as available.

Suite side: `tests/helpers/auth/get-auth-token.ts`, the `apiCoverage` fixture
(`GET /api/v1/flows/basic_examples/`), `tests/helpers/other/registered-templates-drift.ts`
and its unit test, `tests/assets/templates/registered-templates-baseline.json`, and
`scripts/update-registered-templates-baseline.ts`.

---

## Checklist bullet

`QA-CHECKLIST.md` §11.1 — *Registered set*.

---

## What this spec deliberately does not do

- **It does not assert the gallery.** Tabs, cards, featured picks and search are **G1**
  (`templates-gallery`, #1863).
- **It does not assert a template's graph.** Component types, edges and notes are **S1**
  (`templates-instantiate`, #1864), which parametrizes over the baseline this spec commits.
- **It does not assert the endpoint's shape.** `api/flows/api-flows-public-and-metadata.spec.ts`
  owns that, and duplicating it here would give two places to update for one upstream change.
- **It does not assert `GET /api/v1/starter-projects/`** (a separate, 5-item listing) — its
  auth gate is §1.15's and its blocklist filtering is §21.2's.
- **It does not assert the three catalog anomalies** the #1860 scoping found (Social Media
  Agent's `agent` tag, Knowledge Retrieval's empty tags, Meeting Summary's `test MB`): a spec
  that encodes today's data as wrong fails on every run until upstream changes it. They are
  filed instead.
