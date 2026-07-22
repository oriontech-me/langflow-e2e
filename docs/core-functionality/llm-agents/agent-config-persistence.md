# Agent config persistence — settings preserved on save & reopen

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.2 "Flow with Agent saved and reopened → settings preserved".
Agent settings edited on the node (advanced fields exposed via the node
**inspector** side-panel) must survive the full persistence round-trip:
autosave writes them to the flow document, and reopening the flow from the
home page renders them back.

One test drives three sentinels covering the template's three field
serializations:

- **string** — `system_prompt` set to `PERSIST_PROBE <nonce>` (per-run nonce:
  a default or residue from an earlier run can never satisfy the assert);
- **int** — `max_iterations` set to `7` (non-default);
- **bool** — `add_current_date_tool` flipped `true → false` (asserting the
  pre-flip state is `true` first, so the flip is proven a real write, not a
  read-back of a default).

Both persistence halves are asserted:

1. **Saved** — after `waitForFlowSaveSettled`, the flows API shows the three
   sentinel values in the Agent node's template.
2. **Reopened preserved** — navigating home and reopening the flow from its
   card, the node body renders the exact sentinels (the inspector-added
   fields persist on the body across reload).

If this fails, agent configuration silently reverts on reload — users lose
prompt/limit/tool settings without any error.

**Model-free by design** (area rule): persistence is a backend/autosave
contract — no LLM call, no provider key, no Playground. The template is
loaded WITHOUT provider setup and nothing is executed.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@workspace`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@regression` — guards the autosave→reload round-trip; `@agents` —
Agent configuration surface; `@workspace` — flow save/reopen lifecycle.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No provider key or `models.json` needed (model-free).
- Run with `--workers=1` — the spec is serial (named template flows collide
  under parallelism).

---

## Step by step *(required)*

**Test — Agent settings survive save and reopen** (§6.2)

1. Load the Simple Agent template via `loadTemplateByName`, capturing the
   created flow's id from the `POST /api/v1/flows/` response. No pre-cleanup
   of existing flows (a wipe kills parallel workers' in-flight flows, #553;
   duplicate names auto-suffix) — the spec deletes its own flow by id in
   `afterEach`. No provider setup (model-free).
2. `adjustScreenView` to render the Agent node (the template loads with the
   node outside the initial viewport, so its body fields do not mount until
   the canvas is fit — the sibling agent specs get this for free from
   `SimpleAgentTemplatePage.load`, which this model-free spec does not use),
   then `waitForFlowSaveSettled` — the load + fit-view schedule an autosave
   whose response would otherwise revert the first edit.
3. Expose the advanced fields. dev49 replaced the old **Controls** dialog
   (`edit-button-modal`) with the node **inspector** side-panel: select the
   Agent node → `parameters-button` (`openAdvancedOptions`) → toggle
   `inspector-add-max_iterations` and `inspector-add-add_current_date_tool`
   to expose both on the node body → `inspection-panel-close`
   (`closeAdvancedOptions`). Add both in ONE inspector session, then
   `waitForFlowSaveSettled` — the add-autosave (debounced PATCH) must land
   before any value is edited, or its response re-renders the node and
   detaches the field mid-edit (the documented autosave race).
4. Set the sentinels on the node body, `waitForFlowSaveSettled` after each so
   the serialized edits never race one another's PATCH. On the body the field
   testids drop the `_edit_` infix:
   - `textarea_str_system_prompt` → `PERSIST_PROBE_<nonce>` — on the body by
     default (no inspector-add). **Clear + typed, never `fill()`**: the
     node-level textarea is a controlled input that `fill()` sets in the DOM
     without marking the node dirty, so the edit never autosaves and is
     reverted on the next re-render (0/5 persisted historically). Real
     keystrokes (`pressSequentially`) commit it;
   - `int_int_max_iterations` → `7` — body int field: `fill()` + blur (verify
     the DOM value);
   - `toggle_bool_add_current_date_tool` — assert `aria-checked="true"`
     (template default), click, assert `"false"`.
5. **Saved assert (API):** fetch the flow by the id captured at creation
   (`GET /api/v1/flows/{id}` — the canvas URL id is transient on 1.11, so
   the id comes from the template-instantiation `POST` response, not the
   URL) and poll until the Agent template shows all three sentinel values.
6. Navigate home (`page.goto("/")`), reopen the flow via its
   `flow-name-<id>` card, wait for the canvas, `adjustScreenView`.
7. **Reopened assert (UI):** the inspector-added fields persist on the body
   across reload, so the three body fields render the exact sentinels
   directly (nonce string, `7`, `aria-checked="false"`) — no re-open of the
   inspector needed.

---

## Validation criterion *(required)*

All three sentinels — string, int and bool — must appear BOTH in the
persisted flow document (API, after save settles) and in the Controls dialog
after a full home-navigation reopen. Any missing/reverted field fails.

## Guarding against false positives *(how)*

- **Per-run nonce** in the string sentinel — defaults or residue can never
  match.
- **Pre-flip assertion** on the bool — proves the test wrote the value; a
  changed template default fails loudly instead of silently inverting the
  sentinel's meaning.
- **Int-field write verified in the DOM** (`toHaveValue("7")`) before the
  save assert — a clamped or dropped value fails here as well as in the API
  assert, a double guard.
- **API assert before the reload** — separates "was never saved" from "saved
  but not re-rendered", so a failure pinpoints the broken half.
- **Force-failure checks** (CONTRIBUTING §2): M1 — expect a different int via
  the API ⇒ saved-assert must fail; M2 — expect a different nonce in the UI ⇒
  reopened-assert must fail.

---

## What this test does not cover *(optional)*

- Persistence of model/provider selection (`model_model`) — requires a
  configured provider; provider-management specs cover that surface (#505).
- Tool rename persistence (`tools_metadata`) — covered by
  `agent-tool-name-validation.spec.ts` (#490).
- Version-history restore or flow export/import round-trips.

---

## External dependencies *(required)*

- None beyond the running Langflow instance (model-free: no provider API, no
  collect-models data).
