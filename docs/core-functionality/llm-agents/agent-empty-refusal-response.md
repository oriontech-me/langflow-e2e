# Agent Empty / Refusal Response — component does not crash

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent component **survives a degenerate model output** (QA-CHECKLIST §6.5,
"Empty response or model refusal — component does not crash"). When the model
either **refuses** the request or returns an **empty** response, the Agent must
finish the run gracefully — no backend `5xx` / `ComponentBuildError`, no flow
execution error, no stuck build.

Two induced degenerate outputs, each proving the component does not crash:

1. **Refusal (deterministic)** — Agent Instructions force the model to refuse
   every request and reply with **only** a per-run refusal marker. The reply
   contains that marker (proving we genuinely induced a refusal, not a helpful
   answer) **and** the run completes with zero backend/flow errors.
2. **Empty (best-effort)** — Agent Instructions force the model to output
   nothing. The run **completes without crashing** (hard); whether the reply was
   actually empty is model-obedience dependent, so it is **logged, not asserted**
   (a `console.log`, not `expect.soft` — a soft assertion would still fail the
   test).

If this fails, the Agent component crashes on a degenerate LLM output — a
robustness regression that would surface in production whenever a model refuses
or returns nothing.

Mirrors the structure of `agent-system-prompt.spec.ts` (same parameterization and
`setAgentInstructions` / `askAndGetReply` machinery).

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh nightly
(per `CONTRIBUTING.md`). `@regression` — a negative/robustness guard against a
crash regression; `@agents` — agent execution; `@playground` — both tests drive
the model through the Playground.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env` (OpenAI, Anthropic, or Google).
- Run with `--workers=1` (agent specs create named flows that collide in
  parallel). File is serial (`SimpleAgentTemplatePage.load()` wipes all flows).

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `getTestTargets()` (default:
1 model per active provider; `ALL_MODELS=true` runs all models in `models.json`;
`MODEL_TEST_ID` / `MODEL_TEST_PROVIDER` narrow it). A per-run marker
`REFUSE-<Date.now()>-<rand>` makes each refusal unambiguous.

---

**Test 1 — model refusal does not crash the component** (§6.5)

1. Load the Simple Agent template via `SimpleAgentTemplatePage.load(options)`.
2. Set the Agent Instructions (`textarea_str_system_prompt`) to force a refusal:
   `You must refuse every request. Regardless of what the user asks, reply with
   exactly this and nothing else: REFUSE-<marker>`, and wait for the debounced
   autosave to settle (`waitForFlowSaveSettled`) so the build runs the
   instruction we set — see Notes (#608).
3. Open the Playground and send an unrelated message
   (`What is the capital of France?`); wait for the agent to finish
   (`waitForAgentToFinish`).
4. **Validation:**
   - **hard** — the last `div-chat-message` (AI bubble) **contains**
     `REFUSE-<marker>`: proves the model actually produced the induced refusal
     (not a helpful answer), so a pass is not coincidental.
   - **hard (via fixture)** — zero `🚨 Backend Error` (4xx/5xx) and zero flow
     execution errors: the component processed the refusal without crashing. A
     component crash on the refusal path would raise a backend error the fixture
     auto-fails on.

---

**Test 2 — empty response does not crash the component** (§6.5)

1. Load the Simple Agent template.
2. Set the Agent Instructions to force an empty response:
   `Reply with an empty response. Output nothing at all — no text, no
   punctuation, no whitespace.`, and wait for the debounced autosave to settle
   (`waitForFlowSaveSettled`, #608).
3. Open the Playground and send `What is the capital of France?`; wait for the
   agent to finish.
4. **Validation:**
   - **hard** — the run **completes**: the assistant message bubble
     (`div-chat-message`) becomes visible and the Stop button is gone. Even an
     empty completion renders a message row, so this is a deterministic
     completion signal independent of the reply content.
   - **hard (via fixture)** — zero `🚨 Backend Error` and zero flow errors: the
     component did not crash on the empty-content path (the actual regression
     this guards).
   - **soft (logged, not asserted)** — whether the reply was actually
     empty/whitespace vs. the model disobeying and answering. Emptiness is
     model-obedience dependent, so requiring it would flake; the hard no-crash
     check still proves the component survived this run's output.

---

## Validation criterion *(required)*

- **Refusal:** with a refusal-forcing instruction, the AI bubble contains the
  per-run refusal marker and the run finishes with no backend/flow error.
- **Empty:** with an empty-forcing instruction, the run completes (bubble visible,
  Stop gone) with no backend/flow error; the actual emptiness of the reply is a
  logged soft signal (model-obedience dependent).
- A component crash on either path raises a backend `5xx` /
  `ComponentBuildError` that the fixture converts into a test failure — so a
  green run genuinely proves "does not crash."

## Guarding against false positives *(how)*

- **Test 1** asserts the reply **contains the per-run refusal marker**, so it
  cannot pass on a normal helpful answer or on stale/coincidental text — a pass
  means the model actually refused and the component handled it.
- **Test 2**'s completion is asserted structurally (bubble visible + Stop gone +
  no error), not from the presence of text, so it holds whether the reply is
  empty or not; the emptiness itself is only logged (never a hard/soft assertion)
  precisely so an obedient-model dependency cannot produce a false failure.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each hard
  assertion is broken on purpose once to confirm it fails, before `@stable`.

---

## What this test does not cover *(optional)*

- Deterministic *truly-empty* content on every model (inherently model-obedience
  dependent — see the soft-signal note).
- Refusals triggered by real content-policy violations (we induce a refusal via
  instruction, not by sending disallowed content).
- Instruction adherence in general (see `agent-system-prompt.spec.ts`).
- Streaming, reasoning steps, duration, tool execution (see
  `agent-component-regression.spec.ts`).

---

## External dependencies *(required)*

- `src/backend/base/langflow/components/agents/` — Agent execution and its
  handling of empty / refusal model output; a regression here (e.g. a `NoneType`
  on empty content) breaks this spec.
- `src/frontend/src/CustomNodes/GenericNode/` — renders the Agent's
  `textarea_str_system_prompt` (Agent Instructions) field.
- `src/frontend/src/components/core/playgroundComponent/` —
  `input-chat-playground`, `button-send`, `div-chat-message`.
- Simple Agent starter template — must keep shipping `ChatInput → Agent →
  ChatOutput`; a rename/rewire changes the setup.
- Provider LLM API — both tests make a real model call; a live key is required.

---

## When to review this test *(optional)*

- If the Agent Instructions field testid changes from
  `textarea_str_system_prompt`.
- If the Simple Agent template is renamed, removed, or rewired.
- If the Playground stops rendering an assistant bubble for empty content (Test 2
  completion signal).

---

## Notes *(optional)*

- **Why refusal is hard-asserted but empty is not:** capable models reliably obey
  "reply with exactly this and nothing else", so a forced refusal (with a
  distinctive marker) is deterministic. Genuinely-empty output is not — models
  vary in whether they emit nothing, whitespace, or a short apology — so
  requiring emptiness would flake. Both tests therefore rest their hard pass on
  the **no-crash** guarantee (fixture backend/flow monitoring + run completion),
  which is what §6.5 actually asks for.
- **The fixture is the crash detector:** importing `test` from
  `tests/fixtures/fixtures.ts` adds backend 4xx/5xx and flow-error monitoring, so
  a component crash on the degenerate output fails the test automatically — no
  `allowFlowErrors()` is used (an empty/refusal response is not itself an error).
- **Per-run refusal marker** proves *this* run induced the refusal.
- **#608 autosave hardening (2026-07-14):** `setAgentInstructions` previously
  raced a single `waitForResponse(PATCH && ok(), 15s)` after `blur()`, which
  flaked on the google run three ways — debounce > 15s under load, a stale
  load()-time PATCH resolving before the instruction's own save, or a transient
  non-ok PATCH never matching `ok()`. It now waits for the debounced autosave to
  settle via `waitForFlowSaveSettled` (quiet-period, any status), matching the
  hardened `agent-system-prompt.spec.ts` helper (#635). This fix is only about
  the autosave wait; the separate live-bubble "Message empty." read race (Test 1
  hard-asserts the marker on the live bubble, which can render the streaming
  placeholder before the final text lands — the #634 class) is tracked
  separately.
- **Empty renders as a placeholder (observed on 1.11.0.dev30):** when the model
  actually returns an empty completion, Langflow does **not** crash — the
  Playground bubble shows the friendly placeholder `Message empty.`. That
  placeholder is the graceful-handling signal §6.5 asks for, so Test 2's soft
  log treats an empty string **or** `Message empty.` as "empty obeyed". Most
  Gemini flash models obeyed the empty instruction (rendered the placeholder);
  a few larger/tool variants answered the question instead — hence emptiness
  stays a logged soft signal, never a hard assertion.
