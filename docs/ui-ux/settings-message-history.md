# Settings → Messages — history shows sent messages in order with working filters

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev8`)

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
4. **Column filters work** — the `session_id` filter narrows the grid to one
   conversation and the `sender` "Equals User" filter then leaves only User
   rows; clearing the value restores that conversation's full row set.

## Scoping note *(what broke in #1778)*

Settings → Messages is a **global** audit surface. The suite runs
`fullyParallel` against one shared superuser on one instance, so every sibling
spec's messages land in this same table — and AG Grid virtualizes **rows** the
way #616 found it virtualizing columns: only what fits the viewport is in the
DOM. Collecting `.ag-cell[col-id="text"]` off an unscoped grid therefore reads
*some other spec's* messages and asserts this test's prompts are among them.

Measured on `1.13.0.dev8` with 50 stored messages: the footer reports
"1 to 50 of 50", the DOM carries **18** rows, and this test's own — the newest,
and therefore last under the ascending default — are not among them. That is
#1778: a hard 3/3 failure on the VM lane while the feature was working, because
the rows were one scroll away.

The test therefore **scopes the grid to its own conversation before reading a
single row**: it resolves its session id from
`GET /api/v1/monitor/messages?flow_id=<own flow>` (never off the screen — the
row carrying the prompt is exactly the row virtualization may not have
materialized) and applies the `session_id` column's "Equals" filter. The scope
is then **asserted**, not assumed: every rendered `session_id` must equal it,
so a filter that silently failed to apply hands back the global grid *and
fails* instead of greening.

**Rejected alternative — sweeping the vertical scroll**, the row-axis twin of
the #616 column sweep. It collects the rows, but it leaves every assertion
measuring other specs' messages, and its cost grows with the instance's entire
message history — the lane that found this serves 654 tests from one instance.
Scoping is O(this test's own rows). The same move PR #1779 made for #1773,
where a global flow count was scoped to a project the test owns.

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
- `OPENAI_API_KEY` set **and** OpenAI recorded `active` in `providers.json` by
  `collect-models` — the flow is the Simple Agent template driven through
  `initialGPTsetup`, and the test skips when either is missing
  (`providerSkipGate("openai")`, #1029).
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
5. **Scope:** resolve this conversation's `session_id` from
   `GET /api/v1/monitor/messages?flow_id=<own flow>` (the flow id tracked for
   cleanup), apply the `session_id` column's "Equals" filter, and assert every
   rendered `session_id` equals it. Everything below reads the scoped grid.
6. **Column contract:** sweep the grid horizontally collecting every
   `.ag-header-cell` `col-id`; assert the collected set contains all 11
   promised columns (superset-tolerant).
7. **Order:** read all `timestamp` cells (≥ 4 rows expected: 2 user + 2
   agent); assert they parse (≥ 4 parseable, so the check is never vacuous)
   and are **monotonically ascending**. Monotonicity alone also holds for a
   reversed grid, so it is paired with a direction-sensitive check: the row
   index of `Hello, how are you?` must be **less than** the row index of
   `What is 2+2?` in the `text` column.
8. **Content:** `sender` column contains `User` and a machine/agent value;
   `text` column contains both prompts verbatim.
9. **Filter:** click the `sender` header's dedicated filter button
   (`.ag-header-cell-filter-button` — the old `.ag-icon-menu` + "Filter" tab
   flow no longer exists on 1.11); pick "Equals", type `User`; assert every
   remaining row's sender is `User`; clear the value; assert the row count
   is restored (> filtered, ≥ 4).

---

## Validation criterion *(required)*

- Every row the grid renders after scoping belongs to this test's own session —
  asserted, so an unapplied filter fails instead of silently widening the read.
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
  playground session specs. The `session_id` filter is used here as the
  **instrument** that scopes the read; only its narrowing effect is asserted.
- Exact set equality of columns (new upstream columns are tolerated by
  design — only removals of promised columns fail).

---

## External dependencies *(required)*

- **OpenAI API** — two real agent completions (the conversation whose
  history is asserted).
- `tests/helpers/other/initialGPTsetup.ts` + `resolveGptModel` +
  `data/models.json` (collect-models).
- `GET /api/v1/monitor/messages?flow_id=` — read once, to resolve this
  conversation's `session_id` for the grid scope (#1778).
- AG Grid rendering of the messages table (`.ag-header-cell[col-id]`,
  `.ag-cell[col-id]`, `.ag-center-cols-viewport` for the horizontal sweep,
  column-menu filter UI) — Settings → Messages page
  (`src/frontend/src/pages/SettingsPage/pages/messagesPage/`).
