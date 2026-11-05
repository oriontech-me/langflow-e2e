# Connector runs — the integration's own error on the canvas, and a connection field no edge can reach

**File:** `tests/tests-automations/regression/core-functionality/integrations/connector-run-errors.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev7`)

Owning issue: #2355 (Dedicated Integrations, Wave 11). It covers upstream langflow#15773 (integration codes and hints
kept in workflow errors) and #15753 (no canvas handle on a `connection_ref` field), both merged into `release-1.13.0`
on 2026-10-14/15. It also covers the page half of #15763. The API half of #2355 is in
`docs/api/connections/api-connections-health.md`.

---

## What this test validates *(required)*

Measured on `1.14.0.dev7`, on a Drive *List Files* node (`ext:google:GoogleDriveListComponent@official`), whose only
required input is its connection.

### 1. A connector failure reaches the canvas with its code and its hint (langflow#15773)

Before #15773 the canvas showed only the short message of an integration failure, without the recovery advice. Now
a node run from the canvas goes through `POST /api/v2/workflows` with `mode: stream` and `stream_protocol: agui`. Its
terminal `RUN_ERROR` event carries the integration error's `code`, and a message made of the error's message, a blank
line and its hint. The canvas renders it as `[<code>] <message>`, with the hint on its own line. It shows it twice:
in the node's *Flow build failed* panel, and in the *Workflow run failed* notice.

Measured for a handle no connection carries:

```
RUN_ERROR  {"code": "connection-unresolved",
            "message": "Connection 'google/<handle>' could not be resolved. Configure the connection for this execution environment.\n\nConfigure the connection for this execution environment."}
canvas     Workflow run failed
           [connection-unresolved] Connection 'google/<handle>' could not be resolved. Configure the connection for this execution environment.
           Configure the connection for this execution environment.
```

The hint repeats inside `connection-unresolved`'s own message. `ConnectionUnresolvedError` builds its message from the
hint, and the translator appends the hint whenever it is not the **whole** message. Recorded, not asserted beyond the
exact text above.

For an expired credential the same surface reads `[auth-expired] The provider credential is expired or was rejected.`
and *"Reconnect the integration and try again."*. The issue's sentinel rule holds there: the token planted on the
row appears nowhere in the run stream or on the page.

**The fixture's gate agrees.** The run fails on purpose, so the test calls `page.allowFlowErrors()`. That hatch
suppresses the gate, not the report. `page.flowErrorReport()` must still count the run as a **failure** naming the
message, not as an unread or provider-outage stream. That is the end-to-end half of the unit test in the API spec doc
(§ 4).

### 2. The connection's page shows what the run found (langflow#15763, page half)

The API spec doc § 1 has the measurement. A run refused for an expired credential writes `expired` / `unhealthy` on
the row itself. Here the same run is started from the canvas, and `/settings/connections` then shows that row with
the badge `Expired`. It still does after a reload. Nobody pressed *Check credential*.

### 3. A connection field has no handle, so no edge can reach it (langflow#15753)

Before #15753 every connector's connection field carried a grey input handle that could never accept an edge. No
output emits `connection_ref`, and the field has no `input_types`. Measured on a flow holding a *Chat Input* and a
Drive *List Files* node:

- Drive *List Files*' handles are exactly `handle-googledrivelistcomponent-shownode-query-left` and
  `…-files-right`. The connection field (`connectionref_connection_ref_connection`) is on the node and has none.
- From *Chat Input*'s output (`handle-chatinput-shownode-chat message-right`), a click-to-connect onto the connection
  field and a drag onto it each leave **0** edges.
- **The control:** the same click-to-connect onto `query` draws **1** edge. The saved flow's only edge targets
  `fieldName: query`, so the mechanism works and the absence above is the field's, not the gesture's.

---

## Tags *(required)*

`@stable` `@integrations` `@ui-ux`.

`@stable` because nothing here needs a provider key, a tenant or the network. The expired credential is refused
inside the instance.

---

## Step by step *(required)*

Runs as the superuser, because the canvas under auto-login cannot switch users. Flows are created through the API
from the component catalog (`createCatalogFlow`). Every flow and connection a test creates is deleted after it, by id.

**Test 1 — a connector that cannot resolve its connection shows the integration's code and hint, on the canvas and
in the run stream.**
1. Save a Drive *List Files* flow bound to a handle no connection carries. Allow the deliberate flow error.
2. Open the flow and press the node's run button (`button_run_drive: list files (app files)`).
3. The run's `RUN_ERROR` event carries `code: connection-unresolved` and the message measured above.
4. The canvas shows `[connection-unresolved] Connection '<handle>' could not be resolved. …` and the hint line.
5. `page.flowErrorReport()` counts the run: `evaluated ≥ 1`, and one failure whose message is the resolution
   message. Nothing is unevaluated.

**Test 2 — a run refused for an expired credential says so with its code and hint, leaks no token, and leaves the
connection Expired on its page.**
1. Plant a Google row holding `drive.file`, with a sentinel token and an `expires_at` in the past. It reads `ready`.
2. Save a Drive *List Files* flow bound to it, open it, and run the node.
3. The `RUN_ERROR` carries `code: auth-expired`, and the canvas shows `[auth-expired] The provider credential is
   expired or was rejected.` and *"Reconnect the integration and try again."*. The sentinel is in neither the stream
   nor the page.
4. Open `/settings/connections`. The row (`connection-row-<name>`) shows `Expired`, and still does after a reload. The
   API row reads `expired` / `unhealthy`.

**Test 3 — a connection field has no canvas handle, so no edge can reach it.**
1. Save a flow with a *Chat Input* and a Drive *List Files* node, no edges, and open it.
2. The Drive node shows its connection field and exactly the two handles measured above. None of them is the
   connection's.
3. Click-to-connect from *Chat Input*'s output onto the connection field, then drag the same output onto it. The
   canvas still has 0 edges.
4. Click-to-connect onto `query`: 1 edge. After the autosave, the saved flow has one edge, and its target handle's
   `fieldName` is `query`.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev7`. Every assertion is on
an exact code, message or count, and each absence (no handle, no edge, no token) sits next to a control that shows
the same check can see a presence. No flow or connection with this spec's names is left after the run.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser), with the Google bundle
  installed (the nightly ships it).
- No provider key, no OAuth registration, no network egress.
- `src/lfx/src/lfx/workflow/agui_translator.py` — the `RUN_ERROR` message and `code`.
- `src/lfx/src/lfx/schema/message.py` — `ErrorMessage` keeping the integration error's `code` and `solution`.
- `src/frontend/src/controllers/API/agui/run-flow-bridge.ts` — `[code] message` on the canvas.
- `src/frontend/src/CustomNodes/GenericNode/components/RenderInputParameters/utils.ts` — `computeDisplayHandle`
  returning `false` for a `connection_ref` field.
- `src/backend/base/langflow/services/connection/service.py` — the run-time expiry the page shows.
- `src/lfx/src/lfx/integrations/errors.py` — the codes, messages and hints.
