# Agent config persistence — settings preserved on save & reopen

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.2 "Flow with Agent saved and reopened → settings preserved".
Agent settings edited through the node's **Controls** dialog must survive the
full persistence round-trip: autosave writes them to the flow document, and
reopening the flow from the home page renders them back.

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
   card, the Controls dialog renders the exact sentinels.

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
- Run with `--workers=1` — the spec is serial (`loadTemplateByName` wipes all
  flows).

---

## Step by step *(required)*

**Test — Agent settings survive save and reopen** (§6.2)

1. Load the Simple Agent template via `loadTemplateByName` (wipes flows; no
   provider setup).
2. Open the Agent's **Controls** dialog. The `edit-button-modal` toolbar
   button only renders with the node selected AND the Inspector Panel hidden
   (`hideInspectorPanel` first, then click the Agent node).
3. Set the sentinels:
   - `textarea_str_edit_system_prompt` → `PERSIST_PROBE_<nonce>` — **typed,
     never `fill()`**: the dialog textarea is a controlled input that only
     registers real keystrokes — a `fill()`ed edit passes the DOM check but
     is silently dropped on close (~50% of runs), and the node-level
     textarea + `fill()`/blur does not trigger autosave at all on 1.11
     (0/5 runs persisted). Clear + `pressSequentially` in a retry loop with
     a DOM verification between attempts (select-all fired before focus
     settles selects nothing and the nonce lands in front of the default);
   - `int_int_edit_max_iterations` → `7` — int fields reject `fill()` and
     swallow fast keystrokes (see `agent-max-tokens.md`): click, settle,
     clear, slow `pressSequentially`, verify the DOM value;
   - `toggle_bool_edit_add_current_date_tool` — assert `aria-checked="true"`
     (template default), click, assert `"false"`.
4. Close (`edit-button-close`) and `waitForFlowSaveSettled`.
5. **Saved assert (API):** resolve the flow from the flows list (the canvas
   URL id is transient on 1.11; the wipe guarantees a single flow) and poll
   until the Agent template shows all three sentinel values.
6. Navigate home (`page.goto("/")`), reopen the flow via its
   `flow-name-<id>` card, wait for the canvas.
7. Reopen the Controls dialog (same hide-inspector + select-node dance).
8. **Reopened assert (UI):** the three dialog fields render the exact
   sentinels (nonce string, `7`, `aria-checked="false"`).

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
- **Int-field write verified in the DOM** before closing the dialog (the
  known fill/keystroke quirks would otherwise save a clamped value — which
  the API assert would also catch, a double guard).
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
