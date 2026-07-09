# Flow Functionality — Run Flow

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the **Run Flow** component end-to-end: a pipeline flow (ChatInput → ChatOutput) is built, then a second flow uses the Run Flow component to invoke the pipeline. The test verifies that the output of the pipeline matches the input text — confirming that the Run Flow component correctly chains flows together.

The built flow is renamed to a unique name so it can be selected deterministically by name in the Run Flow "Flow Name" dropdown, rather than by the fragile first-option (`dropdown-option-0`) position that failed when the instance held other flows (issue #340).

If this breaks, users cannot compose flows via the Run Flow component — a core Langflow orchestration feature.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@api`

---

## Step by step *(required)*

1. Bootstrap the app and create a blank flow
2. Add ChatOutput and ChatInput components to the canvas
3. Connect: ChatInput → ChatOutput
4. Rename the built flow to a unique name (for deterministic selection later)
5. Return to main page and create a second blank flow
6. Add the Run Flow component to the second flow
7. Open the flow name dropdown in Run Flow and refresh the list
8. Select the built flow by its unique name from the dropdown
9. Fill the `chatinput` textarea with `"THIS IS A TEST FOR RUN FLOW COMPONENT"`
10. Click `button_run_run flow`
11. Wait for "built successfully" notification
12. Click the output inspection button (`output-inspection-*`)
13. Assert the "Empty" placeholder input value equals `"THIS IS A TEST FOR RUN FLOW COMPONENT"`

---

## Validation criterion *(required)*

- "built successfully" notification appears after running
- Output inspection shows the exact input text echoed back through the pipeline

---

## External dependencies *(required)*

- `src/frontend/src/components/core/nodeToolbarComponents/` — Run Flow component UI and flow name dropdown
- `src/backend/base/langflow/api/v1/flows.py` — flow listing API used by the dropdown refresh
- `src/backend/base/langflow/processing/` — flow execution chain that runs the pipeline

---

## What this test does not cover *(optional)*

- Run Flow with input/output mapping customization
- Error handling when the referenced flow is deleted
- Run Flow with multiple chained flows

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM required — ChatInput → ChatOutput echo requires no AI calls

---

## Notes *(optional)*

- `dotenv.config()` is called at the start only in non-CI environments to load `.env` variables; in CI, environment variables are injected directly.
- The test uses `getByTestId(/^textarea_str_chatinput.*/)` (regex) because the testid includes a dynamic suffix.
- Final assertion uses Playwright-native `await expect(value).toHaveValue("...")` (auto-waiting) instead of `expect(await ...inputValue()).toBe("...")`.
- Test body is wrapped in `try { ... } finally { /* API cleanup */ }` that deletes the 2 most-recently-created flows via `getAuthToken` + `DELETE /api/v1/flows/{id}`. Cleanup is best-effort (errors swallowed) so original test failures aren't masked by cleanup errors.
