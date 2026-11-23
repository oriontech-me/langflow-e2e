# Browser locale

> Moved verbatim from `CLAUDE.md` (#2532). `CLAUDE.md` keeps the standing rules and links here; this file keeps the mechanism, its history and its measurements. Counts and dates are as of when each passage was written. Re-measure before quoting one.

- Browser locale `en-US` by default, resolved by `tests/fixtures/locale.ts` rather than
  hardcoded (#1400): a spec opts out with `test.use(withLocale("pt-BR"))`, a whole run
  with `PW_LOCALE`, and an invalid tag aborts the config instead of falling back to
  English. **It does not decide the language Langflow renders** — measured on
  `1.12.0.dev20`, the UI reads `localStorage.languagePreference` and never
  `navigator.language`, so under `pt-BR` every string stays English and `<html lang>`
  stays `en`. What it does govern is `Intl` formatting and the document
  `Accept-Language`. The backend's `set_locale` middleware is a **partial** third axis,
  not a "no": Langflow localises by `Accept-Language` (`/api/v1/flows/basic_examples/` →
  `Sugestões básicas` under `pt`), and while the frontend pins the header on the calls
  that pass through its axios interceptors — 17 of 20 on the home screen — the other 3
  (a `/api/` subresource, two `/api/v9/invites/` XHRs) carry the context locale, so a
  spec asserting on the backend's locale must set the header itself. `CONTRIBUTING.md` →
  *Browser locale* has the three-axis table and the measurement. Pinned behaviourally by
  `tests/fixtures/locale-gate.spec.ts`, the sibling of the two error-policy gates
