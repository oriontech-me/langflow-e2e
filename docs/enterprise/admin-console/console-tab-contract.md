# Enterprise — Every Screen of the Admin Console Resolves and Loads Its Own Data

**Last validated:** Langflow Enterprise 1.12.0 (image built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`/admin-ee` is the console an operator uses to govern an Enterprise instance, and § 21
names the admin **UI** as the part Enterprise exclusively owns — every enforcement
mechanism behind it is already covered from the API side. It has seven screens. Before
this spec, one of them was covered (the catalog tab, for one field), so nothing would have
noticed a screen that stopped loading, a route that stopped resolving, or a tab whose label
opened the wrong screen.

This is the **shell** contract, and it is deliberately shallow: it says nothing about what
any screen lets an operator *do*. It says that each screen exists, is reachable both ways,
is the one its tab claims, and fetched its own data. Every deeper spec in this directory
depends on that — an assertion about an audit filter passes vacuously against a screen that
never rendered.

### The seven screens, measured

Each has its own heading, its own subtitle, and one API read no other tab performs. The read is the load-bearing column: all seven render the same chrome, so an
assertion on chrome would pass against any of them.

| Route | Tab label | Own subtitle (the screen's body) | Read only it performs |
|---|---|---|---|
| `users-groups` | Users & groups | *Manage users and their access to this Langflow instance.* | `GET /api/v1/users/` |
| `access-control` | Access control | *Define roles, grant them to people and teams, and review who has access.* | `GET /api/v1/authz/roles` |
| `catalog` | **Components** | *Manage the approved component catalog, builder visibility, and policy.* | `GET /api/v1/enterprise-admin/catalog/components` |
| `models` | Models | *Choose which models are available in this Langflow instance.* | `GET /api/v1/model-availability-policy` |
| `providers` | Providers | *Approve model providers globally for this Langflow installation.* | `GET /api/v1/model-provider-policy` |
| `security` | Security | *Configure login connections, recovery access, and security defaults.* | `GET /api/v1/sso/connections` |
| `audit-logs` | Audit logs | *Sign-on and access-control events for this Langflow instance, newest first.* | `GET /api/v1/authz/audit` |

### Why the subtitle and not a testid

The first draft of this spec anchored each screen on a `data-testid`, and measuring the
candidates refuted the choice twice over. Four of the seven — `models-empty-state`,
`providers-recommended-state`, `login-connections-empty-state`, `audit-details-cell` —
describe an instance **state**, not a screen: they exist because this container has no
providers, no SSO connection and some audit rows, and the same screen on a configured
instance renders none of them. And `admin-sub-tabs`, the candidate for `users-groups`,
is also present on `access-control`, so it identifies nothing.

The subtitle is the screen's own header copy, rendered by that route's component and
independent of how much data the instance holds. Measured across all seven: exactly one
occurrence on its own screen and **zero on the other six**. It carries the pair this spec
needs — the subtitle proves *this* screen mounted, the 2xx read proves it fetched its own
data — where a state-dependent testid would make the spec fail on a configured instance
for a reason that has nothing to do with the console.

The label and the route disagree for one screen — **Components** is `/admin-ee/catalog` —
which is why the strip test asserts the mapping rather than assuming a tab named X lands
on `/admin-ee/x`.

### Two DOM facts that decide the spec's shape

Both are the opposite of the obvious guess, and getting either wrong produces a spec that
looks reasonable and asserts nothing:

- The strip `enterprise-admin-tabs` holds seven `role="tab"` **buttons**, not links, named
  by their visible label and carrying no `data-testid` at all. Navigation is
  `getByRole("tab", { name })`; which one is current is `aria-selected="true"`.
- `data-testid="enterprise-admin-tab-<route>"` is **not on the tab**. Despite its name it
  sits on the screen's own `<section role="tabpanel">`, whose `aria-label` is the tab's
  visible label, and **only the active route's panel exists in the DOM** — the other six
  are not rendered.

  The first version of this spec read that testid as the active-tab marker and asserted
  `aria-selected` on it. All nine tests failed, on a console where nothing was wrong: the
  attribute is on the button, and the button has no testid. The name is misleading enough
  that inferring the owner from a list of a page's testids gets it backwards, so it is
  recorded here rather than left to be rediscovered.

  The correction is an improvement, not a workaround. A container is a stronger anchor than
  a marker: the panel being visible says *this screen's content region mounted*, its
  uniqueness in the DOM says *no other screen mounted with it*, and its `aria-label` ties
  the route to the label the strip shows — which is the label→route mapping this spec
  exists to pin, asserted at the DOM rather than inferred from a click.

### Why an unresolved-i18n test lives in the shell spec

It is the one defect class this console has actually shipped. Issue #1563 measured
`/admin-ee/users-groups` rendering **17** raw `admin.*` keys: every column header, the
search box, the two toggles that deactivate an account and grant superuser, and the
delete-confirmation dialog's title, body and both buttons — so the last thing between a
click and a deleted account stated nothing, and a screen-reader user was told
`admin.deleteTitle` before deleting a user.

That is fixed on the image this spec is validated against: zero raw keys across all seven
screens. The guard is written now precisely because the fix is unwitnessed — a locale
resource is among the easiest things in a frontend to drop again, and the failure is
silent everywhere except on screen.

## Assertions of absence, and how each is kept honest

Two of the three tests assert that something is **not** there, which is the failure mode
this repo has paid for most often: a predicate that can no longer match anything stays
green forever and reads as coverage.

- **The screen must be there before its absence means anything.** The i18n test requires
  each tab's own subtitle to be visible *before* it inspects any text. Without that, a blank
  screen satisfies "no raw keys" perfectly.
- **The predicate has a real negative control, not a synthetic one.** The older
  `langflow-enterprise:local` image (2026-08-18) still ships the defect, so the predicate is
  proven to fail on a build where it must — rather than trusted because it is green on the
  build where it should pass. Measured, pointing the spec at that image: **9 distinct keys
  on `users-groups`**, and **0** on the build this spec is validated against. That is the
  force-fail this spec records, and it is why the test names every offending screen and key
  rather than the first — the count is how the control is read.

### What the predicate matches, and the two ways it was wrong first

Both corrections came out of running the negative control, and neither is visible from the
passing side:

- **Anchoring it to the whole string reports the harmless findings and misses the serious
  one.** #1563's `admin.deleteTitle` is the accessible name of the **delete-account**
  button, and it reaches the DOM composed — `"admin.deleteTitle — langflow"`. An anchored
  `^…$` pattern found the seven column headers and not that. The same is true of the two
  toggles that deactivate an account and grant superuser. So the match is unanchored, and
  it reads `aria-label` / `title` / `placeholder` alongside rendered text: half of what
  this defect class costs is paid by someone who cannot see the screen.
- **Matching anywhere costs exactly one false positive, and it is a product name.**
  *Approve IBM watsonx.ai models for use across Langflow.* — `watsonx.ai` is
  `namespace.token` in shape. So a candidate counts only if some segment is camelCase
  (`deleteTitle`, `columnUsername`, `cannotDeactivateSelf`) or it is nested more than one
  level deep. `watsonx.ai` is neither.

  That filter can miss an all-lowercase single-dot key, and that is the right direction to
  be wrong in: a locale regression drops a namespace rather than one string, so the
  camelCase siblings still fail the test — while a fabricated finding sends someone to read
  a screen that is correct.

### What this test does not reach

Nine of #1563's seventeen keys are found; the other eight are not rendered in the default
state of the screen. They belong to the **delete-confirmation dialog** (its title, body and
both buttons), the **empty state**, and the clear-search control — all behind an
interaction this shell spec deliberately does not perform. Recorded rather than glossed,
because the dialog's copy is the most consequential of the seventeen, and covering it is
part of what the `users-groups` follow-up spec is for.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

`@regression` is not decoration: #1563 was a real defect on this console, and the third
test is its guard. `@ui-ux` is the functional tag — this is console navigation and
rendering, not the governance semantics its API siblings cover, so `@governance` would
overstate it.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

1. Authenticate once against the Enterprise instance and require the **RBAC variant** —
   `authz_enabled: true` and `superuser_bypass: false`. Skip, naming the start command,
   otherwise: `access-control` and `audit-logs` read `/authz/*` and have nothing to load
   on a container without it, so two of the seven screens would report an environment
   choice as a product failure.
2. Seed the browser session from the cached token rather than filling the login form —
   the instance rate-limits `/api/v1/login` to 5 per minute per IP for the whole machine.
   The login form is `enterprise/auth/login-surface.spec.ts`'s subject, not this spec's.
3. **Per tab (seven tests):** start recording responses, `goto /admin-ee/<route>`, then
   assert, in this order:
   - the URL is still `/admin-ee/<route>` — a screen that redirected to a default tab
     would satisfy every remaining assertion of the *default* tab;
   - the strip marks it current — the `role="tab"` button named by its label carries
     `aria-selected="true"`;
   - its panel `enterprise-admin-tab-<route>` is visible and its `aria-label` is that
     label, which is where the route↔label mapping is actually pinned;
   - the tab's own subtitle from the table above is visible — the panel proves the
     container mounted, the subtitle proves its body rendered;
   - the tab's own API read was performed **and** answered `2xx`.
4. **The strip (one test):** open one screen, then click each of the other six by
   `getByRole("tab", { name })`; after each click assert the URL is that tab's route and
   that screen's panel is the one now mounted.
5. **Unresolved keys (one test):** walk all seven screens; on each, wait for that screen's
   own subtitle, then collect every visible leaf text and match it against
   `^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$`. Fail naming every screen and string that
   matched.

## Validation criterion *(required)*

The per-tab tests fail when a screen stops resolving, redirects away, renders another
screen's content, loses the selected state on its tab, or paints its shell without
performing the read that populates it. The
strip test fails when a tab's label stops opening the screen it names. The i18n test fails
when any screen in the console renders an unresolved translation key.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh` (port 7891 by default).
- A browser.
- **One** unit of the per-IP login budget, spent by the shared token cache and reused by
  all nine tests.
- No LLM provider, no network egress, and no licence — `security` is asserted on its
  empty state, which is what an unlicensed instance correctly shows.
- No Langflow **source** paths, and that is not an omission: the Enterprise frontend does
  not live in `langflow-ai/langflow`, so there is no upstream path this doc could name that
  `scripts/watch-upstream-areas.mjs` would resolve. Every sibling doc under
  `docs/enterprise/` is in the same position.

## Notes

Four non-2xx responses are expected here and are not defects. The first is declared to the
fixture with `page.expectKnownHttpError()`; the other three are globally exempt already:

- `GET /api/v1/sso/entitlements` -> `503`, on the screens that reach `security`. An
  Enterprise instance with no licence refuses that read by design, and
  `enterprise/auth/entitlement-fail-closed.spec.ts` asserts that exact refusal as the
  product's contract. It is declared per screen rather than silenced with
  `allowHttpErrors()`, which would take the whole test's advisory log with it — and the
  declaration is verified in both directions: against a **licensed** instance the 503 stops
  firing, and the fixture fails naming the entry to delete, which is the right signal since
  this list would then be out of date.

  **Every arrival at `security` awaits that read**, and this is not tidiness (#1636). The
  declaration is only honest if the state it declares has actually occurred by the time the
  test ends, and the first version of this spec awaited only each screen's primary `read`.
  The per-tab Security test observed the `503` alongside its own read and passed; the strip
  and i18n walks merely passed through, asserted on what had rendered, and could finish
  first. Under the load of a whole-directory run they did — the spec alone reported 3 hits
  twice over while the full run reported 2 and failed on a stale exemption, on an instance
  answering `503` to 5 of 5 direct calls at that moment.

  Measured before relying on it: entitlements is requested on **every** arrival — by `goto`,
  by clicking the tab, and again on clicking away and back. Nothing is cached, so awaiting it
  cannot hang.

  Falsified deterministically rather than by hoping to reproduce a load-dependent race:
  delaying the response by 6 s makes the race certain, and **without** the wait three tests
  fail with `1 declared known backend defect(s) did NOT occur`, **with** it all nine pass.

  It is also a better test on its own terms. A screen whose reads have not landed is a screen
  the i18n scan is reading too early, and an assertion of **absence** taken against a
  half-rendered screen is precisely the failure mode this document warns about two sections
  above.

The remaining three fire on every page load of the console:

- `GET /api/v1/auto_login` → `403`, correct on a password-first instance; the HTTP error
  policy already exempts auth endpoints.
- `POST /api/v1/refresh` → `401`, because the session is seeded with an access token and
  deliberately no refresh token.
- `GET /api/v1/store/tags` → `500`, the external Langflow Store, unreachable in this
  environment and already exempt.

The per-tab tests scope their response assertion to that tab's own read, so none of these
can satisfy or break it.

One measurement trap, recorded because it produced a wrong validation claim once: the
fixture prints `Backend Error` on **stdout**. Under `--reporter=json` that is the JSON
file, so grepping the run's stderr for it reports zero on a run that logged two. Capture
both streams (`2>&1`) when checking step 4 of the validation checklist.
