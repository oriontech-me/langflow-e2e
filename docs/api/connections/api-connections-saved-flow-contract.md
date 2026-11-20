# Connections — the saved-flow contract

**File:** `tests/tests-automations/regression/api/connections/api-connections-saved-flow-contract.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2298 (Dedicated Integrations, batch 2).

---

## What this test validates *(required)*

A saved flow names a connection by its **handle** (`<provider>/<name>`) and never carries a credential.
That is what lets a flow move between users and instances without leaking a token, and lets it bind to a
different connection that has the same handle. Before this file nothing asserted it: the batch-1 specs
cover the `Connection` entity, and `api-connections-resolution-entry-points` covers which callers may
resolve a connection, but nothing exported a bound flow, imported it somewhere else, or ran a connector
until the **provider** refused the token.

Seven tests:

1. **Export keeps the handle and carries no credential.** A flow bound to a planted connection is exported
   twice, as a flow (`POST /api/v1/flows/download/`) and as its project's zip
   (`GET /api/v1/projects/download/{project_id}`). Both exports carry the handle string, and the raw text
   of both contains neither of the connection's two planted sentinels (access and refresh token, the
   batch-1 technique, #1967). The sentinel sweep is a **contract guard**: a flow never stores the token,
   so today nothing can put it in an export, and no mutation of this suite can make the sweep fail
   without changing the product. It is there to catch the day an export starts embedding credentials.
2. **A malformed handle is nulled on export, not on save or import.** Three malformed values
   (`google/a/b`, `Google/Bad Name`, `nohandle`) sit beside a well-formed control in one flow. Save and
   read-back keep all four; the export nulls the three malformed ones and keeps the control; uploading an
   envelope that carries a malformed handle keeps it.
3. **The round trip keys on the class.** The manifest's `component_ref` for `microsoft.outlook.send` is
   the class name `OutlookSendComponent`, while the catalog entry's `name` is `OutlookSendMail`. A flow
   with that node is exported, deleted and re-imported. The imported node keeps the catalog's type key,
   `component_class_name`, `code_hash`, code and handle. Those checks only read back what the upload
   stored, so the imported node is then **built**: the server instantiates the class, reaches its
   connection input and stops at `connection-unresolved` (no row has that handle), before the send could
   run. That build is what shows the node resolves to the catalog entry.
4. **Imported by another user, the handle binds to that user's connection.** The superuser exports a flow
   bound to its own `google/<name>` connection, which holds the scope the action needs. A throwaway user
   imports it and builds it:
   - with no connection of its own, the build stops at `connection-unresolved`, naming the handle. The
     handle never falls through to the exporter's row;
   - after the user plants its own connection under the **same** name, with no scopes, the build stops at
     `scope-missing`. Only the importer's row can produce that code: the exporter's row holds the scope,
     so resolving it would have gone on to the provider.
5. **A run that fails at the provider surfaces no token.** A Drive connector runs with a planted fake token
   that holds the right scope, so it gets past resolution and Google rejects the token. The build stops at
   `auth-expired`, and the connection reads `expired` afterwards, which is what proves the provider was
   reached. Neither sentinel appears in the build's event stream, `GET /api/v1/monitor/messages`,
   `GET /api/v1/monitor/builds`, `GET /api/v1/monitor/transactions`, the trace list or the trace detail.
   The trace detail must record the failure (`error_code: auth-expired`), so the sweep is not over an
   empty trace.
6. **The Playground and the trace view show the failure, not the token.** The same run, started from the
   Playground: the error card shows the `auth-expired` text, the trace view lists the Drive span with the
   same code, and neither page's HTML carries a sentinel.
7. **Field guards.**
   - A component declaring a connection input with `tool_mode=True` is refused at code validation
     (`POST /api/v1/custom_component` → `400`, "Connection references cannot be exposed as tool-call
     inputs").
   - A connector switched to Tool Mode never offers `connection` as a tool argument, even when the saved
     template flags that field `tool_mode: true`.
   - A connection input whose handle names another provider is refused at code validation (`400`,
     "Connection reference provider 'slack' does not match declared provider 'google'"). A saved flow
     carrying such a handle on a catalog connector is accepted on save, survives export (it is
     well-formed), and its run is refused with the same message before any resolution.

### Where the measurement disagrees with the issue

- **"A malformed handle is nulled on import" is false.** Measured on `1.14.0.dev32`: `POST /api/v1/flows/`,
  `POST /api/v1/flows/upload/` and `GET /api/v1/flows/{id}` all keep `google/a/b` as sent. The nulling in
  `utils/flow_secrets.py` (`_strip_template_field_value`, `connection_ref` branch) runs where secrets are
  stripped, which is the **export** (`_build_flows_download_response`, the project download) and the
  non-owner and public reads. Test 2 asserts that split. A malformed handle that reaches a run is refused
  there (`Connection references must use the form '<provider>/<name>'`), so keeping it on import exposes
  nothing.
- **"A handle whose provider differs is refused" holds at code validation and at run time, not at save.**
  A saved `slack/<x>` on a Google connector is stored, read back and exported unchanged, because it is
  well-formed. The refusal is the run's (`ConnectionRefInput` re-validated when the component is built).
- **The field-level tool-mode guard lives in the input model, not in the saved template.** A template
  that sets `tool_mode: true` on the connection field is stored and echoed back by
  `POST /api/v1/custom_component/update`, and nothing refuses it. It is inert: the tool schema
  (`tools_metadata`) is built from the component's own inputs, so `connection` never becomes a tool
  argument. Test 7 asserts the property that matters (no tool argument), not a refusal that does not
  exist.
- **Overlap with four existing specs, and what is new here.**
  - `api-connections-resolution-entry-points` sweeps every response, event stream and recorded message of
    eleven entry points for sentinels, but each of its runs stops before a provider (the probe, a
    principal refusal or `scope-missing`).
  - `api-connections-health` (its expired-credential test) and `core-functionality/integrations/connector-run-errors`
    (its expired-credential test) run a connector to `auth-expired` too, but from a credential whose
    `expires_at` is in the past, which Langflow refuses before calling Google.
  - `core-functionality/integrations/connector-tool-mode` asserts that a connector in Tool Mode never takes
    `connection` as a tool argument. Test 7 keeps only the case it does not cover: a saved template that
    flags the field `tool_mode: true`.

  What this file adds: a run whose token Google itself rejected (the provider is actually reached), the
  sweep of the monitor surfaces and the trace that run leaves behind, and the export/import contract.
- **Re-importing on the same instance means deleting the original first.** An export keeps the flow id,
  and `POST /api/v1/flows/upload/` **upserts** an id its user already owns (measured: `201`, same id). That
  is an update, not an import. Tests 2 and 3 delete the source flow first so the upload is a create;
  another user's upload gets a new id, so test 4's importer needs nothing.

### Recorded, not asserted

- **The shareable playground and the other public paths** cannot resolve a connection at all
  (`api-connections-resolution-entry-points`, rows 7–11).
- **A real provider tenant.** Every token here is fake. Test 5 needs Google to reject it, nothing more.
- **Another instance.** The move between instances is simulated by export, delete and re-import on the
  same one; the flow JSON is the only thing that travels, and it is what tests 1–3 inspect.

### Candidate upstream tickets (not filed)

None. The disagreements above are premises of the issue, not product defects.

### Budget and parallel safety

- **Connection writes:** four superuser seeds plus their deletes (8 writes), and one by the throwaway
  user, inside the 30/minute per-user bucket (#2295).
- **Logins:** one, for the throwaway user, created inside test 4 only so a run spends one login however
  the tests spread across workers.
- **Egress:** tests 5 and 6 need `www.googleapis.com` to answer a fake token with `401`. The GitHub
  runners have egress. Egress from the QA VM to `www.googleapis.com` was **not verified** (the VM was
  unreachable while this was built); see *Tags* for what a missing route does.
- **Tracing:** tests 5 and 6 need tracing on (`LANGFLOW_DEACTIVATE_TRACING=false`). The VM daily runs with
  tracing on (`run-e2e.sh` defaults it to `false`), and the PR lane turns it on when this spec is
  selected. The local starters default tracing **off**, so a contributor running this spec locally needs
  `LANGFLOW_DEACTIVATE_TRACING=false` on the instance. With tracing off, the trace list is empty and both
  tests fail saying so, rather than sweeping nothing.
- Every name is unique per run, every flow lives in a project of its own or is deleted by id, and no list
  length is read.

---

## Tags *(required)*

`@api` `@integrations` `@stable`, plus `@playground` `@observability` on test 6.

`@stable`: no provider key and no model. Tests 1–4 and 7 need nothing outside the instance. Tests 5 and 6
need tracing on and egress to Google (see *Budget and parallel safety* for which lanes provide them).

**Residual risk of tests 5 and 6: they depend on Google being up.** When Google answers a 5xx, the route
to it fails, or it rate-limits, the run's typed code is `provider-unavailable`, `network-error` or
`rate-limited` instead of `auth-expired`. The tests still **fail** then, never skip (#1010/#1012), but
through `providerOutageMessage()` (`tests/helpers/integrations/provider-outage.ts`): the message starts
with `[provider-outage]`, which the `provider-outage` entry of
`scripts/lib/infra-signature-patterns.json` matches, so the daily's unreviewed `@stable` auto-removal
treats the failure as infra and keeps the tag (the #1128 lesson). What it does not cover: an outage that
Langflow maps to some other code (for example a Google error page read as `invalid-request`), which
fails as an ordinary, attributable diff. A lane with no route to Google at all would fail tests 5 and 6
on every run, as infra, until the route exists.

---

## Step by step *(required)*

`beforeAll`: the superuser's token, the component catalog, and a run id from which every name and
sentinel is derived.

**Test 1.**
1. Plant a `google` connection with an access and a refresh sentinel.
2. Create a project and, inside it, a flow with one Drive *List Files* node bound to the connection.
3. Download the flow: the node's `connection` value is the handle; the raw text carries neither sentinel.
4. Download the project: the zip's single JSON carries the handle and neither sentinel.

**Test 2.**
1. Save one flow with four Drive nodes: three malformed handles and one well-formed control.
2. Read it back: all four values are as sent.
3. Download it: the three malformed values are `null`, the control is kept.
4. Delete the flow and upload an envelope carrying `google/a/b`: the imported value is still `google/a/b`.

**Test 3.**
1. Read the manifest: `microsoft.outlook.send` has `component_ref: "OutlookSendComponent"`.
2. Read the catalog entry `ext:microsoft:OutlookSendComponent@official`: its `name` is not the
   `component_ref`, and its `metadata.component_class_name` is.
3. Save a flow with that node bound to a `microsoft/<name>` handle, download it, delete it, upload the
   download.
4. The imported node has the catalog's type key, `component_class_name`, `code_hash` and code, and the
   handle.
5. Build the imported flow: `connection-unresolved`, naming the handle, before the send could run.

**Test 4.**
1. Plant a superuser `google` connection holding `drive.file`, with sentinels.
2. Save a Drive flow bound to it and download it.
3. Create a throwaway user and upload the download as that user: a new flow id.
4. Build it as that user: `connection-unresolved`, naming the handle.
5. As that user, plant a connection under the same name with no scopes and its own sentinels.
6. Build again: `scope-missing`.
7. Both build streams carry none of the four sentinels.

**Test 5.**
1. Plant a superuser `google` connection holding `drive.file`, with sentinels; save a Drive flow bound to it.
2. Build it: `auth-expired`. An outage code fails naming the provider outage (see *Tags*).
3. The connection now reads `status: expired`.
4. Sweep the build stream, the monitor messages, builds and transactions of the flow (each polled until it
   has recorded the run: the vertex build is written after the stream ends), the trace list and the trace
   detail. None carries a sentinel; the trace detail records `error_code: auth-expired`.

**Test 6.**
1. Plant the same kind of connection; save a Chat Input → Drive flow bound to it.
2. Open the flow, open the Playground, send a message.
3. The error card appears. The run's code, read from its trace, is `auth-expired` (an outage code fails
   naming the outage, see *Tags*). Expanded, the card shows the `auth-expired` text. The page HTML carries
   no sentinel.
4. Close the Playground, open *Traces*, open the run: the span tree lists the Drive span; its detail shows
   `auth-expired`. The page HTML carries no sentinel.

**Test 7.**
1. Validate a component whose connection input sets `tool_mode=True`: `400` with the tool-call message.
2. Validate one whose connection input defaults to `slack/<x>` on provider `google`: `400` with the
   provider message.
3. Switch the Drive connector to Tool Mode through `POST /api/v1/custom_component/update` with
   `tool_mode: true` on its connection field: the flag is echoed back, and no tool's arguments include
   `connection` (the unflagged case is `connector-tool-mode`'s).
4. Save a Drive flow with `slack/<x>`: kept on save and on export. Build it: the provider message, and no
   resolution code (`connection-unresolved`, `scope-missing`, `auth-expired`).

---

## Validation criterion *(required)*

All seven tests pass three consecutive times at `--retries=0` with default workers against
`1.14.0.dev32` with tracing on, and these hold on every run:

- no export, import response, build stream, monitor record, trace or page carries any planted sentinel;
- the handle survives export and import, and a malformed one is nulled on export only;
- the imported Outlook node resolves to the catalog entry the manifest's `component_ref` names;
- the imported flow resolves the importer's connection and never the exporter's;
- the provider-rejected run reads `auth-expired` everywhere it is recorded, and flips the connection to
  `expired`;
- `connection` is never a tool argument, and a foreign-provider handle is refused at validation and run.

Each test except test 1's sentinel sweep (a contract guard, see above) has a force-fail mutation
executed against it, and so do test 3's build and the outage message of tests 5 and 6.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (test 7), tracing on (tests 5–6) and egress to Google (tests 5–6).
- `src/backend/base/langflow/utils/flow_secrets.py` — `_strip_template_field_value`: a `connection_ref`
  value is kept when `ConnectionRef.parse` accepts it and nulled otherwise.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_build_flows_download_response`, the flow export.
