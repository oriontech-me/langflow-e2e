# Spec: Tool Mode — Component as Tool

**Test file:** `tests/tests-automations/regression/core-components/tool-mode.spec.ts`

## What this test validates

Verifies that any component can be promoted to **Tool Mode** so it becomes consumable by an Agent's `tools` input. Tool Mode is the mechanism that turns ordinary components (URL, Custom Component, etc.) into callable tools — without it, the Agent has nothing to dispatch and the platform's agentic story breaks.

The test exercises three independent surfaces that can each toggle Tool Mode:

1. **Keyboard shortcut** — `Ctrl/Meta+Shift+M` toggles the `toolset` view on the focused node.
2. **Component button** — `tool-mode-button` toggles the same state via UI click; the test alternates the button six times to confirm the toggle is idempotent and not racey.
3. **Sidebar Custom Component** — adding a Custom Component from the sidebar and clicking `tool-mode-button` enables Tool Mode on a freshly-instantiated node.

After Tool Mode is on, the test connects the URL component's `toolset` output to the Agent's `tools` input, runs the URL component, and asserts that the build succeeds and the toolset output exposes `tool_name`, `tool_description`, and `tool_tags` test IDs — confirming Tool Mode produces a structurally valid tool definition the Agent can consume.

For the Custom Component branch the test asserts that `tool_name` is present but `tool_description` and `tool_tags` are absent, documenting that an unconfigured Custom Component still becomes a tool but without metadata.

## Tags

`@release` `@stable` `@components`

## Validation criterion

| Step | Criterion |
|---|---|
| After `Ctrl+Shift+M` on URL node | `text=toolset` is visible (`count > 0`) |
| After second `Ctrl+Shift+M` | `text=toolset` is hidden (`count === 0`) |
| After 6 alternations on `tool-mode-button` | Toggle remains deterministic (no stuck visible/hidden state) |
| After connecting URL `toolset → tools` | At least one `.react-flow__edge` exists |
| After running URL component | `text=built successfully` is shown |
| After opening URL toolset inspection | `tool_name`, `tool_description`, `tool_tags` test IDs are present |
| After adding Custom Component + Tool Mode | `output-inspection-toolset-customcomponent` is visible |
| After running Custom Component | `tool_name` is present; `tool_description` and `tool_tags` are absent |

## External dependencies

- `src/backend/base/langflow/components/data/url.py` — URL component must expose a tool-mode-compatible interface; renaming `URL` or its outputs breaks the `data_sourceURL` sidebar test ID and the `urlcomponent` handle prefix.
- `src/backend/base/langflow/custom/custom_component/component.py` — Tool Mode plumbing; if `tool_mode` flag handling changes, the toggle stops emitting the `toolset` view.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeToolbarComponent/index.tsx` — `tool-mode-button` test ID lives here. Any rename breaks the UI-toggle assertions.
- `src/frontend/src/pages/FlowPage/components/PageComponent/index.tsx` — registers the `Ctrl/Meta+Shift+M` shortcut. If the binding changes, the keyboard branch fails.
- `src/frontend/src/components/core/parameterRenderComponent/components/sidebarComponent/sideBarItem/index.tsx` — `data_source*` and `models_and_agents*` sidebar test IDs.
- `src/backend/base/langflow/components/agents/agent.py` — Agent component's `tools` input; renaming the port breaks the `handle-agent-shownode-tools-left` selector.

## What this test does not cover

- Actual Agent execution against the connected tool. The test stops at structural validation (toolset metadata exists) — it does not run the Agent against an LLM provider to confirm the tool is invoked.
- Custom Component code editing to populate `tool_description` / `tool_tags`. The test intentionally asserts these are empty to lock the default-state contract.
- Tool Mode behavior under streaming vs. polling event delivery — the test runs in default mode only.

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — the test never executes the Agent, only the URL/Custom Component side.

## Notes

- Validated across 5 deterministic runs (~17–21s each) on Langflow 1.10.0 with zero backend errors and zero flow errors.
- Force-fail probe on the first `toolset` count assertion confirms the test catches real regressions (no false positive masking).
- The repeated 6-toggle sequence in the middle of the test is intentional: it stresses the toggle path that historically raced when keyboard and button events overlapped.

## Last validated

1.10.x
