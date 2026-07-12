# Spec: Agent Instructions (system prompt) respected in the model response

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/agent-system-prompt.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

Confirms that the **Agent Instructions** field (the agent's system prompt,
`textarea_str_system_prompt`) actually reaches the model and shapes its output:
a constraint written into the instructions is honoured in the agent's Playground
response, regardless of what the user asks.

The test sets a deterministic, model-agnostic instruction — the agent must
include a **per-run sentinel code word** (`PINEAPPLE-<uniq>`) verbatim in every
reply — then sends an unrelated user question and asserts the sentinel appears in
the response. The sentinel is something the model would never emit on its own for
that question, so its presence proves the system prompt was applied end to end
(UI field → flow → backend → model call), not merely saved. The sentinel is
generated fresh each run, so a pass can only be caused by *this* run's
instruction reaching the model — never a cached, hardcoded or leaked value.

A second **negative-control** test guards against a false positive: with a
neutral instruction (no sentinel), it asserts the model does **not** emit the
sentinel stem for the same question — proving the code word is not something the
model produces spontaneously, so a match in the positive test is caused by the
instruction, not coincidence.

This is the §6.5 "Output and Reasoning" deliverable: instructions are a core
agent contract; a regression that dropped the system prompt would silently
un-steer every agent flow while still returning plausible text.

---

## Tags

`@stable` `@release` `@agents` `@playground` — on both tests (positive +
negative control). Validated against collected provider data (see the area
`CLAUDE.md`).

---

## Step by step

Both tests share the target resolution and helpers (`setAgentInstructions`,
`askAndGetReply`); the file is serial (see Model strategy).

Target resolution (both): resolve targets from `models.json` (one model per
active provider by default; `MODEL_TEST_ID` / `MODEL_TEST_PROVIDER` / `ALL_MODELS`
override). Skip a target if its provider is inactive or its env key is missing.

**Test 1 — instructions respected (positive):**
1. Load the **Simple Agent** template via `SimpleAgentTemplatePage.load(options)`
   (clears flows, loads template, configures provider/model). Skip on
   `MODEL_NOT_AVAILABLE`.
2. Generate a per-run sentinel `PINEAPPLE-<uniq>`. Set the Agent Instructions:
   fill `textarea_str_system_prompt`, blur, **drain every pending autosave**
   (`waitForFlowSaveSettled`), then **confirm server-side** that the instruction
   reached the PERSISTED flow — poll `GET /api/v1/flows/` until the unique
   sentinel appears in a flow's `data` graph. The earlier single
   `waitForResponse(PATCH /api/v1/flows/)` could match a STALE PATCH still in
   flight from `load()` (model selection), resolving before the instruction's own
   save landed — so the build could run the template default (no instruction) and
   the model answers the literal question without the sentinel (#635). The
   server-side check is the payload-level proof the instruction reaches the
   provider (DOM state cannot prove persistence): if the sentinel IS in the
   persisted flow but the reply omits it, that is unambiguously model-side
   non-adherence, not a dropped instruction.
3. Open the Playground (`playground-btn-flow-io`), send an unrelated message
   ("What is the capital of France?"), wait for the run to finish (Stop button
   appears then hides).
4. Assert the latest `div-chat-message` contains the sentinel (case-insensitive).

**Test 2 — negative control:**
1. Load the template.
2. Set a neutral instruction ("You are a helpful assistant.") + autosave.
3. Send the same unrelated message, wait for finish.
4. Assert the latest `div-chat-message` does **not** contain the sentinel stem
   (`PINEAPPLE`).

---

## Validation criterion

| Test | Criterion |
|---|---|
| Positive | after the run, latest `div-chat-message` **contains** the per-run sentinel |
| Negative control | after the run with a neutral prompt, latest `div-chat-message` does **not** contain the sentinel stem |

A positive that omits the sentinel means the system prompt did not reach the
model (fail). A negative control that emits the stem means the sentinel is not a
reliable signal (fail — invalidates the positive assertion).

---

## Model strategy

- Parameterized per provider/model from `models.json` (inline `getTestTargets`,
  mirroring `agent-component-regression.spec.ts` in this folder — there is no
  shared export yet).
- Requires `collect-models.spec.ts` to have run and at least one provider API key
  in `.env`. Without keys/data, every target skips with a reason (no false pass).
- Run with `--workers=1` (agent specs create named flows that collide in parallel).
- File-level `test.describe.configure({ mode: "serial" })` — `load()` deletes all
  flows before loading the template, so parallel provider blocks would wipe each
  other.

---

## External dependencies

- **A live provider API key** (e.g. `OPENAI_API_KEY`) in `.env` and collected
  `providers.json` / `models.json`. This is a real model call — no mock.
- `textarea_str_system_prompt` — Agent Instructions field on the Agent node.
- `SimpleAgentTemplatePage` / `providerSetupMap` — template load + provider config.
- Playground testids: `playground-btn-flow-io`, `input-chat-playground`,
  `button-send`, `div-chat-message`; Stop button (`role=button name=Stop`).

---

## What this test does not cover

- Instruction *persistence across reload* — covered by
  `core-components/agent-component-regression.spec.ts` ("system prompt accepts
  input and persists across flow reload").
- Tool calling / reasoning steps — covered by the agent interaction suite.
- Multi-turn instruction adherence (only a single user turn is asserted).
- Exact response wording beyond the sentinel (models phrase freely; only the
  enforced constraint is checked, to stay deterministic across models).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (nightly).
- `collect-models.spec.ts` run; at least one active provider with a valid key.

---

## Notes

- **Why a sentinel code word?** It is the strongest model-agnostic signal that
  the instruction was applied: even small models comply with "always include this
  word", and the assertion is a deterministic `contains`, not a fuzzy semantic
  match. Asserting a persona/language/format would be flakier across models.
- **Per-run sentinel + negative control** are the two false-positive guards:
  randomising the sentinel each run rules out a cached/leaked match, and the
  negative-control test rules out the model emitting the stem spontaneously.
- `SimpleAgentTemplatePage.load()` deletes all flows before loading the template.
  Under rapid repeated runs the bulk-delete endpoint can 500 intermittently
  ("An internal error occurred while deleting flows") — a shared backend-under-load
  artifact caught by the fixture, not this spec's logic; single runs are clean and
  the config retries absorb it.
