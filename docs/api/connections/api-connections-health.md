# Connections — health after creation, and what a pasted Slack token is checked against

**File:** `tests/tests-automations/regression/api/connections/api-connections-health.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev7`)

Owning issue: #2355 (Dedicated Integrations, Wave 11). It covers the health of a connection once it exists:
upstream fixes langflow#15763, #15766 and #15767 (all merged into `release-1.13.0` on 2026-10-15) and the suite's side
of #15775. The run-time error surface (#15773) and the canvas (#15753) are in
`docs/core-functionality/integrations/connector-run-errors.md`.

---

## What this test validates *(required)*

Every premise below was measured on `1.14.0.dev7`. Upstream code was read on `release-1.14.0`. The issue's own premises
were read from code and had not been measured. Two of them do not hold black-box: item 1's refresh path and item 5. The
sections below say what replaces each one.

### 1. A run refused for an expired credential marks the row, with no health check (langflow#15763)

Before #15763, a run refused for an expired credential reported the expiry, and the row kept reading `ready` /
`unknown` until someone pressed *Check credential*. The resolver now writes `expired` / `unhealthy` inside the run's own
locked transaction, then raises.

The issue describes the trigger as a provider rejecting an **OAuth refresh**. That path needs a credential carrying the
`oauth` block only a completed callback writes. `refresh_if_needed` returns early without it, the same wall #2307 hit
for langflow#15822. The persistence itself is reachable another way. A row planted with an `expires_at` in the past
is `ready` at create, and the resolver refuses it before any call leaves the instance. Measured:

| | Before the run | After one run (no `/health`) |
|---|---|---|
| `status` | `ready` | `expired` |
| `health` | `unknown` | `unhealthy` |
| `health_checked_at` | `null` | set |
| `updated_at` | as created | moved |
| `has_credentials` | `true` | `true` (the credential is kept) |

The run itself fails with `auth-expired`. In the v2 run stream (`stream_protocol: agui`), the `RUN_ERROR` event is
`{"code": "auth-expired", "message": "The provider credential is expired or was rejected.\n\nReconnect the integration and
try again."}`. The planted token appears nowhere in the response. A second run keeps the row `expired`.

**The control:** a failure that is not a credential rejection must leave the row alone, because #15763 keeps every
other failure retryable and the saved state intact. A row holding only `openid`, run against Drive *List Files*, fails
with `scope-missing`, and the row is **identical** afterwards: `ready`, `unknown`, the same `updated_at`.

### 2. A pasted Slack token is checked with Slack before it is saved (langflow#15767)

Before #15767, pasting `xoxb-123` created a `ready` Slack connection. Every non-app-level Slack token now goes to
Slack's `auth.test` from the **server** before anything is stored. There is no local format rule, so a string that does
not look like a Slack token at all also reaches Slack. Measured, `POST /api/v1/connections`, provider `slack`:

| Token | Answer |
|---|---|
| `xoxb-…` that Slack does not know | `422 {"detail": "Slack rejected this token. Paste a valid token and try again."}` |
| a string that is not Slack-shaped | the same `422` |
| `xapp-…` with identity `user_delegated` | `422 "A Slack app-level token acts as the app, so its identity must be 'bot'."` |
| `xapp-…` with a `refresh_token` | `422 "Slack app-level tokens neither expire nor refresh; remove refresh_token and expires_at."` |
| `xoxb-…` claiming the `connections:write` scope | `422 "The connections:write scope belongs to Slack app-level tokens (xapp-) only."` |

None of the five leaves a row. The last three are refused **locally**, before Slack is asked.

