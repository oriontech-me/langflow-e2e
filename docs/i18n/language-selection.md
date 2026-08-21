# i18n — Language selection

**Last validated:** Langflow 1.12.x (measured on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

The **display-language selector** in Settings → General: that choosing a
language actually re-renders the interface in it, that the choice survives a
reload, and that **every** language the selector offers is backed by a
translation bundle that loads. This is the seam immediately past
`ui-ux/settings-general-section.spec.ts`, which asserts the Language card
exists and stops there.

1. **should re-render the interface when the display language changes** —
   picking `Português` in the Settings → General language selector switches
   `document.documentElement.lang` from `en` to `pt`, retitles the settings
   header from `General` to `Geral`, leaves the selector reading `Português`,
   and writes `pt` to `localStorage.languagePreference`.
2. **should keep the selected language across a reload and a second tab of the
   same browser session** — after switching to `Português`, a `page.reload()`
   and a second page opened in the **same browser context** both come up in
   Portuguese, with no second visit to the selector.
3. **should load a translation bundle for every language the selector offers** —
   the selector's options are enumerated at run time; each one is selected in
   turn and must (a) set `<html lang>` to a language code, (b) for every
   non-English code, fetch `/assets/<code>-<hash>.js` with a `200`, and (c)
   change the settings header away from the English `General`. English is the
   inverse case and is asserted as such: it fetches **no** bundle (its
   translations are inlined in the app bundle) and restores `General`.

---

## Tags *(required)*

`@stable` `@regression` `@ui-ux` `@settings`

`@regression` because the batch exists to pin fixed upstream defects, not to
describe a new feature — see **Notes**. `@ui-ux` and `@settings` are the
existing functional tags for this surface; **no new `@i18n` tag is introduced**,
following the rule that a new functional tag is only warranted when there is no
OSS area to reuse (the `@authz` precedent in `CLAUDE.md`).

`@stable` from the first PR on the same grounds as the `memory` specs: every
assertion is LLM-free and provider-free, nothing is created server-side so there
is nothing to leak, and the whole file measured **20.6 s** in the scout that
walked all seven languages. Subject to the VALIDATE burst passing at
`--retries=0 --workers=1`.

Not `@release`: switching display language is not a pre-deploy happy path.

---

## Validation criterion *(required)*

- **`document.documentElement.lang` is the primary observable, not a translated
  string.** The frontend sets it at boot and again on every `languageChanged`
  event (measured in the shipped bundle:
  `hRn = e => {document.documentElement.lang = e}`, registered as the
  `languageChanged` handler). It is a machine value that upstream cannot
  reword, so it survives a translation edit that would break a string
  assertion — while still being *product* state, not test state.
- **The combobox is resolved by role and pinned to exactly one match, never by
  its accessible name.** The trigger carries **no `id` and no `data-testid`**
  (measured in the bundle and live) — only
  `aria-label={t("settings.languageSelectAriaLabel")}`, which is itself
  translated: it reads `Select language` in English, `Selecionar idioma` in
  Portuguese, `言語の選択` in Japanese. A `getByRole("combobox", { name: "Select
  language" })` therefore works exactly once and then resolves zero elements —
  the trap that makes test 3 unwritable if taken naively. Settings → General
  renders **exactly one** combobox in all seven languages (measured), so the
  spec resolves `getByRole("combobox")` and asserts `toHaveCount(1)` first: if a
  second one ever appears, the test fails naming that, instead of silently
  driving the wrong control.
- **The option labels are the stable half and are used as such.** They are
  hardcoded native names in the frontend (`English (Recommended)`, `Français`,
  `Español`, `Deutsch`, `Português`, `日本語`, `中文`) and do **not** move when
  the interface language changes — only the `(Recommended)` suffix is
  translated, which is why the English option is matched on `/English/` rather
  than on its full label.
- **Test 3 enumerates the selector rather than asserting a fixed list of
  seven.** The bullet's claim is *"every language offered in the selector has a
  bundle that loads"* — a hardcoded list would pass unchanged on the exact
  defect it exists to catch, which is a **new selector entry shipped without a
  bundle** (upstream `#12738`/`#12740` shipped `ru` and `ko` that way). Reading
  the options at run time means an eighth entry is covered the day it appears.
- **"The bundle loads" is asserted as a `200` on the chunk request, and "the UI
  re-rendered" separately.** They are different failures: a missing bundle
  `404`s the dynamic import and leaves the interface silently English (the
  `#12738` shape), so asserting only "the text changed" would report the right
  verdict for the wrong reason, and asserting only the request would not notice
  a bundle that loads but is never applied. Both, per language.
- **English is asserted as the inverse case, not skipped.** Its translations are
  inlined in the app bundle and the loader short-circuits on `e !== "en"`, so
  selecting English must produce **no** locale chunk request at all. Asserting
  that pins the optimisation; a test that merely skipped English would also pass
  if English started fetching a chunk that does not exist.
- **Persistence is asserted in the two places it is real, and the third is
  documented as out of scope.** The preference lives in `localStorage`, so it
  survives a reload and a second tab of the same browser context, and is
  **correctly** absent from a fresh `browser.newContext()`. The spec must
  therefore never open a new context to check "a new session" — that reads
  designed behaviour as a bug.

---

## External dependencies *(required)*

- A running Langflow instance reachable at `PLAYWRIGHT_BASE_URL`. **No provider
  key, no LLM call, no flow.** The whole surface is client-side.
- The seven locale chunks the image ships under
  `langflow/frontend/assets/` (`de`, `es`, `fr`, `ja`, `pt`, `zh-Hans`, plus
  `en` inlined). Their presence is the subject of test 3, not a precondition of
  it.
- Settings → General must be reachable through `user-profile-settings` →
  `menu_settings_button` → the `General` link, the same path
  `ui-ux/settings-general-section.spec.ts` uses.
- `src/frontend/src/i18n.ts` — the module that reads
  `localStorage.languagePreference`, registers the `languageChanged` →
  `document.documentElement.lang` handler, and holds the dynamic-import map of
  locale chunks the bundle-loads test observes.
- `src/frontend/src/locales/` — the shipped translation bundles; the selector's
  option list must stay 1:1 with this directory (the upstream defect class).
- `src/frontend/src/pages/SettingsPage/pages/GeneralPage/` — the Language card:
  the hardcoded option labels, the translated `aria-label`, and the change
  handler (`changeLanguage` + `localStorage` write + `useGetTypes`
  invalidation).

---

## Cleanup *(required)*

Nothing is created server-side, so there is nothing to delete. The only state
the tests write is `localStorage.languagePreference` in their own browser
context, which Playwright discards with the context after each test — no test
inherits another's language.

---

## What this test does not cover *(optional)*

- The **browser** locale axis and the missing-key fallback — `locale-resilience.md`
  (§18.2), the sibling in this batch.
- The quality or completeness of any individual translation.
- The language selector in the app header, if one exists there — this spec
  drives the Settings → General one named by the checklist bullet.
- The side effect that switching language invalidates the component-types query
  (`setTypes({})` + `invalidateQueries(["useGetTypes"])` in the change handler):
  real, measured in the bundle, but a catalog concern rather than an i18n one.

---

## Notes *(optional)*

- **Where the facts come from.** Every selector and every string below was
  harvested twice: from the shipped frontend bundle inside the running container
  (`langflow/frontend/assets/index-d_5OgSTc.js`) and then confirmed live against
  `1.12.0.dev33` with a throwaway scout. The scout is what produced the
  translated-`aria-label` trap above, which reading the bundle alone would have
  missed.
- **The upstream defects this pins.** `langflow-ai/langflow#12738` and `#12740`
  shipped selector entries (`ru`, `ko`) with no corresponding bundle. On
  `1.12.0.dev33` the selector offers exactly the seven languages the image ships
  a bundle for, so the defect is **fixed** and test 3 is a regression guard, not
  a reproduction.
- **Measured behaviour of the change handler**, for whoever debugs this next:
  selecting a language `await`s the dynamic import of its chunk, calls
  `i18n.changeLanguage`, writes `localStorage.languagePreference`, then clears
  the component-types store and invalidates `useGetTypes`. The last step means a
  language switch also triggers a catalog refetch — expect a `GET /api/v1/all`
  in the network log that has nothing to do with i18n.
