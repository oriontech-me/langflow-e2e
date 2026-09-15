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

So the **set comparison keys on `name_key`**: an identity must not depend on a request header
any caller can set.

**Two wrong reasons were written in this section before the right one, and both are recorded
because each named a trap that does not exist.** A documented trap that is itself wrong is
worse than none, and this passage produced two of them in a row.

What is actually measured on `1.13.0.dev12`:

| Measurement | Result |
|---|---|
| `Accept-Language: pt-BR` | `name` → *Sugestões básicas*, `name_key` unchanged — the localization is real |
| **No `Accept-Language` at all** | **English** — `set_locale` defaults to `en` |
| `PW_LOCALE=pt-BR` through the `request` fixture | **English.** Playwright carries the context `locale` into the `APIRequestContext`, but it never reaches the wire as `Accept-Language` |
| **All three `Accept-Language` pins deleted from the spec** | **2 passed — GREEN** |

- ❌ *"Keying on `name` would report 26 missing plus 26 extra under a `PW_LOCALE=pt-BR` run"* —
  false: that run cannot change this endpoint's answer.
- ❌ *"The `name` comparison is what goes red when the pin is lost"* — also false, and measured
  above: the pin is **explicitness, not a gate**, for as long as the backend's default is `en`.

- ❌ *"What the `name` comparison buys is an upstream rename"* — the third wrong version, and
  the mechanism is why. The served `name_key` is **not** the persisted column:
  `translate_starter_flows` (`src/backend/base/langflow/utils/i18n.py`) recomputes it as
  `safe_flow_key(flow.name)` on **every request**, then looks the served `name` up as
  `starter_flows.<that key>.name` with the persisted name as the fallback. Both served fields
  descend from one source. Measured on the live listing under `en-US`: `safe_flow_key(name)
  == name_key` for **26 of 26**, no divergence — so they are not independent observations. A
  genuine rename (*Blog Writer* → *Blog Author*) moves the key too and fires **missing** plus
  **extra**, never `renamed`.

What `renamed` genuinely catches is narrower, and kept because it is free: the translation
table disagreeing with the persisted name for one key (an upstream edit to
`locales/en.json`'s `starter_flows.<key>.name` without the starter JSON's own `name`, or a
punctuation-only rename that collapses to the same key, *Document Q&A* → *Document Q & A*),
and a locale that genuinely reached the request by some future route — a lane adding
`extraHTTPHeaders`, a proxy, an upstream change to the default. That last one is a hypothesis
and is written as one, not as a trap that has been observed.

So the honest statement of the design: the set is keyed on `name_key` because identity must
not ride on a header, and the `name` check is a cheap **second observation of a shared
source**, not an independent one. Three drafts of this passage claimed more than that; each
is left above rather than quietly replaced.

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

**This spec inverts its siblings' severity, and that is a chosen cost rather than an
oversight.** `component-catalog-drift` and `api-surface-drift` **warn** in `globalSetup` and
never fail (#980's trade: a catalog change costs nobody a test). Here a removed template is a
hard red, because #1862 asked for exactly that — an absence nothing goes red about is the
#1234 failure. Know what that buys and what it costs: the first legitimate upstream template
removal produces a **hard daily failure**, and `remove-stable-from-failures.ts` strips
`@stable` in an unreviewed commit, after which restoring it is a manual checkbox on an issue
(#1746's orphan class). The remedy is one `npm run templates:baseline` commit, so the cost is
one red day and a tag to put back — paid deliberately, because the alternative is a warning
nobody reads, which is the `mode=count` lesson this repo has already paid for once.

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
| Add a fictional template to `templates[]` | RED — reported as an undeclared absence, naming it, with the `?include_blocked=true` probe's verdict appended |
| **Move** a registered template out of `templates[]` and into `declaredAbsences[]` | RED — reported as a stale declaration, naming the declaration and its issue |
| Remove a real template from `templates[]` | **GREEN**, with the extra reported in the output and asserted in the annotation |
| Change one template's recorded `name` while leaving its `nameKey` | RED via the `renamed` branch, naming both spellings |
| Delete the report block from the extras step | RED — the annotation assertion is what makes "reported" a property rather than a hope |

The second row says **move** on purpose: *adding* a registered template to `declaredAbsences[]`
while leaving it in `templates[]` is a different failure — the baseline then both expects and
declares it absent, which `describeBaselineDefect` refuses as UNKNOWN. Still red, but not this
branch, and the first version of this table was not reproducible as written.

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

**Validation:** the comparison actually ran (`verdict.kind !== "unknown"`), `verdict.missing`
is empty, `verdict.renamed` is empty, and the extras report that the verdict calls for is the
one the test actually emitted — asserted against `testInfo.annotations`, because the earlier
`comparedCount === baseline.templates.length` was `x === x` and pinned nothing.

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
  a deliberate, reviewed edit;
- **an active catalog-policy template block → exit 1**, naming the blocked templates. The
  listing it captures is policy-filtered, so a refresh on an instance a `@destructive`
  governance spec left blocked would commit the block as the expectation, after which the
  spec reports clean forever about a template that is not in the gallery — #1234's failure
  mode arriving through the refresh path. `--min-templates` cannot catch it: six of 26 can
  vanish and still clear a floor of 20. It probes `?include_blocked=true`, and when it
  **cannot** probe (superuser-only) or gets an unreadable answer it says so rather than
  reading silence as "nothing is blocked" (#1012).

`--force` bypasses the count floor **and** the block refusal — it is one flag for two
decisions, so an operator passing it for the documented minimal-image reason also disarms the
block check. It therefore never bypasses in silence: the blocked templates are named and the
warning says the spec will report clean about them until the policy is cleared and the
baseline refreshed.

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
- `src/backend/base/langflow/services/database/models/flow/model.py` — the persisted
  `name_key` column. Note it is **not** what the endpoint serves: see the next entry.
- `src/backend/base/langflow/utils/i18n.py` — `translate_starter_flows`, which recomputes the
  served `name_key` from the persisted English name on every request and looks the served
  `name` up under it. This is the derivation the spec actually compares on, and the reason
  `name` and `name_key` are not independent observations.
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
