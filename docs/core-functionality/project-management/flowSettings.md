# Spec: Flow settings — name & description edit with character limits (§12.2 View and Edit Flow)

**Test file:** `tests/tests-automations/regression/core-functionality/project-management/flowSettings.spec.ts`

**Last validated:** Langflow 1.12.x

---

## What this test validates

The flow-settings modal (opened from the flow header `flow_name`) lets a user
edit a flow's **name** and **description**, enforces a **character limit** on
each field, persists the saved values, and reopens showing exactly what was
saved. This is the "edit flow metadata" half of §12.2.

Concretely:

1. Both fields **cap input at their maximum length** — filling past the limit
   truncates the value in place and surfaces a **"Character limit reached"**
   message (description cap is **250** characters on 1.11).
2. Saving a valid name + a (truncated) description **succeeds** — the modal
   closes (upstream `handleSubmit` only closes on a resolved save; the error
   path keeps it open, so a closed modal is the deterministic success signal).
3. Reopening the modal shows the **persisted** name and description — proving
   the save round-tripped through the backend, not just the local form.

## Hardening rationale (why a rewrite, not a bare promotion)

The pre-#681 test could pass without validating anything: every gate in its
body was a **non-awaiting `locator.isVisible()` / `isEnabled()` whose boolean
was discarded** (`flow_name`, "Character limit reached", `save-flow-settings`,
"Changes saved successfully" — lines 16/28/39/43), it **clicked a fading toast**
as its success signal (racing the toast's own auto-dismiss), used the weak
`expect(a == b).toBeTruthy()` pattern (a comparison bug hides as a pass), and
**left its flow behind** (no cleanup). Those are exactly the conditions a
validate-&-promote issue must fix before `@stable`. The rewrite replaces every
discarded query with a real auto-waiting `expect`, uses modal-closed as the
save signal (matching the already-hardened `renameFlow` helper, #357), captures
the truncated values from the fields rather than trusting a hand-typed 250-char
literal, and adds id-scoped flow cleanup.

---

## Tags

`@stable` `@release` `@workspace`

(`@release` `@workspace`: flow lifecycle/metadata management. `@api` dropped —
the test drives the UI modal, not the REST API directly. `@stable` applied by
#681 after deterministic burst validation.)

---

## Step by step

1. Bootstrap and open a blank flow; capture the flow id from `/flow/{id}` for
   cleanup. Let the editor's autosave settle (`waitForFlowSaveSettled`) before
   touching the modal, so an in-flight `PATCH` does not re-render it mid-edit.
2. Open the settings modal with `openFlowSettings(page)` — the shared header
   opener, which drives the `menu_bar_display` button once it reports enabled
   rather than clicking the `aria-hidden` `flow_name` span inside it (#1215).
3. **Name limit:** fill `input-flow-name` with an overlong string; assert
   "Character limit reached" is visible and the field value was truncated
   (shorter than the input).
4. Fill `input-flow-name` with a valid random name.
5. **Description limit:** fill `input-flow-description` with a ~1000-char
   string; capture the truncated value and assert it is **250** characters
   (the enforced cap).
6. Assert `save-flow-settings` is enabled; click it; assert the modal closed
   (`input-flow-name` hidden) — the save succeeded.
7. Reopen the modal via `renameFlow(page)` with no edits (reads the persisted
   values, asserts save is disabled with no change, cancels).
8. Assert the persisted name equals the random name and the persisted
   description equals the captured 250-char truncation.

---

## Validation criterion

| Step | Criterion |
|---|---|
| Overlong name | "Character limit reached" visible; field value truncated |
| Overlong description | field value capped at exactly 250 chars |
| Save | `save-flow-settings` enabled → click → modal (`input-flow-name`) closes |
| Reopen | persisted name == the random name; persisted description == the 250-char truncation |
| No-change reopen | `save-flow-settings` disabled (nothing to save) |

Each assertion is a real auto-waiting `expect`; a regression in the limit
enforcement, the save round-trip, or the persistence fails a specific step.

---

## External dependencies

- Modal testids: `menu_bar_display` (the header button the opener drives),
  `flow_name` (read only — the header's committed name), `input-flow-name`,
  `input-flow-description`,
  `save-flow-settings`, `cancel-flow-settings` (scouted live; renaming breaks
  the test).
- "Character limit reached" copy (`flow.characterLimitReached`).
- Description max length = 250 (1.11 nightly); a change to the cap changes the
  captured length assertion.
- `renameFlow` helper (already hardened, #357) for the reopen/read/cancel path.
- `waitForFlowSaveSettled` helper (avoids the autosave-vs-modal re-render race).

---

## What this test does not cover

- The REST `PATCH /api/v1/flows/{id}` path directly (covered by API specs);
  this asserts the UI modal round-trip.
- Endpoint-name / other flow-settings fields beyond name + description.
- Duplicate-name rejection (`flow.nameAlreadyExists`).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required.

---

## Flow cleanup

The test creates one blank flow. Its id comes from the `POST /api/v1/flows` → 201
**response**, not from the canvas URL — the URL races the bootstrap flow's stale id
(blank-flow opens behind the templates modal), which is what previously deleted the
wrong flow and leaked the renamed one. Capture and teardown are the shared
`trackCreatedFlows` helper since #1108, so the `afterEach` deletes id-scoped
(404-tolerant) via the API and reports a failed delete instead of swallowing it.
Behavioral force-fail: stop the tracker from matching the creation endpoint and the
flow count grows while the test still passes.

### Opening the header must drive the button, not the span (#1215)

`flow_name` is an **`aria-hidden` `<span>` inside** the `menu_bar_display` button,
which upstream renders as `disabled={isReadOnly}` with

```ts
useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId, "write"))
```

i.e. it fails **closed** for the whole time `POST /api/v1/authz/me/permissions` is
in flight — deliberately, per its own docstring. A `<span>` is not a form control,
so Playwright's actionability check never covers that disabled state: a click
landed in the window is swallowed by the browser with **no error at all**, and the
failure surfaces later and elsewhere (a control inside the dialog that never
appears). Two of the four signatures #1005 classified were exactly that.

This spec therefore opens the popover through `openFlowSettings(page)`, which
asserts the header is present, waits for the **button** to report enabled, and
then clicks it. The `disabled` attribute arrived upstream on 2026-07-15
(`887f2a552d`, langflow-ai/langflow#14068), so it is live on the nightly the daily
runs.
