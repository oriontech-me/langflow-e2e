# Triggers — inbound webhook ingress: signing, the uniform 404, events, test and replay

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-webhook-ingress.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev0`)

Owning issue: #2308 (Dedicated Integrations, batch 2). The issue names #2303 as the source of a
trigger helper; #2303 is still open, so this file makes its own trigger calls, the way #2309 did.
It reuses the throwaway owner from #2295 (`tests/helpers/integrations/connections-owner.ts`) and the
catalog flow builder (`tests/helpers/flows/build-catalog-flow.ts`). The trigger lifecycle itself
(CRUD, the state machine, flow-save reconciliation) is #2303's; who a trigger run executes as is
#2309's (`docs/api/triggers/api-triggers-run-identity.md`).

---

## What this test validates *(required)*

`POST /api/v1/triggers/ingress/{provider}/{public_id}` is the one route in Langflow that accepts a
write with no session, no API key and no user. A delivery is authenticated by a signature over its
body alone, so every way the route can refuse is a possible oracle. The contract under test:

1. **The signing secret is shown once.** `POST /triggers/{id}/signing-secret` mints the ingress
   address and the secret, and is the only response that ever carries the secret.
   `GET /triggers/{id}/ingress` answers the address and `has_signing_secret`, never the secret.
   Rotating it invalidates the old secret on the next delivery, with no grace window, and keeps the
   address.
2. **A valid delivery is accepted exactly once.** `X-Langflow-Signature: v1=<hex HMAC-SHA256 of
   "v1:{timestamp}:{body}">` plus `X-Langflow-Timestamp` within ±300 s answers `202` with an empty
   body and appends one ledger row. The same delivery again answers `202` and appends nothing.
3. **Every refusal is the same `404`.** Status, body bytes and response headers are identical
   (apart from `date`) whatever the cause, so a caller cannot learn whether an id exists, how close a
   signature was, or whether a trigger is paused.
4. **The ledger shows the run, and the flow gets the payload.** The row moves to `completed` with a
   `job_id`, and the flow's trigger node receives the delivery through `event_payload`.
5. **`/test`** appends a synthetic event that goes through the real dispatcher, and is refused with
   `409` on a dead trigger.
6. **`/replay`** appends a **new** row linked to the original, which runs the original payload again.
7. **A failing flow** is recorded as failed in the ledger with no retry. The trigger's own health
   while that happens is a known defect, tracked by #2328 (see *Known defect*).

### Measured on `1.14.0.dev0`

- **Flow save creates the trigger.** A flow with an `InboundWebhookTrigger` node, created through
  `POST /api/v1/flows/`, gets one `inbound_webhook` row in state `pending`, with `node_id` set to the
  node's id, `config: {share_session: false}`, `max_attempts: 5`, `concurrency_limit: 1`. That row is
  what feeds `event_payload`: the dispatcher sends the event as a tweak keyed by `trigger.node_id`,
  so a trigger created through the API with no `node_id` runs the flow with an empty event.
- **Secret.** Before the first mint, `GET …/ingress` answers `200` with `public_id: null`,
  `ingress_url: null`, `has_signing_secret: false`. The mint answers exactly the keys `trigger_id`,
  `public_id`, `ingress_url`, `has_signing_secret` and `signing_secret` (43 characters). The URL is
  `<origin>/api/v1/triggers/ingress/webhook/<public_id>`, with a 32-character `public_id`. Afterwards,
  `GET …/ingress` answers the same address with `has_signing_secret: true` and no `signing_secret`
  key. A second mint returns the same `public_id` and a different secret, and the old secret then
  answers the uniform `404` while the new one answers `202`. On a `schedule` trigger both routes
  answer `409` `"Only inbound webhook triggers have an owner-managed signing secret."`.
- **Delivery.** `202`, `content-length: 0`, no `content-type`. The row's `dedupe_key` is
  `ingress:webhook:<32 hex>`, a digest of the timestamp plus the body, and its `payload` is
  `{provider: "webhook", delivery: <the body>}`. The identical request again answers `202`, and the
  trigger still has exactly one row. The row is `completed` ~10 s after the delivery, with `job_id`
  and `session_id` (`trigger:<trigger_id>:<event_id>`).
- **`event_payload`.** The trigger node's `Event` output is the dispatcher's envelope:
  `{trigger_id, event_id, kind: "inbound_webhook", provider: null, dedupe_key, attempt: 0, payload}`.
  A Chat Output wired to it writes that envelope to the run's session as a fenced JSON block, read
  from `GET /api/v1/monitor/messages?flow_id=…`. Note `provider` is the **trigger's** column (`null`
  for a webhook), while `payload.provider` is the ingress's `"webhook"`.
- **The uniform 404.** Every probe below answered `404`, body exactly `{"detail":"Not found"}`
  (22 bytes), headers `content-type: application/json`, `content-length: 22`, `server: uvicorn`,
  `date`, and no others: an unknown `public_id`, a wrong signature, a timestamp 400 s old, one 400 s
  in the future, no signature headers, a body that is not JSON, a paused trigger, a body of
  1 MiB + 1 byte, a provider segment of `microsoft` or `google` (real providers, wrong kind), and of
  `slack` and `nosuch` (not ingress providers). No probe appended a row. A body of exactly 1 MiB
  (1 048 576 bytes) answered `202`: the route refuses only a length *over* the limit.
- **One shape check is not a 404, and is not an oracle.** A `public_id` shorter than 8 characters
  (or outside `[A-Za-z0-9_-]`) answers FastAPI's `422` path validation. It depends only on the shape
  of the string, never on whether a trigger exists, so it reveals nothing. It is recorded here and
  not asserted.
- **`/test`.** `202`, a `pending` row with `dedupe_key: "test:<uuid>"` and `payload` equal to the
  request's `payload` plus `test: true` (`{"test": true}` when the body is `{}`). It is dispatched
  and `completed` like any delivery, and the flow receives it with that payload. A trigger created
  with `state: "dead"` answers `409` `"Trigger is dead and cannot be tested."`.
- **`/replay`.** `202`, a new `pending` row with `replay_of_event_id` set to the original's id,
  `dedupe_key: "replay:<original id>:<uuid>"` and the original's `payload`. The original row is left
  as it was. The replay is dispatched and `completed`, and the flow receives the original delivery.
  An unknown `event_id` and the event of another trigger both answer `404` `"Event not found"`.
- **A flow that fails on every run.** Three signed deliveries to a trigger with `max_attempts: 2`
  produced three rows, each `failed` with `error: "job_failed"`, `attempt: 0` and a `job_id`. None
  was retried and none reached `dead`. The trigger read `active` with `last_error: null`, and only
  `last_fired_at` moved.

### Premises from the issue that did not hold

- *"A flow that fails on every event reaches `dead` after `max_attempts`."* It does not. A job that
  fails is terminal for its event (`reconcile_dispatched` → `failed`, `job_failed`). `max_attempts`
  counts **submit** attempts, and an event reaches `dead` only when submitting the job fails or its
  lease expires (`_schedule_retry`). A black-box test cannot provoke either.
- *"A trigger reaches `dead`."* Nothing writes `TriggerState.DEAD`. The only way to get a dead
  trigger is to create it with `state: "dead"`, which `TriggerCreate` accepts. That is how test 5
  reaches the `409`.
- *"The secret must be wrong in every probe that is not testing the secret."* Inverted on purpose,
  with the owner's agreement. A wrong secret would make every probe refuse for the secret's sake, so
  a stale timestamp, a paused trigger or an oversized body would be measured as nothing. Each probe
  carries exactly **one** defect and is otherwise signed with the right secret, and each has a
  positive control: the same request without the defect answers `202`. The provider-segment probes
  are the exception, and say less than they look like they do: see test 3.

### Known defect — a trigger whose every run fails reads healthy

TRG-2 recorded it, and it reproduces: a trigger whose flow fails on every delivery stays `active`
with `last_error: null`. The only trace of the failures is on the events. Nothing an owner reads on
the trigger (the list, `GET /triggers/{id}`) says it has not completed a run since it was armed.
The upstream ticket and its `test.fail()` pin are owned by #2328, not by this file's issue. Here,
test 7 asserts only the ledger half, which is correct behaviour.

### What is not covered here, and why

- **`/replay` answering `409` outside the 7-day window** is not reachable on any lane: it needs an
  event older than `trigger_replay_window_days`, which is `gt=0` (at least one day), and a delivery
  cannot be back-dated.
- **An event reaching `dead`** needs a failed job submit or an expired dispatcher lease, neither of
  which a black-box caller can cause.
- **`last_error` holding a bare exception class name (TRG-6)** is written only by Microsoft/Google
  source cleanup (`source_cleanup.py`), which needs a real provider tenant.
- **The rate-limit refusals** (600/min per trigger, 60/min per client for unknown ids) also answer
  the uniform 404. Driving one would spend a budget the whole instance shares, so they are not
  probed.
- **The Microsoft Graph handshake** (`validationToken` echo) and **the Slack per-app route** belong to
  provider triggers, not to the generic webhook.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model and no network egress. The ingress and the dispatcher are on
by default on every lane (`trigger_ingress_enabled`, `trigger_dispatcher_enabled`). `@stable` enters
in this PR. The `test.fail()` pin #2328 adds (*Known defect*) will carry `@regression` instead.

---

## Step by step *(required)*

Seven tests over the `request` fixture, each declaring its operations through `apiCoverage`. One
throwaway owner (`createConnectionsOwner`) per worker, created in `beforeAll`, and its token sent on
each test's own `request`; `afterAll` deletes the owner, which takes its flows and triggers with it.
One owner per worker rather than per test because each owner costs a login, and the login route
allows 5 per minute per IP: an owner per test sat out a whole window mid-run (measured, +60 s).
Every call is scoped by flow or trigger id, so the tests never read each other's rows. Every
delivery body is unique within its trigger, and every event is matched by id or `dedupe_key`, never
by position. Events still running when `afterAll` deletes the owner (test 3's controls are never
waited for) are removed by that delete's cascade. A delivery is signed exactly as `verify_webhook` checks it.

The **webhook flow** used below is `InboundWebhookTrigger → Chat Output` (the trigger's `Event`
output into `input_value`), created through `POST /api/v1/flows/`. Its trigger is the one flow save
creates: `GET /api/v1/triggers?flow_id=…` → exactly one `inbound_webhook` row with `node_id` = the
node's id, which is then enabled (`active`).

**Test 1 — `the signing secret is answered once, never read back, and a rotation retires the old one at once while the address stays`**
1. Webhook flow and its trigger. `GET …/ingress` → `200`, `public_id: null`, `ingress_url: null`,
   `has_signing_secret: false`.
2. `POST …/signing-secret` → `200`, exactly the five keys above. `ingress_url`'s path is
   `/api/v1/triggers/ingress/webhook/<public_id>`, and the secret is non-empty.
3. `GET …/ingress` → `200`, the same `public_id` and `ingress_url`, `has_signing_secret: true`, and
   no `signing_secret` key. The secret's value appears nowhere in the response text.
4. `POST …/signing-secret` again → the same `public_id` and URL, a different secret.
5. A delivery signed with the **old** secret → the uniform 404. The same body and timestamp signed
   with the **new** secret → `202`.
6. A `schedule` trigger on the same flow: `GET …/ingress` and `POST …/signing-secret` both → `409`
   with the message above.

**Test 2 — `a signed delivery is accepted once, runs, and reaches the flow through event_payload`**
1. Webhook flow, its trigger, a secret.
2. Deliver a signed body → `202`, empty body. The events list holds exactly one row: `dedupe_key`
   starts with `ingress:webhook:`, `payload` is `{provider: "webhook", delivery: <body>}`.
3. Send the **identical** request again (same body, same timestamp, same signature) → `202`, and the
   list still holds exactly that one row (same id).
4. Wait for the row to settle (cap 45 s) → `completed`, `job_id` and `session_id` set, `error: null`.
5. Read the run's message by that `session_id` and parse its JSON: `event_id` and `dedupe_key` are
   the row's, `kind: "inbound_webhook"`, and `payload.delivery` equals the body.

**Test 3 — `every refusal answers the same 404, byte for byte, and writes no ledger row`**
1. Webhook flow, its trigger, a secret. Record the row count (zero).
2. Each probe below carries one defect and is otherwise signed with the right secret. Each must
   answer `404` with exactly the reference body `{"detail":"Not found"}`, and the same header set and
   values as the reference refusal (the unknown id), apart from `date`:
   - an unknown `public_id` of the same length;
   - a signature computed with a wrong secret;
   - a timestamp 400 s in the past, and one 400 s in the future;
   - no `X-Langflow-Signature` and no `X-Langflow-Timestamp`;
   - a body that is not JSON;
   - a body of 1 048 577 bytes;
   - the provider segment `microsoft`, `google` and `nosuch` in place of `webhook`. These pin that
     the refusal is uniform, **not** the kind check (`resolve_target` refusing a provider that does
     not match the trigger's kind): were that check to regress, a webhook trigger resolved under
     `microsoft` would still be refused by `verify_microsoft` (no `value` list) and under `google`
     by `verify_google` (no channel token), so the 404 is guaranteed either way. A black-box
     regression of the kind match is not observable with a webhook trigger; `nosuch` is refused
     earlier still, at the closed provider set;
   - the trigger paused (`POST …/disable` → `paused`).
3. The events list still holds zero rows.
4. Positive controls → `202`: the body of exactly 1 048 576 bytes, the paused probe's exact request
   after `POST …/enable`, and one fresh, correctly signed JSON body on the `webhook` segment (the
   other probes' defects removed). These controls are what make each 404 attributable to its defect.

**Test 4 — `the test action appends a synthetic event that runs through the real dispatcher`**
1. Webhook flow, its trigger (enabled; no secret is needed).
2. `POST …/test` with `payload: {e2e: <run>, marker: "test"}` → `202`, a `pending` row, `dedupe_key`
   starting with `test:`, `payload` equal to `{e2e: <run>, marker: "test", test: true}`.
3. Wait for it to settle → `completed`, with `job_id` and `session_id`. Its run's message parses to
   an envelope whose `event_id` is the row's and whose `payload` is the row's payload.

**Test 5 — `the test action is refused on a dead trigger`**
1. A trigger created through the API with `state: "dead"` on a webhook flow → `201`, `state: "dead"`.
2. `POST …/test` → `409`, `detail: "Trigger is dead and cannot be tested."`, and the events list stays
   empty.

**Test 6 — `replay appends a new linked row that runs the original payload, and leaves the original as it was`**
1. Webhook flow, its trigger, a secret. Deliver a signed body and wait for it to be `completed`.
2. `POST …/replay` with its `event_id` → `202`, a **new** id, `replay_of_event_id` = the original's
   id, `dedupe_key` starting with `replay:<original id>:`, and `payload` equal to the original's.
3. Wait for the replay to settle → `completed`, with its own `job_id` and `session_id`. Its run's
   message carries `event_id` = the replay's id and `payload.delivery` = the original body.
4. The original row is unchanged: same id, still `completed`, same `job_id`.
5. `POST …/replay` with an unknown `event_id` → `404` `"Event not found"`. With the original's
   `event_id` on a **different** trigger of the same owner → `404` `"Event not found"`.

**Test 7 — `a flow that fails on every delivery records each event as failed, with no retry`**
1. A flow that raises on every run (one custom component of kind `raise`). A trigger on it, created
   through the API (`kind: "inbound_webhook"`, `max_attempts: 2`), enabled, with a secret.
2. Deliver two distinct signed bodies → `202` each.
3. Wait until both rows settle → each `failed`, `error: "job_failed"`, `attempt: 0`, `job_id` set.
   Wait one more dispatcher poll and read again: still `failed`, still `attempt: 0`, nothing
   re-queued and no third row.

---

## Validation criterion *(required)*

Tests 1–7 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev0`, and once
at `--workers=2` together with `api/triggers/`, with:

