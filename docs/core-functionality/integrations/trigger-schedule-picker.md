# Triggers on the canvas — the Schedule picker

**File:** `tests/tests-automations/regression/core-functionality/integrations/trigger-schedule-picker.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2569)

Owning issue: #2569. The server contract (each type's compiled timing, refusals, the legacy *Update* rule) is
`docs/api/triggers/api-triggers-schedule-picker.md`. The node's badge and Enabled switch are
`trigger-node-controls.md`.

---

## What this test validates *(required)*

The Schedule node as every user now sees it since upstream
[#16322](https://github.com/langflow-ai/langflow/pull/16322): a **Schedule type** dropdown that shows only the
fields that type needs, and a searchable timezone list. Three canvas behaviours, each tied to a defect #16322's
history names:

1. **Fields per type.** Picking a type swaps the node's fields to exactly that type's set, and the saved node
   (and the trigger row compiled from it) reads back what the canvas showed.
2. **A typed cron survives a type switch.** Picks used to overwrite a hand-written cron; switching to Daily and
   back to Custom must show the cron the user typed.
3. **A saved timezone outside the list is shown and kept.** The combobox used to hide a saved value outside its
   options and clear it when the list opened, which stopped the trigger.

Measured on `1.14.0.dev39` (live scout), the fields each type shows, by their `title-…` testids (the Schedule
type and Timezone rows are always present; *After downtime* and *Share session across runs* are advanced and not
on the node):

| Type | Fields shown | Field controls |
|---|---|---|
| At regular intervals | `title-interval, in minutes` | `int_int_interval_minutes` |
| Once | `title-date and time` | `datetime_str_run_at_date`, `datetime_str_run_at_time` |
| Daily | `title-time of day` | `timeofday_str_times_of_day_0`, `timeofday_str_times_of_day_add` |
| Weekly | `title-days of the week`, `title-time of day` | `multiselect_str_days_of_week`, the time-of-day controls |
| Monthly | `title-days of the month`, `title-time of day` | `multiselect_str_days_of_month`, the time-of-day controls |
| Custom (cron) | `title-cron expression` | `popover-anchor-input-cron_expression` |

The type dropdown is `dropdown_str_schedule_type` (value in `value-dropdown-dropdown_str_schedule_type`); its
options are `<label>-<index>-option` (e.g. `Weekly-3-option`). The timezone is `dropdown_str_timezone` (value in
`value-dropdown-dropdown_str_timezone`), a combobox over 599 zones.

---

## Tags *(required)*

`@stable` `@components` `@integrations`

As the sibling canvas trigger specs (`trigger-node-controls`, `trigger-placement`). Keyless; no schedule is
enabled, so nothing fires.

---

## Step by step *(required)*

**Setup (per test).** Create the flow through the API from the live catalog (`createCatalogFlow`, one
`ScheduleTrigger` node) with the values the test needs, open it with `openFlowById`, and wait for the node
(`title-Schedule`). Skip with the reason when the catalog's template has no `schedule_type` (before
`1.14.0.dev30`). Teardown unmounts the editor (`unmountEditorForCleanup`) and deletes the flow id-scoped.

**Test 1 — the picker shows only the fields its type needs, and the saved node reads back what it showed.**

1. Start from Daily. For each type in the table, in order (At regular intervals, Once, Weekly, Monthly, Custom
   (cron), Daily): open `dropdown_str_schedule_type`, click the type's option, and assert the node's set of
   `title-…` field labels (excluding `title-Schedule`, `title-schedule type`, `title-timezone`) is **exactly**
   the table's set for that type, and the dropdown reads that type.
2. Finish on Weekly. Poll the **stored** flow (`GET /api/v1/flows/{id}`) until its node reads
   `schedule_type: "Weekly"` with `days_of_week` and `times_of_day` shown and the other picker fields hidden, and
   the stored days and time are the template defaults the canvas showed (Monday–Friday, `08:00`), and the
   trigger row's timing is exactly `cron: "0 8 * * 1-5"`, the Weekly cron for those values.

**Test 2 — a typed cron survives switching the type away and back.**

1. Start from Custom (cron) with the template's default cron. Fill `popover-anchor-input-cron_expression` with a
   per-run cron (`*/<n> * * * *`, `n` from the run) and leave the field.
2. Switch to Daily: the cron field is gone (`title-cron expression` count 0).
3. Switch back to Custom: the field shows the typed cron.
4. The stored flow's node reads `schedule_type: "Custom (cron)"` and the typed cron, and the trigger row's
   `cron` is the typed cron.

**Test 3 — a saved timezone outside the list is shown and kept when the list opens.**

1. The flow is created with Daily and timezone `posix/America/New_York` (loads on the server, not in the 599
   options). The row reads that timezone, `reason: pending`.
2. On the canvas, `value-dropdown-dropdown_str_timezone` shows `posix/America/New_York`.
3. Open the timezone list and close it with `Escape`, without picking: the value still shows the zone.
4. Make an edit that saves the node without touching the timezone (switch the type to Weekly), and poll the
   stored flow until the node reads Weekly: its `timezone` is still `posix/America/New_York`, and so is the
   trigger row's.

---

## Validation criterion *(required)*

- **Fields per type:** the exact label set per type, both directions (a field that should hide and does not
  fails as much as one that should show and does not), and the stored node plus compiled row agreeing with the
  last pick.
- **Typed cron:** the field shows the typed value after the round trip, and the stored node and row hold it. A
  pick that overwrote the cron would show the default or the Daily-compiled cron.
- **Timezone:** the value shown before and after the list opens, and still stored after a save. A combobox that
  clears an unlisted value would show the placeholder or `UTC`, and the save would store it.

---

## What this test does not cover *(and why)*

- Each type's compiled timing in detail, refusals and the legacy *Update*: the API spec (faster and exact).
- Typing a timezone into the combobox search: the saved-value case is the defect's path.
- The date-time and time-of-day widgets' own input formats.

---

## Preconditions *(required)*

- Langflow `1.14.0.dev30` or later. Earlier builds skip with the reason.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` — the inputs, `update_build_config` and `_show_picker_fields`
- `src/lfx/src/lfx/base/triggers/schedule.py` — `FIELDS_BY_TYPE`, the field set per type, and `timezone_options`
- `src/backend/base/langflow/services/triggers/schedule_config.py` — validates the stored timezone and timing
- `src/backend/base/langflow/services/triggers/scheduler.py` — runs the stored timing
- `tests/helpers/flows/build-catalog-flow.ts` — `createCatalogFlow`
- `tests/helpers/flows/open-flow-by-id.ts` — opens the flow in the editor
- `tests/helpers/flows/unmount-editor-for-cleanup.ts` — stops the editor's polling before teardown
- `tests/helpers/triggers/trigger-api.ts` — `listTriggers`
