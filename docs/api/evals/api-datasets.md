# API Evals — datasets, the input of every evaluation

**File:** `tests/tests-automations/regression/api/evals/api-datasets.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev38`)

Owning issue: #2563 (Wave 12 — 1.14 OSS features). First spec of the evals family;
#2564 (evaluations) and #2565 (UI) build on the helper it adds
(`tests/helpers/api/evals/datasets.ts`).

---

## What this test validates *(required)*

Langflow 1.14 adds **evaluations** (upstream langflow-ai/langflow#15999): a flow is run
over a **dataset** and each row is scored. Upstream #16591 turned the feature **on by
default** — `GET /api/v1/config` reports `feature_flags.evals: true` on the nightly —
so every OSS user has it, and nothing in this suite touched it. A dataset is the input
of every evaluation, so its API is the first layer.

The family is **16 operations** under `/api/v1/datasets`, all in the schema. This spec
drives all 16 and asserts status and body shape for each.

Measured contracts (`1.14.0.dev38`, auto-login bearer):

| Operation | Answer |
|---|---|
| `POST /datasets/` | `201` `{id, name, description, revision, item_count, created_at, updated_at}`, `revision: 1`, `item_count: 0`. A name the caller already uses → `409 "A dataset named '<n>' already exists"`; `name: ""` → `422 string_too_short` at `["body","name"]` |
| `GET /datasets/?search=` | `200` page `{total, page, size, items}` holding only the caller's datasets |
| `GET /datasets/{id}` | `200` the same record; unknown → `404 "Dataset not found"`; not a UUID → `422 uuid_parsing` at `["path","dataset_id"]` |
| `PATCH /datasets/{id}` | `200`; `revision` **unchanged** — a rename is metadata. A taken name → `409` |
| `DELETE /datasets/{id}` | `204`, then the dataset and its items answer `404` |
| `POST /datasets/{id}/items` | `201`, the created rows as an **array** with `position` in insertion order, `source: "manual"`, an omitted `expected_output` stored as `null`. `input: ""` → `422` at `["body","items",0,"input"]` |
| `GET /datasets/{id}/items` | `200` page, ordered by `position` |
| `PATCH /datasets/{id}/items/{item_id}` | `200` the row; `clear_expected_output: true` sets it to `null`; unknown item → `404 "Dataset item not found"` |
| `POST /datasets/{id}/items/delete` | `200 {"deleted": N}`; an unknown id → `{"deleted": 0}` and nothing removed |
| `POST /datasets/{id}/import/preview` | `200 {headers, rows, total_rows}`, `rows` capped at **5** (`PREVIEW_ROWS`) while `total_rows` counts all; **writes nothing** |
| `POST /datasets/{id}/import` | multipart `file` + `input_column` (+ `expected_column`) → `200 {imported, skipped: [{row, reason}]}`; rows appended with `source: "csv"` |
| `GET /datasets/examples` | `200`, a list of `{key, name, description, item_count}` (3 on dev38) |
| `POST /datasets/examples/{key}` | `201`, a new dataset named after the example (suffixed ` 2`, ` 3`… when taken) holding `item_count` rows; unknown key → `404 "No example dataset named '<k>'"` |
| `POST /datasets/{id}/examples/{key}` | `200`, the example's rows **appended**; the description is filled from the example only when the dataset had none |
| `POST /datasets/{id}/duplicate` | `201`, `"<name> (copy)"` (then `"(copy) 2"`), same rows in the same order, `revision: 1` |
| `GET /datasets/{id}/export` | `200 text/csv; charset=utf-8`, `attachment; filename="<name>.csv"`, a UTF-8 BOM, header `input,expected_output`, CRLF line ends |

Four contract details worth their own asserts, each measured rather than assumed:

**`revision` counts content writes, not every write.** Creating sets `1`; adding,
editing, clearing and deleting items each move it forward; renaming does not. An
evaluation records the dataset revision it ran on (#2564), so a revision that missed a
content change would let an evaluation claim a dataset it never saw. The spec asserts
"strictly greater after every content write, equal after a rename" rather than the
literal numbers.

**The CSV import is a cleaning step, not a byte copy.** Every cell is trimmed
(`"  padded  "` → `"padded"`), a blank expected cell becomes `null`, and a row whose
input is empty is **skipped with its 1-based file line** (`{"row": 4, "reason":
"Input is empty"}` — the header is line 1). A wrong column name is refused with the
file's columns listed, a non-UTF-8 file and an empty file each with their own `422`
reason, and none of the three writes anything.

**Export is spreadsheet-safe, which makes it lossy by design.** `csv_safe_cell`
(`utils/csv_safety.py`) prefixes a cell whose first visible character is `=`, `+`,
`-` or `@` with `'`, so a spreadsheet does not run it as a formula. The import does
**not** strip that prefix back — a genuine leading apostrophe would be
indistinguishable — so `=1+1` exported and re-imported comes back as `'=1+1`. The spec
asserts both halves: the prefix on export is the security contract (CSV injection), and
the round-trip **identity** is asserted for every other kind of value — commas,
quotes, embedded newlines, non-ASCII — which is what a user exporting to edit and
re-import relies on.

**Ownership answers `404`, never `403`.** A second user gets `404 "Dataset not
found"` on all eight per-id operations, an empty list for the owner's name, and may
create a dataset **with the same name** — names are unique per user, not per instance.
The `404` is the OSS convention (#2553): the API does not confirm that someone else's
id exists.

---

## Tags *(required)*

`@stable` `@api` `@database` `@evals`

`@evals` is a **new functional tag**: evaluations and datasets have no OSS area to
reuse — `@observability` is traces and tokens, `@files` is the file store — so it
follows the rule `@integrations` and `@authz` set, and is added to the tag table in
`CLAUDE.md` and `docs/infra/tags.md` in the same change. Not provider-dependent: no
operation in this family calls a model.

---

## Precondition *(required)*

- A Langflow **1.14+** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `GET /api/v1/config` → `feature_flags.evals`. **Absent** means the build predates
  evals, and every test skips naming that. **`false`** means a 1.14 build with evals
  turned off, and the suite **fails** — the default is `true`, so a `false` is either a
  lane configured against the product default or an upstream change of default, and
  both deserve a red rather than a green all-skip (#1010).
- Test 7 creates one throwaway user (`createThrowawayUser`, one login — OSS rate-limits
  `/api/v1/login` at 5/min per IP).

---

## Step by step *(required)*

Seven independent tests over the `request` fixture, each declaring its operations with
`apiCoverage.declare()`. Every dataset is created with a per-test unique name and its id
goes into a tracker; `afterEach` deletes exactly those ids (the listing is per user but
every worker shares the superuser, so a listing-diff cleanup would delete another
worker's datasets).

**Test 1 — `creates, reads, lists, renames and deletes a dataset`**
1. `POST /datasets/` `{name, description}` → `201`, the seven keys exactly,
   `revision: 1`, `item_count: 0`, `name`/`description` as sent.
2. `POST /datasets/` with the same name → `409`, `detail` naming it. `name: ""` →
   `422` at `["body","name"]`.
3. `GET /datasets/{id}` → `200`, deep-equal to the create response.
4. `GET /datasets/?search=<name>` → `total: 1`, that id.
5. `PATCH` `{name: <new>, description: null}` → `200`, both applied, **`revision` still
   `1`**.
6. `DELETE` → `204`; `GET /datasets/{id}` → `404 "Dataset not found"`;
   `GET /datasets/not-a-uuid` → `422 uuid_parsing` at `["path","dataset_id"]`.

**Test 2 — `items keep their order, edits and deletions, and the dataset counts them`**
1. Create a dataset; `POST .../items` with five rows, the last one with no
   `expected_output` → `201`, an array of five, inputs in the order sent, positions
   strictly increasing, `source: "manual"`, the last `expected_output: null`.
2. `GET .../items` → the same five ids in the same order; the dataset reads
   `item_count: 5` and a `revision` above the create's.
3. `PATCH` row 2's `input` → `200` with the new input and the old expected output;
   `PATCH` row 3 with `clear_expected_output: true` → `expected_output: null`. Each
   write moves `revision` forward.
4. `POST .../items/delete` with rows 1 and 4 → `{"deleted": 2}`; `GET .../items` holds
   **exactly** rows 2, 3 and 5, in that order, carrying the two edits; `item_count: 3`.
5. Negative paths, each leaving `item_count` at 3: an unknown item id on `PATCH` →
   `404 "Dataset item not found"`; on delete → `{"deleted": 0}`; an item with
   `input: ""` → `422` at `["body","items",0,"input"]`.

**Test 3 — `CSV import previews without writing, imports trimmed rows and skips empty inputs`**
1. Create a dataset holding one manual row (so "appended" is observable).
2. Preview a 3-column file of three data rows, one with an empty input → `200`, the
   headers and the three rows verbatim, `total_rows: 3`; the dataset's `item_count` and
   `revision` are unchanged.
3. Preview a 30-row file → `rows` has **5** entries, `total_rows: 30`.
4. Import the 3-row file with `input_column`/`expected_column` → `200 {"imported": 2,
   "skipped": [{"row": 4, "reason": "Input is empty"}]}`; the items are the manual row
   followed by the two CSV rows, `source: "csv"`, cells **trimmed**, a blank expected
   cell `null`.
5. Refusals, none of which writes: `input_column: "nope"` → `422` whose `detail` names
   the missing column and lists the file's columns; a non-UTF-8 file → `422 "The file is
   not UTF-8 encoded. …"`; an empty file → `422 "The file has no header row."`. The
   `item_count` is still 3.

**Test 4 — `bundled examples create a dataset and append to one`**
1. `GET /datasets/examples` → `200`, a non-empty list, every entry carrying `key`,
   `name`, `description` and a positive `item_count`. The spec takes the **first**
   entry rather than a hardcoded key, so a renamed example does not fail it for the
   wrong reason.
2. `POST /datasets/examples/{key}` → `201`; `name` starts with the example's name (a
   ` 2` suffix appears when another dataset already holds it); `item_count` equals the
   example's; `GET .../items` returns that many rows.
3. Create a dataset with its own description and append the same example →
   `200`, `item_count` equal to the example's, and **the description kept**.
4. Append to a dataset with no description → the description becomes the example's.
5. `POST /datasets/examples/<unknown>` → `404 "No example dataset named '<k>'"`.

**Test 5 — `duplicates a dataset into an independent copy`**
1. Create a dataset with three rows.
2. `POST .../duplicate` → `201`, a new id, `name: "<name> (copy)"`, `revision: 1`,
   `item_count: 3`; its items carry the same inputs and expected outputs in the same
   order, under **new** item ids.
3. Duplicate again → `"<name> (copy) 2"`.
4. Delete a row in the copy → the source still holds three rows.

**Test 6 — `exports a spreadsheet-safe CSV that round-trips everything else`**
1. Create a dataset whose rows hold a comma, a double quote, an embedded newline,
   non-ASCII text, a `null` expected output, and a formula-leading input (`=1+1`) and
   expected output (`+cmd`).
2. `GET .../export` → `200`, `content-type` `text/csv; charset=utf-8`,
   `content-disposition` an attachment named `<name>.csv`; the body starts with the
   UTF-8 BOM, its first line is `input,expected_output`, lines end in CRLF, and the
   formula cells read `'=1+1` and `'+cmd`.
3. Import that body into a fresh dataset → every non-formula row comes back
   **identical** (`input` and `expected_output`, `null` included) in the same order; the
   formula row comes back with the apostrophe (the lossy half, asserted so a change in
   either direction is seen).

**Test 7 — `another user can neither see nor change the dataset`**
1. Create a dataset with one row; create a throwaway user.
2. As that user: `GET`, `GET .../items`, `PATCH`, `POST .../items`, `GET .../export`,
   `POST .../duplicate`, `POST .../examples/{key}` and `DELETE` on the owner's id each →
   `404 "Dataset not found"`; `GET /datasets/?search=<name>` → `total: 0`.
3. As the owner: the dataset is unchanged — same name, `item_count` and `revision`.
4. As the other user: `POST /datasets/` with the **same name** → `201` (names are unique
   per user); delete it.

---

## Validation criterion *(required)*

Three consecutive passes at `--retries=0 --workers=1`, with:

- every response asserted on status **and** body shape, and every refusal on its
  `detail` text or `loc`, not on the status alone;
- item order and identity asserted by id after every mutation, and `revision` proven to
  move on content writes and stay on a rename;
- the import's trimming, `null` mapping and skipped-row line number asserted, and each
  refusal proven to write nothing (`item_count` re-read);
- the export's BOM, header, CRLF and formula prefix asserted, and the round-trip proven
  row by row;
- the non-owner refused with `404` on every per-id operation **and** the owner's record
  proven unchanged afterwards;
- the declared coverage (16 operations) matching what the fixture recorded;
- no dataset and no user left behind.

---

## External dependencies *(required)*

- A running Langflow 1.14+ OSS instance at `PLAYWRIGHT_BASE_URL` with
  `feature_flags.evals: true` (the default).
- No provider key, no model, no network egress.
- Upstream sources the contract was read from (`langflow-ai/langflow@release-1.14.0`):
  - `src/backend/base/langflow/api/v1/datasets.py`
  - `src/backend/base/langflow/services/evaluations/dataset_service.py`
  - `src/backend/base/langflow/services/evaluations/csv_io.py`
  - `src/backend/base/langflow/services/evaluations/examples.py`
  - `src/backend/base/langflow/utils/csv_safety.py`
- The API-surface baseline (`tests/assets/api/api-surface-baseline.json`) must list the
  datasets family for the gauge to count it; it was last refreshed on `1.13.0.dev19`,
  before the family existed.
