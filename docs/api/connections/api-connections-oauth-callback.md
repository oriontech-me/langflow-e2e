# Connections — the OAuth callback's controls

**File:** `tests/tests-automations/regression/api/connections/api-connections-oauth-callback.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev2`)

Owning issue: #2307 (Dedicated Integrations, batch 2). It depends on #2301, which gives every lane four fake OAuth
registrations (`docs/api/connections/oauth-fake-registrations.md`). Its UI half is
`docs/core-functionality/integrations/connection-oauth-wizard.md`.

---

## What this test validates *(required)*

A provider ends consent by sending the browser to `GET /api/v1/connections/oauth/{provider}/callback`. That route
takes no login: the one-shot `state` and the browser-binding cookie that `oauth/start` set are its only
authentication. This file drives the callback the way a browser would and asserts each control on the status, the
body, the headers **and the row it leaves behind**. Batch 1 could not: the product ships no registration, so
nothing could start an authorization (#1967 recorded `status: error` as unreachable).

No provider is called. `oauth/start` builds the authorization URL locally, and every callback here fails before the
token exchange. What reaches the exchange (a successful consent, a refresh) needs a real tenant and stays out of
scope.

Measured on `1.14.0.dev2`, with the four registrations loaded:

### Every failure answers the same page

Every refused callback answers `400` with `text/html` and the same body, *"OAuth authorization failed. Return to
connections and start again."*, whatever the cause. It also carries the three headers `oauth/start` sets:
`Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. Because the body does not tell the causes
apart, every case below is told apart by **what the row reads afterwards**, never by the response.

### What a callback does to the row

| Callback | Row afterwards |
|---|---|
| The right `state`, **no** binding cookie | Unchanged: same status, `status_reason`, `updated_at`. The `state` is **not** consumed, so the same `state` with its cookie still completes afterwards. |
| A `state` an older `oauth/start` minted, after a newer one on the same row | Unchanged. The newer start replaced the stored state digest. |
| The right `state` and cookie, `error=access_denied` | `status_reason: oauth-denied`. A row with a saved credential stays `ready` and keeps it (`has_credentials: true`). A row without one turns `status: error`. |
| The right `state` and cookie, neither `code` nor `error` | `status_reason: oauth-expired`, and `status: error` on a row without a credential. |
| The right `state` and cookie on **another provider's** callback path, with a `code` | `status_reason: oauth-failed`, `status: error`. A Google `state` cannot complete on Slack's path, and the attempt still consumes it. |
| A `state` already used | Unchanged. Consumption is one-shot, including when the first use failed. |

The three reasons are all three `oauth-*` values of `ConnectionStatusReason`. A failed attempt writes its reason
whether or not the row has a credential, and turns the status to `error` only when it has none
(`_record_failed_authorization`). So `ready` with `oauth-denied` is a real state, and the next successful
`POST …/health` clears the reason (measured: `status_reason: null`, `health: healthy`).

### Reconnect cannot destroy a saved credential here

Manual QA on 1.13 recorded that an abandoned Reconnect broke a working connection. Upstream fixed it in
langflow#15822 (2026-10-16, in `release-1.13.0`, `release-1.13.1` and `release-1.14.0`, and in the running image).
The defect could not have reproduced against this suite's credentials anyway. It lived in
`broker.refresh_if_needed`, which compared a stored credential's `oauth.generation` with the newest attempt's. Only
a credential a successful callback stored carries that `oauth` block. A planted one (`ConnectionCreate.credentials`)
takes the function's early return. So no `test.fail()` is needed. Test 2 asserts the black-box half of the contract
instead: neither a superseding start nor a denied callback touches the saved credential, and the next health check
still reads it.

### The two OAuth routes a browser reaches answer an HTML `429`

The callback and the Desktop browser handoff (`GET …/oauth/{provider}/browser`) are limited **per client IP**,
5/minute each, in **two separate buckets**. The sixth call in the window answers `429` with an HTML page (title and
heading *"Too many OAuth attempts"*), `Retry-After: 60` and the same three headers. That page comes from
`main.py`'s handler, which picks `oauth_rate_limit_response` for exactly those two endpoints. Every other route
answers the JSON `{"detail": "Too many requests. Please try again later.", "retry_after": "60"}`, and
`oauth/start` is the contrast here: it is limited **per user**, 5/minute.

The window is fixed and opens on its first hit (a measured reset 60 s after it; refused hits do not extend it). The
limit check is the first line of the callback, before the `state` is read. So a `429` consumes nothing, and the same
callback answers normally once the window resets.

### The callback budget is the whole lane's

Every spec in a lane reaches the instance from one client IP, so the 5 callbacks a minute are shared by this file
and the wizard spec, which runs callbacks in its popup. This file spends 5 and then exhausts the bucket on purpose
(test 3). The cost is handled rather than avoided: the callback helper waits out a `429` and sends the same request
again, which is safe for the reason above. Its log line names the wait. The one test that wants the `429` reads it
raw.

### Recorded, not asserted

- **The Google authorization URL** is asserted in test 1 (host, path, `client_id`, the redirect's **path** and the
  requested scopes, a 43-character `state`, PKCE `S256`). The other three registrations' URLs were measured in #2301
  and are not repeated: one `oauth/start` per provider would spend the owner's start bucket on shapes #2301's
  document already records.
- **The redirect's host.** It is the registration's `http://localhost/…`, without the lane's port, by #2301's
  design. A spec asserting it would assert the fixture.
- **A forged binding cookie** (the right name, a wrong value of the right length) also answers `400` and consumes
  nothing: measured, the real cookie afterwards still recorded `oauth-denied`. The server refuses it one step later
  than a missing cookie (the `UPDATE` matches no binding, where a missing cookie fails the length check), with the
  same outcome, so it is not a separate test.
- **The backend logs an `OAuthError` traceback** for every refused callback. That is upstream's logging, not a
  `🚨 Backend Error`: this file has no `page`, so the fixture's HTTP monitor is not attached.

---

## Tags *(required)*

`@stable` `@api` `@integrations`.

`@stable` because #2301 put the registrations on every lane, scheduled ones included. Without them `oauth/start`
answers `400 "OAuth registration ID is not configured."` and the first test **fails**, never skips (#1010).

---

## Step by step *(required)*

**`describe.configure({ mode: "serial" })`.** Test 3 exhausts the callback bucket and the owner's start bucket, so it
must run after the others, in the same worker.

**Setup.** `beforeAll` creates a throwaway owner (`createConnectionsOwner`, #2295), so the starts and `/health`
spend that user's buckets, never the superuser's that the wizard spec uses. Each test deletes the rows it created,
and `afterAll` disposes the owner.

The callback helper always sends an **explicit** `Cookie` header, the captured `name=value` or an empty one. The test's
`request` keeps a cookie jar: it stores the binding cookie from `oauth/start` and drops it when the callback answers
with `Max-Age=0`. Left to the jar, a "no cookie" call could carry the cookie and a replay could not. An explicit
header overrides the jar (measured: an explicit empty header left the `state` unconsumed).

**Test 1 — a callback without the binding cookie is refused and leaves the state usable; the state cannot complete
on another provider's path, nor be used twice.**
1. The owner creates a Google row with no credential (`pending`).
2. `oauth/start` with `e2e-google` and `[openid, email]` → `200`. The authorization URL is Google's, built locally:
   `https://accounts.google.com/o/oauth2/v2/auth`, the registration's `client_id`, a redirect whose path is
   `/api/v1/connections/oauth/google/callback`, `scope` equal to the two requested, a 43-character `state`,
   `code_challenge_method=S256`. The response sets one `lf_connection_oauth_<24 hex>` cookie: `HttpOnly`,
   `Max-Age=600`, `Path=/api/v1/connections/oauth`, `SameSite=lax`, no `Secure` (the redirect is HTTP). It carries the
   three headers.
3. The callback with that `state`, `error=access_denied` and **no** cookie → `400`, the fixed body and the three
   headers. The row is unchanged.
4. The same `state` and its cookie on **Slack's** callback path, with a `code` → `400`. The row reads
   `status: error`, `status_reason: oauth-failed`. A reason is written only when a callback consumes the `state`, so
   this step is also the proof that step 3 left it usable.
5. The same `state` and cookie again, on Google's path → `400`. The row is unchanged since step 4.

**Test 2 — a newer start supersedes the older one, and a denied consent keeps the saved credential.**
1. The owner creates a Google row with a planted credential (`ready`, `has_credentials: true`).
2. Two `oauth/start` calls, A then B, both `200`, with different `state` values and cookie names.
3. The callback with A's `state` and cookie and `error=access_denied` → `400`. The row is unchanged.
4. The callback with B's `state` and cookie and `error=access_denied` → `400`. The row reads `status: ready`,
   `status_reason: oauth-denied`, `has_credentials: true`, `granted_scopes` unchanged.
5. `POST …/health` → `200`, `health: healthy`, `status_reason: null`. The saved credential still resolves.

**Test 3 — the OAuth routes a browser reaches answer an HTML 429; `oauth/start` answers the JSON one.**
1. The callback with a malformed `state`, repeated until a `429`. Every response before it is the `400` page, and the
   `429` arrives within 6 calls (fewer when tests 1 and 2 used the same window). The `429` is `text/html` with
   *"Too many OAuth attempts"* as title and heading, `Retry-After: 60` and the three headers.
2. The same against the browser handoff (`…/oauth/google/browser?state=…&handoff=…`), whose `400` is the same page.
3. `oauth/start` on a row of the owner's, repeated until a `429`. That `429` is `application/json`
   `{"detail": "Too many requests. Please try again later.", "retry_after": "60"}`, and the bodies before it are not
   `429`s.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev2`, and once at
`--workers=2` together with the wizard spec. On every run:
- each callback's outcome is read from the row, never inferred from the response;
- no connection or throwaway user is left behind.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13+** instance at `PLAYWRIGHT_BASE_URL` started with #2301's fake registrations
  (`LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`, set by every starter and every lane). Rate limiting on, at its
  defaults.
- Auto-login (the superuser) with user self-registration through `POST /api/v1/users/`, for the throwaway owner.
- No provider tenant and no network egress.
- `src/backend/base/langflow/api/v1/connections.py` — `oauth/start`, the callback, the browser handoff, the shared
  failure page and its three headers.
- `src/backend/base/langflow/services/connection/oauth/broker.py` — state minting and supersession, one-shot
  consumption, the three `oauth-*` reasons and `_record_failed_authorization`.
- `src/backend/base/langflow/services/connection/oauth/config.py` — the registrations and their validation.
- `src/backend/base/langflow/main.py` — the `RateLimitExceeded` handler that answers the two browser routes in HTML.
- `src/backend/base/langflow/services/rate_limit/service.py` — the per-IP and per-user buckets.
