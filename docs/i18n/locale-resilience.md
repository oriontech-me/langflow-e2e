# i18n — Locale resilience

**Last validated:** Langflow 1.12.x (measured on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

That an unsupported language **degrades instead of breaking the product**. Two
independent failure modes: a stored language preference Langflow ships no bundle
for (the upstream **black-screen** class), and a bundle that ships but is missing
individual keys.

1. **should boot into a shipped language for every unsupported or regional
   preference** — `localStorage.languagePreference` is seeded before the first
   navigation with each of `nb-NO`, `ru`, `ko`, `xx`, `zh-CN`, `zh-SG`, `pt-BR`,
   `de-AT` and an unset value. In every case the application reaches
   `mainpage_title` with a non-empty body, and `document.documentElement.lang`
   settles on the language the frontend's normaliser resolves — `en` for the
   four it cannot place, `zh-Hans` for both Chinese regionals, `pt` for `pt-BR`,
   `de` for `de-AT`.
2. **should boot in English under a browser locale Langflow ships no bundle
   for** — the whole test runs under `withLocale("nb-NO")`. The application
   renders, `navigator.language` reads `nb-NO`, `document.documentElement.lang`
   reads `en`, and `localStorage.languagePreference` is **unset** — the browser
   locale never becomes a language preference.
3. **should fall back to English for a key the active bundle lacks, next to
   siblings it translates** — with the interface in Portuguese, the flow
   editor's Create Memory modal renders `Criar Memória`, `Nome` and
   `Tamanho do lote` in Portuguese while the `Vector Database` label and its
   description — two keys the Portuguese bundle does not carry — render their
   English text. No raw i18n key (`memory.dbProviderLabel`) appears anywhere in
   the dialog.

---

## Tags *(required)*

`@stable` `@regression` `@ui-ux` `@workspace`

`@regression` is the load-bearing tag: test 1 pins three fixed upstream
black-screen defects (see **Notes**). `@workspace` covers the flow editor and
its Memories panel, which test 3 has to reach; `@ui-ux` covers the rest. No new
`@i18n` functional tag — see the sibling doc.

`@stable` from the first PR: LLM-free and provider-free (test 3 never selects an
embedding model, so it does not inherit `memory-base-panel.spec.ts`'s
provider-dependent branch), and the one flow test 3 creates is deleted
id-scoped.

---

## Validation criterion *(required)*

- **Test 1 asserts the frontend's normaliser, and the expected value per seed is
  measured, not assumed.** The shipped bundle resolves the stored preference
  through a three-step ladder before i18next ever sees it: exact match against
  the seven shipped codes → the `zh-hans`/`zh-cn`/`zh-sg` special case → the
  primary subtag (`pt-BR` → `pt`) → `en`. Each row of the table asserts one
  branch of that ladder, so a regression that flattens it to "unknown ⇒ en"
  would still be caught by the `zh-CN` and `de-AT` rows, and a regression that
  drops the final `en` fallback — the black-screen shape — by the `nb-NO`, `ru`,
  `ko` and `xx` rows.
- **"Boots" is asserted as three things, because a blank screen satisfies one of
  them.** The defect being pinned renders a black page with a live document: the
  navigation resolves and the URL is right. So each row requires
  `mainpage_title` to become visible **and** the body to carry text **and**
  `<html lang>` to hold the expected code. A bare `waitForURL` or a
  `toBeVisible()` on the app shell would pass on the very failure this exists
  to catch.
- **The seed is written with `addInitScript` before the first navigation.**
  `localStorage.languagePreference` is read once, at module evaluation
  (`normalize(localStorage.getItem("languagePreference") || "en")`), so a value
  written after the page loads changes nothing until the next load — a test that
  seeded post-navigation would assert the default and pass for the wrong
  reason.
- **Test 2 exists because the checklist bullet says "browser language" and the
  product does not read it.** Langflow's `i18n.ts` consults
  `localStorage.languagePreference` and has no language-detector plugin, so
  `navigator.language` is inert (measured for #1400 and re-measured here). Test 2
  pins that independence: it is the only assertion in the suite that would fail
  if upstream added detection, at which point every unshipped browser locale
  becomes a boot risk again and test 1's table becomes reachable from the
  browser. It uses `withLocale()` — the sanctioned opt-in — never a bare
  `test.use({ locale })`.
- **Test 3's vehicle is chosen, not convenient — and one obvious candidate is a
  decoy.** On `1.12.0.dev33` all six non-English bundles are missing the **same
  five** keys that `en` carries: `shortcuts.modifierOnly`, `memory.backendLabel`,
  `memory.dbProviderLabel`, `memory.dbProviderDescription` and
  `memory.dbProviderNotConfigured`. `shortcuts.modifierOnly` **must not be
  used**: its call site passes an inline
  `{ defaultValue: "Add at least one non-modifier key…" }`, so it renders English
  whether or not `fallbackLng` works, and a test built on it would pass against a
  broken fallback. The three `memory.*` keys are called with no `defaultValue` at
  all, so English there can only come from `fallbackLng: "en"`. `memory.backendLabel`
  needs an existing memory base; `memory.dbProviderLabel` and its description
  render unconditionally in the Create Memory modal, on an instance with nothing
  configured — which is why that modal is the vehicle.
- **Test 3 asserts translated siblings in the same dialog, not just the English
  string.** "This label is in English" is also true of an instance that never
  switched language at all. The falsifiable form is the pair: `Criar Memória` /
  `Nome` / `Tamanho do lote` in Portuguese **and** `Vector Database` in English,
  read from one screenshot of one dialog.
- **A raw-key check backs it up**, because i18next's other failure mode is to
  render the key itself: the dialog's text must not contain
  `memory.dbProviderLabel`. Two different broken states — key echoed, or empty
  string — are excluded by the pair of assertions.
- **This test has a known expiry and says so in its own failure.** If upstream
  translates those keys, the English assertion goes red on a healthy product.
  The assertion therefore carries a message naming that possibility and pointing
  at how to re-measure (diff the `en` translation object in
  `assets/index-*.js` against `assets/pt-*.js`), so the next reader is not left
  diagnosing a phantom i18n regression.

---

## External dependencies *(required)*

- A running Langflow instance reachable at `PLAYWRIGHT_BASE_URL`. **No provider
  key and no LLM call** — test 3 opens the Create Memory modal and never selects
  an embedding model, so the provider-dependent control that
  `memory-base-panel.spec.ts` branches on is irrelevant here.
- `POST /api/v1/flows/` and `DELETE /api/v1/flows/{id}` for test 3's own flow —
  the Memories nav item requires a flow to be open.
- `withLocale()` from `tests/fixtures/locale.ts` (#1400) for test 2. Without it
  the browser-locale axis cannot be exercised at all: `CONTRIBUTING.md` bans a
  bare `test.use({ locale })`, which is what made these bullets unwritable
  before that fixture landed.
- The `pt` locale chunk shipped by the image, for test 3.
- `src/frontend/src/i18n.ts` — the normaliser ladder test 1 transcribes, the
  `fallbackLng: "en"` configuration test 3 exercises, and the absence of a
  language-detector plugin that test 2 pins.
- `src/frontend/src/locales/pt.json` — the bundle whose five-key gap against
  `en` is test 3's subject; if upstream fills it, the test says how to
  re-measure (see Validation criterion).

---

## Cleanup *(required)*

Test 3 creates one flow through `POST /api/v1/flows/` and deletes it id-scoped
in `afterEach`, leaving the editor first via `unmountEditorForCleanup` so the
deleted flow's editor polls cannot 404 into the fixture's HTTP log. No memory
base is ever created — the modal is cancelled. Tests 1 and 2 create nothing;
their only state is `localStorage` inside their own browser context, which
Playwright discards with it.

---

## What this test does not cover *(optional)*

- The Settings → General selector itself — `language-selection.md` (§18.1), the
  sibling in this batch.
- Whether the **backend** localises. It does — `GET /api/v1/flows/basic_examples/`
  answers `Sugestões básicas` under `Accept-Language: pt` — but that is a third
  axis reached by an explicit header, not by either mechanism here
  (`CONTRIBUTING.md` → *Browser locale*).
- The other two en-only keys (`memory.backendLabel`,
  `memory.dbProviderNotConfigured`), which need a registered memory base and a
  half-configured DB provider respectively.
- Right-to-left layout: Langflow ships no RTL bundle, so there is nothing to
  assert.

---

## Notes *(optional)*

- **The upstream defects test 1 pins.** A missing Chinese bundle
  (`langflow-ai/langflow#12923`, `#13477`) and Norwegian Bokmål `nb-NO`
  (`#13196`) each rendered a **black screen** — the product did not open at all
  for those users. On `1.12.0.dev33` every one of those inputs boots, so this is
  a regression guard rather than a reproduction. `nb-NO` and `zh-CN` are in the
  table specifically because they are those reports.
- **Measured normaliser**, transcribed from the shipped bundle so the table above
  is auditable:

  ```js
  const SUPPORTED = ["en", "de", "es", "fr", "ja", "pt", "zh-Hans"];
  const normalize = (e) => {
    if (SUPPORTED.includes(e)) return e;
    if (["zh-hans", "zh-cn", "zh-sg"].includes(e.toLowerCase())) return "zh-Hans";
    const primary = e.split("-")[0];
    return SUPPORTED.includes(primary) ? primary : "en";
  };
  ```

  i18next is then initialised with `fallbackLng: "en"`, `returnNull: false` and
  `returnEmptyString: false` — the configuration test 3 exercises.
- **Where the facts come from.** The five-key gap was produced by diffing the
  `en` translation object inside `assets/index-*.js` against each locale chunk
  (2387 English keys, 2382 in each of the six bundles, identical gap in all
  six), then confirmed live: the Create Memory modal under `pt` renders
  `Vector Database` and `Where this memory base stores vectors. Configured
  providers come from DB Providers settings.` in English amid an otherwise
  Portuguese dialog.
