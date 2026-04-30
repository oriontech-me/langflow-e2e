# Loop Component — Rendering, Error and Iteration

**Last validated:** Langflow 1.10.x (timeout corrected 2026-04-30, fixes #87)

---

## What this test validates *(required)*

Validates three fundamental behaviors of the Loop component on the Langflow canvas:

1. **Correct rendering** — the node appears on the canvas with all expected handles (`inputs-left`, `item-left`, `item-right`, `done-right`) and with the output inspection buttons present in the node footer.
2. **Error path without connections** — running the Loop with no connections shows the "Flow build failed" notification without freezing the interface; the node remains intact and the run button stays accessible.
3. **Real iteration via template** — using the "Research Translation Loop" template, the Loop iterates over 2 ArXiv articles and produces an aggregated response in the Playground containing at least 2 mentions of "Title", confirming the loop completed both iterations.

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
1. Skip the test if `OPENAI_API_KEY` is not set in the environment
2. Navigate to "All Templates" and wait for the `template-research-translation-loop` card
3. Click the template and wait for `title-Loop` to appear
4. Verify that there are edges on the canvas (confirms template wiring)
5. Verify the 4 handles of the Loop (same criterion as Test 1)
6. Change `int_int_max_results` to `2` (limit ArXiv to 2 results)
7. Click "Setup Provider" on the Language Model component, select OpenAI, fill in `OPENAI_API_KEY`, save and select `gpt-4o-mini`
8. Open the Playground via `playground-btn-flow-io`
9. Type "transformer neural networks" in `input-chat-playground` and send
10. Wait for `chat-message-AI-*` to appear (timeout 240 s)
11. Extract the text of the last AI message and count occurrences of "title" (case-insensitive); must be ≥ 2

---

## Validation criterion *(required)*

- All 4 handles (`inputs-left`, `item-left`, `item-right`, `done-right`) are visible on the node
- The 2 output inspection buttons (`item`, `done`) are visible in the node footer
- Running without connections produces "Flow build failed" notification without crash; node and run button remain accessible
- The "Research Translation Loop" template loads with visible edges (wiring intact)
- The final response in the Playground contains ≥ 2 occurrences of the word "title", confirming 2 complete loop iterations

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/flow_controls/loop.py` — LoopComponent implementation; changes to the `inputs`, `item`, `done` ports or the display name break the handle selectors
- `src/backend/base/langflow/initial_setup/starter_projects/Research Translation Loop.json` — template loaded in Test 3; renaming or removing the template breaks the `template-research-translation-loop` selector
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputParameter/` — renders the output inspection buttons; changes to the `output-inspection-{port}-{component}` pattern break the Test 1 selectors
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles; the `handle-{component}-shownode-{port}-{side}` pattern must remain stable

---

## What this test does not cover *(optional)*

- Loop exit condition (the `done` port activated by an LLM criterion): covered separately by a future issue in QA-CHECKLIST
- Behavior with very large DataFrames or loops of hundreds of iterations
- Cancellation of execution in the middle of an ongoing loop
- Execution mode with models other than the template default

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- Tests 1 and 2 do not need an API key (no LLM execution)
- Test 3 requires `OPENAI_API_KEY` in the environment; it is skipped gracefully when the key is absent. The test configures the Language Model component via the "Setup Provider" UI before executing the flow — the template ships unconfigured and fails with "A model selection is required" without this step
- Tests run in `serial` mode to avoid 400 errors from parallel autosave ("flow must be unique")

---

## When to review this test *(optional)*

- If the Loop component is renamed or its ports change names
- If the "Research Translation Loop" template is renamed, removed or has its wiring altered
- If the `data-testid` pattern of handles or output inspection buttons changes in the frontend

---

## Notes *(optional)*

- Test 3 configures the Language Model component before running the Playground — the template ships without a provider selected, causing "A model selection is required" if the setup step is skipped
- The timeout in Test 3 is 240 s for the LLM response and the test-level timeout is set to 8 minutes via `test.setTimeout` — the template makes 2 sequential model calls (one per ArXiv article) which can take 3-4 minutes on CI infrastructure; the global 5-minute cap is insufficient for this flow
- The test is skipped automatically (not failed) when `OPENAI_API_KEY` is absent, so it does not block local runs without API keys
- The validation criterion counts occurrences of "title" (case-insensitive) in the aggregated response: the Parser formats each article as `Title: {title}\nSummary: {summary}`, so 2 articles guarantee ≥ 2 "title" in the final output
- `allowFlowErrors()` is required in Test 2 to disable the automatic flow error monitor injected by the fixture
