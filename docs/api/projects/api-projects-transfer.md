# API Projects — download and upload (`/api/v1/projects/{download,upload}`)

**File:** `tests/tests-automations/regression/api/projects/api-projects-transfer.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev14`)

Owning issue: #1707 (Wave 7 — OSS API coverage, `projects` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

Product defect against both tests, **fixed upstream in `1.13.0.dev14`**: #1807 /
`LE-2598` — see *The defect these two tests caught* below. The instrumentation it left
behind is a regression detector, not a workaround.

---

## What this test validates *(required)*

The two transfer operations of the family, which nothing in the repo drives at all:
exporting a project as an archive and importing one back. The interesting half is the
**collision semantics**, which are the opposite of the sibling endpoint's.

Measured on `1.13.0.dev0`, re-measured on `1.13.0.dev12`:

| Operation | Answer |
|---|---|
| `GET /api/v1/projects/download/{project_id}` on a project with **no flows** | `404 {"detail":"No flows found in project"}` — an empty project is not downloadable |
| `GET /api/v1/projects/download/{project_id}` on an id that resolves to no project | `404 {"detail":"Project not found"}` — a **different** string, which is what makes `detail` a discriminator (see below) |
| `GET /api/v1/projects/download/{project_id}` with a non-UUID id | `422`, `detail[0].type === "uuid_parsing"` — never a 404 |
| `GET /api/v1/projects/download/{project_id}` with one flow | `200`, body is a **ZIP** (`PK\x03\x04`, 626–656 B for a one-flow project) |
| `POST /api/v1/projects/upload/` with that ZIP while the flows still exist | `422 {"detail":"Flow(s) with the following IDs already exist: <id>. Use the update endpoint or upload_file() for upsert semantics."}` |
| `POST /api/v1/projects/upload/` once those ids are gone | `201`, and the body is a **list of the imported flows** (`FlowRead[]`) — **not** the project object |
| the imported flow | keeps **the same `id`** it had in the archive (which is why re-importing collides) |
| the created project | is named after the **uploaded file**, extension stripped (`p3.zip` → `p3`) |
| `POST /api/v1/projects/upload/` with a non-archive | `400 {"detail":"Invalid JSON file: invalid literal: line 1 column 1 (char 0)"}` |

