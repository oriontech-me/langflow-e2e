# Agent Markdown Output — response renders as correct Markdown in the Playground

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent's response is **rendered as HTML from Markdown** in the Playground chat
(QA-CHECKLIST §6.5, "Agent returns output in correctly rendered Markdown"). When
the Agent is instructed to reply using Markdown syntax — a heading, a bulleted
list, a bold word and a fenced code block — the Playground's chat renderer
(react-markdown + remarkGfm, inside `.markdown.prose`) turns that syntax into the
corresponding **HTML tags** (`<h1..3>`, `<ul><li>`, `<strong>`, `<code>`) instead
of showing the raw Markdown characters.

The **distinctive observable** is the pairing:

- the rendered chat bubble **contains** the HTML tags for each construct, **and**
- the visible text does **not** contain the raw Markdown tokens (`**`, `## `).

A broken or plain-text renderer would show `**bold**` / `## Heading` literally —
so the raw-token-absence assertion is what proves the output was actually
*rendered*, not echoed as source. This is the built-in guard against a false
positive (a bubble that merely contains the words but never rendered Markdown).

Parameterized per active provider (OpenAI / Google / Anthropic), so it covers
whichever provider is configured; a provider with no chat model is skipped.

If this fails, the Playground no longer renders Agent Markdown output correctly —
a core presentation regression for every agent reply.

---

## Tags *(required)*

`@regression` `@agents` `@playground`

