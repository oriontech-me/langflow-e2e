# Spec: Settings — Page Access and Sidebar Navigation

**Test file:** `tests/tests-automations/regression/ui-ux/settings-navigation.spec.ts`

## What this test validates

Covers the entry point to the Settings page and the integrity of its sidebar
navigation — the `§15.10 — Access Settings page` checklist item.

Four independent tests:

1. **Access Settings page** — the profile menu (`user-profile-settings` →
   `menu_settings_button`) navigates to Settings and the page renders its
   section header (`settings_menu_header`).
2. **Sidebar sections listed** — the four long-standing sections (General,
   Model Providers, Shortcuts, Messages) are present as navigation links. The
   1.12 nightly renders nine links (General, MCP Servers, Langflow API Keys,
   Langflow MCP Client, Global Variables, Model Providers, DB Providers,
   Shortcuts, Messages); only the four stable ones are asserted, so an upstream
   addition/rename of the newer MCP/DB entries does not redden the daily run,
   while removing a core section does.
3. **Shortcuts section lists every documented shortcut** — the Shortcuts page
   renders an AG Grid (`role="row"`, columns `display_name` / `shortcut`).
   The test asserts the grid lists **at least 27 shortcut rows** (the
   `defaultShortcuts` catalog size on 1.12.0.dev5) and that **every** row shows
   a non-empty key binding in its `shortcut` cell. This is the *listing* half
   of `§15.10 — All documented shortcuts work`; actually exercising the
   bindings on canvas is covered by `langflowShortcuts.spec.ts` (7 of them) and
   `settings-shortcuts-edit.spec.ts` (rebinding one), which is why the
   checklist bullet stays `[~]`.
4. **Model Providers section loads** — navigating to Model Providers switches
   the header and renders the page description
   `"Configure AI model providers and manage their API keys."`.

Tests 1–2 are the "can the user reach Settings at all" gate; a regression in the
profile menu, the route, or the section list breaks them before any deeper
Settings spec runs.

## Tags

`@stable` `@release` `@workspace` `@regression` `@settings`

## Validation criterion

| Step | Criterion |
|---|---|
| Profile menu → Settings | `settings_menu_header` is visible (Settings route rendered) |
| Settings sidebar | Links `General`, `Model Providers`, `Shortcuts`, `Messages` all visible |
| Shortcuts section | `settings_menu_header` contains `Shortcuts`; shortcut grid has ≥ 27 data rows; every row's `shortcut` cell has non-empty text |
| Model Providers section | header contains `Model Providers` AND text `"Configure AI model providers and manage their API keys."` is visible |

Non-criterion (deliberate): the test does not assert the *total* number of
sidebar links, nor the presence of the 1.12-only sections (MCP Servers, DB
Providers, Langflow MCP Client) — those are still moving upstream.

## External dependencies

- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx` — `user-profile-settings`, `menu_settings_button` testids.
- `src/frontend/src/pages/SettingsPage/index.tsx` — `settings_menu_header` testid and the sidebar link labels.
- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/index.tsx` — AG Grid with `display_name` / `shortcut` columns.
- `src/frontend/src/constants/constants.ts` — `defaultShortcuts` array (27 entries on 1.12.0.dev5). Shrinking it below 27 fails test 3 by design.
- `src/frontend/src/pages/SettingsPage/pages/ModelProvidersPage/index.tsx` — the literal description string asserted in test 4.

No provider API key and no flow creation — the spec is read-only UI navigation,
so it leaves no state behind (no cleanup needed).

## Last validated

1.12.x (nightly `1.12.0.dev6`)