**The asymmetry worth a test.** `POST /api/v1/flows/upload/` **upserts by id**
(measured in #1699: re-uploading the same flow updates it). `POST /api/v1/projects/upload/`
**refuses** the same collision with a `422` telling the caller to use the update
endpoint. Two sibling importers, opposite behaviour on the identical input; either one
drifting toward the other is a silent data-loss change (upsert where the caller
expected a refusal) that no test would catch today.

**The uploaded file name is a project name, so it obeys the same length rule.** A
project's derived MCP server name is `lf-${sanitize_mcp_name(name)[:26]}` and must be
unique per user, so an archive whose file name shares its first 26 characters with an
existing project is refused `409 MCP server name conflict` (#1409). The spec generates
a four-character label plus a base36 timestamp for exactly that reason.

Two consequences for the test's own shape: the response gives back **flows, not a
project**, so the created project has to be found by listing and matching the file
name; and because the import reuses ids, the happy path must run **after** the source
flow is deleted, which is also the only way to exercise it more than once on a
long-lived instance.

**Correction, measured on `1.13.0.dev12`: the download route DOES set a content type.**
`download_project_flows` builds its `StreamingResponse` with
`media_type="application/x-zip-compressed"` and the response carries it, alongside a
`content-disposition` naming `<timestamp>_<project>_flows.zip`. The previous revision of
this doc — and the inline comment in the spec, and #1807's own body — said the endpoint
sets none, which is false on this build. The archive is still asserted by **magic
bytes** because that is the strictly stronger check: a header can be right while the
body is not a ZIP at all. The header is recorded here rather than asserted; pinning it
belongs to the family's coverage issue (#1707), not to this fix.

---

## The defect these two tests caught — `LE-2598` (#1807), fixed in `1.13.0.dev14`

Both tests read a resource back through a route that answers from the database, and on
a loaded instance those reads can answer `404` for a row the API has already
acknowledged. The cause is not either route: **every write route taking `DbSession`
answers its 2xx before the transaction commits**, so a read issued with the id the
write just returned can correctly find nothing.

`_new_flow` does `session.add` → `flush()` → `refresh()` → `return FlowRead` and never
commits; the commit belongs to the `DbSession` dependency (`session_scope`:
`yield session; await session.commit()`), and FastAPI runs a `yield`-dependency
teardown **after** the response has been written to the client. The mechanism, the
five links and the causal proof are documented once in
`docs/api/flows/api-flows-versions.md` — this file records only what is specific to
the projects family.

On the 2026-09-10 daily ([run 34478166565](https://github.com/oriontech-me/langflow-e2e/actions/runs/34478166565), triage #1806 → #1807) both tests fired inside one 16 s window
on shard 3, alongside two flows specs:

- test 1 failed **3/3 attempts** — `GET /api/v1/projects/download/{id}` answered `404`
  for a project it had just populated. `@stable` was auto-removed in `403b8842`.
- test 2 failed attempt 0 — the just-imported project was **absent** from
  `GET /api/v1/projects/`; it passed on attempt 1, 2.8 s later.

**What makes the projects side different from the flows side, and why `detail` is not
enough here.** On the flows routes the 404 string separates the shapes by itself
(`"Flow not found"` = the row is not visible, `"Not Found"` = FastAPI's unmatched
route). On `GET /api/v1/projects/download/{id}` it does not: the **same** string —
`"No flows found in project"` — is the legitimate answer for a genuinely empty project
**and** the answer while the flow's `INSERT` is uncommitted, because
`download_project_flows` selects `Flow.folder_id == project_id` and raises on an empty
result (`projects_files.py:79`). Test 1's own step 1 asserts that legitimate 404. So
the discriminator has to come from a **second read** — of the flow row, since that is
the row whose visibility decides this 404. What a second read cannot do is fix its own
timing, which is the limit measured in *When the pair collapses* below.

**What the tests do about it: nothing that changes an assertion.** `200` with a ZIP for
a populated project, and the imported project being in the listing, *are* the contracts
these tests assert, and the issue forbids closing this with a retry, a sleep or a
narrower scope. What they gain is **attribution**, computed only on the failing branch.

### The fix, and how it was verified rather than assumed

Upstream `langflow#15078` scopes the session dependency to the function —
`DbSession = Annotated[AsyncSession, Depends(injectable_session_scope, scope="function")]`
(`api/utils/core.py`), plus the same on the five auth dependencies in
`services/auth/utils.py` — so the teardown that commits runs **before** the response is
written. It was merged on `release-1.12.2` and back-merged into the 1.13 line between
`1.13.0.dev12` and `1.13.0.dev14`.

A green run proves nothing here — the defect never reproduced locally in the first
place (the idle window is below one HTTP round trip). What was measured is the
**ordering, from both sides**, by re-running the same gated 300 ms delay between
`session_scope`'s `yield` and its `commit` on each image:

| | `1.13.0.dev12` (before) | `1.13.0.dev14` (after) |
|---|---|---|
| the four sequences under the delay | **0/10** each | **10/10** each |
| `POST` latency under the delay | 11-20 ms — the client is not waiting for the commit | **338-366 ms** — it is |
| the read-back immediately after | `404`, row visible only 302-313 ms later | `200`, `polls: 1` |

The delay moved from *after* the response to *inside* it. That is the defect inverted,
not a quieter symptom — and it is why `@stable` is back on test 1 and #1807 closes.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable`: keyless and deterministic — one project, one trivial flow, no run.

**Test 1's tag was auto-removed by the daily on 2026-09-10 (`403b8842`) and is restored
here**, not on a test-side mute: `LE-2598` is fixed in the image the scheduled lanes
pull and the fix was verified there by the measurement above. Restoring it any earlier
would have been the mute #1807's *Deliverables* forbid — which is why the intermediate
revision of this file argued for keeping it off, on `1.13.0.dev12`, where the fix was
genuinely absent.

**Test 2 never lost its tag, and not because it is immune** — it failed on the same run,
on the same mechanism, and kept the tag only because the daily's retry budget absorbed
it (it passed on attempt 1) and a tag is removed only by a hard failure.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. Ids are pushed
as they are created; `afterEach` deletes flows first, then projects (via
`helpers/flows/delete-project.ts`), including the project the **import** creates,
which is found by name and by the flow ids it brought back.

**Test 1 — `download refuses an empty project and returns a ZIP for a populated one`**
1. Create a project; `GET /api/v1/projects/download/{id}` → `404`,
   `detail === "No flows found in project"`.
2. Create a flow inside it; download again → `200`, and the first four bytes of
   `response.body()` are `PK\x03\x04`. The `200` is asserted unconditionally. On a
   non-`200` the step builds a diagnosis into the assertion's message from two reads —
   the failing response's own `detail` (`describeResponseDetail`) and a by-id readback
   of `GET /api/v1/flows/{flow_id}` for the flow just created
   (`describeFlowReadback`, the #1759 helper). Neither throws, both run only on the
   failing branch, and the assertion itself is unchanged.

   **The pair narrows the failure to four cases, and two of them are a verdict.** The
   readback is what reaches rows 1 and 2 at all — rows 3 and 4 are decided by the
   `detail` string alone — but it does not settle either of them, and the reason is
   route-local. The two reads use **different keys**: the download selects flow rows by
   `Flow.folder_id == project_id`, the readback addresses one flow row by its id. They
   are not reads of different **rows** — the row whose visibility decides this `404` is
   the same flow either way, which is the whole point of *When the pair collapses*
   below. (Test 2, further down this file, *is* the case with two genuinely different
   rows: it reads the flow **and** the project listing, and carries a table row for each
   direction in which the two can diverge.) In the family's vocabulary: `api-flows-batch` and `api-invalid-key`
   reissue the **same request**, while this route's second read asks a **different
   question** of the same row.

   | `detail` | flow readback | shape |
   |---|---|---|
   | `"No flows found in project"` | `200` — the row EXISTS | the flow row is there, but the readback prints a **status, not a `folder_id`** — so this is either `LE-2598`'s window (the flow's `201` preceded its commit and the download's `folder_id` query saw nothing) or a flow that committed *outside this project*. Measured on `1.13.0.dev12` and `dev14` alike: creating a flow with no `folder_id` and downloading 1.5 s later — no window anywhere — produces this exact row. **Those two are told apart by re-running**, not by another read: this step always posts with `folder_id` (`spec:122`), so the second branch requires `POST /api/v1/flows/` to have stopped honouring it — a product regression, which reproduces, where the window does not. |
   | `"No flows found in project"` | `404` — not visible to this read | **UNDECIDED**, not a verdict. Either the flow is genuinely gone (a commit that never happened, a cross-worker wipe) **or** the window is still open and wider than the gap between these two reads. |
   | `"Project not found"` | either | the **project** row is the one missing — a different subject, and new: step 1 already proved that id resolved. |
   | `"Not Found"` | either | FastAPI's unmatched-route 404 — the download route stopped resolving. |

   A readback that cannot answer is `UNDECIDED` and claims neither (#1012). The
   readback must never become the asserted read: the `expect` runs on the status
   captured from the **first** download, so a row that lands between the two reads
   still fails the test — it just says why.

   **When the pair collapses — measured, and the reason row 2 says UNDECIDED (#1876).**
   This table first read row 2 as *"the flow is genuinely gone — not `LE-2598`"*, and
   `LE-2598` produces exactly that pair while its window is open. Replaying step 2 on
   `1.13.0.dev12` under the family's usual toggle — a 300 ms delay between
   `session_scope`'s `yield` and its `commit`, gated on a marker file so control and
   mutation run in the same process:

   | phase | downloads answering `200` | what the pair said |
   |---|---|---|
   | control | **10/10** | — |
   | mutation (300 ms) | **0/10** | `404 "No flows found in project"` + flow readback `404`, **10 of 10** |
   | revert, same process | **10/10** | — |

   The mechanism is what makes this a rule rather than one experiment's result: the
   keys differ — the download is addressed by `project_id`, the readback by `flow_id` —
   but **the row that is invisible is the same one**. Under `LE-2598` the uncommitted
   row is the flow just posted into the project: the download's `folder_id` query cannot
   see it, and the readback of that same flow cannot either. What a pair of reads needs
   in order to discriminate is not two keys but one read that lands *after* the window,
   which two calls issued milliseconds apart cannot guarantee. What separates them is a
   **later** read or the container log.

   How much weight row 2 carries, stated over what was actually measured. The figure the
   family quotes — **8-11 ms** — was measured on the flows `POST` → versions sequence
   (#1777), not here. On *this* sequence what is measured is the un-forced control:
   **8/8** downloads answering `200`, which says the window closed inside the
   `POST`→download gap and nothing narrower. It does **not** bound the window, and the
   flow `POST`'s own latency (7-9 ms on `dev12`, 8 ms on `dev14`) is **not** that bound
   either — under `LE-2598` the response is written *before* the commit by construction,
   so that number is a request time, not a window. What the control does establish is
   that the natural window normally closes before the readback, so an idle run gives row
   1; the forced 300 ms is wider than that gap by construction. And the generalisation
   holds for the case that matters anyway, since a failing occurrence has by definition
   already outlasted a round trip — which is exactly when the pair collapses.
3. Keep the buffer for test 2's fixture path (each test builds its own — no shared
   state between tests).

**Test 2 — `upload refuses colliding flow ids and imports once they are gone`**
1. Create a project with one flow and download it.
2. `POST /api/v1/projects/upload/` with the archive **as-is** → `422`; the `detail`
   contains the flow's id and the words `already exist`.
3. Delete the flow and the project (the source is now gone).
4. Upload the archive again → `201`; the body is an array of length 1 whose single
   element has the flow's **original id** and name.
5. `GET /api/v1/projects/` → a project named after the uploaded file (extension
   stripped) exists; `GET /api/v1/projects/{that id}` lists the imported flow. The
   presence assertion is unchanged. On an absence the step builds its message from two
   further reads: a by-id readback of the imported **flow**
   (`describeFlowReadback` — the upload returned its id, so it is addressable even when
   the project is not) and a **re-read of the listing** (`describeProjectListing`).

   | flow readback | listing re-read | shape |
   |---|---|---|
   | `200` — the flow EXISTS | the name IS now listed | `LE-2598`'s window, already closed when the diagnosis ran: the upload's `201` preceded its commit and both rows landed between the two reads. **Transient.** |
   | `200` — the flow EXISTS | still absent | the flow row and the project row have **diverged** — the import committed one and not the other. Not a window; a data defect. |
   | `404` — the flow is absent | the name IS now listed | the reverse divergence: a project holding nothing. |
   | `404` — the flow is absent | still absent | **undecided** — a window still open when the diagnosis ran looks exactly like an import that never committed at all. |

   **That last row is measured, not hypothesised, and it is why the pair is a lead
   rather than a verdict here.** Under the 300 ms toggle both reads come back negative
   (`{post: 201, list: 200, listed: false, flow_readback: 404}`, 10 of 10) because the
   diagnosis is issued milliseconds after the failure and therefore inside the same
   window. On the daily, where the window is under one HTTP round trip, the same two
   reads land *after* it and give row 1. So the honest reading is: rows 1-3 name a
   shape; row 4 says the reads were taken too close to the failure to separate the two,
   and the next step is the container log, not another read. **Test 1's pair has the same
   hole, for the same reason** — an earlier revision of this file claimed it did not,
   on the grounds that its two reads use different keys. They do, but the invisible row
   is the same flow either way; it is measured under *When the pair collapses* in test
   1's step 2, and corrected here (#1876).

   Same rule as test 1: the re-read decorates the message only. `expect` asserts on the
   **first** listing, so a project that appears a moment later still fails the test.
6. Upload a `text/plain` part instead of an archive → `400`, `detail` starts with
   `Invalid JSON file:`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the ZIP
asserted by magic bytes (never by `Content-Type` — see the correction above: the header
exists on `dev12`, but the body is the stronger check), the collision asserted on the id
**inside** the `detail` string, the happy path asserting that the imported flow keeps its
id, and the declared coverage — `GET /api/v1/projects/download/{project_id}` and
`POST /api/v1/projects/upload/` — matching what the fixture recorded. Zero projects and
zero flows left behind, the imported ones included.

For the `LE-2598` instrumentation specifically: forcing test 1's download to a non-`200`
must produce a failure message naming the response `detail` **and** the flow readback
verdict, and forcing test 2's listing to miss the project must name the flow readback
**and** the listing re-read — and both steps must still **fail**. An instrumented
assertion that stops failing is the defect this suite exists to catch, inverted. None of
the diagnostic reads is added to `apiCoverage.declare`: the gate fails a declaration the
test never issues, and these run on the failing branch only.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/projects.py` — `download_file` and `upload_file`;
  `download_file`'s own `404 "Project not found"` (the first of the two).
- `src/backend/base/langflow/api/v1/projects_files.py` — `download_project_flows`, which
  raises the second `404 "Project not found"` and the `404 "No flows found in project"`
  this spec's step 1 asserts and `LE-2598` borrows.
- `src/backend/base/langflow/api/v1/flows.py` — `upload_file`, the upserting sibling
  this file contrasts with.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_new_flow`, which flushes
  without committing (`LE-2598`).
- `src/backend/base/langflow/api/utils/core.py` — `DbSession`, the auto-commit-at-teardown
  session dependency.
- `src/lfx/src/lfx/services/deps.py` — `session_scope`, where the commit actually happens.
- No provider key, no model, no network egress.
