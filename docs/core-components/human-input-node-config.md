# Spec: Human Input node configuration (HITL branch handles)

**Test file:** `tests/tests-automations/regression/core-components/human-input-node-config.spec.ts`

**Last validated:** Langflow 1.12.x (scouted on `1.12.0.dev10`; the live-rebuild test
re-validated on `1.12.0.dev39`, the first nightly carrying the LE-2278 fix)

---

## What this test validates

Confirms the **configuration surface** of the `Human Input` node shipped with Langflow
1.11.0 (upstream `langflow-ai/langflow#13633`, LE-1449): the node's **branch outputs are
derived from its `User Choices` field**, one handle per choice, and that derivation
holds on four occasions.

1. **On add** — a freshly added node presents **exactly** the two default branch handles
   (`Approve`, `Reject`), before any field is touched: both present, and no third branch
   nobody asked for.
   **Scope caveat, measured rather than assumed:** this does *not* isolate the hardcoded
   `outputs` list in `lfx/components/flow_controls/human_input.py`. That list carries the
   comment *"update_outputs only fires on a field change"*, but the frontend fires
   `POST /api/v1/custom_component/update` **on mount** for any `real_time_refresh` field
   whose `options` are empty (`hooks/use-fetch-data-on-mount.ts`), and `decisions` is such
   a field — so the handles would be rebuilt on add even with that list removed. Isolating
   the fallback needs a different oracle (delay that response with `page.route` and assert
   the handles are already there); out of scope here.
2. **On change (live)** — adding a custom choice creates its branch handle **without a
   reload**: the `real_time_refresh` field round-trips through
   `POST /api/v1/custom_component/update` and the node re-renders with the new handle.
   **This step is also a regression guard (LE-2278).** The same `real_time_refresh` wiring
   fires an on-mount refresh for `decisions`, and until
   `langflow-ai/langflow#14741` a response computed *before* the user's commit was applied
   *after* it, silently reverting the just-added choice: `decisions` went back to
   `["Approve", "Reject"]` — the chip vanished with no toast — while the node kept
   rendering the third branch handle. The node was left **mixed** (two chips, three
   handles) and autosave persisted the reverted value over the user's work. Caught twice
   by the daily on loaded CI shards (2026-08-13, 2026-08-21) as *the chip's own edit row
   never entered the DOM*, so the step asserts the choice both **arrives** and **stays**
   once the refresh round trip has settled.
3. **After save + reload** — the configured choices and their handles survive a full page
   load. **Two** mechanisms can rebuild them — `update_frontend_node()` on the backend and
   the frontend's own on-mount round trip — so the spec asserts the **observable** (the
   handles are there after the reload) without attributing it to either. What it does pin
   is that the reload actually happened: a `window` sentinel set before it must be gone
   after, because every DOM assertion in that step is *also* satisfied by the pre-reload
   page, so a silently-cancelled navigation would otherwise pass it.
4. **Against a stale refresh response** — a choice committed while the node's on-mount
   refresh is still in flight survives that response landing. This is LE-2278 turned into a
   **deterministic** oracle: the on-mount response is held with `page.route` until just
   after the commit, then released into the window the bug needed. Test 2's re-read catches
   the same defect but only when the response happens to lag, which never happens on an
   idle box — the pre-fix rate there is 0 in 10 locally against 2 hits in 30 days on the
   8-worker daily. Holding the response makes the guard fire every run, on any machine.

The custom choice is deliberately a **two-word label** (`Request Changes`), because the
label→handle mapping is where the two ends of this feature have to agree: the backend
slugifies it (`_action_id()`: lowercase, spaces → underscores) into the output **name**
`branch_request_changes`, while the frontend derives the handle **testid** from the
display name (`handle-humaninput-shownode-request changes-right`) and its own
`toActionId()` mirror decides whether an existing edge still belongs to the renamed
choice. A one-word label would pass even if one side dropped its normalisation.