- the secret read back nowhere but the minting response, and an old secret refused immediately after
  a rotation that kept `public_id`;
- exactly one ledger row for a delivery sent twice, `completed` with a `job_id`, and the flow's run
  message carrying that row's `event_id` and the exact delivery body;
- every refusal byte-identical in status, body and headers (except `date`), no row written by any of
  them, and every probe paired with a `202` control that differs from it only by its defect;
- `/test` and `/replay` rows running through the dispatcher to `completed`, the replay linked to an
  original that stayed unchanged;
- the failing flow's events `failed` / `job_failed` / `attempt: 0`, and not retried after one more
  dispatcher poll;
- the declared coverage matching what the fixture recorded (the file drives only the `request`
  fixture and opens no page, so the fixture's HTTP-error monitor, which watches page traffic, sees
  none of the deliberate `404`s and `409`s):
  `POST /api/v1/flows/`, `GET /api/v1/triggers`, `POST /api/v1/triggers`,
  `GET /api/v1/triggers/{trigger_id}`, `POST /api/v1/triggers/{trigger_id}/enable`,
  `POST /api/v1/triggers/{trigger_id}/disable`, `GET /api/v1/triggers/{trigger_id}/ingress`,
  `POST /api/v1/triggers/{trigger_id}/signing-secret`, `GET /api/v1/triggers/{trigger_id}/events`,
  `POST /api/v1/triggers/{trigger_id}/test`, `POST /api/v1/triggers/{trigger_id}/replay`,
  `POST /api/v1/triggers/ingress/{provider}/{public_id}`, `GET /api/v1/monitor/messages`.

