# Governance — which trigger kinds may run: the palette, arming, live triggers and dispatch

**File:** `tests/tests-automations/regression/governance/trigger-policy-enforcement.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev34`)

Owning issue: #2451 (the 1.14 triggers and connectors batch). Test 4 is #2502's: the policy on the trigger kinds the
nine 1.14 providers bring (`docs/api/triggers/api-triggers-provider-kinds.md`). The integration half of the same bundle,
read through API v2, is the sibling `docs/governance/integration-policy-v2.md`. The audit rows an owner's
and an operator's trigger actions write are `docs/api/triggers/api-triggers-audit.md`; this file asserts
the one audit row a policy writes, `trigger:policy_denied`. Upstream: #16333 (first tag `v1.14.0.dev23`).

---

## What this test validates *(required)*

Since 1.14 the operator's policy bundle carries `approved_trigger_kinds`, written by a superuser through
`PUT /api/v2/policy-bundle`. `null` is unrestricted (the default), `[]` denies every kind, and a list
approves only the kinds it names. The contract under test:

1. **The palette hides a denied kind.** `GET /api/v1/all` drops the denied trigger component from the
   *Triggers* category, and the sidebar's search no longer finds it, while an approved kind stays.
2. **A denied kind cannot be armed.** `POST …/enable` and `POST /api/v1/triggers` with `state: "active"`
   answer `403` with `{"code": "policy_blocked", "message": "Blocked by trigger policy. Ask an
   administrator to approve this trigger kind."}`.
3. **Live triggers converge.** The `active` and `pending` rows of a denied kind are paused within one
   policy refresh: `state` and `reason` read `paused`, `last_error_code` reads `policy_blocked`, and
   `last_error` carries the message above. A trigger of an approved kind is left alone.
4. **An event dispatched under a denied kind is refused.** It ends `failed` with error `policy_blocked`,
   and its trigger is paused the same way.
5. **Each refusal is audited.** `trigger:policy_denied` (result `deny`) names the trigger, its kind and
   flow, and the purpose: `enable` for a refresh or a refused enable, `dispatch` for a refused event.
6. **Restoring the policy restores the palette, not the triggers.** Back to `null`, the kind returns to
   the palette, but a trigger the policy paused stays paused until its owner resumes it.
7. **Older writers keep the facet.** A `PUT /api/v1/policy-bundle` that leaves `approved_trigger_kinds`
   out keeps the active value.
8. **A provider's trigger kinds obey the same ceiling, each on its own** (#2502, measured on `1.14.0.dev34`).
   Approving `["jira.issue_created", "schedule"]` has three effects:
   - `GET /api/v1/all` keeps exactly two trigger components, *Jira: On Issue Created* in the `jira` category and
     *Schedule*. Every other provider kind leaves its own category, including *Jira: On Issue Updated* beside
     the one approved.
   - The sidebar search for *jira* finds *On Issue Created* and not *On Issue Updated*.
   - Within one refresh, the `pending` rows of the denied kinds (`jira.issue_updated`, `github.issue`) read
     `paused` / `policy_blocked`. The approved kind's row is left `pending`.

   Enabling a denied kind whose node is bound to the owner's own `pending` connection answers the policy's
   `403`, before any of the connection's own gates. It writes a `trigger:policy_denied` row with
   `purpose: enable` and the kind. The approved kind, bound the same way, gets past the policy and is refused
   at its own first gate (`409 background_runs_not_allowed`), which is the control that the `403` is the
   policy's.

   Measured, not asserted: when the handle names **no** connection, `enable` answers
   `409 trigger_connection_not_owned` even for a denied kind. The handle is resolved under the admission lock
   before the policy is read. That order is an implementation detail rather than a contract, so the test
   binds real connections.

### Measured on `1.14.0.dev28`