**`@stable` is intentionally withheld (promotion gated — issue #826).** This area
is in the current flaky cluster (#773); the spec is authored now but promoted to
`@stable` only after the clean, non-guarded baseline for the Wave 3 infra work is
achieved. Absence of `@stable` is explained here per the PR checklist.

`@regression` — guards a rendering regression; `@agents` — agent execution;
`@playground` — the reply is produced and asserted in the Playground chat.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider with a chat model. The test resolves one chat
  model per provider and skips an inactive provider (with reason).
- Run with `--workers=1` (agent specs create named flows that collide in
  parallel). File is serial (`SimpleAgentTemplatePage.load()` wipes all flows).

---

## Step by step *(required)*

The spec generates **1 test per active model** via
`resolveTestTargets({ tier: "tool-calling", requires: "chat" })` (default: one chat
model per active provider). `requires: "chat"` excludes the non-chat families
(embedding / tts / audio / whisper / realtime / image / moderation / search).

**Changed in #1184:** this spec carried its own copy of the resolver with **no
`MODEL_TEST_ID` branch**, so pinning a model did not pin this spec — it kept running
one target per provider. It now honours the documented env precedence like every
other parametrized spec, which also means `MODEL_TEST_PROVIDER` alone sweeps that
provider's chat catalog rather than narrowing to one model. Use the
`MODEL_TEST_PROVIDER` + `MODEL_TEST_ID` pair to narrow.

---

**Test — Agent reply renders as Markdown** (§6.5)

1. Load the Simple Agent template via
   `SimpleAgentTemplatePage.load({ provider, model })`. The template ships
   `ChatInput → Agent → ChatOutput` wired.
2. Set the **ChatInput node's** "Input Text" field
   (`[data-testid^="rf__node-ChatInput"] textarea_str_input_value`) on the canvas
   to a prompt that demands a Markdown-only reply containing a level-2 heading, a
   three-item bulleted list, one **bold** word, and a fenced code block; wait for
   autosave (`waitForFlowSaveSettled`). Setting the prompt on the node — not the
   Playground textarea — avoids the async re-injection race documented in
   `agent-multimodal-image-input.md` (Notes).
3. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground` and assert it prefilled the prompt.
4. Send (`button-send`); wait for the agent to finish
   (`waitForAgentToFinish` — the Stop button appears then hides).
5. **Validation** — on the last rendered AI bubble (`.markdown.prose`):
   - a heading tag is present (`h1, h2, h3`),
   - the bulleted list rendered — `li` count `>= 2`,
   - a bold run rendered — `strong` present,
   - a fenced code block rendered — `code` present, **and**
   - the visible text does **not** contain the raw tokens `**` or `## `
     (proving the Markdown was rendered to HTML, not shown as source).

---

## Validation criterion *(required)*

The last Playground AI bubble (`.markdown.prose`) contains the HTML tags for
every requested construct — `h1|h2|h3`, `li` (`>= 2`), `strong`, `code` — **and**
its visible text contains no raw Markdown tokens (`**`, `## `). Presence of the
tags proves the constructs rendered; absence of the raw tokens proves they were
*rendered* rather than echoed as literal source.

## Guarding against false positives *(how)*

- **Rendered vs raw:** the primary guard is asserting the raw tokens (`**`,
  `## `) are **absent** from the visible text while the corresponding tags are
  present. A renderer that dumped the Markdown source verbatim would fail this
  pairing even though the words are all there.
- **Multiple constructs:** requiring heading + list + bold + code together makes
  a coincidental pass (e.g. a stray `<strong>` from unrelated formatting)
  implausible.
- **Deterministic prompt:** the prompt is set on the ChatInput node and its exact
  prefill is asserted in the Playground before sending, removing the typing race.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each hard
  assertion is broken on purpose once to confirm it fails.

---

## What this test does not cover *(optional)*

- Markdown **table** rendering via remarkGfm (covered for a non-agent flow in
  `playground/playground-output-data.spec.ts`, DataFrame → `<table>`).
- Structured **JSON** output via `output_schema` (see
  `agent-structured-output.spec.ts`).
- Links, images, nested lists, blockquotes — the spec asserts the four most
  reliably-produced constructs.
- Streaming/partial-render behavior — the assertion runs after the agent finishes.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/chatComponents/` — Playground Markdown /
  code-block rendering (react-markdown + remarkGfm inside `.markdown.prose`); a
  change to the plugins or the container class breaks the assertions.
- `src/backend/base/langflow/components/agents/` — the Agent must keep emitting
  its reply as a Message rendered through the chat renderer.
- Simple Agent starter template — must keep shipping `ChatInput → Agent →
  ChatOutput`.
- Provider chat model — a live key and a chat model are required; the provider is
  skipped otherwise.

---

## When to review this test *(optional)*

- If the Playground chat renderer (`.markdown.prose`, react-markdown plugins) or
  the code-block component changes.
- If the Simple Agent template is renamed, removed, or rewired.
- On promotion to `@stable` once the #773 baseline is clean (issue #826 gate).

---

## Notes *(optional)*

- **Renderer grounded** in the existing `@stable` spec
  `playground/playground-output-data.spec.ts`: a ```json fence renders as a
  `<code>` element and a GFM table as `<table>`, both inside `.markdown.prose`.
  The same renderer turns the Agent's Markdown reply into HTML tags.
- **Prompt determinism** mirrors `agent-multimodal-image-input.md`: the Playground
  chat input pre-fills from the ChatInput node's `input_value` and re-injects the
  template default asynchronously, so the prompt is set on the canvas node and its
  prefill asserted before sending.
- **Wrapping-fence guard (scouted on 1.11.0.dev49, gpt-4o-mini):** a prompt that
  merely says "reply in Markdown … include a fenced code block" makes the model
  intermittently (~1 in 3 runs) wrap the ENTIRE reply in a single ```markdown
  fence — the Playground then correctly renders it as one code block, so the
  heading/list/bold never become tags and the raw tokens (`##`, `-`, `**`) appear
  literally. That is correct rendering of a code fence, not a bug — but it makes
  the test a false negative. The prompt therefore explicitly forbids wrapping the
  whole answer in a code block and scopes the fence to `print('hello')` only;
  verified 8/8 clean after the change.
- **Promotion gated (#826):** authored without `@stable`; promote after the Wave 3
  clean baseline (#773) — do not add `@stable` in this PR.