After the run, the instance has no flow, trigger or user left from this file.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser, with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (test 7's failing flow) and the trigger settings at their
  defaults: `trigger_ingress_enabled`, `trigger_dispatcher_enabled`, a 5 s
  `trigger_dispatcher_poll_interval_s`, `trigger_ingress_max_body_bytes` 1 048 576,
  `trigger_ingress_signature_tolerance_s` 300, `trigger_replay_window_days` 7.
- `src/backend/base/langflow/api/v1/trigger_ingress.py` — the route, its order of checks and the one
  `404` every refusal gets.
- `src/backend/base/langflow/services/triggers/ingress/verifiers.py` — `verify_webhook`, the
  signature scheme, the timestamp window and the dedupe digest.
- `src/backend/base/langflow/services/triggers/ingress/intake.py` — `resolve_target`, the accepting
  states and the `{provider, delivery}` envelope.
- `src/backend/base/langflow/api/v1/triggers.py` — `ingress`, `signing-secret`, `events`, `test`
  and `replay`.
- `src/backend/base/langflow/services/triggers/ledger.py` — dedupe on `(trigger_id, dedupe_key)` and
  `replay_event`.
- `src/backend/base/langflow/services/triggers/dispatcher.py` — `build_submit_request` (the
  `event_payload` tweak keyed by `node_id`), `reconcile_dispatched` and `_schedule_retry`.
- `src/lfx/src/lfx/base/triggers/base.py` and
  `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the `event_payload` field and the
  node the flow-save reconciler turns into a row.
- `tests/helpers/integrations/connections-owner.ts`, `tests/helpers/flows/build-catalog-flow.ts` and
  `tests/helpers/flows/build-custom-component-graph.ts`.