**Why the first two depend on egress, and why that is accepted.** `auth.test` is a fixed URL called by the Langflow
process, so a Playwright route cannot stand in for Slack (the issue's suggested mock). Calling it with a token Slack
never issued involves no tenant and no account. Without egress, the server answers `422 "Slack could not check this
token. Try again."` instead. Every lane reaches the public provider APIs today, and the specs that run models depend
on the same access. So the test asserts the **rejection** wording exactly, and an instance without egress fails it,
naming the other message. Either way the token is refused.

**Checking an app-level token does not claim health it cannot know.** #15767 also stopped *Check credential* from
reporting a pasted token `healthy` without asking Slack. An `xapp-` token is never sent to `auth.test`: it is confined
to the Socket Mode listener and checked when a listener opens its socket. Measured: `POST /test` and `POST /health` on
an `xapp-` row both answer `200` with `health: "unknown"` and the row still `ready`. Neither claims `healthy`.

### 3. Deleting a row whose provider revocation fails removes it whole (langflow#15766)

`DELETE` revokes before it deletes (`ConnectionService.delete` calls `revoke`). For an `xapp-` row the revocation goes to
Slack's `auth.revoke`, which refuses it. `api-connections-surface-details.spec.ts` asserts that outcome on `/revoke`
(`provider_revocation: "failed"`), and the toast saying so. What it does not assert is the issue's last clause: a failed
revocation must not leave the row half-deleted. Measured: `DELETE` answers `204`, the list no longer carries the row,
and a second `DELETE` answers `404 "Connection not found"`.

The outcome does not depend on egress: Slack refusing the token and the call never leaving the instance raise the same
error (#2305's measurement).

### 4. The suite's flow-error gate never takes an integration error for a provider outage (langflow#15775)

#15775 split a Google **transport** failure (`network-error`, with the reason: timeout, DNS, refused, unreachable, TLS
or connection) from a provider **outage** (`provider-unavailable`). Both are raised inside the Langflow process by the
Google client. A Playwright route aborts browser requests only, so the issue's "route abort, then a 5xx" cannot reach
them. Provoking them needs an instance without egress to `googleapis.com`, which is a lane variant and not a spec.

The half that belongs to this suite is reachable as a unit test. `tests/fixtures/flow-error-policy.ts` downgrades a
run-stream error that matches `PROVIDER_OUTAGE_PATTERNS` to *unevaluated*, so a drained account cannot strip
`@stable`. The issue asks that this list never swallow a genuine integration error. `flow-error-policy.test.ts` feeds
`classifyFlowError()` a `RUN_ERROR` per integration error code, worded the way the AG-UI translator composes it (the
message, a blank line, the hint). The verdicts split three ways, and only the first is what the issue asks for:

- **A failure, never an outage:** `connection-unresolved`, `auth-expired`, `scope-missing`, `policy-blocked`, and
  `network-error` with each of its six reasons. These say something about the instance, the connection or the
  policy. `network-error` is this server's own egress, which is exactly the difference #15775 draws.
- **Downgraded, and pinned as such:** `rate-limited` (*"The provider rate limit was reached."*) matches the existing
  `rate-limited` pattern. That is the gate's documented policy for a provider's rate limit, which is account state,
  not a Langflow defect. The test asserts it so a reader of § 4 cannot take the first list as "every code".
- **Not decided here:** `provider-unavailable` (*"The provider is temporarily unavailable."*) matches nothing today,
  so it fails a test. Whether a provider's own outage should be unevaluated instead is a policy question for the gate,
  so it is recorded, not pinned.

Two of these messages were measured live (`connection-unresolved`, `auth-expired`). The rest are composed from
`lfx/integrations/errors.py` and `agui_translator.py`, and the test says which.

### Recorded, not asserted

- **A planted Google token that Google rejects leaves the row `ready`.** Measured: a fresh token Google never issued
  fails the run with `auth-expired` (a real `401` from `googleapis.com`), and the row stays `ready` / `unknown`, run
  after run. #15763 persists a rejection only on the OAuth refresh path. #15767 does it only for a pasted **Slack**
  token, matched by digest. A Google token stored through `ConnectionCreate.credentials` gets neither: no refresh, and
  no digest check. Whether that is a gap is upstream's call. It is recorded here, not asserted.
- **#15767's run-time expiry of a pasted Slack token** needs a token Slack accepts at create, i.e. a real workspace.
- **#15766's confirmed revocation** (`revoked`) needs the same.
- **The page's three revocation toasts**: `not_applicable` is asserted in `connections-row-actions.spec.ts`, and
  `failed` in `api-connections-surface-details.spec.ts`.

---

## Tags *(required)*

`@stable` `@api` `@integrations`.

`@stable` because nothing here needs a provider key or a tenant. Only the network has to reach `slack.com`, which
every lane does (see § 2).

---

## Step by step *(required)*

The file owns its rows through a throwaway user, created once per worker (`connections-owner.ts`, #2295). That user's
write, `/test` and `/health` buckets are its own. Every connection and flow a test creates is deleted after it, and
deleting the user takes anything left with it.

**Test 1 — a run refused for an expired credential marks the connection expired and unhealthy, with no health check,
while a run refused for a missing scope leaves its connection as it was.**
1. Plant a Google row holding `drive.file` with a sentinel token and `expires_at: 2020-01-01T00:00:00Z`. It reads
   `ready`, `unknown`, `health_checked_at: null`.
2. Plant a second Google row holding only `openid`, with an ordinary sentinel token.
3. Save one Drive *List Files* flow per row, each bound to its row's handle.
4. Run the first through `POST /api/v2/workflows` (`mode: stream`, `stream_protocol: agui`). The stream carries one
   `RUN_ERROR`, `code: auth-expired`, whose message is the expiry message, a blank line and the hint. Neither sentinel
   appears in the response.
5. Read the list. The expired row now reads `expired`, `unhealthy`, `health_checked_at` set, `updated_at` moved, and
   `has_credentials: true`.
6. Run the second flow. Its `RUN_ERROR` is `scope-missing`. Read the list: that row is exactly as created.

**Test 2 — a pasted Slack token is checked with Slack before it is saved, and an app-level token breaking its rules
is refused locally, each with its reason.**
1. Create five Slack rows, one per token in the § 2 table. Each answers `422` with exactly that row's `detail`.
2. Read the list. None of the five names is in it.

**Test 3 — checking an app-level token does not report it healthy.**
1. Plant an `xapp-` row (identity `bot`). It reads `ready`, `unknown`.
2. `POST /test`, then `POST /health`. Both answer `200`, and neither returns `health: "healthy"`. Both return `unknown`.
3. Read the list: `ready`, `unknown`.

**Test 4 — deleting a connection whose provider revocation fails removes it whole.**
1. Plant an `xapp-` row.
2. `DELETE` it: `204`.
3. The list no longer carries it, and a second `DELETE` answers `404 "Connection not found"`.

**Unit — `tests/fixtures/flow-error-policy.test.ts`: a genuine integration error in the run stream is a failure,
never a provider outage, and a provider's rate limit is the one that is downgraded.**
- For each code in § 4's first list, `classifyFlowError()` on a `RUN_ERROR` carrying its translator-composed message
  returns `failed: true`, and `providerOutage()` returns `null`.
- For `rate-limited`, it returns `failed: false` with `providerOutage: "rate-limited"`.

---

## Validation criterion *(required)*

All four tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev7`, and the unit test
passes in `npm run test:units`. Every assertion is on an exact status, `detail`, `code` or field value, and each
state change sits next to a control that must not change. No connection, flow or throwaway user is left after the run.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login, rate limiting at its defaults.
- Outbound network from the Langflow instance to `slack.com` (test 2's first two rows; see § 2).
- No provider key, no OAuth registration, no tenant.
- `src/backend/base/langflow/services/connection/service.py` — the run-time expiry in `_resolve`, the scope check, and
  `delete` calling `revoke`.
- `src/backend/base/langflow/services/connection/slack_credentials.py` — `validate_manual_credential`, the local
  app-level rules, and `check_slack_web_token`.
- `src/backend/base/langflow/api/v1/connections.py` — create, `/test`, `/health`, delete.
- `src/lfx/src/lfx/integrations/errors.py` — every integration error's code, message and hint.
- `src/lfx/src/lfx/workflow/agui_translator.py` — how the `RUN_ERROR` message and code are composed.
- `src/bundles/google/src/lfx_google/components/google/_workspace_client.py` — the Google client's network and outage
  classification (#15775).
