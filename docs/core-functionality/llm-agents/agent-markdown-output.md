# Agent Markdown Output — response renders as correct Markdown in the Playground

**Last validated:** Langflow 1.13.x (Wave 8 T1 verdict measured on the nightly)

---

## What this test validates *(required)*

The Agent's response is **rendered as HTML from Markdown** in the Playground chat
(QA-CHECKLIST §6.5, "Agent returns output in correctly rendered Markdown"). When
the Agent is instructed to reply using Markdown syntax — a heading, a bulleted
list, a bold word and a fenced code block — the Playground's chat renderer
(react-markdown + remarkGfm, inside `.markdown.prose`) turns that syntax into the
corresponding **HTML tags** (`<h1..3>`, `<ul><li>`, `<strong>`, `<code>`) instead
of showing the raw Markdown characters.

The **distinctive observable** is the pairing, read against the reply the model
actually produced:

- every Markdown construct present in the **persisted reply text** renders as its
  HTML tag in the bubble, **and**
- the visible text does **not** contain the raw Markdown tokens (`**`, `## `).

A broken or plain-text renderer would show `**bold**` / `## Heading` literally —
so the raw-token-absence assertion is what proves the output was actually
*rendered*, not echoed as source. This is the built-in guard against a false
positive (a bubble that merely contains the words but never rendered Markdown).

**The reply is read before it is judged, and that is the change #1790 made.**
Until then the spec required all four constructs to be present as tags, which
made it depend on the model obeying every clause of the prompt — the dependence
#1187 rules out, and the one that failed in measurement (see *Notes*). The
constructs are now derived from the run's own persisted text
(`GET /api/v1/monitor/messages?flow_id=…&sender=Machine`), so the assertion is
about the **renderer**: whatever the model wrote must render. A model that skips
bold no longer fails the test; a renderer that drops a bold the model *did* write
still does, both through the missing `<strong>` and through the raw `**` it
leaves in the visible text.

Parameterized per active provider (OpenAI / Google / Anthropic), so it covers
whichever provider is configured; a provider with no chat model is skipped.