- `src/backend/base/langflow/api/v1/flows.py` — create, read, upload and download routes.
- `src/backend/base/langflow/api/v1/projects.py` — the project download and upload routes.
- `src/backend/base/langflow/api/v1/projects_files.py` — where the project download strips secrets
  (`strip_flow_secrets`), and so nulls a malformed handle.
- `src/backend/base/langflow/services/connection/service.py` — the database resolver: per owner, by
  handle.
- `src/lfx/src/lfx/integrations/models.py` — `ConnectionRef`: the handle's grammar.
- `src/lfx/src/lfx/inputs/inputs.py` — `ConnectionRefInput`: the tool-mode and provider guards.
- `src/lfx/src/lfx/custom/custom_component/component.py` — `resolve_connection`, which repeats the
  provider check at run time.
- `src/lfx/src/lfx/integrations/errors.py` — the codes asserted (`connection-unresolved`,
  `scope-missing`, `auth-expired`).
- `src/bundles/google/src/lfx_google/components/google/_workspace_client.py` — maps Google's rejection of
  the token to `auth-expired`.
- `src/bundles/microsoft/src/lfx_microsoft/components/microsoft/outlook_send.py` — `OutlookSendComponent`,
  `name = "OutlookSendMail"`.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/custom_component` and its `/update`.
- `src/backend/base/langflow/api/v1/monitor.py` and `src/backend/base/langflow/api/v1/traces.py` — the
  recorded surfaces swept in test 5.
- `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/create-project-via-api.ts`,
  `tests/helpers/integrations/create-connection.ts`, `tests/helpers/integrations/connection-probe.ts`
  (`DRIVE_LIST_TYPE`), `tests/helpers/integrations/provider-outage.ts` (the outage message),
  `tests/helpers/auth/throwaway-user.ts` and `tests/pages/PlaygroundPage.ts`.
