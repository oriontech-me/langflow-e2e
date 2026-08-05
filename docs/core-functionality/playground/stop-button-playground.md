# Playground – Stop Button

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that the **Stop** button in the Playground interrupts an in-progress flow execution and surfaces a `"build stopped"` confirmation message.

The test uses a Custom Component with a 60-second `sleep()` to guarantee the flow is still running when the stop action fires. If `button-stop` is missing, fails to appear during execution, or the backend does not acknowledge the cancellation, this test will catch it.

---

## Tags *(required)*

`@stable` `@release` `@api` `@playground`

---

## Step by step *(required)*

1. Open a blank flow and add a **Chat Output** component via the sidebar
2. Add a **Custom Component** whose `build_output` method calls `sleep(60)` before returning — this keeps the flow running long enough for the stop action
3. Connect CustomComponent output → ChatOutput input
4. Click **Run** on ChatOutput to start execution, then immediately open the Playground
5. Wait up to 30 s for `button-stop` to appear (visible while the build is in progress)
6. Click `button-stop`
7. Assert that the text `"build stopped"` becomes visible (confirms backend acknowledged the cancellation)

---

## Validation criterion *(required)*

- `button-stop` is visible within 30 s of starting execution
- After clicking `button-stop`, the text `"build stopped"` appears within 30 s

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx` — renders `button-stop` during active builds; calls `stopBuilding()` on click
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/no-input.tsx` — alternate render path for `button-stop` when the flow has no input component

---

## What this test does not cover *(optional)*

- Stopping a flow from the canvas (outside the Playground)
- Stopping an agent mid-reasoning step (covered in `agent-component-regression.spec.ts`)
- Behaviour when the flow completes before the stop button is clicked

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key required; the Custom Component is pure Python with a timed sleep

---

## Notes *(optional)*

- The 60-second `sleep()` in the Custom Component is intentional — it guarantees the flow is still in-progress when Playwright clicks the stop button, avoiding a race condition where the flow finishes before the assertion fires.
- `button-stop` is the last occurrence (`.last()`) because the Playground may render multiple instances depending on the session state.