If this fails, the Playground no longer renders Agent Markdown output correctly —
a core presentation regression for every agent reply.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` since the Wave 8 T1 verdict (#1790). The gate this section used to
record — the Wave 3 flaky cluster #773 — is closed, and the promotion was
measured rather than assumed: three `manual.yml` dispatches at `retries=0`,
`provider=auto`, on the nightly, green on all three providers in all three
passes (9/9; runs 34881735770 / 34881749638 / 34881764492).

**A second set of three dispatches, the next day, is why the assertion changed
before the tag stayed.** Runs 34980294666 / 34980298743 / 34980302630
(2026-09-15, same lane, same settings) read 7/7, 7/7 and **1 failed / 5 passed /
1 skipped**: `[anthropic / claude-haiku-4-5]` failed on `strong` after the
heading and the list had already rendered — the reply carried no bold run at all
— and the file-level serial mode then skipped `[google]`, costing that provider
an observation. 18 attempts across the two days, 17 green, one red: a flake of
the model's compliance, not of the renderer. Promoting it unchanged would have
imported exactly the kind of red Wave 8's three-observation rule exists to catch
**before** a promotion.

The `MODEL_TOGGLE_WRITE_STALLED` failure the inherited-spec triage table
recorded against this spec (`docs/triage/inherited-spec-triage.md`) is stale by
construction and is NOT evidence about this file: the mechanism was
`setupGoogle` clicking all 29 of the provider panel's toggles, which
`53f49475` (#1679) replaced with a scoped write that clicks nothing on the
normal path. That commit was authored 2026-09-10T10:11Z and merged into `main`
at 15:35Z (PR #1805, `d1eb0670`) — **18 h AFTER** the verdict table merged
(2026-09-09T21:07Z), so no dispatch that produced the table could have carried
the fix. One of the 2026-09-14 dispatches is the
positive control: its `Collect models` reported `gemini-3.5-flash` "listed but
OFF", so the Google variant ran the COLD path — enabling the model itself
through the provider panel, the exact route #1649/#1679 document — and passed.
The stall did not reappear in any of the six dispatches across the two days.

`@regression` — guards a rendering regression; `@agents` — agent execution;
`@playground` — the reply is produced and asserted in the Playground chat.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider with a chat model. The test resolves one chat
  model per provider and skips an inactive provider (with reason).
- Run with `--workers=1`. That is what keeps two provider blocks from loading
  named templates at the same time (agent-family rule); each provider block is
  `test.describe.serial`, so a failure in one no longer skips the others.

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
   `SimpleAgentTemplatePage.load({ provider, model })`, keeping the flow id it
   returns. The template ships `ChatInput → Agent → ChatOutput` wired.
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
5. **Read the reply as the run persisted it** — poll
   `GET /api/v1/monitor/messages?flow_id={id}&sender=Machine` (Bearer) until a
   message carries non-empty `text`. The row appears before the text does, so an
   unpolled single read can observe an empty string (see *Notes*).
6. **Derive the constructs the model actually produced** from that text: a
   level-2 heading (`## ` at line start), a bulleted list (two or more `- ` lines),
   a bold run (`**…**`), a fenced code block (` ``` `). At least one must be
   present — a reply with no Markdown at all fails, naming the model, because it
   cannot exercise the renderer.
7. **Validation** — on the last rendered AI bubble (`.markdown.prose`):
   - every construct found in step 6 renders as its tag (`h1, h2, h3` / `li`
     count `>= 2` / `strong` / `code`), the failure message naming which construct
     was written but not rendered;
   - the visible text is non-empty and contains **no** raw tokens `**` or `## `
     (proving the Markdown was rendered to HTML, not shown as source).

---

## Validation criterion *(required)*

For the reply the run persisted, **every** Markdown construct that reply contains
renders as its HTML tag in the last Playground AI bubble (`.markdown.prose`) —
`h1|h2|h3` for a heading, `li` (`>= 2`) for the list, `strong` for a bold run,
`code` for a fenced block — **and** the bubble's visible text is non-empty and
carries no raw Markdown tokens (`**`, `## `).

The persisted reply must contain at least one construct; a reply with none fails
with that stated as the cause, so a model that ignored the prompt is reported
rather than passing vacuously (#1012).

## Guarding against false positives *(how)*

- **Rendered vs raw:** the primary guard is asserting the raw tokens (`**`,
  `## `) are **absent** from the visible text while the corresponding tags are
  present. A renderer that dumped the Markdown source verbatim would fail this
  pairing even though the words are all there.
- **Expectation derived from the reply, not from the prompt:** the constructs
  asserted are the ones the persisted text actually carries, so the test cannot
  pass by the model omitting work, nor fail because it did.
- **At least one construct:** a reply with no Markdown would make every
  conditional assertion vacuous, so that case fails explicitly.
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
- Links, images, nested lists, blockquotes — the spec reads the four most
  reliably-produced constructs out of the reply.
- **Which** constructs a given reply carries: the model chooses, and the test
  asserts the rendering of whatever it chose.
- Streaming/partial-render behavior — the assertion runs after the agent finishes.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/chatComponents/` — Playground Markdown /
  code-block rendering (react-markdown + remarkGfm inside `.markdown.prose`); a
  change to the plugins or the container class breaks the assertions.
- `src/lfx/src/lfx/components/models_and_agents/` — the Agent must keep emitting
  its reply as a Message rendered through the chat renderer.
- `src/backend/base/langflow/api/v1/monitor.py` — `GET /api/v1/monitor/messages`
  and its `flow_id` / `sender` filters, which is where the reply is read from.
- `src/lfx/src/lfx/schema/message.py` — the message's `text` field carrying the
  reply as the model wrote it.
- Simple Agent starter template — must keep shipping `ChatInput → Agent →
  ChatOutput`.
- Provider chat model — a live key and a chat model are required; the provider is
  skipped otherwise.

---

## When to review this test *(optional)*

- If the Playground chat renderer (`.markdown.prose`, react-markdown plugins) or
  the code-block component changes.
- If the monitor API stops exposing the reply text, or stops accepting `flow_id`
  — the expectation would have nothing to derive from.
- If the Simple Agent template is renamed, removed, or rewired.
- If the daily records this test flaky again: the remaining model dependence is
  the "at least one construct" floor, so a reply with no Markdown is the shape to
  look for before suspecting the renderer.

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
- **The measured red that changed the assertion (#1790).** On run 34980302630 the
  anthropic variant reached `strong` with a reply that had already rendered a
  heading and a list: the model produced three of the four constructs and skipped
  bold. Nothing about the renderer was wrong, and no timeout would have helped.
- **The reply text lands at completion, so it must be polled.** Measured on
  `1.13.0.dev12` at 1 Hz while a run finished: the `Machine` row is visible with
  `text: ""` for at least two seconds — twice in a row in the sample — before it
  carries the reply (114 characters, `## Report`, the three bullets and
  `**important**`). A single read taken when the bubble appears can therefore
  observe an empty string; the spec polls until non-empty and fails with that
  stated if it never arrives. `content_blocks` stayed empty on that run, so the
  `text` field is the source to read.
- **File-level serial was scoped to per-describe serial (#1790).** The old
  `test.describe.configure({ mode: "serial" })` skipped every later provider
  block once one failed — measured on run 34980302630, where `[google]` was
  skipped after `[anthropic]` failed and the pass lost an observation. Each
  provider block is now `test.describe.serial`, the shape #1690 prescribes for
  the five files it owns (this file is not among them); `--workers=1` remains
  what prevents concurrent template loads.
