# Agent Component — Image Input in Playground

**Last validated:** Langflow 1.11.0

---

## What this test validates *(required)*

Validates that the **Agent** component can receive an image attachment in the Playground and produce a meaningful response describing it. It loads the Simple Agent template, configures the OpenAI provider via the centralized model-provider modal, attaches a PNG to the chat input, sends a prompt, and asserts that the attachment is rendered in the user message and that the model's reply references the image content. If this test fails, multimodal (vision) input through the Agent is broken for real use.

---

## Tags *(required)*

`@stable` `@release` `@components` `@agents`

---

## Step by step *(required)*

The spec contains **1 test** — `"user must be able to send images in the playground with the agent component"`.

Requires `OPENAI_API_KEY` (vision-capable `gpt-4o-mini`); skips when the key is absent. OpenAI is used (not Anthropic) so the test actually runs in the weekly workflow, which provides `OPENAI_API_KEY`.

1. Load the **Simple Agent** template via the canonical `SimpleAgentTemplatePage.load({ provider: "openai" })` — it clears existing flows, opens the templates modal through the correct entry point, waits for the canvas to actually load (`canvas_controls_dropdown`), then configures the OpenAI provider. With no explicit model it selects a resilient default (`gpt-4o-mini`, vision-capable on the Agent component)
2. (Provider setup is part of step 1's `load()` — the centralized path: open `model_model` → `manage-model-providers` → select `provider-item-OpenAI` → fill the `sk-...` key → save → enable model toggles → select model)
3. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`
4. Attach `tests/assets/media/chain.png` via the Playground file input (`[data-testid="input-wrapper"] input[type="file"]`) and confirm the `img[alt="chain.png"]` preview
5. Clear the input and type `"what is this image?"` with real keystrokes (`pressSequentially`), then click `button-send`
6. Wait ~5s for the model reply
7. Read the last `.markdown.prose` block (the model reply) and assert it matches `/(chain|inkscape|logo)/` and is longer than 50 characters

---

## Validation criterion *(required)*

- The dropped image (`chain.png`) is attached and rendered as an `img[alt="chain.png"]` preview before sending
- The model reply references the image content (matches `chain`, `inkscape`, or `logo`)
- The reply is a substantive description (> 50 characters)

---

## External dependencies *(required)*

- `src/backend/base/langflow/initial_setup/starter_projects/Simple Agent.json` — defines the Simple Agent template graph at runtime; changes to nodes break template load
- `src/frontend/src/modals/modelProviderModal/` — `model_model`, `manage-model-providers`, `provider-item-OpenAI`, the `sk-...` input, the Save/Replace button, and the `llm-toggle-*` switches — any rename breaks `setupOpenAI` (shared helper at `tests/helpers/provider-setup/setup-openai.ts`)
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `input-wrapper` file input, `button-send` — any rename breaks the attach/send flow
- `tests/assets/media/chain.png` — the image fixture attached into the chat

---

## What this test does not cover *(optional)*

- Image input via providers other than OpenAI (`setupOpenAI` configures OpenAI only)
- Multiple-image attachments (covered by `playground-attachments-management.spec.ts`)
- Non-image attachments (covered by `playground-non-image-attachment.spec.ts`)
- Image input via the Agent's direct input handle rather than the Playground

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `OPENAI_API_KEY` defined in `.env` — without it the test skips
- Run with `--workers=1` to avoid flow conflicts

---

## When to review this test *(optional)*

- If the Simple Agent template is removed or renamed in `starter_projects`
- If the centralized model-provider modal changes its testids (breaks `setupOpenAI`) — this is what caused issue #312: the previous in-component provider testids (`value-dropdown-dropdown_str_agent_llm`, `popover-anchor-input-api_key`) were removed in 1.10.x
- If the Playground attachment rendering changes (`img[alt="chain.png"]` preview no longer surfaced) or the chat input stops accepting `pressSequentially` input

---

## Notes *(optional)*

- **Fixed in issue #312**: the test previously configured the provider through removed in-component testids (`value-dropdown-dropdown_str_agent_llm`, `popover-anchor-input-api_key`). It now delegates to `setupOpenAI(page)`.
- **Why OpenAI**: the test needs a vision-capable model. It originally used Anthropic, but the weekly workflow only provides `OPENAI_API_KEY`, so an Anthropic-keyed test would always skip in CI and give no weekly signal. `gpt-4o-mini` is vision-capable and runs in the weekly.
- **1.11.0 template-load fix**: the test previously loaded the template with a manual `awaitBootstrapTest` + `side_nav_options_all-templates` + heading click. On Langflow 1.11.0 that path landed on the projects list instead of the flow canvas (post-create navigation race), so the provider entry point never appeared and the test failed at the 30s `model_model`/`Setup Provider` wait. It now uses the canonical `SimpleAgentTemplatePage.load()` (same helper as the other agent/memory specs), which waits for `canvas_controls_dropdown` before returning.
- **1.10.x quirks handled**: (1) the image is attached via `setInputFiles` because the old manual `DataTransfer` drop no longer renders the attachment; (2) the chat input is pre-filled with a sample prompt and the send action reads the component's internal state, so the prompt is typed with `pressSequentially` (a programmatic `.fill()` is ignored).
