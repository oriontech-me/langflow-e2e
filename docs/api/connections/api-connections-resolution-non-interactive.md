# Connections — a non-interactive caller needs the owner's opt-in

**File:** `tests/tests-automations/regression/api/connections/api-connections-resolution-non-interactive.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #2306 (Dedicated Integrations, batch 2). It reuses the probe from #2296
(`tests/helpers/integrations/connection-probe.ts`), and its sibling
`api-connections-resolution-entry-points.md` covers the interactive and the anonymous families.
Trigger runs are a non-interactive family too, but they are #2309's.

---

## What this test validates *(required)*

A user's connection carries `allow_non_interactive`, which is **off** by default. Batch 1 asserted that
default on the API and on the page's switch (#1970). What nothing asserted is the **effect**: a run with
nobody present must not use a user's connection unless that user opted in. Upstream calls a default
flipped to on a *silent privilege grant* (risk #8).

The rule is in the portable floor (`lfx/services/connection/base.py`, `authorize_principal`). A
**user-owned** row is refused to a non-interactive principal unless `allow_non_interactive` is on
(reason `non-interactive-opt-in-required`). An **instance** row never reads the flag.

The families that stamp a non-interactive principal on a run are listed in
`api/utils/execution_principal.py`. This file runs a flow through each one that the OSS nightly serves,
plus the two refusals the database resolver adds on top of the floor. Measured on `1.13.0.dev47`:

| # | Behaviour | Entry point (family) | User conn, opt-in off | User conn, opt-in on | Instance conn |
|---|---|---|---|---|---|
| 1 | The opt-in gates a webhook run, and turning it off takes effect on the next run | `POST /api/v1/webhook/{flow_id}` (`webhook`) | **DENY** | PERMIT | PERMIT, its own flag off |
| 2 | A resumed HITL run is non-interactive, even though the caller owns the job | `POST /api/v2/workflows/{job_id}/resume` (`workflow_hitl_v2`) | **DENY** after the pause, PERMIT before it in the same job | PERMIT | PERMIT, its own flag off |
| 3 | KB connector ingest fails closed, before any job exists | `POST /api/v1/knowledge_bases/{kb}/ingest/connector` (`job_owner`) | **DENY** `403` | past the principal, to `scope-missing` | — |
| 4 | An owned row shadows an instance row with the same handle, and a denied owned row never falls back | Playground build, then webhook | **DENY** on the webhook, no fallback | — | resolves only once the owned row is gone |
| 5 | A Slack app-level token (`xapp-`) resolves only inside the trigger listener | Playground build, then webhook | **DENY** `listener-only` in both runs, the opt-in on for the webhook | | — |

Every PERMIT asserts **which** row resolved (its id and `owner_kind`). Every DENY asserts the code and
the typed **reason**, because a run failing for another cause would otherwise read as a correct denial.

### The oracle

The probe component from #2296 calls `self.resolve_connection(<field>).get_credential()` for each of its
handles and prints one line per field. The line is either
`PROBE <field> resolved owner_kind=<kind> connection_id=<id>` or
`PROBE <field> denied code=<code> reason=<reason>`. The probe never prints the token and never calls a
provider. Where each non-interactive path leaves its result:

- **Webhook:** the request answers `202` *"Task started in the background"*. The run's Chat Output is
  recorded in the owner's `GET /api/v1/monitor/messages?flow_id=…`, about 0.6–1.6 s later.
- **HITL:** the job's `GET /api/v2/workflows?job_id=…` lands on `completed` after the resume. Its
  `outputs["ChatOutput-probe"].content` carries the probe lines.
- **KB ingest:** the resolution runs synchronously in `validate_config`, so the refusal is the response
  itself. It is a `403` carrying `error_code`, `hint` and `details.reason`.

### What each row adds beyond "denied"

- **Row 1 has a contrast on the same flow.** The Playground build (interactive) resolves the user
  connection while its opt-in is off. The webhook denial is therefore about the family, not about a
  connection that does not work. The opt-in then goes off → on → off across three webhook runs, and
  the third run is denied again.
- **Row 2 has a contrast inside the same job.** A second probe sits **before** the Human Input node.
  The background submit stamps `workflow_v2`, which is interactive, so that probe resolves the user
  connection. Its line becomes the Human Input prompt, so it is read from the pending request
  (`GET /api/v2/workflows/pending`). The probe **after** the node runs on resume, under
  `workflow_hitl_v2`, and is denied. Same job, same caller, same connection: only the resume changed.
- **Row 3 has no provider in play.** With the opt-in on, the planted connection (no `drive.file` scope)
  gets past the principal and stops at `scope-missing`, which upstream checks **after** the principal.
  Neither request creates an ingestion run (`GET …/runs` stays at `total: 0`). Ingest *success* needs a
  real Google tenant and is out of scope, as the issue says.
- **Row 4 deletes the owned row as its contrast.** Once the owned row is gone, the same webhook
  resolves the instance row with the same handle. So the earlier denial was a refusal to fall back, not
  an instance row that was unreachable on that path.
- **Row 5 covers both kinds of run.** The build is interactive. The webhook runs with the opt-in **on**,
  so the opt-in floor cannot be what refuses it. The server marks the row `granted_scopes:
  ["connections:write"]` whatever the client sent, and that marker is asserted on the `201` body as a
  precondition.

### Where the measurement differs from the issue

- **Location.** The issue names `core-functionality/integrations/connection-resolution-non-interactive.spec.ts`.
  This file sits beside its sibling under `api/connections/`. It drives no page, and
  `core-functionality/integrations/` holds the page specs (#1969, #1970).
- **KB ingest "opt-in on → reaches the provider"** is asserted as *gets past the principal*
  (`scope-missing`). Granting `drive.file` would pass validation and spawn a background job that calls
  the Google Drive API with a fake token. That needs egress, and it ends in a provider error that would
  mark the row expired.
- **Instance rows ignore the opt-in** rests on a decision record that is still `Status: proposed`
  (`design/dedicated-integrations/decisions/instance-connection-referenceability.md`, last verified
  2026-09-05). `authorize_instance_connection` is the seam an integration-policy service would override
  to narrow it. This file asserts the current behaviour (rows 1 and 2 plant the instance row with
  `allow_non_interactive: false` and expect it to resolve). If that decision lands differently, these
  assertions are the ones to revisit.
- **Only a superuser may create an instance row** (`403 "Only a superuser may create an instance
  connection."`). The instance rows are therefore the superuser's, and everything else is a throwaway
  owner's (see *Budget*).

