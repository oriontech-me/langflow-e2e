# Agent Multimodal Image Input — image via input handle processed

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent processes an **image passed via its input handle** (QA-CHECKLIST §6.5,
"Image passed via input handle is processed correctly"). An image attached to the
chat input travels through the `ChatInput.message → Agent.input` handle (the
template's default wiring) to a **vision-capable** model, and the agent's response
**describes the image content** — proving the image was actually received and
processed, not dropped.

A **negative control** (same prompt, no image attached) proves the description
keyword only appears when the image is present, so the positive assertion cannot
pass on a coincidental or prompt-driven word.

Parameterized per active provider (resolving a vision-capable chat model), so it
covers whichever provider is configured (OpenAI / Google / Anthropic).

If this fails, the Agent can no longer consume image input through its canonical
input handle — a core multimodal regression.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh nightly.
`@regression` — guards a multimodal input regression; `@agents` — agent
execution; `@playground` — the image is attached and the flow run through the
Playground.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider with a **vision-capable** chat model (OpenAI
  `gpt-4o*`, Google `gemini-*-flash`, Anthropic `claude-3.5-*`). The test resolves
  such a model per provider and skips a provider that has none.
- Test image `tests/assets/media/chain.png` (a chain/links graphic).
- Run with `--workers=1` (agent specs create named flows that collide in
  parallel). File is serial (`SimpleAgentTemplatePage.load()` wipes all flows).

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `getTestTargets()` (default:
1 vision model per active provider). It resolves a vision-capable model for the
target provider; if none is available the provider is skipped.

---

**Test 1 — image via input handle is described by the agent** (§6.5)

1. Load the Simple Agent template via
   `SimpleAgentTemplatePage.load({ provider, model })` with a resolved
   vision-capable model. The template ships `ChatInput → Agent(input) →
   ChatOutput` wired (edge `ChatInput.message → Agent.input_value`, the input
   handle).
2. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`.
3. Attach `chain.png` via the chat input's file widget
   (`[data-testid="input-wrapper"] input[type="file"]`, `setInputFiles`) — the
   only UI path to attach an image; it flows through the `ChatInput → Agent.input`
   handle.
4. Confirm the attachment rendered: `img[alt="chain.png"]` is visible.
5. Set the prompt deterministically: fill the **ChatInput node's** "Input Text"
   field (`textarea_str_input_value`) with `what is this image? describe it` on
   the canvas and wait for autosave (`waitForFlowSaveSettled`); the Playground
   chat input pre-fills from this node value (see Notes — typing into the
   Playground races an async re-injection of the template default).
6. Send (`button-send`); wait for the agent to finish
   (`waitForAgentToFinish` — Stop button appears then hides).
7. **Validation:** the last rendered AI response (`.markdown.prose` / chat
   bubble) **matches** `/chain|link|logo|inkscape/i` **and** its length is
   `> 50` — the vision model described the image content, proving the image was
   received via the input handle and processed.

---

**Test 2 — negative control: no image, no image-specific description** (§6.5)

1. Load the Simple Agent template with the same resolved model.
2. Open the Playground; wait for `input-chat-playground`.
3. Type the **same** prompt `what is this image? describe it` **without attaching
   any image**.
4. Send; wait for the agent to finish.
5. **Validation:** the response does **not** match `/chain/i` — with no image the
   model cannot describe a chain, so the keyword only appears in Test 1 because
   the image was actually processed. This eliminates the false positive that the
   Test 1 keyword came from the prompt or coincidence rather than the image.

---

## Validation criterion *(required)*

- **Positive:** with `chain.png` attached, the agent's response mentions the
  image content (`/chain|link|logo|inkscape/i`) and is non-trivial (`> 50`
  chars) — the image reached the vision model through the `ChatInput → Agent`
  input handle and was processed.
- **Negative control:** with no image and the same prompt, the response does not
  mention `chain` — proving the positive match is caused by the image, not the
  prompt.

## Guarding against false positives *(how)*

- **Content keyword + length:** Test 1 asserts the reply describes the *actual*
  image (chain/link/logo) and is substantive, not a generic acknowledgement.
- **Negative control (Test 2):** the same prompt without the image must NOT
  produce the keyword — this is the primary guard, mirroring the positive /
  negative pattern in `agent-system-prompt.spec.ts`. Together they prove the
  keyword is caused by the processed image, not the prompt or chance.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each hard
  assertion is broken on purpose once to confirm it fails, before `@stable`.

---

## What this test does not cover *(optional)*

- Non-image file input (PDF/CSV/docs) into the Agent.
- Attaching an image on a canvas node (no ChatInput file field exists on the
  canvas — the only attach path is the chat input widget; see Notes).
- OpenAI-specific playground image regression — kept in
  `general-bugs-agent-images-playground.spec.ts` (the bug's regression origin);
  this spec is the §6.5 home and adds active-provider (e.g. Gemini) coverage.
- Agent tool execution, streaming, reasoning (see
  `agent-component-regression.spec.ts`).

---

## External dependencies *(required)*

- `src/backend/base/langflow/components/agents/` — Agent multimodal input
  handling; a regression in how image messages are consumed breaks this spec.
- `src/frontend/src/components/core/playgroundComponent/` — the
  `input-wrapper` file input, `input-chat-playground`, `button-send`, and the
  attachment `img` preview.
- `src/backend/base/langflow/components/inputs/` (ChatInput) — must keep emitting
  a Message carrying attached files on its `chat message` output.
- Simple Agent starter template — must keep shipping `ChatInput → Agent →
  ChatOutput`; a rewire changes the input-handle path.
- Provider vision model — a live key and a vision-capable model are required; the
  provider is skipped otherwise.

---

## When to review this test *(optional)*

- If the chat input file-attach widget (`input-wrapper` / `input[type=file]`) or
  the attachment preview changes.
- If the Simple Agent template is renamed, removed, or rewired.
- If `chain.png` is replaced (update the description keywords).
- If a canvas-node image-attach path is introduced (would enable a stronger
  handle-only variant).

---

## Notes *(optional)*

- **Mechanism (scouted on 1.11.0.dev33):** the Agent's message input handle is
  `handle-agent-shownode-input-left` (`input_value`, `inputTypes [Message]`), fed
  by `ChatInput.message`. The ChatInput **node** on the canvas exposes only a text
  field (`textarea_str_input_value`) — **no file-attach field**. The only UI path
  to attach an image is the chat input widget (`input-wrapper` file input, which
  accepts `image/png,image/jpeg,…`); the attached image flows through the
  confirmed `ChatInput → Agent.input` handle. Hence the image is attached via the
  Playground input and the handle carries it to the agent.
- **Vision model required:** `SimpleAgentTemplatePage.load()` with no explicit
  model selects the *first available* model, which may not be vision-capable
  (e.g. a `gemma-*`). The spec therefore resolves a vision-capable model per
  provider and skips a provider with none.
- **Prompt via the ChatInput node, not the Playground textarea:** the Playground
  chat input pre-fills from the ChatInput node's `input_value`, and it
  **re-injects the template default (`Hello, how are you?`) asynchronously** —
  which races and corrupts any text typed directly into the Playground (observed:
  the default reappears mid-type). Setting the node's "Input Text" on the canvas
  (then `waitForFlowSaveSettled`) makes the Playground prompt deterministic; the
  test asserts the Playground prefilled exactly the prompt before sending.
- **Overlap acknowledged:** the image→agent mechanism is shared with
  `general-bugs-agent-images-playground.spec.ts` (OpenAI-only bug regression).
  This spec is the named §6.5 home, is provider-parameterized (adds Gemini/active
  provider coverage), and adds the negative control.
