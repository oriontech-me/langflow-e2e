# Settings → Messages — history shows sent messages in order with working filters

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev6`)

---

## What this test validates *(required)*

The message-history table on **Settings → Messages** is the operator's audit
surface for everything exchanged in the Playground. After a two-message agent
conversation, the test validates that:

1. **The table's column contract holds** — every column the history feature
   promises (`timestamp`, `text`, `sender`, `sender_name`, `session_id`,
   `files`, `id`, `flow_id`, `properties`, `category`, `content_blocks`) is
   present in the grid. The check is **superset-tolerant**: upstream adding
   new columns (1.11 added `context_id`, `edit`, `duration`,
   `session_metadata`) must not fail the test; a promised column *removed*
   must.
2. **Messages appear oldest first (chronological)** — the grid renders the
   API order, and **1.12 flipped that order on purpose**: `monitor.py`
   `get_messages` no longer hardcodes `.desc()`; it now exposes `order_by`
   (default `timestamp`) and `order` (default **`ASC`**), validated against
   `ALLOWED_MESSAGE_ORDER_FIELDS` / `{ASC,DESC}`, and applies
   `order_col.desc()` only when `order == DESC` (verified in the shipped
   `1.12.0.dev5` source). The newest-first premise this spec carried for 1.11
   (#616) is dead **by design**, not by regression — see the ordering-history
   note below.
3. **Content integrity** — both sent prompts appear verbatim in the `text`
   column; `sender` distinguishes `User` from the machine/agent side.
4. **Column filters work** — filtering `sender` by "Equals User" leaves only
   User rows; clearing the filter restores the full row set.

## Virtualization note *(what broke in #616)*

AG Grid **virtualizes columns horizontally**: header cells outside the
scrolled-into-view region are NOT in the DOM, so
`expect(locator).toBeVisible()` on a fixed `col-id` fails as "element(s) not
found" the moment the column set grows wide enough to push that column off
the initial viewport. That is exactly what happened on the 1.11 nightly — the
`id` column was never removed (the original 11 columns all still exist; 15
render in total); four new upstream columns widened the grid past the
viewport. The column contract is therefore asserted by **collecting all
`col-id`s while sweeping the grid's horizontal scroll**, never by
per-column DOM visibility.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@api` `@settings`

Promoted to `@stable` in #946 after the ordering premise was re-derived from the
1.12 backend (`order=ASC` default) and the spec ran clean in a 3x `--retries=0`
burst on nightly `1.12.0.dev6`.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` set — the flow is the Simple Agent template driven through
  `initialGPTsetup` (the test skips without the key).
- Run with `--workers=1` for local validation (agent-family convention —
  named template loads collide under parallelism).

---

## Step by step *(required)*

1. Bootstrap to the templates modal, load the **Simple Agent** template, run
   `initialGPTsetup` (model pinned via `resolveGptModel`, in-dropdown ranking
   fallback).
2. Open the Playground; send `Hello, how are you?`; wait for the agent to
   finish (Stop button appears → hidden) and assert a non-empty response.
3. Send `What is 2+2?`; same wait + non-empty assertion.
4. Close the Playground; navigate **Settings → Messages**.
5. **Column contract:** sweep the grid horizontally collecting every
   `.ag-header-cell` `col-id`; assert the collected set contains all 11
   promised columns (superset-tolerant).
6. **Order:** read all `timestamp` cells (≥ 4 rows expected: 2 user + 2
   agent); assert they parse (≥ 4 parseable, so the check is never vacuous)
   and are **monotonically ascending**. Monotonicity alone also holds for a
   reversed grid, so it is paired with a direction-sensitive check: the row
   index of `Hello, how are you?` must be **less than** the row index of
   `What is 2+2?` in the `text` column.
7. **Content:** `sender` column contains `User` and a machine/agent value;
   `text` column contains both prompts verbatim.
8. **Filter:** click the `sender` header's dedicated filter button
   (`.ag-header-cell-filter-button` — the old `.ag-icon-menu` + "Filter" tab
   flow no longer exists on 1.11); pick "Equals", type `User`; assert every
   remaining row's sender is `User`; clear the value; assert the row count
   is restored (> filtered, ≥ 4).

---

## Validation criterion *(required)*

- The collected column-id set ⊇ the 11 promised columns.
- Timestamps render in ascending (oldest-first) order, with ≥ 4 parseable
  timestamp cells after two exchanges; the first prompt sent renders above the
  second one.
- Both prompts present verbatim; `User` and machine senders both present.
- "Equals User" filter yields only User rows; clearing restores the full set.

---

## Flow cleanup *(required)*

The test creates one flow (Simple Agent template). Every `POST
/api/v1/flows` → 201 id is tracked and deleted in `test.afterEach`
(id-scoped — never name-based or delete-all). Deleting the flow also
cascades its messages, leaving the shared instance clean. Behavioral
force-fail contract: no-op the cleanup and the flow count grows.

---

## What this test does not cover *(optional)*

- Message editing / deleting through the table (`edit` column actions).
- Session-scoped views (`session_metadata`, session rename) — covered by the
  playground session specs.
- Exact set equality of columns (new upstream columns are tolerated by
  design — only removals of promised columns fail).

---

## External dependencies *(required)*

- **OpenAI API** — two real agent completions (the conversation whose
  history is asserted).
- `tests/helpers/other/initialGPTsetup.ts` + `resolveGptModel` +
  `data/models.json` (collect-models).
- AG Grid rendering of the messages table (`.ag-header-cell[col-id]`,
  `.ag-cell[col-id]`, `.ag-center-cols-viewport` for the horizontal sweep,
  column-menu filter UI) — Settings → Messages page
  (`src/frontend/src/pages/SettingsPage/pages/messagesPage/`).
