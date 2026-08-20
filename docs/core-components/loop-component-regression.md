# Loop Component — Rendering, Error and Iteration

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

Validates four fundamental behaviors of the Loop component on the Langflow canvas:

1. **Correct rendering** — the node appears on the canvas with all expected handles (`inputs-left`, `item-left`, `item-right`, `done-right`) and with the output inspection buttons present in the node footer.
2. **Error path without connections** — running the Loop with no connections shows the "Flow build failed" notification without freezing the interface; the node remains intact and the run button stays accessible.
3. **Real iteration via template** — using the "Research Translation Loop" template, the Loop iterates over 2 ArXiv articles and produces an aggregated response in the Playground containing at least 1 mention of "Title". The threshold is intentionally relaxed to `>= 1` (rather than `>= 2`) because the LLM response is non-deterministic — what this assertion proves is that the loop emitted a non-empty aggregated response after running the template end-to-end; iteration count itself is covered deterministically by Test 4.
4. **Exit-condition termination** — given a deterministic input DataFrame of N rows (no LLM, no network), the Loop's `done` output emits an aggregated DataFrame of exactly N items, proving the loop stops after the input is exhausted. Validated for N=3 and N=1 in the same test.

If any of these tests fails, the Loop component is broken in the product: either in rendering, error handling, or actual iteration cycle execution.

---

## Tags *(required)*

`@stable` `@release` `@components` `@templates` `@playground`

---

## Step by step *(required)*

**Test 1 — renders correctly with all handles and output inspection buttons**
1. Navigate to the home and create a blank flow
2. Search "Loop" in the sidebar and add the component to the canvas via `add-component-button-loop`
3. Adjust zoom with `adjustScreenView`
4. Verify that `title-Loop` and `button_run_loop` are visible
5. Verify the 4 handles: `handle-loopcomponent-shownode-inputs-left`, `handle-loopcomponent-shownode-item-left`, `handle-loopcomponent-shownode-item-right`, `handle-loopcomponent-shownode-done-right`
6. Verify the inspection buttons: `output-inspection-item-loopcomponent`, `output-inspection-done-loopcomponent`

**Test 2 — run without connections shows build failed notification**
1. Create a blank flow and add the Loop component
2. Call `page.allowFlowErrors()` to indicate flow errors are expected
3. Click `button_run_loop`
4. Wait and confirm that the text "Flow build failed" appears
5. Verify that `button_run_loop` is still accessible and `title-Loop` is still visible with a single node on the canvas