- **Convergence is periodic, not immediate.** The write answers `200` with the new value at once and the
  palette follows at once, but an `active` webhook trigger was still `active` right after the write. It
  was paused within 6 s, and a `pending` Schedule within 7.8 s. The pause comes from the policy refresh
  worker, which runs every `model_provider_policy_refresh_interval_s` (10 s by default) and pauses every
  `active` and `pending` row of a denied kind. The spec waits up to 20 s for it.
- **Creating a denied kind is refused only when armed.** `POST /api/v1/triggers` with `state: "active"`
  answers `403`. The same body without `state` answers `201`, `pending`, and the next refresh pauses
  it.
- **The dispatch branch races the refresh.** With test events queued on an active trigger and the kind
  then denied, the first event the dispatcher picks up fails `policy_blocked` and pauses the trigger. If
  the refresh pauses the trigger first, the queued events fail `trigger_paused` instead, and no event
  ever reads `policy_blocked`. The dispatcher works one event per tick (~5 s) and the refresh runs every
  10 s, so which one wins depends on where the write lands in the refresh's cycle.

  The spec makes the dispatch branch deterministic by aligning with the refresh:
  1. It first denies only `schedule` and waits until a pending Schedule canary is paused, which marks a
     refresh that has just run.
  2. It then queues one test event on the active webhook trigger and denies `inbound_webhook`.

  The next refresh is ~10 s away, and the dispatcher reaches the event in ~5 s. Measured 3 times out of
  3: the event failed `policy_blocked` in 4.9–5.0 s, the trigger paused, and the only audit row read
  `purpose: dispatch`.
- **A `needs_reconnect` trigger is not a way around the race.** The dispatcher treats that state as
  dispatchable, but it did not drain the queued events of a Calendar trigger in `needs_reconnect` for
  40 s, and the refresh does not pause that state. A denied kind in `needs_reconnect` therefore stays
  `needs_reconnect`.
- **Back to `null`, a paused trigger stays paused** (`last_error_code: policy_blocked` unchanged), and
  `enable` then answers `200` and `active`.
- **The audit rows.** Pausing a live trigger and refusing its `enable` write one
  `trigger:policy_denied` row each, both `purpose: enable`. The refused enable's row also carries the
  request's `request_id` and `auth_method`. A refused dispatch writes one row, `purpose: dispatch`.

### What is not covered here, and why

