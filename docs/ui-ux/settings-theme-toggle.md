# Spec: Settings — Theme Toggle

**Test file:** `tests/tests-automations/regression/ui-ux/settings-theme-toggle.spec.ts`

## What this test validates

Verifies that the dark/light mode toggle in the Account Menu correctly updates the application theme by adding or removing the `dark` class on the `#body` element.

The test normalizes to light mode, switches to dark (`menu_dark_button`), confirms `#body.dark` is attached to the DOM, switches back to light (`menu_light_button`), confirms `#body.dark` is detached, then restores system theme.

Key implementation detail: `ThemeButtons` uses plain `<Button>` elements (not Radix `DropdownMenuItem`), so the Account Menu does **not** close automatically after a theme click. `Escape` is pressed after each click to dismiss the menu before re-opening it for the next step.

## Tags

`@release` `@stable` `@settings` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| After clicking `menu_dark_button` | `page.locator("#body.dark").toBeAttached()` passes |
| After clicking `menu_light_button` | `page.locator("#body.dark").not.toBeAttached()` passes |

## External dependencies

- `src/frontend/src/components/core/appHeaderComponent/components/ThemeButtons/index.tsx` — `menu_dark_button`, `menu_light_button`, `menu_system_button` test IDs. Any rename breaks the test.
- `src/frontend/src/App.tsx` — applies `.dark` class to `document.getElementById("body")`. If this changes to `document.documentElement`, update the `#body.dark` locator to `html.dark`.
- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx` — `user-profile-settings` test ID.

## Last validated

1.10.x
