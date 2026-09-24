# UI/UX — Bundles view in the component sidebar

**File:** `tests/tests-automations/regression/ui-ux/integration-side-bar.spec.ts`
**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev22`)

> Promoted out of the Wave 9 T2 inherited backlog. Triage row:
> `docs/triage/inherited-spec-triage.md` (T2, `ui-ux/integration-side-bar.spec.ts`,
> `0/3 green`), filed as **#1912**. The failure was two hardcoded bundle names the
> tested image no longer ships — see *Why it was failing*.

---

## What this test validates *(required)*

That the component sidebar's **Bundles** navigation renders the vendor-integration
tree: clicking `sidebar-nav-bundles` replaces the Components tree with a group labelled
`Bundles`, under which the integrations the image ships appear as their own
disclosures.

If this broke, every vendor integration would become unreachable from the sidebar —
users could still search a component by name, but could not browse the integrations
Langflow offers, which is the only discovery path for a provider whose component name
they do not already know.

---

## Tags *(required)*

`@stable` `@release` `@api` `@workspace` `@ui-ux`

`@api` is inherited from the spec as imported and kept: the Bundles tree is rendered
from `GET /api/v1/all`, so a catalog regression surfaces here as a missing disclosure.

---

## Precondition *(optional)*

- A running Langflow instance whose image installs the `lfx_openai`, `lfx_anthropic`
  and `lfx_google` distributions — true of the stock nightly and required by every
  scheduled lane already (each runs provider specs against all three)
- Auto-login enabled

---

## Step by step *(required)*

1. Bootstrap the app (`awaitBootstrapTest`) and create a blank flow (`blank-flow`),
   capturing the created flow id from the `POST /api/v1/flows/` 201 for cleanup
2. Wait for the sidebar to render (`shad-sidebar`)
3. Click `sidebar-nav-bundles`
4. Assert the group label `Bundles` is visible
   (`[data-sidebar="group-label"]` with text `Bundles`)
5. Assert the three lane-guaranteed bundles each render their own disclosure:
   `disclosure-bundles-openai`, `disclosure-bundles-anthropic`,
   `disclosure-bundles-google`
6. Assert the Components tree is no longer showing — the `Components` group label is
   hidden, so the click switched views rather than appending to them
7. `afterEach` deletes only the captured flow id

---

## Validation criterion *(required)*

After clicking `sidebar-nav-bundles`:

- the `Bundles` group label is visible
- **all three** of `disclosure-bundles-openai`, `disclosure-bundles-anthropic` and
  `disclosure-bundles-google` are visible
- the `Components` group label is hidden

Step 6 is the half that makes this a navigation assertion rather than a render
assertion: without it, a build that showed both trees at once would pass.

---

## Why it was failing *(the measurement, `1.13.0.dev22`)*

The spec asserted `getByText("Notion")` and `getByText("AssemblyAI")`. Measured on the
running nightly, the Bundles view renders **17** disclosures —
`file processing`, `amazon`, `anthropic`, `azure`, `cassandra`, `cohere`, `datastax`,
`docling`, `google`, `ibm`, `langchain`, `microsoft 365`, `ollama`, `openai`, `oracle`,
`slack`, `toolguard` — and **neither Notion nor AssemblyAI is among them**.

Both are `lfx-bundles-shim` families: `lfx/components/Notion/__init__.py` (capital `N`)
and `lfx/components/assemblyai/__init__.py` re-point at `lfx_bundles.notion` /
`lfx_bundles.assemblyai`, and `import lfx_bundles` raises
`ModuleNotFoundError: No module named 'lfx_bundles'` in the container. `GET /api/v1/all`
carries zero `notion` and zero `assemblyai` entries, and a sidebar search for either
returns *"No components found."*

So the failure was **the image's packaging, asserted by name** — not a broken sidebar.
Steps 3 and 4 already pass today; only the two name assertions were dead.

**The replacement names are chosen for lane-guaranteed availability, not taste.**
`openai`, `anthropic` and `google` ship as their own per-vendor distributions
(`lfx_openai`, `lfx_anthropic`, `lfx_google`, all installed on the stock nightly), and
every scheduled lane already depends on all three being present — the daily rotates its
provider by weekday across exactly these three (#1185). A packaging change that removed
one of them would break far more than this spec, which is precisely the property a
hardcoded name needs to have.

**Known and accepted:** this is still an assertion on names, so it inherits the
failure mode that broke the imported version. What changed is the blast radius — the
names now point at distributions the suite cannot function without. Deriving the
expectation from `GET /api/v1/all` at run time was weighed and not taken: it would make
the spec assert the catalog against itself, and a catalog that lost every bundle would
then pass. The catalog's own drift is covered by `globalSetup`'s drift report
(`docs/component-distribution-policy.md`).

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — renders
  the sidebar, its nav items and the group labels the criterion reads
- `src/backend/base/langflow/api/v1/endpoints.py` — serves `GET /api/v1/all`, the
  catalog the Bundles tree is built from

---

## What this test does not cover *(optional)*

- expanding a bundle disclosure and adding a component from it — covered by
  `ui-ux/sidebar-search-and-filter.spec.ts` (*a provider query groups its components
  under the provider bundle*) and `ui-ux/sidebar-add-component.spec.ts`
- the completeness of the bundle list; three named bundles are a floor, not an
  inventory

---

## When to review this test *(optional)*

- the catalog drift report names `openai`, `anthropic` or `google`
- the sidebar's nav or group-label markup changes
- the daily's provider rotation stops covering all three providers (#1185), which is
  what makes these three the guaranteed set