- **Provider triggers that need a real tenant** (GitHub, GitLab, WhatsApp, Telegram):
  - their signing secret is internal: it exists only once the subscription is `active` (for WhatsApp,
    `pending` or `active` plus a `ready` connection), and no route returns it;
  - enabling one calls the provider: GitHub creates a hook, Telegram calls `setWebhook`, WhatsApp calls
    `subscribed_apps`, GitLab calls `/version` and the project's hooks;
  - a planted credential for these four is refused by `POST /api/v1/connections`, which validates it
    against the provider (`422` *"could not reach the provider"* offline, asserted by #2452);
  - the callback URL needs `LANGFLOW_TRIGGER_INGRESS_ORIGIN` set to a public HTTPS origin.

  The polling triggers (Jira, Confluence, ServiceNow, Salesforce) and Discord's gateway need a tenant
  too, to be armed. Tests 1–3 use the two core kinds, `inbound_webhook` and `schedule`, which need
  none. Test 4 covers what needs no tenant for the provider kinds: hiding them, pausing their `pending` rows,
  and refusing their enable. Pausing a provider trigger that is `active`, and a dispatch refused under a
  provider kind, both need a `ready` connection (#2503).
- **An Enterprise narrowing hook** (`governance_blocked`, an approval or quota refusal that is not the
  kind ceiling). The OSS build registers none.
- **A policy source that becomes unavailable**, which fails closed for a configured trigger facet. A
  test cannot make the bundle store unreadable on a shared instance.
- **Deliveries to a paused trigger.** They answer the uniform `404`, asserted by
  `api/triggers/api-triggers-webhook-ingress.spec.ts`.

---

## Tags *(required)*

`@destructive` `@api` `@integrations` `@governance`

`@destructive`: the policy bundle is instance-global, so a denied kind is denied for every worker sharing
the instance. No `@stable`: no scheduled lane runs `@destructive` (#1010). The file refuses to run, with a
skip naming what it found, unless the bundle is pristine (no set populated, both tri-state fields `null`),
and puts the bundle back from its snapshot in `afterAll`. It skips below `1.14.0.dev23`.

---

## Step by step *(required)*

Every test runs as the superuser. Flows are built with `createCatalogFlow` and deleted by id in
`afterEach`. Policy writes go through `tests/helpers/governance/policy-state.ts`, which writes the whole
v2 bundle with the current `expected_revision` and only the fields the test changes. Waits for the
refresh poll the trigger row every second, up to 20 s.

### 1. Approving only Schedule hides Inbound Webhook, refuses arming it, and pauses the one already active

1. Create an *Inbound Webhook → Chat Output* flow and enable its trigger (`active`), and a Schedule flow
   (`pending`).
2. Write `approved_trigger_kinds: ["schedule"]`. Expect `200` with `["schedule"]`, and the same value
   read back through `GET /api/v2/policy-bundle` and `GET /api/v1/policy-bundle`.
3. Expect the *Triggers* category of `GET /api/v1/all` to hold `ScheduleTrigger` and not
   `InboundWebhookTrigger`. Open a flow and expect the sidebar's search to find the Schedule row and no
   Inbound Webhook row.
4. Expect the webhook trigger to read `paused` / `paused` / `policy_blocked` with the policy message
   within one refresh, and the Schedule trigger to stay `pending`.
5. Expect `POST …/enable` on the webhook trigger to answer `403` with the `policy_blocked` body, and
   `POST /api/v1/triggers` for an `inbound_webhook` with `state: "active"` to answer the same. The same
   create without `state` answers `201` `pending`, and the next refresh pauses it.
6. Expect two `trigger:policy_denied` rows for the webhook trigger, each `deny` with `kind`
   `inbound_webhook`, `purpose` `enable` and its `flow_id`.
7. Write the bundle through `PUT /api/v1/policy-bundle` with the six v1 sets and no
   `approved_trigger_kinds`. Expect the answer to still read `["schedule"]`.

### 2. An empty list denies every kind, and null brings the palette back but not the paused triggers

1. Create a Schedule flow (`pending`). Write `approved_trigger_kinds: []`.
2. Expect the *Triggers* category of `GET /api/v1/all` to be empty, and the sidebar's search to find no
   Schedule row.
3. Expect the Schedule trigger paused with `policy_blocked` within one refresh, and its `enable` refused
   `403`.
4. Write `approved_trigger_kinds: null`. Expect both core triggers back in the catalog, and the Schedule
   trigger still `paused` with `last_error_code: policy_blocked`.
5. Expect `enable` to answer `200` and `active`.

### 3. An event dispatched under a newly denied kind fails as policy_blocked and pauses its trigger

1. Create an *Inbound Webhook → Chat Output* flow and enable its trigger (`active`), and a Schedule
   canary (`pending`).
2. Write `approved_trigger_kinds: ["inbound_webhook"]`, and wait until the canary is paused: a refresh
   has just run.
3. At once, send one test event to the webhook trigger (`202`, `pending`) and write
   `approved_trigger_kinds: ["schedule"]`.
4. Expect the event to end `failed` with error `policy_blocked`, the webhook trigger to read `paused` /
   `policy_blocked`, and exactly one `trigger:policy_denied` row for it, with `purpose: dispatch`.

### 4. Approving one Jira kind hides every other provider kind, pauses their pending triggers, and refuses enabling one with the policy's reason

Skips below `1.14.0.dev34`, the build it was measured on. The connections are the superuser's own `pending` rows
(`createConnectionViaApi`, `credentials: null`), deleted by id after the test.

1. Reset `approved_trigger_kinds` to `null`: tests 1–3 leave a ceiling under which these kinds are not in the
   catalog to build from. Then create three flows, each with one provider trigger node bound to a `pending`
   connection of its provider: *Jira: On Issue Created*, *Jira: On Issue Updated* (both `project: DEMO`) and
   *GitHub: On Issue* (`repository: octocat/hello-world`). Each saves one `pending` row.
2. Write `approved_trigger_kinds: ["jira.issue_created", "schedule"]` (the order the server answers). Expect `GET /api/v1/all` to carry
   exactly two components with a `trigger_kind`: `jira.issue_created` in `jira`, and `schedule` in
   `triggers`.
3. Open a flow holding only a Chat Output and search the sidebar for *jira*. Expect the *On Issue Created*
   row and no *On Issue Updated* row.
4. Wait for the refresh. Expect the *Updated* and *GitHub* rows `paused` / `policy_blocked` with the policy's
   message, and the *Created* row still `pending`.
5. Enable the *Updated* trigger. Expect `403` `policy_blocked`, and exactly two `trigger:policy_denied` rows for
   it, one for the refresh's pause and one for the refused enable. Both read `deny`, `kind: jira.issue_updated`,
   `purpose: enable`.
6. Enable the *Created* trigger. Expect `409` `background_runs_not_allowed`, its own first gate, and no
   policy-denied row for it.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` with `PW_DESTRUCTIVE=1` against
`1.14.0.dev28`. All four pass three consecutive times against `1.14.0.dev34` (#2502), with:

- every denial asserted by the server's own answer: the `403` body, the row's `state`, `reason`,
  `last_error_code` and `last_error`, the event's `error`, and the audit row;
- the palette asserted through both the catalog and the sidebar;
- the dispatch branch reached on every run, never the refresh branch in its place;
- the bundle back to its snapshot after the file, checked by reading it back;
- zero `🚨 Backend Error`: the `403`s are driven through the `request` fixture;
- no flow or trigger row left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev23` or later) at `PLAYWRIGHT_BASE_URL`, auto-login,
  with a pristine policy bundle, trigger dispatch running (the default) and the default
  `model_provider_policy_refresh_interval_s` (10 s).
- `src/backend/base/langflow/services/triggers/policy.py` — the kind ceiling, `pause_disallowed_triggers`,
  the palette filter and `stage_policy_denial`.
- `src/backend/base/langflow/api/v1/policy_bundle.py` — the v1 and v2 bundle routes and
  `approved_trigger_kinds`.
- `src/backend/base/langflow/api/v2/policy_bundle.py` — the v2 router.
- `src/backend/base/langflow/services/policy_bundle.py` — the bundle store.
- `src/backend/base/langflow/services/task/model_provider_policy_refresh.py` — the refresh worker that
  pauses live rows.
- `src/backend/base/langflow/services/triggers/dispatcher.py` — the dispatch-time policy check.
- `src/backend/base/langflow/services/triggers/constants.py` — the policy message.
- `src/backend/base/langflow/api/v1/triggers.py` — enable and create.
- `src/backend/base/langflow/api/v1/authz_audit.py` — the audit read.
- `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` and
  `src/lfx/src/lfx/components/triggers/schedule_trigger.py` — the two core trigger components.
- `src/backend/base/langflow/services/triggers/service.py` and
  `src/backend/base/langflow/services/triggers/locking.py` — the order of `enable`'s gates (test 4).
- The Jira and GitHub bundles (`1.14.0.dev34` or later) and #2498's fake Jira site, for test 4.
- `tests/helpers/governance/policy-state.ts`, `tests/helpers/triggers/trigger-api.ts`,
  `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/open-flow-by-id.ts`,
  `tests/helpers/flows/unmount-editor-for-cleanup.ts`, `tests/helpers/flows/delete-flow.ts` and
  `tests/helpers/other/served-version.ts`.
