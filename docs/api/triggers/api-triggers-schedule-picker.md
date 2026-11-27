# Triggers API — the Schedule picker is compiled on the server

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-schedule-picker.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2569)

Owning issue: #2569. The canvas half (which fields each type shows, typing a cron, a timezone outside the list
in the dropdown) is `docs/core-functionality/integrations/trigger-schedule-picker.md`. The row lifecycle
(enable, pause, node removal) is `docs/api/triggers/api-triggers-lifecycle.md`.

---

## What this test validates *(required)*

Since `1.14.0.dev30` (upstream [#16322](https://github.com/langflow-ai/langflow/pull/16322)) the Schedule trigger
asks for a **schedule type** instead of a cron: *At regular intervals*, *Once*, *Daily*, *Weekly*, *Monthly* or
*Custom (cron)*, plus a timezone from a searchable list. Flow save reconciles the node into a trigger row, and the
row's `config` carries the timing the scheduler runs on.

The suite only touched this as compatibility (`api-triggers-lifecycle` and `api-triggers-run-identity` send
`schedule_type: "Custom (cron)"`). This file pins the picker's server contract, and in particular the defects
#16322's own history names:

1. **Compiled on the server.** The cron used to be compiled only when the canvas sent a field refresh, so a flow
   saved through the API, an import or the Assistant ran a **stale** cron. Every flow here is saved through the
   API only, and each type must produce its own timing.
2. **An unusable pick stops the schedule.** An invalid pick (Weekly with no days) used to keep the old schedule
   running, and enabling it reported an invalid cron, a field the user cannot see. Now the row stores an empty
   cron, reads `config_invalid`, and enabling it is refused with the picker's own reason.
3. **A custom cron survives.** A pick used to overwrite a hand-written cron.
4. **A timezone that loads but is not listed** is kept (the list is the interpreter's `available_timezones()`;
   a zone such as `posix/America/New_York` loads but is not in it). An unknown zone is refused with its reason.
5. **A node saved before the picker** keeps its own cron, both on save and through the editor's *Update*
   (`POST /api/v1/custom_component` with the saved node), instead of opening on the picker defaults.

**The timing is not always a cron**, contrary to the issue's title: *At regular intervals* stores
`interval_minutes`, *Once* stores `run_at`, and *Daily* with times at different minutes stores a `crons` list.

---

## Tags *(required)*

`@stable` `@api` `@integrations`

As the sibling `api/triggers/` specs. Keyless, no network, and no schedule here is ever enabled except the
refused one, so nothing fires during a run. Every flow is created by this file and deleted id-scoped, which
deletes its trigger row.

---

## Measured contract (`1.14.0.dev39`)

Each row below is a flow saved through `POST /api/v1/flows/` with one Schedule node, read back through
`GET /api/v1/triggers?flow_id=…`. Only the timing key and the timezone are shown; every row also carries
`catchup_policy: "coalesce"` and `share_session: false`, and reads `state: pending`, `reason: pending`.

| Type and picked values | Stored timing | Timezone |
|---|---|---|
| At regular intervals, `interval_minutes: 15` | `interval_minutes: 15` | `America/Sao_Paulo` |
| Once, `run_at: "2030-12-24T18:30"` | `run_at: "2030-12-24T18:30"` | `Europe/Berlin` |
| Daily, `08:00`, `12:00`, `18:30` | `crons: ["0 8,12 * * *", "30 18 * * *"]` | `UTC` |
| Daily, `6:30 PM` | `cron: "30 18 * * *"` | `UTC` |
| Weekly, Mon–Wed + Fri, `09:15` | `cron: "15 9 * * 1-3,5"` | `Asia/Tokyo` |
| Monthly, days 1, 15, 31, `07:00` | `cron: "0 7 1,15,31 * *"` | `UTC` |
| Custom (cron), `*/7 3 * * 1-5` | `cron: "*/7 3 * * 1-5"` | `UTC` |

Refusals:

| Pick | Row | Enable |
|---|---|---|
| Weekly, no days | `cron: ""`, `reason: config_invalid`, `last_error: "Pick at least one day of the week."`, `blocked_actions.resume: "config_invalid"` | `409`, `detail: {code: null, message: "Pick at least one day of the week."}` |
| Daily, `25:00` | `cron: ""`, `config_invalid`, `last_error: "Write the time of day as 18:30 or 6:30 PM; got '25:00'."` | not measured |
| Daily, timezone `Etc/Unknown` | `config_invalid`, `last_error: "Unknown timezone; use an IANA timezone name."` | not measured |

The editor's *Update* (`POST /api/v1/custom_component`, the current code plus the saved node):

| Saved node | Opens as |
|---|---|
| No `schedule_type`, cron `5 4 * * *` (saved before the picker) | `schedule_type: "Custom (cron)"`, cron `5 4 * * *`, the cron field shown |
| `schedule_type: "Daily"`, cron `5 4 * * *` | stays `Daily` (the cron is not a reason to switch) |
| No `schedule_type`, cron equal to the picker defaults (`0 8 * * 1-5`) | the picker defaults (`Weekly`): nothing to preserve |

---

## Step by step *(required)*

**Setup.** A bearer token, and the component catalog (`fetchComponentCatalog`). Every test first checks that
the catalog's `ScheduleTrigger` template has `schedule_type` and skips with the reason when it does not (a
build before `1.14.0.dev30`). Flows are built with `buildCatalogFlow` and one node, `ScheduleTrigger-…`, and
each test reads the reconciled row with a poll until the flow has exactly one trigger bound to that node.

**Test 1 — each schedule type compiles on the server from a flow saved through the API.** For each row of the
first table: create the flow, read the row, and assert the timing **exactly**: the expected timing key with its
value, no other of `cron`, `crons`, `interval_minutes`, `run_at`, and the picked timezone. `reason` is
`pending`.

**Test 2 — an unusable pick stores no timing, reads config_invalid, and enabling it is refused with the picker's
reason.**

1. A Daily flow (`08:00`) reads `cron: "0 8 * * *"`, `pending`.
2. `PATCH /api/v1/flows/{id}` to Weekly with no days: the row now reads `cron: ""`, `reason: config_invalid`,
   `last_error` the picker message, `blocked_actions.resume: "config_invalid"`. The old cron is gone, so the old
   schedule cannot keep running.
3. `POST /api/v1/triggers/{id}/enable` → `409` with `detail` exactly `{code: null, message: <picker message>}`,
   never a cron error.
4. A Daily flow with `25:00` reads `cron: ""`, `config_invalid`, and the time-of-day message.

**Test 3 — a custom cron survives switching the type away and back.** Custom `*/9 * * * *` → row
`cron: "*/9 * * * *"`; `PATCH` to Daily `08:00` → `cron: "0 8 * * *"`. Then read the **stored** flow
(`GET /api/v1/flows/{id}`): its node's `cron_expression` is still `*/9 * * * *` (the compiled Daily cron was not
written over it). Switch that stored node back to Custom and `PATCH` it → `cron: "*/9 * * * *"` again. Building
the last `PATCH` from the stored flow, not from the test's own copy, is what makes this a check of the server.

