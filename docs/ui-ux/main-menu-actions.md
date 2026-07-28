# Spec: App Header — Main Menu Contract and Actions

**Test file:** `tests/tests-automations/regression/ui-ux/main-menu-actions.spec.ts`

## What this test validates

Covers the `§15.9 — Main menu actions` checklist item. On `1.12.x` the flow
editor no longer has a dedicated "menu bar" dropdown — the breadcrumb's
`menu_bar_display` button opens the **Flow settings** dialog, and the
application's main menu is the header account menu (`user_menu_button`), whose
items are named `menu_*_button` in the source. That menu is the surface tested
here.

Two independent tests, both from the flows list (no flow is created):

1. **The main menu opens with its full item contract** — clicking
   `user_menu_button` opens a `role="menu"` (`data-state="open"`) exposing
   `menu_version_button`, `menu_settings_button`, the four external links
   (`menu_docs_button`, `menu_github_button`, `menu_discord_button`,
   `menu_twitter_button`) and the theme trio (`menu_light_button`,
   `menu_dark_button`, `menu_system_button`). The **version row** shows the exact
   version reported by `GET /api/v1/version` — a cross-layer assert: the menu
   cannot pass on a stale or hardcoded string. Each external link carries its
   expected `href` and `target="_blank"`. `Escape` closes the menu.
2. **A main-menu action navigates** — `menu_settings_button` closes the menu and
   routes to `/settings`, with the Settings header rendered.

Sibling coverage, deliberately not duplicated here:

- `ui-ux/settings-navigation.spec.ts` (§15.10) — the Settings **page** structure
  and its sidebar sections. Test 2 above only proves the menu→route wiring.
- `ui-ux/settings-theme-toggle.spec.ts` (§15.10) — actually switching theme.
  This spec asserts the three theme buttons **exist** and never clicks them:
  theme is persisted per user, so clicking would mutate state shared with every
  other spec on the instance.

## Tags

`@stable` `@release` `@mainpage` `@ui-ux` `@settings`

## Validation criterion

| Step | Criterion |
|---|---|
| Click `user_menu_button` | a `[role="menu"]` with `data-state="open"` is visible |
| Item contract | `menu_version_button`, `menu_settings_button`, `menu_docs_button`, `menu_github_button`, `menu_discord_button`, `menu_twitter_button`, `menu_light_button`, `menu_dark_button`, `menu_system_button` are all visible inside that menu |
| Version row | the row containing `menu_version_button` contains the `version` string returned by `GET /api/v1/version` |
| External links | `Docs` → `https://docs.langflow.org`, `GitHub` → `https://github.com/langflow-ai/langflow`, `Discord` → `https://discord.com/invite/EqksyE2EX9`, `X` → `https://x.com/langflow_ai`, each with `target="_blank"` |
| `Escape` | the `role="menu"` element is detached |
| Click `menu_settings_button` | URL matches `/settings` and `settings_menu_header` is visible; the menu is closed |

Non-criteria (deliberate):

- **The freshness suffix is not asserted.** The version row renders
  `1.12.0.dev8 (latest)`; the `(latest)` / `(update available)` part depends on
  Langflow reaching GitHub's release feed from the test host, so only the version
  substring is asserted.
- **No logout item is asserted.** The E2E instance runs with
  `LANGFLOW_AUTO_LOGIN=true`, under which the menu renders no logout entry.
  Session/logout behavior belongs to the `@auth` specs.
- **External links are never clicked** — asserting `href` + `target` keeps the
  test offline and deterministic; opening a real tab to `x.com` would make the
  suite depend on third-party availability.
- **`menu_version_button` is not clicked.** It is a label span, not an action.

## External dependencies

- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx`
  — `user_menu_button` and every `menu_*_button` testid, plus the four external
  URLs asserted above.
- `GET /api/v1/version` — the authoritative version string compared against the
  menu row.
- `src/frontend/src/pages/SettingsPage/index.tsx` — `settings_menu_header`.

No provider API key, no LLM call, no flow creation — the spec is read-only UI
navigation and leaves no state behind (no cleanup needed).

## Last validated

1.12.x (nightly `1.12.0.dev8`)
