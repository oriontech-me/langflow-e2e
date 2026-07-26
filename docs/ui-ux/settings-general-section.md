# Spec: Settings — General / Messages / Shortcuts Sections Load

**Test file:** `tests/tests-automations/regression/ui-ux/settings-general-section.spec.ts`

## What this test validates

Second half of the `§15.10 — Access Settings page` checklist item: once the
Settings page is open, each of its long-standing sections must actually render
its own content when selected from the sidebar — not just switch the header.

`beforeEach` enters Settings through the profile menu
(`user-profile-settings` → `menu_settings_button`) and waits for
`settings_menu_header`. Then:

1. **General section renders its content** — clicking `General` shows the
   header `General` **and** the two settings groups the page promises on the
   1.12 nightly: the **Language** group (with its description
   `"Choose the display language for the Langflow interface."`) and the
   **Profile Picture** group. Asserting the groups — rather than "some `main`
   element is visible", which passed even with an empty page — is what makes
   this test able to fail.
   Note: with `LANGFLOW_AUTO_LOGIN=true` the password form is intentionally not
   rendered (`{!autoLogin && <PasswordFormComponent>}`), so it is not asserted.
2. **Messages section is accessible** — clicking `Messages` switches the header
   to `Messages`. The message-grid contents are covered by
   `settings-message-history.spec.ts`; here only reachability is asserted.
3. **Shortcuts section is accessible and lists shortcuts** — clicking
   `Shortcuts` switches the header and the shortcut grid renders at least one
   row. Deliberate overlap with `settings-navigation.spec.ts` test 3: that spec
   reaches Shortcuts by URL-level navigation and asserts the *full catalog*;
   this one asserts the *sidebar link* path works after landing on General.

## Tags

`@stable` `@release` `@regression` `@settings`

## Validation criterion

| Step | Criterion |
|---|---|
| Sidebar → General | header contains `General` AND texts `Language`, `"Choose the display language for the Langflow interface."` and `Profile Picture` are visible |
| Sidebar → Messages | `settings_menu_header` contains `Messages` |
| Sidebar → Shortcuts | `settings_menu_header` contains `Shortcuts` AND the shortcut grid renders ≥ 1 row |

## External dependencies

- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx` — `user-profile-settings`, `menu_settings_button` testids.
- `src/frontend/src/pages/SettingsPage/index.tsx` — `settings_menu_header` testid; sidebar link labels `General` / `Messages` / `Shortcuts`.
- `src/frontend/src/pages/SettingsPage/pages/GeneralPage/index.tsx` — the `Language` and `Profile Picture` group headings plus the language description string.
- `LANGFLOW_AUTO_LOGIN=true` (the CI/local default) — hides the password form on the General page.

Read-only UI navigation: no provider key, no flow created, nothing to clean up.

## Last validated

1.12.x (nightly `1.12.0.dev6`)
