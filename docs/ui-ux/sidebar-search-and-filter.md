# Spec: Component Sidebar — Search and Category Filtering

**Test file:** `tests/tests-automations/regression/ui-ux/sidebar-search-and-filter.spec.ts`

## What this test validates

The component sidebar's search and category-filter behavior — the
`§15.1 Component Sidebar` checklist items *Search component by name* and *Filter
components by category*, plus the honest remainder of *Sidebar shows correct
provider count* (see the re-scope note below).

Four independent tests:

1. **Search by name lists only matching components** — typing `chat input` leaves
   `input_outputChat Input` visible while `models_and_agentsPrompt Template`
   disappears from the tree. The **negative** half is the point: every inherited
   §15.1 test asserted only that the match was visible, which passes on a search
   box that filters nothing. The same query in uppercase (`CHAT INPUT`) yields the
   same result (case-insensitive matching).
2. **A no-match search shows the empty state, and clearing restores the tree** —
   a nonsense query leaves **zero** `[data-testid$="_draggable"]` cards and
   **zero** `disclosure-*` sections in the sidebar and renders
   `No components found. Clear your search or filter and try a different query.`;
   clearing the field brings `disclosure-input & output` back.
3. **A provider search groups its components under the provider bundle** —
   `openai` renders `openaiOpenAI` under `disclosure-bundles-openai` **and**
   removes the non-matching `disclosure-input & output` section entirely.
4. **Category disclosures collapse and expand their component list** — sections
   are collapsed on entry (`input_output_chat input_draggable` absent), one click
   reveals the section's components, a second click hides them again.

### Re-scope of two §15.1 bullets (no product surface on 1.12.0.dev6)

Verified live before writing this spec:

- **"Hover over component shows tooltip/preview" → `[~]`.** Hovering a sidebar
  card produces **zero** `[role="tooltip"]` elements, zero Radix popper wrappers,
  no `title` and no `aria-describedby`. The only hover affordance is the `+`
  button (`add-component-button-<slug>`) plus the `icon-GripVertical` drag handle,
  and that button's hover reveal is already `@stable` in
  `core-components/componentHoverAdd.spec.ts`. Asserting the `+` button here would
  cover a different behavior under the bullet's name, so the bullet stays `[~]`
  with this evidence instead.
- **"Sidebar shows correct provider count" → `[~]`.** The sidebar renders no
  numeric badge or count text anywhere (a sweep of every leaf text node under
  `shad-sidebar` for `\d+` or `N models/components/providers` returns nothing).
  The deleted `sidebar-provider-count.spec.ts` never asserted a count either — it
  searched two provider names and matched `[data-testid*="openai"]`, which also
  matches icons. What the product *does* expose is grouping by provider bundle,
  which test 3 covers; the count itself lives on Settings → Model Providers
  (`§7`), not in the sidebar.

### Consolidation note

This spec replaces three deleted files whose 12 tests could not carry `@stable`:

- `ui-ux/sidebar-category-filter.spec.ts` — 5 tests, all "element is visible"
  with no negative half; the last one ends on
  `expect(hasLegacy || hasBeta).toBeTruthy()` built from two
  `isVisible().catch(() => false)` probes.
- `ui-ux/sidebar-filter-by-category.spec.ts` — same coverage again; its
  collapse/expand test hides the only real assertion inside
  `if (expandedAfterCollapse !== null && expandedAfterReopen !== null)`, and on
  1.12 the disclosure has **no** `data-state` attribute, so that assertion never
  ran. Its test titled *"pressing Escape clears the sidebar search"* clears the
  field with `.clear()` and comments that Escape does not clear — a title that
  documents a behavior the test never exercised.
- `ui-ux/sidebar-provider-count.spec.ts` — see the re-scope note above.

None of the three had flow cleanup: each test opened a blank flow through the UI
and left it behind (~10 flows per run).

## Tags

`@stable` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Search `chat input` | `input_outputChat Input` visible AND `models_and_agentsPrompt Template` hidden |
| Search `CHAT INPUT` | same as above (case-insensitive) |
| No-match query | zero `[data-testid$="_draggable"]`, zero `[data-testid^="disclosure-"]` under `shad-sidebar`, and the `No components found.` text visible |
| Clear the field | `sidebar-search-input` has value `""` AND `disclosure-input & output` visible again |
| Search `openai` | `openaiOpenAI` and `disclosure-bundles-openai` visible AND `disclosure-input & output` hidden |
| Disclosure collapsed on entry | `input_output_chat input_draggable` hidden |
| Disclosure expand | after one click, `input_output_chat input_draggable` and `input_outputChat Input` visible |
| Disclosure collapse | after a second click, both hidden again |

Non-criterion (deliberate): no assertion on the *number* of results for a query
(the catalog grows every nightly), on `data-state` (absent on 1.12), or on which
extra bundles a provider query surfaces (`openai` also matches
`empiriolabsEmpirioLabs AI` through its description).

## External dependencies

- Sidebar: `shad-sidebar`, `sidebar-search-input`, `disclosure-<category>`,
  `disclosure-bundles-<vendor>`, `<category>_<name>_draggable`,
  `<category><Display Name>` cards, and the `No components found.` empty state.
- `POST /api/v1/flows/` — the empty flow each test opens the editor on.

No provider API key, no LLM, no flow build.

Flow cleanup: each test creates its own empty flow via the API and deletes it by
id in `afterEach`.

## Scenarios

### 15.1.1 Search by name lists only matching components [-]

- **File:** `tests/tests-automations/regression/ui-ux/sidebar-search-and-filter.spec.ts`
- **Objective:** prove the search box filters the component tree, both ways.
- **Precondition:** empty flow created via API; editor open; sidebar visible.
- **Step by step:**
  1. Fill `sidebar-search-input` with `chat input`.
  2. Read `input_outputChat Input` and `models_and_agentsPrompt Template`.
  3. Refill with `CHAT INPUT` and read both again.
- **Validation:** the match is visible and the non-match is hidden, in both the
  lowercase and the uppercase run.

### 15.1.2 A no-match search shows the empty state [-]

- **File:** same
- **Objective:** prove the search reports "nothing found" instead of silently
  showing everything, and that clearing it restores the tree.
- **Step by step:**
  1. Fill the search with a nonsense token.
  2. Count draggable cards and disclosure sections under `shad-sidebar`; read the
     empty-state text.
  3. Clear the field.
- **Validation:** zero cards, zero disclosures and the `No components found.`
  text while filtered; `disclosure-input & output` visible after clearing.

### 15.1.3 A provider search groups results under the provider bundle [-]

- **File:** same
- **Objective:** prove a provider query narrows the tree to that provider's
  bundle (the surface that exists in place of a provider count).
- **Step by step:** fill the search with `openai`; read `openaiOpenAI`,
  `disclosure-bundles-openai` and `disclosure-input & output`.
- **Validation:** the first two visible, the last hidden.

### 15.1.4 Category disclosures collapse and expand [-]

- **File:** same
- **Objective:** prove the category sections act as filters over the listed
  components.
- **Step by step:** read `input_output_chat input_draggable` on entry; click
  `disclosure-input & output`; read again; click once more; read again.
- **Validation:** hidden → visible → hidden, with no conditional guard.

## Last validated

1.12.x (nightly `1.12.0.dev6`)
