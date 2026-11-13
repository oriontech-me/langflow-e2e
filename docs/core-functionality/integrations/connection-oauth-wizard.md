# Connections — the Add and Reconnect wizard, up to consent

**File:** `tests/tests-automations/regression/core-functionality/integrations/connection-oauth-wizard.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev26`; `1.14.0.dev14` before the `dev23` provider field; the pre-`1.14.0.dev10` side on `1.14.0.dev9`)

Owning issue: #2307 (Dedicated Integrations, batch 2; upstream surfaces A10, B2 and B3). It depends on #2301's fake
OAuth registrations (`docs/api/connections/oauth-fake-registrations.md`). The callback's controls are asserted
through the API in `docs/api/connections/api-connections-oauth-callback.md`.

#2358 later assigned seven upstream wizard fixes (all merged into `release-1.13.0` on 2026-10-15/16) to this issue.
Where each one is covered:

| Upstream | Behaviour | Covered by |
|---|---|---|
| langflow#15796 | Provider setup guidance, Handle / Display name help | test 7 (guides, help), test 2 (no registration) |
| langflow#15810 | Each scope names its actions, their risk, and conditional use | test 1 (Google), test 7 (Microsoft, *For some inputs*) |
| langflow#15809 | An unusable provider is blocked before consent | `governance/integration-policy-enforcement.spec.ts`, test 3 (`@destructive`: the policy is instance-global) |
| langflow#15816 | A lost sign-in window is handled | test 3: the dialog keeps polling and still learns the provider's answer |
| langflow#15822 | Reconnect preserves the saved credential | test 5 (the reachable half; see *Recorded, not asserted*) |
| langflow#15780 | Microsoft reconnect requests offline access | test 5 |
| langflow#15825 | The page's third-party account description | `connections-page.spec.ts` (the page subtitle; this dialog shows no such copy) |

#2376 later followed langflow#15952 (*"feat(jira): add Cloud issue actions and polling triggers"*, first in
`1.14.0.dev10`), which changed what a failed *Add* leaves behind for every provider, not only Jira. Tests 3 and 4
assert each side by served version (see *A failed Add, before and after `1.14.0.dev10`*).

---

## What this test validates *(required)*

The dialog a user connects an account through: *Add connection* from the page, *Reconnect* from a row's menu, and
*Authorize* on a `pending` row. Until #2301 it stopped at *"No OAuth registration is configured for this
provider"*. With the fake registrations it walks to consent, and this file walks it there and back.

**The test plays the provider.** Continue opens a popup on the provider's authorization URL. A context route answers
that URL the way the provider would at the end of consent: a `302` to the instance's callback with the `state` it
was given, plus `error=access_denied`, or neither `code` nor `error`. Or it serves a stub page and never redirects,
to stand for a user who has not answered yet. The browser then delivers the real callback, with the real binding
cookie `oauth/start` set, to the real backend, and the dialog learns the outcome the way it does in production: by
polling the row. Nothing leaves the machine, and nothing is mocked on Langflow's side, apart from the registration
list in tests 2 and 3, and the connection list held while a callback waits out a `429` (see *Budgets*).

The popup must reach the callback through the provider's redirect, never through `popup.goto()`. Measured: a
browser-initiated navigation of the popup to another site swaps its browsing instance. The dialog's handle on the
window then reads as closed, so *Try again* opened nothing and the dialog waited forever.

Measured on `1.14.0.dev2`, and again on `1.14.0.dev7`:

