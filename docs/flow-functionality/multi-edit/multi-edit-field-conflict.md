# Multi-edit safety — a component changed on both sides blocks the update until resolved

**File:** `tests/tests-automations/regression/flow-functionality/multi-edit/multi-edit-field-conflict.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev10`)

Owning issue: #2344 (Wave 11 — Multi-edit, instance migration & integrations; tracker #2356).
Upstream feature: multi-edit safety, `langflow-ai/langflow#14903`, follow-up `#15824`.
Related specs:
- `multi-edit-conflict-review.spec.ts` (#2342) pins how the conflict is raised and how
  changes on different components are listed.
- `multi-edit-conflict-exits.spec.ts` (#2343) pins where each exit puts the work.

This spec covers the one case those two leave out: the **same** component changed by both
people.

---

## What this test validates *(required)*

The merge is component-level: each component is taken whole from one side. When both
sides changed the same component, nothing can be merged automatically, so the dialog
makes the person choose. This is the path most likely to lose work quietly. If *Update*
went through with no choice made, or the choice were applied to the wrong side, one
person's edit would vanish with a success toast.

Every row below was measured on `1.14.0.dev10` with a live scout before any assertion was
written:

| Behaviour | Measured |
|---|---|
| **The conflicted row** (`conflict-resolve-node:<id>`) | It sits under *Your changes*, with the component's name, *"— Changes made by multiple people."*, *"Select which version to keep."* and the badge *"Action required"*. It is collapsed; `conflict-toggle-node:<id>` opens it on two radios: *"Keep my version"* and *"Keep langflow's version"* (the other session's username). Nothing is preselected. |
| **Update is gated** | `confirm-overwrite-flow` is disabled. `conflict-blocked-hint` reads *"Resolve 2 conflicts before updating this flow."*; after one choice, *"Resolve 1 conflict before updating this flow."*; after the last, the hint is gone and the button is enabled. |
| **A choice resolves the row** | It reads *"Keeping my version"* or *"Keeping langflow's version"*, the badge goes, and a checked, disabled checkbox labelled *"<component> is resolved and included"* appears. |
| **The saved value** | `POST /overwrite` → `200`. The server holds the chosen side's value for each conflicted component. |
| **An uncontested change by the other side** | It is listed under *Available changes* (`conflict-change-theirs-node:<id>`), **unchecked**. Checked, it is saved too. |
| **Long values** | A value over 60 characters is summarised as *"Input Text updated."* on both sides. *Show changes* opens the raw before/after, clipped at 800 characters or 12 lines, with *"Shown in part. Open the component to see the whole value."*. The saved value is the whole one: 994 of 994 characters. |

### Facts that shape the design

- **The badge is *"Action required"*, not *"Conflict"*** as the issue expected. The locale
  also has `multiEdit.badge.conflict = "Conflict"`, but this dialog does not render it on
  a contested row. The test asserts what is rendered.
- **Both sides edit the same field, `input_value` of a Chat Input.**
  - The other session writes it over the API.
  - The viewer types into the node's own field (`[data-id="<node>"]
    textarea_str_input_value`).
  - The viewer's autosave is refused with `409`, which is declared narrowly with
    `expectKnownHttpError`.
  - Chat Input is used because one flow can hold several of them, each with a plain text
    field on the canvas.
- **The other side's uncontested change starts unchecked** (measured here and in #2343).
  The mixed test checks it on purpose, so "exactly what was chosen" includes it.
- **The long value is the other side's**, and the test keeps it. A merge that cut the value
  to what the dialog displays would then save 800 characters, not the whole value. Keeping the
  viewer's long value would not tell those two apart, because the viewer's value is already
  on the canvas.
- **The canvas is checked too.** After the update, the canvas shows the saved version
  (`adoptServerVersionOnCanvas`), so the fields must read the chosen values.

---

## Tags *(required)*

`@workspace` `@database` `@ui-ux`

**No `@stable` yet.** It is a new UI spec with a 5 s autosave debounce in its critical path.
It waits for team validation before promotion.

---

## Step by step *(required)*

Every test builds its flow over the API from the live catalog, with Chat Input nodes named
*First Input*, *Second Input* and *Third Input*, plus a Chat Output. It then raises the
conflict:
- open the flow;
- the other session saves new values;
- the viewer types into the same field(s);
- the viewer's autosave answers `409`;
- the viewer opens *Review changes*.

An id-scoped `afterEach` deletes the flow. Waits key on this flow's responses, never on
time.

1. **A component changed on both sides blocks Update until a version is chosen, and *Keep
   my version* saves mine.**
   - *First Input*: the other session sets `their one`, then the viewer types `my one`.
   - The row shows its name, the multiple-people sentence, *"Select which version to
     keep."* and *"Action required"*.
   - *Update Current Flow* is disabled, and the hint reads *"Resolve 1 conflict before
     updating this flow."*.
   - Open the row, choose *Keep my version*. The row reads *"Keeping my version"*, the
     resolved checkbox is there, the hint is gone and *Update* is enabled.
   - Update: `POST /overwrite` → `200`. The server and the canvas hold `my one`.

2. **Keep the other person's version saves theirs whole, even past what the dialog
   shows.**
   - *Second Input*: the other session sets a 1 006-character value, then the viewer types
     `my two`.
   - Both options read *"Input Text updated."*.
   - *Show changes* on theirs shows the clipped diff and *"Shown in part. Open the component
     to see the whole value."*.
   - Choose *Keep langflow's version*. The row reads *"Keeping langflow's version"*.
   - Update: `200`. The server holds all 1 006 characters, identical to what the other
     session saved.

3. **Two conflicts resolved opposite ways, plus an uncontested change, save exactly what
   was chosen.**
   - The other session sets *First Input* to `their one`, *Second Input* to `their two`
     and *Third Input* to `their three`. The viewer types `my one` and `my two`.
   - The hint reads *"Resolve 2 conflicts before updating this flow."*.
   - Choose *Keep my version* on *First Input*. The hint now reads *"Resolve 1 conflict
     before updating this flow."*.
   - Choose *Keep langflow's version* on *Second Input*.
   - *Third Input* is listed under *Available changes*, unchecked. Check it.
   - Update: `200`. The server holds exactly `my one`, `their two` and `their three`, and
     the flow still has the same four nodes. The canvas fields read the same.

---

## Validation criterion *(required)*

- All three tests pass three consecutive times at `--retries=0 --workers=1` on the current
  nightly, and once at `--workers=4`.
- Each test fails under a mutation of its load-bearing assertion, run in isolation:
  - *Update* enabled before the choice;
  - the server holding the other value after *Keep my version*;
  - the long value saved clipped;
  - one side of the mixed merge dropped;
  - the uncontested change missing.
- Zero flows left behind, and zero undeclared `🚨 Backend Error` lines.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the superuser.
- `src/frontend/src/components/core/flowConflict/ConflictResolveRow.tsx`: the contested row, its radios, the resolved label and the badge.
- `src/frontend/src/components/core/flowConflict/ConflictDialogFooter.tsx`: `conflict-blocked-hint` and the gated `confirm-overwrite-flow`.
- `src/frontend/src/components/core/flowConflict/DuplicateFlowModal.tsx`: `chooseSide`, the unresolved count, and `buildMerged` / `onOverwrite`.
- `src/frontend/src/components/core/flowConflict/ChangeRow.tsx`: the raw diff's 800-character / 12-line clip and its notice.
- `src/frontend/src/utils/flow-diff.ts`: `contestedTargetKeys`, `applySelectedChanges`, and the 60-character inline limit.
- `src/frontend/src/hooks/flows/conflict-actions.ts`: the conflict state the dialog is rebuilt from.
- `src/frontend/src/locales/en.json`: the `multiEdit.dialog.*` and `multiEdit.badge.*` strings.
- `src/backend/base/langflow/api/v1/flow_conflict_routes.py`: `overwrite`.
- No provider key, no model, no network egress.
