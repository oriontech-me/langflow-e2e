# Agent Component — Image Input in Playground

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that the **Agent** component can receive an image attachment in the Playground and produce a meaningful response describing it. It loads the Simple Agent template, configures the Anthropic provider via the centralized model-provider modal, drops a PNG into the chat input, sends a prompt, and asserts that the attachment is rendered in the user message and that the model's reply references the image content. If this test fails, multimodal (vision) input through the Agent is broken for real use.

---

## Tags *(required)*

`@stable` `@release` `@components` `@agents`

---

## Step by step *(required)*

The spec contains **1 test** — `"user must be able to send images in the playground with the agent component"`.

Requires `ANTHROPIC_API_KEY` (vision-capable Claude model); skips when the key is absent.

1. Bootstrap and open `All Templates`, then load the **Simple Agent** template
2. Configure the Anthropic provider via `setupAnthropic(page)` — the centralized path: open `model_model` → `manage-model-providers` → select `provider-item-Anthropic` → fill the `sk-ant-...` key → save → enable model toggles → select a Claude model
3. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`
4. Build a `DataTransfer` in the browser context from `tests/assets/chain.png` (base64 → `File`) and dispatch a `drop` event on the chat input
5. Type `"what is this image?"` and click `button-send`
6. Wait for `chain.png` to appear (attachment rendered in the user message)
7. Read the last `.markdown.prose` block (the model reply) and assert it matches `/(chain|inkscape|logo)/` and is longer than 100 characters

---

## Validation criterion *(required)*

- The dropped image (`chain.png`) is rendered in the sent user message
- The model reply references the image content (matches `chain`, `inkscape`, or `logo`)
- The reply is a substantive description (> 100 characters)

---

## External dependencies *(required)*

- `src/backend/base/langflow/initial_setup/starter_projects/Simple Agent.json` — defines the Simple Agent template graph at runtime; changes to nodes break template load
- `src/frontend/src/modals/modelProviderModal/` — `model_model`, `manage-model-providers`, `provider-item-Anthropic`, the `sk-ant-...` input, and the Save/Replace button — any rename breaks `setupAnthropic` (shared helper at `tests/helpers/provider-setup/setup-anthropic.ts`)
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `button-send` — any rename breaks the send flow
- `tests/assets/chain.png` — the image fixture dropped into the chat

---

## What this test does not cover *(optional)*

- Image input via providers other than Anthropic (`setupAnthropic` configures Anthropic only)
- Multiple-image attachments (covered by `playground-attachments-management.spec.ts`)
- Non-image attachments (covered by `playground-non-image-attachment.spec.ts`)
- Image input via the Agent's direct input handle rather than the Playground drop zone

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `ANTHROPIC_API_KEY` defined in `.env` — without it the test skips
- Run with `--workers=1` to avoid flow conflicts

---

## When to review this test *(optional)*

- If the Simple Agent template is removed or renamed in `starter_projects`
- If the centralized model-provider modal changes its testids (breaks `setupAnthropic`) — this is what caused issue #312: the previous in-component provider testids (`value-dropdown-dropdown_str_agent_llm`, `popover-anchor-input-api_key`) were removed in 1.10.x
- If the Playground drop/attachment rendering changes (`chain.png` no longer surfaced in the user message)

---

## Notes *(optional)*

- **Fixed in issue #312**: the test previously configured the provider through removed in-component testids (`value-dropdown-dropdown_str_agent_llm`, `popover-anchor-input-api_key`). It now delegates to `setupAnthropic(page)`, matching the sibling spec `general-bugs-agent-sum-duplicate-message-playground.spec.ts`.
- **Why Anthropic-only**: the test needs a vision-capable model; the historical fixture used Anthropic. Could be generalized to a multi-provider, multimodal target in a future change.