| What the user does | What the dialog shows | What the row reads |
|---|---|---|
| Opens *Add connection* | *Provider* (`connection-provider`): the manifest's providers in its order, the **first** one preselected. On `1.14.0.dev7` that is *GitHub* (langflow#15957 added it ahead of Google), and on `1.14.0.dev23` *Confluence Cloud*, so every test that needs Google picks it. From `1.14.0.dev23` the field is a combobox and not a native `<select>` (see *The provider field* below). Then *Setup guide*, *Handle*, *Display name*, *Share with the whole instance*, and *Scopes to request*: one checkbox per scope (`connection-scope-<scope>`), all checked. Each scope's label lists every action that needs it, with that action's risk (*Read* / *Write*), from the manifest's `display_name` and `risk`. The scope id comes last, shortened to its last segment, with the full scope as its `title`. Slack adds *How to connect* (`connection-method`: *Sign in with Slack* / *Paste a token*) and *Runs as* (`connection-identity`). | — |
| Reads the help | *Handle* and *Display name* each carry an info button (`connection-handle-help`, `connection-display-name-help`; accessible names *Handle help* / *Display name help*). Its tooltip reads *"The identifier flows use to reference this connection, such as `<provider>/work`."* (the example follows the selected provider) and *"A readable name shown in connection lists to help you recognize this account."*. *Setup guide* (`connection-setup-guide`) links the selected provider's page: Google `…/connection-oauth#customer-owned-google-registration`, Microsoft `…/entra-app-registration`, Slack `…/connection-oauth#customer-owned-slack-registration` (all on `docs.langflow.org`). | — |
| Picks Microsoft 365 | The scope a component needs only for some inputs marks each such action *"For some inputs"* after its risk: `Files.Read.All` and `Sites.Read.All`, which the SharePoint/OneDrive actions and trigger need only when given a drive or a site (the manifest's `conditional_scopes`). The same actions list `Files.Read` without the mark, because they always need it. `offline_access` names no action. | — |
| Picks *Paste a token* | A *Token* field (`connection-token`) in place of the scope list, and the *Setup guide* points to the Slack bundle's page | — |
| Continue | *"Waiting for consent in the provider's window…"* and a popup on the provider's authorization URL | `pending` (`oauth/start` does not touch the row) |
| The provider denies | `role=alert` *"The provider denied authorization."*, *Try again*, *Cancel* | `error` / `oauth-denied`. From `1.14.0.dev10` the dialog then **deletes** the row it created (see below) |
| *Try again*, and the provider returns neither `code` nor `error` | *"The sign-in link expired. Start again to get a new one."* | `error` / `oauth-expired`. From `1.14.0.dev10` *Try again* first **creates a new row** with the same handle, and the dialog deletes that one too |
| Closes the popup unanswered | `role=status` *"Langflow can no longer track the sign-in window. If the provider shows an error, ask your administrator to check the OAuth registration before trying again."*, the provider's *Setup guide*, and *Try again* | unchanged |
| …and the provider's answer reaches the callback anyway | the dialog **still** learns it (langflow#15816: losing the window is not a cancellation, so polling goes on): the denial alert replaces the untracked status and the setup help. Measured 0.8 s after the callback. | `error` / `oauth-denied`, then deleted from `1.14.0.dev10` |
| *Cancel* on an Add | the dialog closes | **deleted** (`DELETE` → `204`): an unfinished Add leaves nothing behind. From `1.14.0.dev10`, after a failure there is nothing left to delete, and *Cancel* sends no write |
| *Reconnect* on a `ready` row, *Authorize*, then *Cancel* | dialog titled *"Reconnect <display name>"*, the held scopes checked and marked *Granted*, every other scope unchecked. On **Microsoft**, `offline_access` is checked too but **not** marked *Granted* (langflow#15780: Entra leaves it out of the reported grants, and without it a reconnect would lose the refresh token), and it is requested: in `oauth/start` and in the authorization URL's `scope` | **unchanged**: no write is sent, `ready`, credential kept, badge `Ready` |
| *Authorize* on a `pending` row (`authorize-<name>`), denied, *Cancel* | On Google, *Authorize* stays disabled until a scope is checked (a pending row holds none, and nothing is added to it), and the start asks for exactly the scopes checked | `error` / `oauth-denied`, and the page shows the badge `Error` with *"The provider denied authorization."* under it |

### A failed Add, before and after `1.14.0.dev10`

langflow#15952 added `discardFailedNewConnection` to the dialog. When a connection the dialog **created** fails
(any `oauth-*` reason, any other failed outcome, or a refused `oauth/start`), the dialog deletes it at once, rather
than when the user presses *Cancel*. *Try again* then has no row to retry with, so it creates a new one with the same
handle and starts consent again. A *Reconnect* never discards (its row existed before the dialog), which is why test 6
is the same on both sides. The upstream unit tests pin the new behaviour (*"deletes the new row, and recreates it on
retry"*), so this is an intended contract change, not a regression. Neither `release-1.13.0` nor `release-1.13.1`
carries it.

Measured on `1.14.0.dev14`, test 4's path, in the order the browser sent it:

| Request | Answer | What the list read next |
|---|---|---|
| `POST /api/v1/connections` | `201` | the row `pending` |
| `POST …/{id}/oauth/start`, the provider denies | `200` | `error` / `oauth-denied` |
| `DELETE …/{id}`, sent by the dialog on that read | `204` | no row |
| *Try again*: `POST /api/v1/connections`, same handle | `201`, a **new** id | `pending` |
| `POST …/{new id}/oauth/start`, neither `code` nor `error` | `200` | `error` / `oauth-expired` |
| `DELETE …/{new id}` | `204` | no row |
| *Cancel* | no request | no row |

So on `1.14.0.dev10` and later, the row is gone before the test can read it, and reading the list after the alert
finds nothing (#2376: both tests failed there, `received: undefined`). What the server recorded is still observable:
it is the **list read the dialog itself polled**, the one that taught it the outcome. The tests capture that response
and assert the row in it (`error`, the reason, `has_credentials: false`), then assert the `DELETE` of that row's id
answered `204` and that the list no longer carries the handle. Before `1.14.0.dev10` the same captured read is
asserted, the row is still there when the test reads it, and *Cancel* deletes it.

Which side applies comes from the version the instance declares (`servedVersionAtLeast`, the rule #2336 set), never
from whether a row happens to survive: asking the behaviour would pass a build that lost the delete by accident.

Two states need the registration list mocked, because the lanes serve one registration per provider and profile:

- **No registration.** The setup help (`connection-setup-help`) says *"No OAuth registration is configured…"* and
  tells the operator to set `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`. It suggests a redirect URI
  (`connection-callback-url`) built from the page's own origin, `<origin>/api/v1/connections/oauth/<provider>/callback`,
  which *Copy redirect URI* (`connection-copy-callback`) puts on the clipboard (*"Redirect URI copied."*).
  Continue stays disabled. The suggestion is offered only on HTTPS or loopback HTTP, the broker's own rule. Any
  other origin gets *"Open Langflow at its public HTTPS URL…"* instead, and the test asserts whichever the lane's
  origin calls for.
- **Two registrations for one provider and profile.** An *OAuth registration* select (`#connection-registration`)
  appears, preselecting the first. The test lists a fake id **first** and the real `e2e-google` second, picks the
  real one, and checks that `oauth/start` was sent with it. A start the server accepted is the proof the pick was
  honoured.

### Recorded, not asserted

- **The *Connected* state** needs a real token exchange. It is out of scope with the rest of a successful consent.
- **The popup after a failure.** The dialog closes the popup on success only. After a denial it stays open on the
  callback's failure page.
- **Add's *Continue* does not wait for the registration list.** Reconnect's *Authorize* waits for it
  (`canAuthorize` checks `!registrations.isLoading`), and Add's `canContinue` does not. A *Continue* sent before the
  list arrives finds no list, falls back to the provider id as the registration (`resolveRegistrationId`'s path for a
  backend without the listing route) and starts consent with `registration_id: "google"`. The server answers `400 "OAuth
  registration ID is not configured."`, and the dialog shows *"Authorization did not complete."*. Measured on
  `1.14.0.dev2` by delaying the list, and seen once in this PR's CI, where it was the first attempt of test 4. A user
  rarely beats the request, so the spec waits for the list before it touches the dialog, and the race is recorded here
  instead of asserted.
  **The race reopens on every provider pick, not only on the first open**, because the list is fetched per provider
  (`?provider=<id>`): the list the dialog loads first is the preselected provider's (GitHub since `1.14.0.dev7`,
  Confluence since `1.14.0.dev23`), and
  Google's is fetched only after the test picks Google. Waiting for the first list therefore no longer covered the
  pick, and test 4 lost the race: measured on `1.14.0.dev14`, `oauth/start` answered `400` with *"OAuth registration
  ID is not configured."*, the popup never reached the provider, and the test timed out waiting for the callback
  (`browserContext.waitForEvent`), the signature of test 4's one-off failure on `1.14.0.dev9` (#2376). The spec now
  waits for the list of the provider it picks.
- **The provider field (#2413).** From `1.14.0.dev23` *Provider* is a Radix Select. `connection-provider` is a
  `button` with `role="combobox"` showing the chosen provider's `display_name`, and its options (`role="option"`)
  are named by `display_name` and carry no value in the DOM. It replaces a native `<select>` of provider ids.
  langflow#15951 (the ServiceNow bundle) added it as `ProviderSelect.tsx`, with the provider icons. The 2026-11-11
  daily failed four tests on `locator.inputValue: Node is not an <input>, <textarea> or <select> element`, and test
  1 on an option list of one element. *How to connect*, *Runs as* and *OAuth registration* are still native
  selects. The spec reads ids and names from the manifest the dialog renders, and decides which field it drives by
  the served version (`1.14.0.dev23`), never by what the page shows. `release-1.13.3` still ships the native select.
- **The display name (#2413).** From `1.14.0.dev26` the dialog no longer asks for one. Upstream `1dcd9de3fb`
  (*"use connection handles as display names"*, 2026-11-12) removed the *Display name* field and its help, and the
  connection's `display_name` is now its handle. `1.14.0.dev25` and the 1.13 line keep the field. The spec fills it
  only where it exists, and test 7 asserts its absence from `1.14.0.dev26`, both by served version. The tests that
  open *Reconnect* plant their rows through the API with an explicit display name, so their dialog titles do not
  move. That the handle becomes the display name of a row added in the UI is not asserted here.
- **The 10-minute client timeout**, which also shows the *expired* copy, is not waited out. The server-side
  `oauth-expired` reaches the same copy. langflow#15816 made it hold while the window is untracked too; that is
  the same timer, and it is not asserted either.
- **The Reconnect defect manual QA recorded on 1.13** is fixed upstream (langflow#15822), and could not reproduce
  against a planted credential anyway: the API spec doc explains why. Test 5 asserts the user-visible half: an
  abandoned Reconnect sends no write, and the row stays `Ready`.
- **Clearing `offline_access` before *Authorize*** (langflow#15780 keeps it optional) is not asserted. Asserting it
  needs a second Microsoft start, and this file's starts are budgeted (see below).
- **GitHub** (langflow#15957, new in `1.14.0.dev7`) is offered first, and its dialog is token-only: *Token*, *Token
  expiration*, *Allow background runs*, no scopes, and a *Setup guide* pointing to the bundle's README on GitHub.
  It is a new provider rather than a wizard fix, so it is not covered here.
- **The required-scope checks langflow#15952 added** (a registration's `required_scopes`, forced into the request
  and marked in the list, and *"The provider did not return a refresh token…"* for `oauth-refresh-token-missing`)
  are not asserted: the fake registrations declare no required scope, and the reason needs a real token exchange.

### Budgets, and why the helpers wait

Two limits bind this file, and both are shared with something else.
- **`oauth/start`**: 5/minute **per user**. This file runs as the superuser, because a UI under auto-login cannot
  switch users. It spends exactly 5 starts per run (on both sides of `1.14.0.dev10`: *Try again* recreates a row, not a start), which is why #15780 is asserted on test 5's one start instead
  of a test of its own.
- **The callback**: 5/minute **per client IP**, so shared with the API spec, which also exhausts it on purpose. This
  file spends 4.

A refused start or callback consumes nothing, so the helpers wait out the window and send the same request again,
and log that they did:
- a start the browser sends goes through a page route that resends it after a `429`;
- a popup whose callback answered `429` is reloaded once the window resets;
- the callback test 3 delivers after its popup is gone is resent once the window resets;
- a connection list or registration list read, by the page or by the test, is resent once the window resets (see
  below, the third limit).

Every wait the tests arm on something those helpers may hold (the start's answer, the next callback, a list read)
therefore allows the helpers' cap rather than the default 20–30 s, and so does every assertion on what the page shows
only after a fresh list read: the dialog's outcome alert, and test 6's row turning `Error` (a held read kept that row
on `Pending` for 23 s, measured on `1.14.0.dev14`). Measured on `1.14.0.dev14`: a second run started
within a minute of the first had its first start refused, and the test, waiting 20 s for the start's answer, went red
while the helper was still waiting the window out.

So a validation burst or a CI retry costs time, not a red test. Measured: a popup reloaded after the reset delivered
the callback, and the dialog showed the denial.

The helpers wait up to **two** windows. One was not enough. At `--workers=2`, test 3's callback waited for the
window the API spec had already started. When that window reset, the API spec's test 3 won the race and exhausted
the new window on purpose, so the callback was still refused after 80 s. A wait capped at one window turned that
into a red test.

A third limit follows from that wait. A waiting dialog reads the connection list every 2 s, and list reads are
limited to 60/minute per user. **The registration list counts against the same bucket**: both routes check the
`connections-read` scope (`api/v1/connections.py`), so every *Add* and every provider pick spends it too. Measured at `--workers=2`: two tests waiting out the callback window side by side
read the superuser's list into `429` four times. The tests stayed green, but each `429` is a `🚨 Backend Error` line
in the log. So the file runs its tests **in order, in one worker** (`describe.configure({ mode: "default" })`, which
does not skip the rest after a failure), and one waiting dialog stays at about half the read bucket.

Half is still too much when the wait is long, because the rest of the file reads the same bucket. Measured on
`1.14.0.dev7`: the dialog reads the list every 2.0 s, whether waiting for consent or untracked (22 reads in 40 s).
Two runs show what that costs:
- At `--workers=1`, test 3 waited out the callback window **with its dialog open** (48 s: the API spec had just
  exhausted it). Those reads plus tests 4–6 left test 7's *Add* dialog a `429` on its registration list: a red test
  and two `🚨 Backend Error` lines.
- At `--workers=2`, which is how CI runs, the two specs take the callback bucket from each other. One wait then read
  the list into a `429`.

So while a callback waits out a `429`, the dialog's list reads are **held**: `holdConnectionList` answers them with
one real snapshot, taken by the first read of the wait. Until the callback lands, the row cannot change, so the
snapshot is what the server would answer. Only a `200` is kept; anything else passes through. The hold is lifted
before the helper returns, so the read that teaches the dialog the outcome is a real one. It covers test 3's own
callback and every popup callback that `nextCallback` waits out (tests 4 and 6). This is the only other place the
file stands in for Langflow, after the two mocked registration lists.

From `1.14.0.dev10` the hold is not enough. Every row the dialog creates or discards (langflow#15952) refetches both
lists, and test 4 now creates and discards two. Measured on `1.14.0.dev14`, counting every read of the bucket: the
file sent **63 reads in its first 37 s** (test 3: 15, test 4: 23), so the 61st, test 7's registration list, was
refused, and the dialog could not offer consent. The same arithmetic explains the `429` on test 4's first attempt on
the QA VM (#2376): its reads came right after three attempts of test 3. Reordering cannot help, since every read lands
in the same window. So a refused read is resent once the window resets, like a refused start: `absorbReadRateLimit`
for the page (a context route, so the hold, added later, still wins while it holds; test 3's mocked registration list
fetches through `fetchAbsorbingReadLimit` itself), and the test's own list reads through the same wait. A run that
reaches the limit pays about half a minute, logged as `[oauth] GET … was rate-limited; answered after Ns of
waiting`, and stays green. The refused reads are no longer `🚨 Backend Error` lines, which is the point: they are this
file's own budget, not the product's.

---

## Tags *(required)*

`@stable` `@integrations` `@settings` `@ui-ux`.

`@stable` because every lane, scheduled ones included, carries the fake registrations (#2301). Without them,
*Continue* is disabled behind *"No OAuth registration is configured"* and test 4 **fails**, never skips (#1010).

---

## Step by step *(required)*

The page is `/settings/connections`, opened directly. Rows are found by their unique handle (`connection-row-<name>`,
`connection-menu-<name>`, `authorize-<name>`). Each test records the handles it creates, and `afterEach` deletes
whatever is left through the API. The fake provider is a context route on `https://accounts.google.com/**` (and,
for test 5, `https://login.microsoftonline.com/**`), with the outcome set per step. *Add connection* is opened only
once its registration list has arrived, and then the provider the test needs is picked, waiting again for **that**
provider's list: the list is fetched per provider, the first provider listed is preselected, and on `1.14.0.dev7` that
is GitHub, on `1.14.0.dev23` Confluence (see *Recorded, not asserted* for the race this avoids). From `1.14.0.dev23`
a provider is picked by opening the combobox and choosing the option named by its manifest `display_name`, and the
current one is read back from the combobox's text. The tests run in order in one worker (see *Budgets* above).

**Test 1 — the Add dialog lists every Google scope with the risk of each action that needs it, and offers Slack a
token instead of a sign-in.**
1. Read `GET /api/v1/integrations`. Open *Add connection*. The provider options are the manifest's providers, in
   its order, with the first one preselected: their ids on a native select, and their `display_name`s on the
   `1.14.0.dev23` combobox. Pick Google.
2. For every Google capability and every scope it requires, `connection-scope-<scope>` is checked, and its label
   carries the capability's `display_name` with its risk label. The registration select is absent (one registration
   per profile), and so is the callback help.
3. Pick Slack. *How to connect* offers *Sign in with Slack* (selected) and *Paste a token*. *Runs as* offers *The
   signed-in user* and *A bot*.
4. Pick *Paste a token*. `connection-token` appears, the scope list goes, and *Setup guide* points to
   `…/bundles-slack#two-executing-identities`. Close: nothing was created.

**Test 2 — with no OAuth registration, the dialog explains the operator setup and offers this instance's callback
URL.**
1. Mock the registration list to `{"registrations": []}`, open *Add connection* and pick Google.
2. `connection-setup-help` carries the no-registration alert and names `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`.
3. On HTTPS or loopback HTTP, `connection-callback-url` reads exactly
   `<page origin>/api/v1/connections/oauth/google/callback`. *Copy redirect URI* puts that string on the clipboard
   and says *"Redirect URI copied."*. On any other origin, the *callback unavailable* copy shows instead.
4. Fill a valid handle and display name: *Continue* stays disabled. Close: nothing was created.

**Test 3 — the registration picked is the one consent starts with, a lost sign-in window still learns the
provider's answer, and Cancel discards the half-made connection.**
1. Mock the registration list so Google lists a fake `e2e-google-alt` first and the real `e2e-google` second. Open
   *Add connection* and pick Google: *OAuth registration* offers both and preselects `e2e-google-alt`. Pick
   `e2e-google`.
2. The provider will not answer (stub page). Fill the form and press *Continue*. The `oauth/start` request names
   `registration_id: "e2e-google"` and the checked scopes, and answers `200`. The popup opens on
   `accounts.google.com`. The dialog waits.
3. Close the popup. The dialog reports, as its status, that it can no longer track the sign-in window, shows
   Google's *Setup guide*, and offers *Try again*. The row is still `pending`.
4. The provider's answer arrives anyway: the test delivers `error=access_denied` with the `state` of the
   authorization URL the popup opened, to the instance's real callback, through the browser context's own request
   client. That client carries the binding cookie `oauth/start` set, as the popup would have; it is path-scoped to
   the OAuth routes, so `context.cookies(<origin>)` does not list it. The callback answers `400` (the fixed failure
   page). The dialog shows the denial alert, and the untracked status and the setup help are gone. The list read the
   dialog polled carries the row as `error` / `oauth-denied` with no credential. From `1.14.0.dev10`, the dialog's
   `DELETE` of that row answers `204` and the list no longer carries it; before, the row still reads
   `error` / `oauth-denied`.
5. *Cancel*: the dialog closes. From `1.14.0.dev10` it sends no write; before, its `DELETE` of the row answers
   `204`. Either way the list no longer carries the handle.

**Test 4 — a denied consent, then an expired sign-in link, each say so, and the row records why.**
1. The provider will deny. Open *Add connection*, pick Google, fill the form and press *Continue*. The dialog shows
   *"The provider denied authorization."* as an alert. The list read the dialog polled carries the row as
   `status: error`, `status_reason: oauth-denied`, with no credential. From `1.14.0.dev10` the dialog's `DELETE` of
   that row answers `204` and the list no longer carries it; before, the API row still reads `error` / `oauth-denied`.
2. The provider will return neither `code` nor `error`. *Try again*: the same popup receives the new attempt, and
   the dialog shows *"The sign-in link expired. Start again to get a new one."*. The polled read carries the row as
   `oauth-expired`. From `1.14.0.dev10` that row was created by *Try again* (`POST` → `201`, an id other than the
   first one) and the dialog deletes it as well; before, it is the same row, and it still reads `oauth-expired`. Both
   attempts reached the provider.
3. *Cancel*: the dialog closes and the list no longer carries the handle. From `1.14.0.dev10` *Cancel* sends no
   write.

**Test 5 — an abandoned Reconnect leaves a working connection as it was, and asks Microsoft for the offline access
it never reports as granted.**
1. Plant a `ready` Microsoft row through the API, holding `Mail.Read` and `Mail.Send`.
2. *Reconnect* from its menu. The dialog is titled *"Reconnect <display name>"*. The two held scopes are checked and
   marked *Granted*. `offline_access` is checked and **not** marked *Granted*. Every other scope the registration
   offers is unchecked.
3. The provider will not answer. *Authorize*: `oauth/start` is sent with registration `e2e-microsoft` and exactly
   the held scopes plus `offline_access`. The popup opens on `login.microsoftonline.com`, and its URL's `scope`
   carries the same three. The dialog waits.
4. *Cancel*. The dialog and the popup close, and no non-`GET` connection request is sent.
5. The API row is unchanged: `ready`, `status_reason: null`, `has_credentials: true`, the same `granted_scopes` and
   `updated_at`. The page row still shows `Ready` with no reason line.

**Test 6 — a pending connection the provider refuses shows Error, with the reason, on the page.**
1. Plant a Google row with no credential (`pending`). Its row offers *Authorize* (`authorize-<name>`).
2. *Authorize* opens *"Reconnect <display name>"* with nothing checked, and its *Authorize* button is disabled.
   Check `openid` and `email`, and it is enabled.
3. The provider will deny. *Authorize*: `oauth/start` asks for exactly `openid` and `email` (Google adds nothing
   of its own, unlike Microsoft in test 5). The dialog shows the denial. *Cancel* sends no write, because a
   Reconnect never deletes its row.
4. The page row shows the badge `Error` with *"The provider denied authorization."* under it, and the API row
   reads `error` / `oauth-denied`.

**Test 7 — the Add dialog explains its fields, links each provider's setup guide, and marks the Microsoft scopes
only some inputs need.**
1. Read `GET /api/v1/integrations`. Open *Add connection* and pick Google.
2. Hover *Handle help* (`connection-handle-help`): the tooltip reads *"The identifier flows use to reference this
   connection, such as google/work."*. Hover *Display name help* (`connection-display-name-help`): *"A readable
   name shown in connection lists to help you recognize this account."*. From `1.14.0.dev26` the dialog has no
   *Display name* field, so neither `connection-display-name` nor its help is present (see *The display name*
   below).
3. For Google, Microsoft 365 and Slack in turn, *Setup guide* links that provider's page (the three URLs in the
   table above), and the Handle tooltip's example follows the provider.
4. On Microsoft 365, for every action and every scope it requires or needs only for some inputs, that scope's label
   names the action with its risk, and the *For some inputs* mark follows the action exactly when the scope is
   conditional for it. At least one conditional pair must exist, so the check cannot pass on a manifest that
   stopped declaring them. Close: nothing was created.

---

## Validation criterion *(required)*

All seven tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev14`, and once at
`--workers=2` together with the API spec. Tests 3 and 4 also pass once against `1.14.0.dev9`, the side before
langflow#15952. Every outcome is asserted twice: in the dialog's exact copy and on the row the server answered with,
through the API. After the run, `GET /api/v1/connections` carries no row with this spec's handles.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13+** instance at `PLAYWRIGHT_BASE_URL`, with auto-login (the superuser) and #2301's fake
  registrations (`LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`). Rate limiting on, at its defaults.
- Chromium with clipboard permissions (granted by `playwright.config.ts`).
- No provider tenant and no network egress: the provider's URL is answered by a context route.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx` — the steps, the
  popup handling, the polling and the copy chosen per `status_reason`, *Cancel* deleting an unfinished Add, and,
  from `1.14.0.dev10`, `discardFailedNewConnection` deleting a failed one and *Try again* recreating it.
- `src/frontend/src/controllers/API/queries/connections/use-connections.ts` — the registration list, fetched per
  provider (`useOAuthRegistrationsQuery`).
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AuthorizeStatus.tsx` — the waiting, untracked
  and failed states.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionSetupHelp.tsx` and
  `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/setup-guide.ts` — the setup help and the
  suggested redirect URI.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ProviderSelect.tsx` — the provider
  combobox from `1.14.0.dev23` (langflow#15951): `connection-provider`, options named by `display_name`.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/RegistrationSelect.tsx` — the picker, shown
  only with two or more registrations.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ScopeChecklist.tsx` and
  `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/scopes.ts` — the scope list, its risk labels,
  the *For some inputs* mark, and the scopes a Reconnect preselects (`offline_access` on Microsoft).
- `src/frontend/src/utils/connection-scopes.ts` — how a scope is matched to the actions that need it.
- `src/backend/base/langflow/api/v1/integrations.py` — the manifest's `required_scopes` and `conditional_scopes`.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/SlackTokenFields.tsx` — *How to connect* and
  the token field.
- `src/frontend/src/customization/components/custom-connection-authorization.ts` — how a registration is chosen and
  the popup opened.
- `src/backend/base/langflow/api/v1/connections.py` — `oauth/start`, the registration list and the callback.