### Recorded, not asserted

- **Trigger push and listener runs** (`trigger_push`, `trigger_listener`) are #2309's, and so is the
  **positive** half of row 5 (the listener resolving its app-level token).
- **The deployments family** is stamped by no OSS route.
- **A resume cannot be talked into the interactive family.** A persisted `execution_family` is honoured
  only for trigger families (`api/v2/workflow.py`). This is code, not black-box reachable.
- **Explicit shares** need Enterprise RBAC. Non-interactive families do not admit shares anyway
  (`allow_explicit_shares=False`).

### Budget and parallel safety

- **One throwaway owner per worker** (`createConnectionsOwner`, #2295). Owner connection writes come to
  about 15 per worker per run: five user rows created and deleted, plus four `PATCH`es of the opt-in.
  They are all in the owner's own 30/minute bucket, never the shared superuser's.
- **Superuser writes: 4 per worker per run** — the shared instance row and row 4's same-name instance
  row, each created and deleted.
- **The owner owns every flow, the API key and the knowledge base.** A webhook run acts as the flow's
  owner and a resumed job as the job's owner, so the opt-in under test has to be on the owner's row.
- **Each test plants its own user row.** No test reads a connection another test PATCHes, so test
  order inside a worker does not matter. Every name is unique per run, and nothing reads a list length
  across tests.
- **Every flow, the knowledge base, the API key and every connection** are deleted in `afterAll`, in
  reverse order, every step attempted. Row 4's owned row is deleted by the test itself, and its cleanup
  is then skipped: a `404` delete still costs a write.

---

## Tags *(required)*

`@api` `@integrations` `@stable`.

`@stable`: no provider key, no model, no network egress. The probe stops before any adapter. The KB
ingest stops at the principal or at the scope check, and spawns no job.

---

## Step by step *(required)*

`beforeAll`, per worker:

1. Create a throwaway owner and an API key for it.
2. As the superuser, plant one **instance** `google` row with `allow_non_interactive: false`.

Each user row below carries a sentinel token unique to the run.

**Test 1 (webhook).**
1. Plant a user row. Its `201` body must read `allow_non_interactive: false`.
2. Build a probe flow for the user row and the instance row.
3. The Playground build must resolve **both** (the contrast).
4. Webhook: the user line must read `denied connection-not-authorized non-interactive-opt-in-required`,
   and the instance line must read `resolved instance <id>`.
5. Turn the opt-in on. Webhook: both lines must read `resolved`, each with its own id.
6. Turn it off again. Webhook: the user line must be denied again; the instance line is unchanged.

**Test 2 (HITL resume).**
1. Plant a user row.
2. Build *Chat Input → Probe (before) → Human Input → Probe (after) → Chat Output*. The *before* probe
   takes the user row; the *after* probe takes both rows.
3. Job A, opt-in off:
   1. Submit in `mode: background`.
   2. The job must reach `suspended`.
   3. The pending request's prompt must read `resolved user <id>` for the *before* probe.
   4. Resume with `approve`. The job must reach `completed`.
   5. Its outputs must read `denied … non-interactive-opt-in-required` for the user row and `resolved` for
      the instance row.
4. Turn the opt-in on.
5. Job B: the same steps, and after resume both rows must read `resolved`.

**Test 3 (KB connector ingest).**
1. Create a knowledge base. No embedding credential is needed to create one.
2. Plant a user row with no scopes.
3. Ingest with `source_type: google_drive` and the row's handle. The response must be `403` with
   `error_code: connection-not-authorized`, `details.reason: non-interactive-opt-in-required` and the
   opt-in hint.
4. Turn the opt-in on and ingest again. The response must be `403` with `error_code: scope-missing`,
   naming `drive.file`.
5. `GET …/runs` must report `total: 0`.

**Test 4 (shadowing).**
1. Plant a user row.
2. As the superuser, plant an instance row with the **same name** and `allow_non_interactive: true`.
3. Build a one-handle probe flow.
4. The Playground build must resolve the **user** row's id.
5. Webhook (the user row's opt-in off): the line must be denied with `non-interactive-opt-in-required`.
   It must not resolve the instance row, whose own flag is on.
6. Delete the user row. Webhook: the line must resolve the **instance** row's id.

**Test 5 (Slack app-level token).**
1. Plant a `slack` row with identity `bot` and an `xapp-` sentinel token. Its `201` body must read
   `granted_scopes: ["connections:write"]`.
2. Build a one-handle probe flow.
3. The Playground build must deny it with `connection-not-authorized` and reason `listener-only`.
4. Turn the opt-in on. Webhook: the same denial.

Every response, recorded message, job status and pending request is swept as **text** for every
sentinel token (#1967).

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`, and
once at `--workers=2`. The following hold on every run:

- every PERMIT names the exact planted id and its `owner_kind`;
- every DENY names `connection-not-authorized` and its typed reason (`non-interactive-opt-in-required`
  or `listener-only`);
- the interactive contrast of rows 1, 2 and 4 resolves the same user row the non-interactive run is
  refused;
- no response carries a sentinel token.

Every test also has a force-fail mutation executed against it. Examples: expecting `resolved` where
the opt-in is off, the other `owner_kind` on the shadowed handle, or the other reason on the Slack row.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (the probe). Every lane sets it.
- `src/backend/base/langflow/api/utils/execution_principal.py` — which families are non-interactive,
  and who the dependency principal is (flow owner for a webhook, job owner for a resume).
- `src/lfx/src/lfx/services/connection/base.py` — the portable floor: the opt-in check for user rows
  only.
- `src/backend/base/langflow/services/connection/service.py` — owned-before-instance selection
  (`_owned_or_instance_row`), and the instance-row seam (`authorize_instance_connection`).
- `src/backend/base/langflow/services/connection/slack_credentials.py` — the `xapp-` marker and
  `refuse_outside_listener`.
- `src/lfx/src/lfx/base/knowledge_bases/ingestion_sources/connector_base.py` — the ingestion job's
  `job_owner` principal.
- `src/lfx/src/lfx/base/knowledge_bases/ingestion_sources/google_drive.py` — `validate_config`
  resolving synchronously, and the `drive.file` scope.
- `src/backend/base/langflow/api/v1/knowledge_bases.py` — the connector route, hidden from the schema,
  and its typed `403`.
- `src/backend/base/langflow/api/v2/workflow.py` — `workflow_hitl_v2` on resume.
- `src/backend/base/langflow/api/v1/endpoints.py` — the webhook route and its `webhook` family.
- `src/lfx/src/lfx/integrations/errors.py` — the reasons and their hints.
- `tests/helpers/integrations/connection-probe.ts`, `tests/helpers/integrations/connections-owner.ts`,
  `tests/helpers/integrations/create-connection.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/serving/serving-jobs.ts`, `tests/helpers/knowledge/knowledge-base.ts` and
  `tests/helpers/auth/create-api-key.ts` — the probe, the owner, the planted rows, the flows, the
  jobs doors, the knowledge base and the API key.

Two helper changes come with this file. The probe takes its provider from the handle, so a `slack/…`
handle builds a `provider="slack"` input. `createConnectionViaApi` takes an explicit `name`, for row 4's
same-handle pair.
