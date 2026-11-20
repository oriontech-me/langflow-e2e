# Connections — accessibility and locale coverage

**File:** `tests/tests-automations/regression/core-functionality/integrations/connections-a11y-i18n.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2304 (Dedicated Integrations, batch 2 — the `follow-up` exception set).

---

## What this test validates *(required)*

Upstream's GA checklist (`design/dedicated-integrations/ga-checklist.json`) still lists
**`connections-ui-a11y-i18n`** as `pending-signoff`: *"The axe baseline
(connections.a11y.spec.ts) covering surfaces B2-B5 with a seeded connection, and locale
coverage, still have to be added."* Only a default-load IBM Equal Access scan of the
page has run upstream. This spec supplies that evidence from outside, against the
nightly.

Three things, each measured on `langflowai/langflow-nightly:latest` = `1.14.0.dev32`
before it was asserted.

### 1. An axe scan of each Connections surface, with a seeded connection

The surfaces are named after upstream's `frontend-surfaces.md`:

| Surface | What is scanned (the `include` scope) | Why that scope |
|---|---|---|
| **B1** `/settings/connections` | the page body: the element holding the `settings_menu_header` header and the `connections-list` table | the Settings sidebar and the app header are shared chrome, not this page |
| **row menu** (part of B1) | the open `role=menu` of the seeded row | the menu renders in a portal, outside the page body |
| **B2** Add dialog | the open `role=dialog`, first with the default provider, then with *Google Workspace* chosen | both steps a user sees before consent |
| **B5** node-level picker | the connection field of a placed *Gmail: Send Email* node (`parameter-permission-gate` around `connectionref_connection_ref_connection`), and its open popover (`role=dialog` around `refresh-connections-…`) | the rest of the node is generic node chrome |

**B3** (the OAuth return) and **B4** (the connections store) have no screen of their own
to scan. B3 needs a real provider redirect, which `connection-oauth-wizard.spec.ts`
covers functionally; B4 is client state.

Rule set: **WCAG 2.0, 2.1 and 2.2, levels A and AA** (`wcag2a`, `wcag2aa`, `wcag21a`,
`wcag21aa`, `wcag22aa`), with `@axe-core/playwright` 4.13.0 and `axe-core` pinned to
4.13.0. The rule engine is pinned exactly, because a baseline is written against a rule
set: a floating `axe-core` would let a new rule redden it with no change on either side.
The 4.14 line is not used because `@axe-core/playwright` 4.14.0 declares
`engines: node >=22.12.0` and every lane runs Node 20.

axe's `best-practice` rules are left out. The one they add on this page is
`page-has-heading-one`, which is about the page shell, and a scan scoped to one surface
cannot judge a page-level rule.

**Measured result: every surface is clean.** No WCAG A/AA violation on B1, the row menu,
either step of B2, the B5 field or the B5 popover. So the **known baseline is empty**.
Two measurements decided how the scans are taken:

- **Animations.** A scan of the Add dialog taken while it still fades in reports
  **12 `color-contrast` violations** on its muted text (the handle preview, the name
  help, the scope chips). They are gone once the animation ends. Every scan waits for
  `document.getAnimations()` to finish first.
- **Scope.** Scanning the whole *Gmail* node reports `nested-interactive` (the node's
  Tool Mode button) and `target-size` (the *Select input option* buttons of the To and
  Subject fields). Neither is a Connections control. They belong to generic node chrome,
  which this spec does not own, so the B5 scan is scoped to the connection field and its
  popover.

**The baseline is two-sided (#1084).** It is declared per surface. An undeclared violation
fails the test, and so does a declared one that no longer fires. A scope that matches no
element fails too: axe 4.13.0 throws `No elements found for include`. A scope that matches
an element no WCAG rule applies to would read as clean, so each scan must also apply at
least one rule.

### 2. Every shipped catalog renders the Connections surfaces without a raw key

The frontend ships 8 catalogs: `en`, `de`, `es`, `fr`, `ja`, `ko`, `pt`, `zh-Hans`
(`SUPPORTED_LANGUAGES` in `src/frontend/src/i18n.ts`, and one `locales/<code>.json`
each). It picks the language from `localStorage.languagePreference`, never from the
browser locale (CONTRIBUTING → *Browser locale*).

i18next runs with `fallbackLng: "en"`, so a key missing from one catalog renders in
English. A key renders **raw** (`connections.add.title` in place of a label) only when it
is missing from every catalog. That is what this test looks for, in the page body, the
row menu and the Add dialog, as visible text and in `aria-label`, `placeholder`, `title`,
`alt` and `aria-description`.

The detector matches only the namespaces the Connections tree calls `t()` with on
`release-1.14.0`: `connections.` (194 call sites), `settings.` (3), `common.` (1) and
`loading.` (1). A generic `word.word` pattern would also match a scope short name such as
`drive.file`, which the product shows on purpose.

The language switch is proved for every locale, so a page that silently stayed in
English cannot pass:

- `<html lang>` reads the locale code;
- for every non-English locale, the locale's chunk (`/assets/<code>-<hash>.js`) was
  fetched;
- the page heading differs from the English heading read in the same run.

The chunk is recognised by its body, which must carry `"connections.title":`, and not by
its name alone. Icon chunks share the prefix: `pt-euro-<hash>.js` is served too.

Measured headings: `Connections`, `Verbindungen`, `Conexiones`, `Connexions`, `接続`,
`연결`, `Conexões`, `连接`. No raw key in any of the 8.

On `release-1.14.0` every catalog carries all 198 `connections.*` keys. Between 3 and 8 of
them per catalog hold the English text, such as `OAuth` or a provider name, which is
correct.

### 3. Connector components: the catalog's own name per language, and today's state

Manual QA reported the `ext:*` connector components untranslated. **That is partly
refuted.** The names come from the backend: `GET /api/v1/all` honours `Accept-Language`,
and the frontend sends `Accept-Language: <languagePreference>` on that request (measured:
`pt`).

The sidebar shows whatever the backend returns. Under `pt`, a search for `gmail` lists
`add-component-button-gmail:-enviar-e-mail`.

State of the 86 components the manifest names (`GET /api/v1/integrations`,
`component_ref`), measured on `1.14.0.dev32`:

| Locale | Translated | Untranslated |
|---|---|---|
| de, es, fr, ja, pt, zh-Hans | 22 | 64 |
| ko | **0** | **86** |

In the six locales, the translated ones are all of Slack (9), the Microsoft actions (8)
and the Google actions (5). Untranslated are every Confluence, Discord, GitHub, GitLab,
Jira, Salesforce, ServiceNow, Telegram and WhatsApp component, plus the three Google
triggers and the three Microsoft triggers.

Korean translates **none**, although `ko` translates 130 of 132 core components. That is
recorded here as a candidate upstream ticket, not filed.

What the test asserts, and why it asserts no more:

- For every locale, every connector name is non-empty and is not a raw key.
- Whether a locale translates **any** connector is declared per locale (`ko`: no; the
  other six: yes) and verified both ways. If Korean starts translating, or a locale stops,
  the test fails and names the change.
- The exact untranslated set is **recorded** in the test's annotations on every run, not
  asserted. It moves each time upstream translates a family, and asserting it would turn
  every translation upstream ships into a red daily that strips `@stable`.
- Under `pt`, the sidebar shows the backend's `pt` name for *Gmail: Send Email*, which
  differs from the English one, and the catalog request carried `Accept-Language: pt`. That
  is the non-vacuous anchor: it proves the language reaches the catalog and the catalog
  reaches the screen.

Not duplicated: `connections-page.spec.ts`, `connections-row-actions.spec.ts` and
`connector-node-picker.spec.ts` own the behaviour of these surfaces in English. This file
reads them only to scan them or to check their language. `i18n/language-selection.spec.ts`
and `i18n/locale-resilience.spec.ts` own the language selector and the fallback ladder.

## Tags *(required)*

`@stable` `@ui-ux` `@integrations`.

- `@integrations`: the Dedicated Integrations surface.
- `@ui-ux`: accessibility and language are interface properties.
- No `@settings`: the page is reached by URL, and its navigation is
  `connections-page.spec.ts`'s.

## Step by step *(required)*

**Test 1 — the Connections page, its row menu and the Add dialog are WCAG A/AA clean
(English)**

1. Seed one Google connection through `createConnectionViaApi` (a planted token,
   `status: ready`).
2. Open `/settings/connections` and wait for the seeded row.
3. Scan B1, scoped to the page body. Compare with the B1 baseline.
4. Open the seeded row's menu. Scan the `role=menu`. Compare with its baseline. Close it.
5. Open *Add connection*. Scan the dialog. Choose *Google Workspace*, then scan again.
   Compare both with the B2 baseline.
6. Delete the connection by id.

**Test 2 — the node-level picker is WCAG A/AA clean (English)**

1. Seed one Google connection.
2. Create a flow over the API holding one *Gmail: Send Email* node, bound to the
   connection's handle, and open it.
3. Scan the connection field. Open the picker and wait for the seeded option. Scan the
   popover. Compare both with the B5 baseline.
4. Leave the editor, then delete the flow and the connection by id.

**Test 3 — every catalog renders the Connections surfaces in its language, with no raw
key**

1. Seed one Google connection.
2. For each of the 8 locales:
   1. Load `/settings/connections`: English first, with no stored preference (a fresh context
      has none), then each other locale after writing `localStorage.languagePreference` on the
      page's own origin.
   2. Assert `<html lang>` and, for every locale except `en`, that its chunk was fetched
      and that the heading differs from the English one.
   3. Scan the page body, the row menu and the Add dialog for raw keys.
3. Delete the connection by id.

**Test 4 — connector components: each catalog's own name, and today's state**

1. Read the manifest's connector `component_ref`s.
2. For each of the 8 locales, read `GET /api/v1/all` with `Accept-Language: <code>`.
   1. Assert every connector name is non-empty and not a raw key.
   2. Assert whether the locale translates any connector, against the declaration.
   3. Record the untranslated set as an annotation.
3. Under `pt`, open a new flow and search the sidebar for `gmail`. Assert that the *Gmail:
   Send Email* entry carries the backend's `pt` name, which differs from the English one,
   and that the catalog request carried `Accept-Language: pt`.
4. Leave the editor and delete the flow by id.

## Validation criterion *(required)*

- Each scanned surface reports exactly the violations its baseline declares (none today),
  and every scan applied at least one rule.
- All 8 catalogs switch the page language, and none renders a raw key on the page, the
  row menu or the Add dialog.
- Every connector name in every catalog is non-empty and not a raw key. The per-locale
  "translates any" declaration holds both ways. The `pt` sidebar shows the backend's `pt`
  name.
- No `🚨 Backend Error` is logged.
- Everything the spec creates (connections, flows) is deleted by id.

**Mutations that must fail** (each was run while the spec was written, and each failed with
the message shown):

- Declaring an entry that does not fire, such as `color-contrast` on the row menu: *"declared
  violation color-contrast no longer fires — delete it from the baseline"*.
- Injecting an unlabeled `<input>` into the Add dialog: *"undeclared violation label
  (critical)"*. With an empty baseline, this stands in for removing an entry that fires.
- Pointing the B5 field scope at nothing: *"No elements found for include"*.
- Patching the `pt` chunk so that `connections.add.title` renders as its key: *"pt: raw keys
  on the page"*, naming `connections.add.title`.
- Flipping `ko` to "translates some": *"ko translates 0 of 86 connector names; the
  declaration says it translates some"*.

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/index.tsx`
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx`
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionRowMenu.tsx`
- `src/frontend/src/pages/SettingsPage/components/SettingsPageHeader/index.tsx`
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/index.tsx`
- `src/frontend/src/i18n.ts`
- `src/frontend/src/locales/en.json`
- `src/frontend/src/locales/ko.json`
