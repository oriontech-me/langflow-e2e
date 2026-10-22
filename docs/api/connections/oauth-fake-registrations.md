# Fake OAuth registrations on every lane

**Last validated:** Langflow 1.14.0.dev2 (`langflowai/langflow-nightly:latest`, 2026-10-22).

Owning issue: #2301 (Dedicated Integrations, batch 2). Consumed by #2307 (the Add/Reconnect wizard and the OAuth
callback).

---

## What this test validates *(required)*

This document specifies **infrastructure, not a test**. It records a lane configuration and the decision behind
it, and ships no `.spec.ts`. The specs that rely on it are #2307's. `docs/serving/end-user-identity-lane.md` is the
precedent for a `docs/` artifact that specifies a mechanism.

### The gap

The product ships no OAuth registration. `GET /api/v1/connections/oauth/registrations` answers
`{"registrations": []}`, so:
- the Add/Reconnect wizard stops before consent at *"No OAuth registration is configured for this provider"*;
- `POST /api/v1/connections/{id}/oauth/start`, the browser handoff and the callback have nothing to start from.

The surface was therefore untested. QA-CHECKLIST § 24.4 deferred the wizard for exactly this reason.

Registrations come only from operator configuration: `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`, a JSON object keyed by
registration id, instance-global and read at startup.

### What a fake registration reaches

Measured on `1.14.0.dev2` with the four registrations in `scripts/lib/fake-oauth-registrations.json`, and no
provider tenant:

| Call | Result |
|---|---|
| `GET /oauth/registrations` | Lists all four (`e2e-google`, `e2e-microsoft`, `e2e-slack-user`, `e2e-slack-bot`) with their scope ceilings, `Cache-Control: no-store`. |
| `POST /{id}/oauth/start` | `200` with an `authorization_url` on each provider's own host: `accounts.google.com`, `login.microsoftonline.com/<tenant>`, `slack.com/oauth/v2/authorize` (`user_scope=` for the user profile, `scope=` for the bot). It sets the `lf_connection_oauth_*` binding cookie (HttpOnly, `Max-Age=600`, path `/api/v1/connections/oauth`) and the three response headers `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. **No provider is called.** |
| `GET /oauth/google/callback?state=…&error=access_denied` with the cookie | `400` HTML *"OAuth authorization failed. Return to connections and start again."* with the same three headers. The row moves to `status: error`, `status_reason: oauth-denied`. |

So everything short of a real consent is reachable. The last row also makes `status: error` reachable, which
`api-connections-secret-boundary.md` had recorded as out of reach. Covering it belongs to #2307.

### The four registrations

One per provider and Slack profile, all confidential with a visibly fake client id and secret. Each scope ceiling
is the union of the scopes the manifest's capabilities of that provider and identity declare. Slack's
`connections:write` is left out: it is an app-level token scope, not an OAuth one.

The redirect is `http://localhost/api/v1/connections/oauth/<provider>/callback`: loopback HTTP at the exact path,
which the server accepts, and **no port**. No provider will ever redirect to it, because none accepts the fake
client. Leaving the port out means one value serves every lane, whatever port its instance listens on. A spec must
therefore assert the redirect's **path**, never its host.

### The decision: every lane, no selector

Two shapes were weighed.

| | Fake registrations on every lane's own instance **(chosen)** | A second container plus a lane tag |
|---|---|---|
| Extra container | none | one per run (~1.5 GiB; the QA VM is at ~3 Langflow instances before the kernel SIGKILLs one) |
| Runs in the scheduled daily | yes, at no cost | only if the daily pays for the second container |
| `@stable` for the OAuth specs | possible | no (#1010: no scheduled lane) |
| Lane selector | none | a new tag, excluded from normal lanes |
| What the default instance no longer shows | the *"No OAuth registration"* empty state | nothing |

The lost state is a UI copy the page renders from an empty list, so a spec that needs it can mock
`GET /oauth/registrations` to `{"registrations": []}`. Running the OAuth specs nowhere scheduled has no such
workaround.

The precedent is `LANGFLOW_A2A_ENABLED` (#1240): another product default that hides a whole surface, set on every
lane and pinned there by a test.

**Before deciding, every spec that could depend on the old state was run against an instance with the
registrations** (`1.14.0.dev2`, `--retries=0`):
- `api/connections/` with `core-functionality/integrations/` at `--workers=2`: 55/55;
- `governance/integration-policy-enforcement.spec.ts` in the destructive lane: 7/7.

No spec opens the wizard, and the ones that call `oauth/start` name a random registration id, which still answers
`400 "OAuth registration ID is not configured."`.

### Fail, not skip

The specs that use the registrations must **fail** when the instance has none, never skip. A lane that loses the
variable then goes red, instead of passing while testing nothing (#1010).

To reproduce the product default by hand, start an instance with `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS='{}'`.
Every starter takes the override.

---

## Tags *(required)*

None. This document ships no spec. The consuming specs carry `@integrations`, with `@api` or `@ui-ux`.

---

## Step by step *(required)*

Where the value lives, and what keeps the copies equal:

1. **Canonical:** `scripts/lib/fake-oauth-registrations.json`, readable and reviewed.
2. **Workflows:** `pr-validation.yml`, `manual.yml` and `daily-stable.yml` set it on the Langflow **service**, beside
   the A2A flag. A service starts before any checkout, so it cannot read the file; each carries the compact JSON.
3. **Starters:** `start-langflow-docker.sh`, `start-langflow-pip.sh`, `start-langflow-source.sh` and
   `start-langflow-serving-identity.sh` carry it inlined as `DEFAULT_OAUTH_REGISTRATIONS='…'` and pass
   `"${LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS:-$DEFAULT_OAUTH_REGISTRATIONS}"`. It is inlined rather than read
   from the file, because the VM lane pipes a starter to `bash -s` on the target, where no file of this repo
   exists. `start-langflow-enterprise.sh` is left out: it does not mirror that environment block.
4. **The QA VM's daily** gets it through `start-langflow-source.sh`. `scripts/lib/vm-env-parity.mjs` classifies it
   as starter-carried and compares the starter's literal with the daily's value. The reader resolves
   `${NAME:-$DEFAULT_X}` to the single `DEFAULT_X='…'` assignment, the shape `LANGFLOW_SQLITE_PRAGMAS` already takes
   in `run-e2e.sh`.

---

## Validation criterion *(required)*

- `scripts/fake-oauth-registrations.test.mjs` checks four things:
  - the four entries and the server's validation rules this file could break. A refused registration is
    **omitted** from the list, not reported, so a broken entry would read as a shorter list;
  - every client id and secret is visibly fake, because the repository is public;
  - every one of the seven copies equals `JSON.stringify` of the canonical file byte for byte;
  - no starter reads the file.
- `start-langflow-docker.test.mjs` and `start-langflow-source.test.mjs` execute the starters and parse what reaches
  docker and the server: the canonical JSON by default, `{}` when overridden.
- `check-vm-env-parity` passes with 12 of 12 variables carried.

---

## External dependencies *(required)*

- A Langflow **1.13+** instance. `oauth/start`, the registration list and the callback shipped with Dedicated
  Integrations.
- No provider tenant, no network egress. `oauth/start` builds the authorization URL locally, and a denied callback
  makes no token exchange.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `OAuthRegistration` and its validation rules,
  and `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`.
- `src/backend/base/langflow/api/v1/connections.py` — the registration list, `oauth/start`, the callback and its
  headers.
