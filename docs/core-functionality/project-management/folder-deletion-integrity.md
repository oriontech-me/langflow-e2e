# Folder Deletion Integrity

**Last validated:** Langflow 1.12.x (`1.12.0.dev9`)

---

## What this test validates *(required)*

Validates the **integrity properties around folder (project) deletion** — that the
UI does not keep stale state after a folder disappears. The create/rename/
delete-empty CRUD lifecycle itself belongs to the canonical `folder-crud.spec.ts`;
this spec starts where that one stops and asserts what must remain true *after* a
deletion:

1. the deleted folder leaves the sidebar immediately and the page stays functional;
2. deleting one folder does not disturb a sibling folder, which stays clickable;
3. a folder created right after a deletion is created normally (no stale-cache collision);
4. deleting **every** folder lands on the empty-project screen.

A regression here is the class of bug where the backend deleted the row but the
frontend keeps rendering the folder, keeps a dangling selected-project id, or
refuses to create the next folder because a cache still holds the old one. Test 4
is the only place in the suite that exercises the zero-project state at all.

---

## Tags *(required)*

`@release` `@api` — and `@destructive` on test 4 only.

**No `@stable` yet**, on purpose: the empty-project screen that test 4 reaches
makes the frontend fire `GET /api/v1/projects/undefined` and the suite's fixture
logs the resulting `422` (issue #1008, a product-side defect). Until that is
resolved, this file always carries a `🚨 Backend Error` line, and `@stable` would
put that noise in the daily. The tag is restored once #1008 lands.

**`@destructive` (introduced by #1010)** marks a test that mutates account-wide
state and therefore cannot run beside anything else. It is a lane selector, not a
severity: the default run excludes it and the destructive lane runs it alone —
see *The destructive lane* below.

---

## Step by step *(required)*

**Test 1 — `deleting a folder should update the folder list immediately`**
1. Create the target folder via `POST /api/v1/projects/` (API setup, so the
   deletion target is deterministic and the UI create flow is not re-tested here)
2. `awaitBootstrapTest(page, { skipModal: true })`; assert `sidebar-nav-{name}` is visible
3. Delete it through the UI via `MainPage.deleteProject(name)`
4. Assert the `"Project deleted successfully"` toast
5. Assert `sidebar-nav-{name}` is **no longer visible** — the no-stale-data observable
6. Assert `add-project-button` is still visible (the page did not break)
7. `finally`: if the UI deletion did not complete, remove the folder through
   `deleteProject()` so a failed assertion cannot leak a project (#965)

**Test 2 — `deleting one folder should not affect other folders`**
1. Bootstrap, open a template and come back (exercises the real navigation path)
2. Create `folder-alpha-<stamp>` and `folder-beta-<stamp>` through the UI with
   `createProjectThroughSidebar` (`add-project-button`, then rename the entry the
   backend reports → type the name → Enter)
3. Assert both sidebar entries exist
4. Delete the alpha folder via its `more-options-button_<name>` → `btn-delete-project` → confirm
5. Assert the toast, assert the alpha entry is gone and the beta one is still visible
6. Click the beta folder and assert `mainpage_title` renders — the survivor is still usable
7. Delete it (cleanup through the same UI path; afterEach still removes both ids)

**Test 3 — `creating a new folder after deletion should work correctly`**
1. Bootstrap, template round-trip, create `folder-one-<stamp>` through the UI
2. Delete it, assert the toast and that its sidebar entry is gone
3. **Immediately** create `folder-two-<stamp>` through the same UI path
4. Assert it appears and `sidebar-nav-folder-two-<stamp>` is visible — proves no
   stale-cache collision between the deletion and the next creation
5. Delete it (cleanup)

**Test 4 — `deleting every folder lands on the empty project screen`** *(`@destructive`)*
1. Create one folder via API **holding a flow** (`POST /api/v1/projects/` then
   `POST /api/v1/flows/` with that `folder_id`), so the delete-everything path runs
   against real content rather than only empty folders
2. Bootstrap with `skipModal: true`
3. Loop: count `sidebar-nav-*` entries in `project-sidebar`, delete the first one
   through the UI (hover → `more-options-button_{kebab}` → `btn-delete-project` →
   confirm → toast), re-count; repeat until zero
4. Assert the count reached `0`
5. Assert the sidebar shows `"Start creating a project or flow"`
6. Assert `new_project_btn_empty_page` is visible

---

## The destructive lane (#1010)

Test 4 deletes **every folder of the shared superuser**. Under `fullyParallel:
true` with `workers: 2` that is a cross-test wiper: `fullyParallel` distributes
tests *within a file* across workers, so test 4 could run beside tests 1–3 of this
same file, and beside `folder-crud.spec.ts`, `bulk-actions.spec.ts` and
`flow-navigation-between-folders.spec.ts` in the same job. Observed victim: on PR
#1009 the `Run impacted E2E specs` job failed its first attempt on test 3 (~1.0 min)
and passed on retry.

Measured baseline on `1.12.0.dev8` — the four folder-touching specs run together at
`--workers=2 --retries=0`, three times:

| Run | Result | `404` on sibling-owned ids |
|---|---|---|
| 1 | **1 failed**, 7 passed | 3 (two on `/api/v1/projects/{id}`, one on `/api/v1/flows/{id}/events`) |
| 2 | 8 passed | 0 |
| 3 | 8 passed | 1 (on `/api/v1/projects/{id}`) |

`404` on a **project** id is the wiper's fingerprint: a sibling's own cleanup asks
for a folder the wiper already deleted (same class as #553). The failure in run 1
is the exact victim named in the issue, and its mechanism is sharper than "a
timeout":

```
folder-deletion-integrity.spec.ts:193 › creating a new folder after deletion …
  Error: expect(received).toBe(expected)   Expected: true  Received: false
  Timeout 30000ms exceeded while waiting on the predicate
    at dismissWelcomeOverlayAndWaitForModal (helpers/flows/open-new-flow-templates-modal.ts:106)
    at addFlowToTestOnEmptyLangflow (helpers/flows/add-flow-to-test-on-empty-langflow.ts:10)
    at awaitBootstrapTest (helpers/other/await-bootstrap-test.ts:24)
```

The wiper empties the account mid-flight, so the victim's `awaitBootstrapTest`
takes the **empty-instance branch** and waits 30 s for a welcome overlay that this
state does not produce. Scheduling decides who loses: when the wiper happens to be
scheduled last, the run is clean — which is exactly why the daily sees this as a
rare flake and why `--workers=1` validation never reproduces it.

**Fix: a lane, not a weaker assertion.** Test 4 keeps deleting for real and keeps
asserting the real empty-project screen; what changes is *when* it is allowed to
run:

- `playwright.config.ts` sets `grepInvert: /@destructive/` for every normal run,
  so the default lane never schedules it. `grepInvert` is used deliberately
  instead of `grep`: a CLI `--grep` (the daily's `@stable`, nightly's optional
  filter) **overrides** `config.grep` but leaves `config.grepInvert` in place, so
  the exclusion cannot be bypassed by accident.
- Setting `PW_DESTRUCTIVE=1` clears that exclusion and pins the run to
  `workers: 1` with `fullyParallel: false` — enforced in config, so a caller
  cannot forget it on the command line.
- CI runs the lane as a **separate step after** the normal run (`nightly.yml`,
  `pr-validation.yml`, `adaptive-impacted.yml`, and the shared `run-e2e` action
  used by `manual.yml`), with `--pass-with-no-tests` so it is a no-op when no
  destructive test is in scope.
- To keep the exclusion from becoming a silent cap, a plain run prints a one-line
  notice naming the tag and the exact command that runs the lane.

**Rejected alternatives, with the reason:**

| Direction | Why not |
|---|---|
| Per-test user isolation | Not viable in the UI. `LANGFLOW_AUTO_LOGIN=true` in every workflow and in `start-langflow-docker.sh`; injecting another user's token into the cookies is undone on mount — the app calls `GET /api/v1/auto_login`, overwrites the token, and `whoami` reports the superuser again, with that user's own project invisible in the sidebar (measured on `1.12.0.dev8`; matches the finding in #690). API-level isolation does work, but this test's subject is the UI. |
| Re-scope with a `page.route` mock | Would keep CI untouched, but the deletion→empty-screen transition stops being end-to-end and becomes "the frontend renders an empty list", which is not what the test is for. |
| Cross-process lockfile mutex | Preserves the assertion, but requires every sibling folder spec to take a shared lock and silently regresses the moment a future folder spec forgets to. |
| `test.describe.configure({ mode: "serial" })` | Partial only: removes the intra-file race, not the cross-file one — the wiper deletes folders belonging to three other spec files. |

**Known gap, stated rather than implied:** `daily-stable.yml` runs `--grep
"@stable"` and has no destructive lane. It does not need one today (test 4 is not
`@stable`), but that means **a test carrying both `@stable` and `@destructive`
would silently never run in the daily**. Until the daily grows a lane, treat the
two tags as mutually exclusive — noted in `CONTRIBUTING.md` next to the tag table.

---

## Teardown order and id-scoped folder cleanup (#1023)

Two teardown defects survived the destructive lane (#1010) and are fixed here.

### 1. The page must leave the canvas before the flow is deleted

`afterEach` deletes the starter-template flow tests 2 and 3 create. When the page
is still showing that flow, the editor keeps asking for it. Measured on
`1.12.0.dev9` with a probe that varies **only** the page's location at delete
time:

| Page at delete time | Backend errors |
|---|---|
| folder view | **0** |
| editor open, idle | `404` on `/api/v1/flows/{id}/events?since=` |
| editor still mounting | `404` on `GET /api/v1/flows/{id}` **and** on `/events?since=` |

The last row is the signature #1023 reports, and it is the state a test that dies
inside `openTemplateAndReturnToFolders` leaves behind. Those `404`s are an
artifact of teardown **order** — the fixture logs each as `🚨 Backend Error` and
the deterministic pipeline's VALIDATE gate hard-stops on them — not a product
defect, so the hook navigates to `about:blank` (no backend traffic of its own)
before deleting anything.

### 2. A UI delete is not cleanup

Tests 2 and 3 delete their folders through the UI, and that used to be the only
thing removing them. It is not reliable: `DELETE /api/v1/projects/{id}` answers
**500** under concurrent writes while the toast still reads "Project deleted
successfully" (#965 / LE-2020), and the folder survives. Test 1 had the same hole
in a different shape — its `finally` only deleted the folder *if the UI deletion
had not completed*, and "completed" was inferred from the sidebar entry
disappearing, which the UI does optimistically.

Measured: six consecutive `--workers=2` runs of the four folder specs from a
clean instance left **11 orphan folders** (`New Project`, `New Project (2)`…),
and the leak is what breaks the next run — with 8 of them seeded, this spec goes
from *3 passed in 18.4 s* to *2 failed in 55.0 s*, both on `input-project` never
appearing after the double-click. That is also why the folder names now carry a
per-run stamp and why the fresh entry is addressed by the name the backend
returned (`createProjectThroughSidebar`) instead of
`getByText("New Project").last()`.

Every project created through the page is therefore deleted id-scoped in
`afterEach` via `deleteProject`, which retries the 500 and treats `404` (the
happy path, where the UI really did delete it) as done. The same hook also
tracks **every** `POST /api/v1/flows/ → 201` the page makes, not just the
template one, and **all four tests register the tracker** — including the two
that open no template. Two flows still leaked with only tests 2 and 3 tracking:
on an instance left with no flows (which test 4 does inside its own lane),
`awaitBootstrapTest` seeds one through `addFlowToTestOnEmptyLangflow`, and
`openNewFlowTemplatesModal`'s welcome-overlay branch can land on a freshly
created "New Flow". Neither is a flow the test asked for, and neither had an
owner.

**A/B for the naming half**, both arms with 8 leftover `New Project` folders
seeded on the same instance:

| Arm | Result |
|---|---|
| before (`getByText("New Project").last()`) | **2 failed** in 55.0 s |
| after (name read from the `201`) | **3 passed** in 21.8 s, project count unchanged |

---

## Validation criterion *(required)*

- **The race is gone where it was observable.** Running the four folder-touching
  specs together at `--workers=2 --retries=0`
  (`folder-deletion-integrity`, `folder-crud`, `bulk-actions`,
  `flow-navigation-between-folders`) produces **no `404` on a sibling-owned flow
  or project id** and no folder-disappeared timeout, 3× in a row. Before the fix
  the same command logs `404`s on ids another test is still using.
- **The run is repeatable, not just green once (#1023).** The same command, six
  times back to back from a clean instance: 6/6 green and the project count back
  at its baseline after **every** run. Before the id-scoped folder cleanup the
  same six runs left 11 orphan folders and failed from run 2 onwards.
- **The default lane really excludes it:** `npx playwright test <spec> --list`
  reports 3 tests, not 4, and a normal run prints the notice naming
  `@destructive` and the lane command.
- **The lane really runs it:** `PW_DESTRUCTIVE=1 npx playwright test <spec>
  --grep @destructive` reports exactly 1 test and it passes, reaching the real
  empty-project screen (both the sidebar message and `new_project_btn_empty_page`).
- **Each test still fails when it should:** every `test()` in the file mutated red
  one at a time (force-fail), including test 4 inside the lane.
- **No leaks:** the folders/flows each test creates are gone at the end, and the
  project count returns to its baseline.
- Expected residue while #1008 is open: exactly one `🚨 Backend Error: 422 …
  /api/v1/projects/undefined` from test 4. It is product-side and must not be
  silenced here.

---

## What this test does not cover *(optional)*

- Folder rename and the create/delete-empty lifecycle — `folder-crud.spec.ts`.
- Moving flows between folders — `flow-navigation-between-folders.spec.ts` (UI)
  and `api/flows/api-folders-crud.spec.ts` (API).
- Bulk selection and multi-delete — `bulk-actions.spec.ts`.
- Multi-user isolation of folders — not testable through the UI while
  `LANGFLOW_AUTO_LOGIN=true` (see the lane section).
- Whether flows inside a deleted folder are cascaded or re-parented — asserted in
  `folder-crud.spec.ts`, not here.

---

## Preconditions *(optional)*

- Langflow reachable at `PLAYWRIGHT_BASE_URL`, auto-login enabled so
  `getAuthToken()` can mint a bearer for the API setup steps.
- Test 4 assumes the acting user's folders are all deletable, including the
  initial Starter Project — true since the initial folder became deletable.
- Test 4 must run in the destructive lane. Running it beside other specs is the
  defect this spec's own history documents.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/projects.py` — `DELETE /api/v1/projects/{id}`
  and the project list endpoint; the `500`-under-contention defect (LE-2020)
  observed on delete also reaches this spec's cleanup path.
- `src/frontend/src/pages/MainPage/components/myCollectionComponent/` — renders
  the `project-sidebar` and its `sidebar-nav-*` entries; the loop in test 4 and
  every visibility assertion depend on those testids.
- `src/frontend/src/pages/MainPage/components/dropdown/` — the
  `more-options-button_{name}` → `btn-delete-project` → confirm path used by
  tests 2, 3 and 4.
- `src/frontend/src/pages/MainPage/pages/emptyPage/` — the empty-project screen:
  the `"Start creating a project or flow"` copy and `new_project_btn_empty_page`
  testid asserted by test 4; it is also where the `projects/undefined` request of
  #1008 originates.
- `src/frontend/src/controllers/API/queries/folders/` — the folder query cache;
  a stale-cache regression here is exactly what tests 1 and 3 are built to catch.