**Test 3 — Research Translation Loop template: full wiring and iterates over 2 ArXiv papers**
1. Skip the test when OpenAI cannot serve a live call — `OPENAI_API_KEY` unset, or
   the provider recorded `inactive` in `providers.json`
   (`providerSkipGate("openai")`, #1029)
2. Navigate to "All Templates" and wait for the `template-research-translation-loop` card
3. Click the template and wait for `title-Loop` to appear
4. Verify that there are edges on the canvas (confirms template wiring)
5. Verify the 4 handles of the Loop (same criterion as Test 1)
6. Click "Setup Provider" on the Language Model component, select OpenAI, fill in `OPENAI_API_KEY`, save and select a cheap chat model. Both the "Setup Provider" button and the `model_model` dropdown are opened with a dispatched click (`dispatchEvent("click")`), not a hit-tested `.click()`: selecting the node opens the `InspectionPanel` (a pinned top-right card) over the Setup Provider button, and at zoomed-out scale the bound `api_key` popover renders over the ~10px-tall `model_model` trigger — both intercept a normal click and time out (issue #580). `dispatchEvent` targets each element directly and bypasses the interception. Handled inside the shared `setupLanguageModelOpenAI` helper
7. Change `int_int_max_results` to `2` (limit ArXiv to 2 results)
8. Open the Playground via `playground-btn-flow-io`
9. Type "transformer neural networks" in `input-chat-playground` and send
10. Wait for the last `chat-message-AI-*` message to be visible (timeout 240 s — the ArXiv fetch and first LLM call can take a while)
11. Assert the message **contains** "title" (case-insensitive) via `toContainText(/title/i, { timeout: 240000 })`. `toContainText` re-evaluates as tokens stream in, so it never samples a partially-streamed response — this is what makes the assertion robust against the streaming race tracked in #356 (the earlier code read the text once, on the first streamed token, and intermittently saw no "title" yet). Matching ≥ 1 occurrence confirms at least one complete loop iteration (Parser → LLM → done)

**Test 4 — stops after exhausting input DataFrame and emits aggregated done**
1. `awaitBootstrapTest` (each created flow's id is tracked and deleted in `afterEach` — scoped teardown, #515 — never a global `cleanAllFlows`, which races concurrent workers)
2. Build a flow body in-memory from `tests/assets/flows/loop-exit-condition.json` with the Create List node's `texts.value` set to a 3-element list and a randomized flow name
3. `POST /api/v1/flows/` with the body to create the flow server-side, capturing the returned flow id (pushed to `createdFlowIds` so `afterEach` deletes it)
4. Navigate to "/" and open the exact card by flow id — locate `[data-testid="list-card-open-button"][aria-labelledby*="${flowId}"]` and open it with a dispatched click (`dispatchEvent("click")`). Scoping by id avoids `.first()` picking the wrong card; the dispatched click bypasses the hit-test interception when residual cards from other specs/workers on the shared home grid overlap the target's absolute-inset open button (issue #580). The home navigation triggers a full owned-flows re-fetch, avoiding the deep-link cache race
5. Wait for `title-Loop` on the canvas; call `adjustScreenView`
6. Click `button_run_loop`; wait for "built successfully"
7. Click `output-inspection-done-loopcomponent`, wait for `[role="dialog"]`, read the pagination summary "1 to N of N. Page 1 of 1" via regex; assert N === 3
8. Press Escape to close the modal
9. Repeat with `texts` set to a 1-element list — steps 2–8 only (the N=3 step already bootstrapped; scoped `afterEach` handles cleanup); assert N === 1

---

## Validation criterion *(required)*

- All 4 handles (`inputs-left`, `item-left`, `item-right`, `done-right`) are visible on the node
- The 2 output inspection buttons (`item`, `done`) are visible in the node footer
- Running without connections produces "Flow build failed" notification without crash; node and run button remain accessible
- The "Research Translation Loop" template loads with visible edges (wiring intact)
- The final response in the Playground contains ≥ 1 occurrence of the word "title", confirming at least one complete loop iteration (Parser → LLM → done)
- The aggregated `done` DataFrame has length exactly equal to the input DataFrame size (validated for N=3 and N=1 via the loop-exit-condition asset)

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/flow_controls/loop.py` — LoopComponent implementation; changes to the `inputs`, `item`, `done` ports or the display name break the handle selectors
- `src/backend/base/langflow/initial_setup/starter_projects/Research Translation Loop.json` — template loaded in Test 3; renaming or removing the template breaks the `template-research-translation-loop` selector
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputParameter/` — renders the output inspection buttons; changes to the `output-inspection-{port}-{component}` pattern break the Test 1 selectors
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles; the `handle-{component}-shownode-{port}-{side}` pattern must remain stable
- `tests/assets/flows/loop-exit-condition.json` — committed flow used by Test 4; rebuild via Langflow UI if upstream schema changes break the POST `/api/v1/flows/` body validation
- `src/lfx/src/lfx/components/processing/create_list.py` — CreateListComponent; the `texts` template field is the mutation target in Test 4 and breaks if the field name changes
- `src/lfx/src/lfx/components/processing/converter.py` — TypeConverterComponent used as the loop body (Data → Message); changes to its output ports break the asset wiring

---

## What this test does not cover *(optional)*

- Behavior with very large DataFrames or loops of hundreds of iterations
- Cancellation of execution in the middle of an ongoing loop
- Execution mode with models other than the template default
- DataFrame size N=0 (Loop initialization short-circuit at `loop.py:181-184`, distinct code path from termination by exhaustion)
- Conditional early-exit triggered from inside the loop body — Langflow's Loop has no such mechanism today

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- Tests 1 and 2 do not need an API key (no LLM execution)
- Test 3 requires `OPENAI_API_KEY` in the environment **and** OpenAI recorded `active` in `providers.json` by `collect-models`; it is skipped gracefully otherwise (`providerSkipGate("openai")` — #1029; the two sequential completions under an 8-minute budget are exactly the shape that hangs a shard's worker when the key is drained). The test configures the Language Model component via the "Setup Provider" UI before executing the flow — the template ships unconfigured and fails with "A model selection is required" without this step
- Tests run in `serial` mode to avoid 400 errors from parallel autosave ("flow must be unique")

---

## When to review this test *(optional)*

- If the Loop component is renamed or its ports change names
- If the "Research Translation Loop" template is renamed, removed or has its wiring altered
- If the `data-testid` pattern of handles or output inspection buttons changes in the frontend

---

## Notes *(optional)*

- Test 3 configures the Language Model component before running the Playground — the template ships without a provider selected, causing "A model selection is required" if the setup step is skipped
- Test 3 reads the streamed response with `toContainText(/title/i, { timeout: 240000 })` rather than a one-shot `textContent()` read — `toContainText` re-evaluates as tokens stream in, so it never samples a partially-streamed message. The earlier one-shot read fired on the first streamed token and made the "title" assertion intermittently fail (flake tracked in #356). The test-level timeout is set to 8 minutes via `test.setTimeout` — the template makes 2 sequential model calls (one per ArXiv article) which can take 3-4 minutes on CI infrastructure; the global 5-minute cap is insufficient for this flow
- The test is skipped automatically (not failed) when OpenAI is unusable — key absent, or recorded `inactive` — so it does not block local runs without API keys. Set `IGNORE_PROVIDER_HEALTH=1` to override a stale local `providers.json`
- The validation criterion counts occurrences of "title" (case-insensitive) in the aggregated LLM response; the threshold is ≥ 1 because the LLM produces a free-form output and may echo "title" in only one of the N responses — checking ≥ N would couple the assertion to non-deterministic LLM formatting
- `allowFlowErrors()` is required in Test 2 to disable the automatic flow error monitor injected by the fixture
- **Test 4 daily-#744 timeout was environmental, not a product/wait defect (#751):** the daily on 2026-07-14 hit a 60s `waitForSelector("text=built successfully")` timeout on the `loop-exit-condition.json` flow (`CreateList → Loop → TypeConverter → ChatOutput`, no LLM). Root-cause on the current nightly proved the product healthy: the flow builds in ~0.1s via `POST /api/v1/build/{id}/flow` with every vertex `valid:true`. That daily was a mass-failure run (296 passed / 27 hard-failed / 27 flaky across unrelated areas — traces, agents, custom-component, mcp), i.e. shared-instance saturation. No code change to Test 4; `@stable` kept per `CONTRIBUTING.md` (quarantine only if it reproduces on a clean, non-saturated daily)
- **Test 3 (#722) — AI-message timeout raised 240s → 360s (transient-saturation).** The Research Translation Loop test hard-failed/recurred on load-degraded dailies (07-08/09/13/17): the final AI chat message stayed on placeholder dots and `/title/i` never matched inside 240s. Not a product regression — the template runs green in isolation on the current nightly (`1.11.0.dev46`, 1 passed ~1.2m; loop iterates, ArXiv fetches, LLM resolves). Under parallel CI saturation the two sequential LLM calls + live ArXiv fetches can exceed the 240s message-resolution budget, so the two `botMessage` waits (`toBeVisible` + `toContainText(/title/i)`) were raised to **360s** — still well within the 8-minute `test.setTimeout`. `@stable` kept
- **#1518 — the sidebar search RESET, and the hand-rolled add is gone (test-defect).** Test 1 failed on the 2026-08-19 and 08-20 dailies waiting 10 s for `add-component-button-loop` to attach after `sidebar-search-input.fill("Loop")`, and it was quarantined at triage of daily #1517. Root-caused on nightly `1.12.0.dev33` with an instrumented scout: the fill races the flow page mount and loses, the mount resets the search input to `""`, and no filter is ever re-applied — the term is already gone the instant `fill()` returns, and the sidebar still lists ZERO entries after 25 s of polling, so nothing arrives late and a longer budget provably cannot help. Rate 4 of 22 ungated fills (~18 %); an identical re-fill repairs it in ~320 ms. Two rival readings were refuted by measurement, not argument: `GET /api/v1/all` on dev33 still lists Loop under `flow_controls` (no reparenting, so the testid is right), and the catalog request completes before the fill in every run, hit or miss. This spec waited `state:"attached"`, so its target was not merely hidden either. Fix: `addLoopComponent` now routes through `addComponentFromSidebar`, which reads the term back and re-types it, and also covers the swallowed click one layer later (#1304). The `flow_controlsLoop` hover it dropped is not needed — the `+` button measured visible with no hover on 25 of 25 entries. `@stable` restored
