# Spec: Upload a file via the Read File component (§5.1 File Upload)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/upload-via-component.spec.ts`

**Last validated:** Langflow 1.12.x

---

## What this test validates

A user can bring a local file into a flow through the **Read File** component's
file picker — the canvas-component upload path (distinct from the Chat Input /
Playground upload that `limit-file-size-upload.spec.ts` exercises). The full
chain must work end to end:

1. The Read File component is added to the canvas and exposes a file field with
   an "open file management" affordance.
2. Uploading a local file through the component's file-management modal makes
   the file appear in **My Files**, pre-selected.
3. Confirming the selection **attaches the file to the component** (the node
   shows the file chip).
4. Running the component **builds successfully** and its output is the file's
   **exact text content** — the distinctive, causal observable.

The file's content is a unique sentinel, so the output match cannot be
coincidental: `test-file.txt` = `This is a test file for upload functionality
testing.`.

The **bytes** come from that asset, but the **upload name is a fresh random stem
per run** (`generateRandomFilename()`), because `POST /api/v2/files` renames an
upload whose name collides — see _Unique upload name_ below. Every name-derived
testid in this spec is therefore built from that stem.

## Validation criterion (concrete, distinctive)

After uploading the asset's bytes under a per-run unique name through the Read
File component and running the node:

- the node shows a successful build badge (`node_duration_read file`), and
- the component's **raw-content output** (`output-inspection-raw content-file`
  → the output modal `textarea`) equals the file's exact text
  `This is a test file for upload functionality testing.`.

A regression in the upload, the file→component attachment, or the component's
read path fails a specific step — the output text is the end-to-end proof.

---

## Tags

`@stable` `@release` `@files` `@components`

