# Multi-edit safety — the conflict dialog's exits keep their promises

**File:** `tests/tests-automations/regression/flow-functionality/multi-edit/multi-edit-conflict-exits.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev7`)

Owning issue: #2343 (Wave 11 — Multi-edit, instance migration & integrations; tracker #2356).
Upstream feature: multi-edit safety, `langflow-ai/langflow#14903`, follow-up `#15824`. How the
conflict is raised and listed is pinned by `multi-edit-conflict-review.spec.ts` (#2342). The
`fork` / `overwrite` API contract is pinned by `api/flows/flow-version-precondition.spec.ts`
(#2341).

---

## What this test validates *(required)*

The *Review Version Changes* dialog has three exits, and each one promises where the
viewer's work ends up. Upstream reworked the third exit inside #14903, because *"Discard
was the only exit from the conflict dialog that destroyed something"*. Every promise is
checkable on the server, so every test here asserts the **server state**, not only the
toast.

Every row below was measured on `1.14.0.dev7` with a live scout before any assertion was
written:

| Exit | Measured |
|---|---|
| **Update Current Flow** (`confirm-overwrite-flow`) | `POST /overwrite` → `200`. Toast: *"Flow updated. The version it replaced is in the history."*. The server now holds the viewer's canvas: their move, **and** `hello` on Chat Input, because the other session's change is offered unchecked and was not picked. The history gains one entry, `"Replaced by a newer edit"`, holding the other session's graph. The banner is gone. |
| **Duplicate Flow** (`confirm-duplicate-flow`) | `POST /fork` → `201`, then the editor navigates to `/flow/<copy>/folder/<folder>`. The copy, `<name> (copy)`, holds the viewer's canvas. The original keeps the other session's version and token. No `PATCH` reaches the original afterwards. Reopening the original loads the other session's version, and the next edit saves with `200`. |
| **Load Latest** (`dialog-load-latest-button`) | The footer turns into a confirmation (`load-latest-confirm`): *"Load the latest version?"* / *"Your current selections and unsaved edits will be discarded and replaced with the latest version of this flow."*. Then `load-latest-confirm-button` sends `POST /versions/` → `201`, with description `"Saved when discarding a conflict"` and the viewer's canvas as `data`. Toast: *"Your changes are in version history. The canvas shows the latest version."*. The canvas shows the other session's text, and the server is unchanged. Restoring that entry from version history brings the viewer's edit back: `POST …/activate` → `200`. |
| **Moved again while choosing** | The other session saves a second time while the dialog is open. *Update* then gets `POST /overwrite` → `409`, and the toast *"Someone saved again while you were choosing. The changes below are up to date."*. The dialog stays open and now lists *"Input Text updated from hello to <second text>."*. The server keeps the second save. |
| **Cancel** | The dialog closes, the banner stays, and the server is unchanged. |
| **Archive failure** | With `POST /versions/` forced to `500`, the frontend retries it (4 requests, about 7 s). Then it shows *"Your changes could not be saved to version history, so nothing was discarded."*. The confirmation, the dialog and the banner stay, the server is unchanged, and the history is empty. |

### Facts that shape the design

- **The conflict is staged the same way as in #2342.** The other session's API
  `PATCH` changes Chat Input's text; the viewer drags *Mine Prompt*; the viewer's
  autosave is refused with `409`. The two edits touch **different** components on
  purpose. A component both sides changed is *contested* and keeps *Update* disabled
  until it is answered (`conflict-blocked-hint`). That gate is a separate behaviour and
  is not what these exits promise.
- **The other session's changes start unchecked** (measured). *Update* therefore writes
  the viewer's canvas over the other version, and the test asserts that, plus the
  archive of what it replaced. Adopting a checked change is a merge feature, outside
  this issue.
- **The issue's *saveBlocked* premise is not reachable from the UI.** The issue expects
  an edit in the original tab after *Duplicate* to show *"This flow was duplicated, so
  it is no longer being saved. Open it again to continue editing."*, with no `PATCH`.
  But *Duplicate* navigates to the copy at once, and reopening the original calls
  `resumeFlow` (`flowStore.resetFlow`). That clears the abandonment, by upstream's
  design (*"leaving the mark in place left the flow permanently unsaveable for the
  rest of the session"*). Measured: reopening and editing saves with `200`, and no
  notice appears. The abandonment only catches a save still queued against the
  original at the moment of the fork.
  - What the test asserts instead is the observable half of that promise: **no `PATCH`
    reaches the original** from the fork until it is reopened.
  - The test also asserts the *"Open it again to continue editing"* half: reopening
    shows the other session's version, and an edit saves normally.
  - The notice itself stays uncovered.
- **The archive-failure branch is isolated**, so it is covered. Only `POST
  /api/v1/flows/{id}/versions/` is routed to `500`; every other call is real.
- **Deliberate HTTP errors are declared narrowly** with `page.expectKnownHttpError()`:
  - the viewer's refused autosave, `PATCH /api/v1/flows/{id}` → `409`, in every test;
  - the refused overwrite, `POST …/overwrite` → `409`, in the moved-again test;
  - the forced archive failure, `POST …/versions/` → `500`.

  Each declaration also fails its test if the response stops happening.
- **Restoring from history goes through the UI** (version-history panel → the entry →
  *Restore* → *Restore*), since that is the path the toast sends the person to. The
  list has no testids, so the entry is located by its description,
  `"Saved when discarding a conflict"`. That text is the promise under test.

---

## Tags *(required)*

`@workspace` `@database` `@ui-ux`

**No `@stable` yet.** It is a new UI spec with a 5 s debounce in its critical path. The
archive-failure test also waits out the frontend's retries (about 7 s). It waits for
team validation before promotion.

---

## Step by step *(required)*

Every test builds its flow over the API from the live catalog (`createCatalogFlow`):
- *Chat Input* (`input_value: "hello"`), *Chat Output* and a Prompt Template, *Mine
  Prompt*. Prompt Template is used rather than Text Input because Text Input is
  `legacy: true`.

It then raises the conflict:
- open the flow;
- the other session sets Chat Input to `"their text"`;
- the viewer drags *Mine Prompt*, and its autosave answers `409`;
- the viewer clicks *Review changes*.

Each test opens the flow with `openFlowById`, and an id-scoped `afterEach` deletes every
flow it created, the fork included. Waits key on this flow's responses, never on time.

1. **Update Current Flow writes the viewer's work and keeps the replaced version.**
   - Click *Update Current Flow*. `POST /overwrite` answers `200`, and the
     `overwriteSucceeded` toast appears.
   - The server has *Mine Prompt* moved off its starting position and Chat Input back
     at `hello`.
   - The history holds exactly one entry, `"Replaced by a newer edit"`. Its `data` has
     Chat Input at `their text`, which is the replaced version.
   - The banner is gone.

2. **Duplicate Flow puts the viewer's work in a new flow and leaves the original alone.**
   - Click *Duplicate Flow*. `POST /fork` answers `201`, and the editor lands on
     `/flow/<copy id>`.
   - The copy is named `<original> (copy)`, has *Mine Prompt* moved and Chat Input at
     `hello`.
   - Edit the copy and wait for its autosave (`200`). That save comes after the
     debounce, so any save still queued for the original would already have been sent.
     None was: no `PATCH` reached the original.
   - The original is unchanged: Chat Input at `their text`, *Mine Prompt* at its
     starting position, and the same `version_token` as before the exit.
   - Reopen the original.
   - The reopened canvas shows `their text`. An edit there saves with `200`, and no
     banner or *saveBlocked* notice appears.

3. **Load Latest asks first, archives the viewer's canvas, and that archive restores.**
   - Click *Load Latest*. The confirmation shows its title and description.
   - Confirm. `POST /versions/` answers `201`, and the `discardSucceeded` toast appears.
   - The canvas and the server show `their text`. The server token is unchanged, and
     the banner is gone.
   - The history holds exactly one entry, `"Saved when discarding a conflict"`. Its
     `data` has *Mine Prompt* moved.
   - Restore it: open version history, select the entry, *Restore*, then *Restore*.
     `POST …/activate` answers `200`.
   - The server now has *Mine Prompt* moved and Chat Input at `hello`. The viewer's
     edit is back.

4. **A second save while choosing is not overwritten.**
   - With the dialog open, the other session sets Chat Input to `"their second text"`.
   - *Update* gets `POST /overwrite` → `409` and the `overwriteMovedAgain` toast.
   - The dialog stays open and lists *"Input Text updated from hello to their second
     text."*.
   - The server still has `their second text`.

5. **Cancel changes nothing.**
   - Click *Cancel*. The dialog closes and the banner is still shown.
   - The server's token, text and positions are the ones from before the dialog opened.

6. **A failed archive discards nothing.**
   - Route `POST /api/v1/flows/{id}/versions/` to `500`.
   - *Load Latest*, then confirm. The `discardArchiveFailed` error appears.
   - The confirmation and the dialog are still open, and the banner is still shown.
   - The server is unchanged (same token, `their text`), and the history is empty.

---

## Validation criterion *(required)*

- All six tests pass three consecutive times at `--retries=0 --workers=1` on the
  current nightly, and once at `--workers=4`.
- Each test fails under a mutation of its load-bearing assertion, run in isolation:
  - the overwrite keeps B's text;
  - the original changed after the fork;
  - the archive entry is absent;
  - the restore does not bring back the move;
  - the second save is overwritten;
  - cancel changed the token;
  - the history after a failed archive is not empty.
- Zero flows left behind, and zero undeclared `🚨 Backend Error` lines.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the superuser.
- `src/frontend/src/components/core/flowConflict/ConflictDialogFooter.tsx`: the exit buttons, the in-place Load Latest confirmation, and their testids.
- `src/frontend/src/components/core/flowConflict/DuplicateFlowModal.tsx`: `onOverwrite`, `onDuplicate`, `handleOverwriteRefusal`, and the merge of unselected changes.
- `src/frontend/src/hooks/flows/use-take-latest-version.ts`: archive first, abandon on failure.
- `src/frontend/src/hooks/flows/conflict-actions.ts`: `fetchAndAdoptServerVersion`, `attachTheirFlow`, `refreshConflictState`.
- `src/frontend/src/stores/flowConflictStore.ts`: `abandonFlow` / `resumeFlow`.
- `src/frontend/src/stores/flowStore.ts`: `resetFlow`, which resumes an abandoned flow on reopen.
- `src/frontend/src/hooks/flows/handle-blocked-save.ts`: the *saveBlocked* notice this spec records as unreachable.
- `src/frontend/src/pages/FlowPage/components/PageComponent/components/RestoreVersionButton.tsx`: the Restore banner and its confirmation.
- `src/backend/base/langflow/api/v1/flow_conflict_routes.py`: `fork` and `overwrite`.
- `src/backend/base/langflow/api/v1/flow_fork.py`: the fork payload.
- `src/backend/base/langflow/api/v1/flow_version.py`: the snapshot `POST` and `activate`.
- `src/frontend/src/locales/en.json`: the `multiEdit.dialog.*` and `multiEdit.loadLatest.*` strings.
- No provider key, no model, no network egress.