**Test 4 — a timezone that loads but is not listed is kept, and an unknown one is refused.** Daily with
`posix/America/New_York`: the catalog's timezone options do not list it, and the row keeps it with
`reason: pending`. Daily with `Etc/Unknown`: `config_invalid` and the unknown-timezone message.

**Test 5 — a node saved before the picker keeps its own cron, on save and through Update.**

1. A flow whose node has no `schedule_type` and cron `5 4 * * *` reads `cron: "5 4 * * *"`.
2. `POST /api/v1/custom_component` with that node → `200`, `schedule_type: "Custom (cron)"`,
   `cron_expression: "5 4 * * *"` and the cron field shown.
3. The same with a Daily node holding a different cron → stays `Daily`.
4. The same with a picker-less node whose cron equals the picker defaults → opens on the default type.

**Teardown.** Delete every flow this file created, id-scoped; the trigger rows go with them.

---

## Validation criterion *(required)*

- **Server compile:** each type's exact timing, with no other timing key. A server that ran the stored cron (the
  pre-fix bug) would answer the template's default cron for every API-saved flow, and fail every row but Custom.
- **Unusable pick:** the empty cron after the `PATCH` (the old schedule cannot run) and the `409` carrying the
  picker's message. A regression to "keep the old schedule" keeps `0 8 * * *`; one to the cron error changes the
  message.
- **Custom survives:** the last `PATCH` reads `*/9 * * * *` again. A pick that overwrote the cron would read the
  Daily cron.
- **Timezone:** the unlisted zone kept, the unknown one refused with its message.
- **Legacy:** the row keeps `5 4 * * *`, and *Update* opens it on Custom with that cron. A regression to the
  picker defaults opens `Weekly`.

---

## Notes

- `posix/America/New_York` is used because it loads on the nightly image (its tzdata ships the `posix/` tree)
  and is not in `available_timezones()`. If an image drops the `posix/` tree, Test 4's first half fails with
  `config_invalid`, which names the cause.
- *Update* needs `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (set by `scripts/start-langflow-docker.sh` and the CI
  service containers): `POST /api/v1/custom_component` is the custom-component route.

---

## What this test does not cover *(and why)*

- The canvas: the sibling UI spec.
- When a schedule fires (the scheduler's clock): no schedule is enabled here, by design.
- `catchup_policy` and `share_session`: unchanged by the picker; asserted only as present.

---

## Preconditions *(required)*

- Langflow `1.14.0.dev30` or later (the picker). Earlier builds skip with the reason.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` for Test 5's *Update* steps.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` — the component: `trigger_config`, `update_frontend_node` (the legacy rule), `_picker_disagrees`
- `src/lfx/src/lfx/base/triggers/schedule.py` — `picker_timing`, `schedule_timing`, the picker messages and `timezone_options`
- `src/backend/base/langflow/services/triggers/schedule_config.py` — `validate_schedule_config`, the unknown-timezone refusal
- `src/backend/base/langflow/services/triggers/scheduler.py` — runs the stored timing
- `src/lfx/src/lfx/custom/utils.py` — `update_rebuilt_node`, where *Update* calls `update_frontend_node`
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/custom_component`
- `tests/helpers/flows/build-catalog-flow.ts` — builds the flow from the live catalog
- `tests/helpers/triggers/trigger-api.ts` — `listTriggers`, `TriggerRead`