(`@files`: file upload/ingestion surface. `@components`: canvas-component
configuration. Created `@stable` by #671 after deterministic validation;
quarantined (`test.fixme`) at the triage of daily #1121 and restored by #1125
together with the determinism fix below; quarantined again at the triage of
daily #1430 and restored with the settle gate of step 6.)

---

## Step by step

1. Bootstrap to the templates modal and open a **blank flow**
   (`awaitBootstrapTest` → `blank-flow`); wait for the sidebar to be
   interactive (`sidebar-search-input` visible).
2. Add the **Read File** component: search "Read File" in the sidebar, click
   `add-component-button-read-file`.
3. Open the component's file management modal (`button_open_file_management`).
4. Upload the asset's bytes under a per-run unique name: click the dropzone
   (`drag-files-component`), which opens a native file chooser, and set
   `{ name: "<stem>.txt", mimeType: "text/plain", buffer }` on it
   (`Promise.all([page.waitForEvent("filechooser"), click])` → `setFiles`).
   Gate on the upload landing server-side (`POST /api/v2/files` with a `< 300`
   status) and keep the response's `id` + `name` for the cleanup and the
   name-derived testids. Both fields are asserted rather than read optionally:
   the `id` is the only handle `afterEach` has (losing it leaks the upload into
   the shared account — the residue this spec was broken by), and the `name`
   must **equal** the stem, so a rename fails loudly instead of being followed
   silently.
5. Assert the file appears (`file-item-<stem>`) **and that the app registered it
   as selected** — `checkbox-<stem>` with `data-state="checked"`. This is the
   load-bearing gate (#1125): the rendered row and the modal's internal
   selection are keyed on the file **path**, so a checked box is the only proof
   that the optimistic upload entry has been replaced by the server's record and
   that confirming will attach _this_ file.
6. Confirm only once the file list has **settled** — no `GET /api/v2/files` still
   in flight — and re-assert `checkbox-<stem>` after that wait. Both halves are
   needed and neither is a timeout in disguise: the node chip is a projection of
   the `useGetFilesV2` cache, so a list response that lands late without this
   file wipes the attachment outright (see _The node chip is a cache
   projection_ below). Then confirm with `select-files-modal-button`.
7. Assert the file attached to the component (`file-item-<stem>` renders on the
   node, after the modal-only `select-files-modal-button` disappears).
8. Run the component (`button_run_read file`); assert `node_duration_read file`
   (successful build).
9. Open the output inspector (`output-inspection-raw content-file`); assert the
   output modal `textarea` value equals the sentinel file content.

---

## External dependencies

- Sidebar/component testids: `add-component-button-read-file`,
  `button_open_file_management`, `drag-files-component`,
  `file-item-<stem>`, `checkbox-<stem>`, `select-files-modal-button`,
  `button_run_read file`, `node_duration_read file`,
  `output-inspection-raw content-file` (scouted live on 1.11.0.dev41,
  re-confirmed on 1.12.0.dev10). The two `<stem>` testids are derived from the
  **name the server returns**, never from the local asset name (#1125).
- Files API: `POST /api/v2/files` (upload — its response carries the `id` used
  for cleanup and the `name` the testids are built from), `GET /api/v2/files`,
  `DELETE /api/v2/files/{id}` (cleanup — the upload persists in the user's
  global file store).
- Asset `tests/assets/files/test-file.txt` (read via `resolveAssetPath` +
  `fs.readFileSync`; uploaded under a random stem).
- No model provider credentials required (pure file read, no LLM).

---

## What this test does not cover

- Chat Input / Playground file upload (covered by
  `limit-file-size-upload.spec.ts`).
- The file-size limit path (same sibling spec).
- Non-text file types (pdf/json/wav) — a `@files` different-types spec is a
  separate §5.1 bullet.
- The Files management PAGE CRUD (covered by `files-page.spec.ts`).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).

---

## Flow & file cleanup

Two persistent artifacts, both cleaned id-scoped in `afterEach`:

- **Flow:** the blank flow is created after `awaitBootstrapTest` (which itself
  may create a bootstrap flow), so the canvas URL id races the bootstrap id —
  capture via the **Pattern A response accumulator** (`page.on("response")`
  collecting every `POST /api/v1/flows` 201 id) and delete all with
  `deleteFlow` (404-tolerant). Never `page.url()` here (#681).
- **Uploaded file:** the upload persists in the user's global file store, so
  `DELETE /api/v2/files/{id}` it in `afterEach`, with the id taken from the
  upload response — otherwise repeated runs accumulate files. Deleting **by id**,
  never by name prefix: the account is shared by every spec of the shard, so a
  `name.startsWith(...)` sweep is a cross-worker wipe (the #465 hazard). The
  previous version of this spec deleted every file whose name started with
  `test-file`. Behavioral force-fail: no-op the file cleanup and the file count
  grows.

---

## Unique upload name — why (#1125)

`POST /api/v2/files` enforces unique names with a **prefix** query, not an
equality check:

```python
stmt = select(UserFile).where(col(UserFile.name).like(f"{root_filename}%"),
                              UserFile.user_id == current_user.id)
if files:
    root_filename = f"{root_filename} ({count + 1})"
```

So an upload of `test-file.txt` becomes `test-file (1)` whenever **any** row of
that user already starts with `test-file` — a residue of an earlier run whose
cleanup did not land, or a second upload in the same account. The file then
attaches under the renamed label, and a name-derived testid built from the local
asset name (`file-item-test-file`) matches nothing on the node.

That is what failed on the daily of 2026-07-30 (run 30534416609): the modal step
passed in ~1 s — matching the _residue_ row — and the node-chip assertion timed
out 15 s later with `element(s) not found`. Reproduced deterministically by
seeding one `test-file` row before the run, on 1.12.0.dev10.

Two independent guards keep the spec deterministic:

1. the upload name is a fresh random stem per run, so the collision branch is
   never entered, and the testids come from the **response's** `name`. That
   guard is itself checked — the run asserts `response.name === stem`, so a
   collision (residue, a stem clash, or a future server-side normalization) is
   reported instead of absorbed by the response-derived testids;
2. the confirm click waits for `checkbox-<stem>` to read `data-state="checked"`,
   which proves the app's selection and the rendered row agree on the file path
   (the earlier gate — a `waitForResponse` on the POST plus a visible row — is
   also satisfied by the optimistic entry, whose row is `pointer-events-none`).

The daily's 2026-07-23 failure on this spec was a **different** signature
(`sidebar-search-input` never visible, during setup) and belongs to #1063 — this
spec is not a same-signature repeat offender.

---

## The node chip is a cache projection — the #1430 defect

The node chip is **not** downstream of a request. Measured on 1.12.0.dev25: it
renders 43–241 ms after the modal closes, and it still renders when
`POST /api/v1/custom_component/update` — the only call in that window — is
stalled 25 s or aborted outright. The spec used to claim the chip "renders only
after the attach PATCH settles"; there is no PATCH on that path, and treating
the absent chip as latency is what made a 15 s timeout look like the right knob.

What the chip actually is, in `InputFileComponent`:

```tsx
files.filter((file) => selectedFiles.includes(file.path))   // files = useGetFilesV2 cache
```

and a reconcile effect in the same component rewrites the node's `value` /
`file_path` from that same cache whenever the modal is closed. So **one**
`GET /api/v2/files` response that does not carry the just-uploaded file destroys
the attachment: reproduced 5/5 by intercepting a single list response and
removing that entry — the chip renders, disappears, the node's `file_path` is
emptied and **saved empty**, with no error and no toast. That is silent data
loss for a user, not only a flaky assertion. Filed upstream as
[LE-2208](https://datastax.jira.com/browse/LE-2208) and carried in
`REGRESSIONS.md` → Ledger.

**Fixed upstream** by
[langflow#14541](https://github.com/langflow-ai/langflow/pull/14541) (merged into
`release-1.12.0` on 2026-08-13). The reconcile no longer reads "this list does
not mention the file" as "the user has no file selected": a path it cannot find
first forces a fresh read, and is dropped only when a list fetched *after* that
still omits it. Re-validated on 2026-08-17 with
`docs/upstream-bugs/scripts/repro-2208-stale-file-list.spec.ts`, which strips
exactly one `GET /api/v2/files` response and reads both the chip and the
persisted `template.path`:

| Build | chip after the stale response | `template.path` persisted |
|---|---|---|
| `1.12.0.dev25` (pre-fix) | gone, 2/2 | `value: []`, `file_path: []` |
| `1.12.0.dev26` | intact | keeps the file |
| `1.12.0.dev30` (the daily's) | intact | keeps the file |

The boundary matches the merge: the `dev26` image was built 2026-08-13 23:01 -03,
the fix merged 20:03 -03 the same day. The repro asserts on the per-run random
file **stem**, not the file id — neither `template.path.value` (the name) nor
`.file_path` (`<user>/<name>.txt`) carries the uuid, so anchoring on the id
reports a wipe on every build, fixed or not.

The daily of 2026-08-12 (run 31581590030) failed with that shape: the modal
assertions passed on the failing attempt, the modal closed, and the chip was
never found in 15 s. Which list response arrived without the file cannot be
proven for that run — its blobs and trace had expired by the time the issue was
worked, only the JSON report survived.

The spec's step-6 gate closes the window the **test** creates — it confirms at
~200 ms after the upload, while a list refetch fired by the upload's
invalidation is still in flight (`GET /api/v2/files` lands ~20 ms after the
`POST` on a quiet instance; on the daily's 8-worker lane it does not). The gate
is kept after the fix for that reason alone, not as a guard.

One sentence that used to sit here is now wrong and is called out rather than
quietly deleted: *"the gate cannot stop a list response that arrives after the
confirm, so if the product race fires the chip assertion still fails."* Post-fix
a late list response does not fire anything — it costs one extra `GET`. The chip
assertion in step 7 remains the guard for a **re-regression**: on `dev25` the
chip renders and then disappears, which fails there and not on a timeout.