**Execution is out of scope** — pausing a run, the decision card and branch routing are
covered separately (issue #1189 → `core-functionality/playground/human-input-pause-resume.spec.ts`).
This spec never runs the flow, so it needs **no LLM provider**.

---

## Tags

`@stable` `@components` `@ui-ux` — plus `@database` on the persistence test, which
asserts state read back from the flows API after a reload, and `@regression` on the
live-rebuild test and the stale-refresh test.

No functional tag maps to HITL today; `@ui-ux` is used because every assertion here is
made against the node's configuration UI.

`@regression` is scoped to **two** tests on purpose. The file began as first-time coverage
of a new feature, which is why the tag was absent everywhere; the live-rebuild test earned
it by catching a real one — the stale-refresh revert filed as
[LE-2278](https://datastax.jira.com/browse/LE-2278) and fixed upstream in
`langflow-ai/langflow#14741` — and the stale-refresh test exists only to guard that fix.
The add-time and persistence tests still guard no previously fixed bug and stay untagged
for it.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on the nightly, `1.12.0.dev10`).
- No provider credentials, no `models.json`, no `--workers=1` — nothing here is
  model-dependent.
- The `Human Input` component must be present in the sidebar under **Flow Control**
  (`add-component-button-human-input`). It is non-legacy and non-beta on 1.12.x, so no
  sidebar toggle is required.

---

## Step by step

**beforeEach (all tests)**
1. `setupBlankFlow(page)` — create a blank flow through the REST API and open it via the
   dashboard card (avoids the UI-creation race); keep the returned id for cleanup.
2. Assert `sidebar-search-input` is visible (the editor is interactive).

**Test 1 — default branch handles on add**
1. `addComponentFromSidebar(page, "Human Input", "add-component-button-human-input")`.
2. Assert `title-Human Input` is visible and `.react-flow__node` has count `1`.
3. Assert the two default choice chips are rendered: `action-edit-Approve`,
   `action-edit-Reject`.
4. Assert both branch handles are visible: `handle-humaninput-shownode-approve-right`,
   `handle-humaninput-shownode-reject-right`.
5. Assert the node has **exactly two** output handles — every
   `[data-testid^="handle-humaninput-shownode-"][data-testid$="-right"]` inside the node,
   count `2` (so a third, unexpected branch fails the test too).

**Test 2 — a custom User Action creates its handle live**
1. Add the node (steps 1–2 above) and assert the output-handle count baseline is `2`.
2. Click `actionpicker-add-decisions` (the `+` next to **User Choices**) and assert the
   inline input `action-add-input` is visible.
3. Fill it with `Request Changes` and press `Enter`.
4. Assert, **on the same page — no reload, no navigation** — that
   `handle-humaninput-shownode-request changes-right` becomes visible, and that the chip
   `action-edit-Request Changes` is rendered.
5. Assert the output-handle count is now `3`, and that the two defaults are still there
   (adding a choice adds a branch; it does not replace the existing ones).
6. **Assert the choice stays** (LE-2278 guard): wait for the field's refresh round trip to
   go quiet, then re-assert the chip and the handle count. A point-in-time `toBeVisible`
   is satisfied by a value that is about to be reverted — under LE-2278 the chip rendered
   from local state and a late on-mount response removed it — so the reverted **mixed**
   state (two chips, three handles) is only caught by reading the chip again after the
   refresh has settled. The re-read is the assertion; a bare wait would not be.

**Test 3 — configured handles persist after save + reload**
1. Add the node and the `Request Changes` choice (Test 2's steps 1–3).
2. Gate on **server truth**, not on network silence: poll `GET /api/v1/flows/{id}`
   (Bearer from `getAuthToken`) until the persisted `Human Input` node's `outputs` names
   are exactly `["branch_approve", "branch_reject", "branch_request_changes"]` — this is
   also the assertion that the `Request Changes` → `branch_request_changes` slug survived
   the round trip.
3. Set a `window.__reloadSentinel` marker, then `page.reload()`, then assert the marker is
   **gone** — the proof that the navigation happened. Every DOM assertion in step 4 is also
   satisfied by the pre-reload page, so without this a reload that never occurred would
   pass the whole step. No `page.on("dialog")` handler is registered anywhere in the spec,
   on purpose: `FlowPage` installs a `beforeunload` that `preventDefault()`s while the
   store is dirty, and Playwright's default ACCEPTS a `beforeunload` dialog — registering a
   handler would cancel the reload (documented in
   `helpers/flows/leave-flow-editor.ts`).
4. Assert the rehydrated node renders all three chips (`action-edit-Approve`,
   `action-edit-Reject`, `action-edit-Request Changes`) and all three branch handles, with
   the output-handle count back at `3`.

**Test 4 — a stale refresh response does not revert a committed choice (LE-2278)**
1. Install a `page.route` on `**/api/v1/custom_component/update` **before** the node is
   added. It claims the **first** request whose body has `field: "decisions"` and a
   `field_value` of length `2` — the on-mount refresh, measured on `1.12.0.dev39` as
   firing ~230 ms after the node lands, carrying `["Approve", "Reject"]`. Every other
   request on that route, including the commit's own `["Approve", "Reject", "Request
   Changes"]`, passes straight through with `route.continue()`.
2. For the claimed request: `route.fetch()` to obtain the real response, flag it **parked**,
   then `await` a gate promise the test opens later, and only then `route.fulfill({ response })`.
   Fetching before parking is what makes the release deterministic — parking the *route* and
   fetching at release time leaves the response arriving after the window has already closed
   (measured: the first attempt at this released nothing, because `route.fetch()` had not
   resolved yet, which silently degraded the test into the *aborted-response* control where
   the add always sticks).
3. Add the node, then `expect.poll` until the parked flag is set — the on-mount response is
   now held, and the guarded window is open.
4. Add the `Request Changes` choice (Test 2's steps 2–3).
5. Wait ~150 ms after the `Enter`, then open the gate. This lands the stale response
   **between** the commit and the commit's own refresh response — the only one of the four
   deliveries that reverts (delivered before the commit, or after that refresh response
   applied, is harmless; never delivered at all is the control where the add sticks).
6. Assert the choice **survived**: the chip `action-edit-Request Changes` is visible, the
   node renders exactly `3` choice chips, and the output-handle count is `3`. The chip count
   is asserted alongside the handle count because the defect's signature is the two
   **disagreeing** — chips `[Approve, Reject]` with three handles — which asserting handles
   alone cannot see.
7. `page.unroute` the endpoint before the hook's cleanup navigation, so a late refresh
   during teardown is not held by a gate nobody will open.

**afterEach (all tests)**
1. `page.goto("/")` to unmount the editor (an editor left mounted over a deleted flow
   404s its `GET /flows/{id}/events` poll, which the fixture logs as a backend error),
   then `deleteFlow(page.request, flowId)`.
   A failed unmount is **warned about and carried on from**, never rethrown and never
   swallowed (#1288): rethrowing would abort the hook before the delete below and leak the
   flow — worse than the noise the navigation prevents — while swallowing silently discards
   the one line that would attribute that 404 noise to its cause.

---

## Validation criterion

| Test | Criterion |
|---|---|
| Human Input renders the default Approve and Reject branch handles when added to the canvas | `handle-humaninput-shownode-approve-right` **and** `handle-humaninput-shownode-reject-right` visible, with the node's output-handle count exactly `2` |
| adding a custom User Action creates its branch handle without a reload | after committing `Request Changes` in `action-add-input`, `handle-humaninput-shownode-request changes-right` becomes visible on the same page and the output-handle count goes `2` → `3` — **and both survive the refresh round trip settling**: the chip `action-edit-Request Changes` is still rendered and the count is still `3` once `POST /api/v1/custom_component/update` has gone quiet, so the LE-2278 mixed state (chips `[Approve, Reject]` + three handles) fails the test |
| a stale refresh response does not revert a committed choice (LE-2278) | with the on-mount `custom_component/update` response held and released ~150 ms after the `Request Changes` commit, the chip `action-edit-Request Changes` is still visible, the node renders exactly `3` chips **and** `3` output handles. Measured A/B on the same host, same script: `1.12.0.dev38` (pre-fix) → `chips=2, handles=3, chip hidden`; `1.12.0.dev39` (post-fix) → `chips=3, handles=3, chip visible` |
| the configured branch handles persist after save and reload | `GET /api/v1/flows/{id}` reports the node's `outputs` names as exactly `branch_approve, branch_reject, branch_request_changes`; the `window.__reloadSentinel` marker is gone after `page.reload()` (the navigation really happened); and the three chips and three handles render again |

---

## External dependencies

- **Sidebar add affordance** — `sidebar-search-input` + `add-component-button-human-input`
  (component `HumanInput`, category `flow_controls`, display name `Human Input`).
- **Node markers** — `title-Human Input`, `.react-flow__node` for scoping and counting.
- **`User Choices` field (`decisions`)** — an `ActionPickerInput` rendered by
  `components/core/parameterRenderComponent/components/actionPickerComponent`: `+` button
  `actionpicker-add-decisions`, inline input `action-add-input` (commits on `Enter` or
  blur, rejects a duplicate with an error toast), chip buttons `action-edit-<label>` /
  `action-remove-<label>` (the label verbatim, **not** slugified).
- **Branch handles** — `handle-{component}-shownode-{output display name lowercased}-{side}`,
  from `CustomNodes/GenericNode/components/handleRenderComponent`. `group_outputs: true`
  on every Human Input output is what makes each branch render its **own** handle instead
  of the single selectable output most components show (`NodeOutputParameter/NodeOutputs.tsx`).
- **`POST /api/v1/custom_component/update`** — the round trip behind the live rebuild
  (`real_time_refresh` on `decisions`). Not asserted directly: the DOM assertion is the
  user-visible outcome, and pinning the endpoint would couple the spec to a refresh
  mechanism upstream may change. It **is** used as a timing signal for the LE-2278 guard —
  the spec waits for it to go quiet before re-reading the chip — which is a weaker
  coupling than asserting its payload: the endpoint going away would make the wait a no-op,
  not a false pass, because the re-read still runs.
- **The staleness guard the LE-2278 fix added** —
  `src/frontend/src/CustomNodes/helpers/mutate-template.ts` (`keepUserEdits`, which keeps a
  locally edited field value over an older in-flight refresh response), reached from
  `src/frontend/src/controllers/API/queries/nodes/use-post-template-value.ts`. Its absence
  is what the guard step detects: before the fix a local edit made through
  `src/frontend/src/CustomNodes/hooks/use-handle-new-value.ts` never stamped
  `last_updated`, so any in-flight response passed the response-vs-response ordering check
  and replaced the whole template.
- **`GET /api/v1/flows/{id}`** with a Bearer token (`helpers/auth/get-auth-token.ts`) —
  the persistence oracle.
- **The refresh request body**, for telling the on-mount call apart from the commit's own.
  Measured on `1.12.0.dev39`: keys `code, template, field, field_value, tool_mode`, with
  the field name under **`field`** (not `field_name`). The two calls are distinguished by
  `field_value` length — `2` on mount, `3` after the commit — rather than by order, so a
  build that fires an extra refresh cannot silently shift which one is held.
- **Helpers** — `helpers/flows/setup-blank-flow.ts`,
  `helpers/flows/add-component-from-sidebar.ts`, `helpers/flows/delete-flow.ts`.

---

## What this test does not cover

- **Running the flow** — the pause/resume, the decision card and exclusive branch routing
  belong to #1189 (`human-input-pause-resume.spec.ts`).
- **Removing or renaming a choice** — `action-remove-<label>` / `action-edit-<label>`
  dropping or renaming a branch handle (and the "connection removed" notice when the
  renamed branch had an edge) is adjacent behaviour, deliberately left out of this
  issue's scope.
- **The duplicate-choice guard** — committing a label that already exists surfaces an
  error toast and no new branch.
- **`Enable Fallback`** — the advanced toggle that adds a `Fallback` branch and reveals
  the `Timeout` field.
- **Edge wiring** — connecting a branch handle to a downstream node, and what happens to
  that edge when its choice is renamed or removed.

---

## Notes

- Everything above was scouted against the running nightly (`1.12.0.dev10`) before the
  spec was written: the node's testids were harvested from the live DOM, and the
  persisted shape (`decisions: ["Approve","Reject","Request Changes"]` →
  `outputs: branch_approve, branch_reject, branch_request_changes`) was read back from
  `GET /api/v1/flows/{id}`.
- The three tests each build their own flow rather than sharing one in a serial describe:
  the setup is cheap (no LLM, no build), and independent tests keep a failure in the live
  rebuild from masking the persistence check.
- Sibling reference for shape: `core-components/singleton-components.spec.ts` (blank flow
  + sidebar add + node assertions + id-scoped cleanup).
- **The live-rebuild test was quarantined and is not any more.** It flaked on the
  2026-08-13 and 2026-08-21 dailies (`action-edit-Request Changes` never entering the DOM),
  was quarantined at triage as `test.fixme` with `@stable` removed, and root-caused to
  LE-2278 rather than to its wait strategy: the window is `[the user's commit → that
  commit's own refresh response applying]`, roughly the 300 ms debounce plus one round
  trip, so it needs the on-mount response to lag ~1 s — rare locally (a 10-run baseline
  never reproduced it), recurrent on a loaded 8-worker shard. The quarantine was lifted
  once the fix reached the nightly (`1.12.0.dev39`); the mechanism, the deterministic
  `page.route` reproduction and the ledger entry live in `REGRESSIONS.md` and issue #1547.
- **The stale-refresh test was A/B'd across the fix boundary, not just run green.** The
  same script against two nightlies on the same host: `1.12.0.dev38` reproduced the defect
  (`chips=2, handles=3`, chip gone — the mixed state from the daily's attempt-0 screenshot)
  and `1.12.0.dev39` did not (`chips=3, handles=3`). A test that only ever ran on the fixed
  build would not have shown it can fail.
- **Test 1's scope caveat is unchanged by that fix.** Isolating the component's hardcoded
  `outputs` fallback still needs a different oracle — the fix stops a stale response from
  overwriting a *user edit*, it does not stop the on-mount refresh from rebuilding the
  handles.
