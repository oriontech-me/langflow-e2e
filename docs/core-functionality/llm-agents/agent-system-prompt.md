# Spec: Agent Instructions (system prompt) respected in the model response

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/agent-system-prompt.spec.ts`

**Last validated:** Langflow 1.12.x

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

- Parameterized per provider/model from `models.json` via the shared
  `resolveTestTargets({ tier: "tool-calling" })` in
  `helpers/provider-setup/test-targets.ts` (#1184 replaced the inline copy this
  spec used to mirror from `agent-component-regression.spec.ts`).
- **Tier: `tool-calling`. This spec was #1187's `any-completion` pilot and the
  adoption is reverted on measurement.** The adoption read the assertion as plumbing
  — the instruction travelled UI → flow → backend → model call, so any model that
  returns text carries the proof — and this doc supported it, saying "even small
  models comply with 'always include this word'". That sentence is now measured and
  it is false through the Agent: `llama3.2:1b`, the model the CI Ollama image bakes,
  passes **9 of 15** routed runs (6/10 local, 3/5 on the CI lane), and `llama3.1:8b`
  1 of 3 — size does not fix it. Called **directly** with the same system prompt and
  user message, the same 1B complies **10/10**, so the loss is the Agent's
  tool-calling scaffolding: the failing replies are the plain answer
  (`"THE CAPITAL OF FRANCE IS PARIS."`) or talk about the tools
  (`"I CAN CALL A TOOL TO RETRIEVE INFORMATION."`).
- **What the tier question actually is:** not "is the reply's content read" but
  "does any assertion depend on the model **choosing** to comply". Instruction
  adherence is model quality, and it is this spec's whole subject — so no local model
  makes this `any-completion`. Rewriting the assertion to something
  model-independent was declined: the "the instruction reached the flow" half is
  **already** asserted by `expectSentinelPersistedInFlows()`, so dropping
  `reply.contains(sentinel)` would assert persistence twice and stop covering the
  end-to-end contract this `@stable @release` spec exists for.
- Consequence: `ANY_COMPLETION_PROVIDER=ollama` no longer routes this spec — it runs
  against a hosted provider on every lane. The routing mechanism itself is unchanged
  and still available to specs that qualify (#1187 / PR #1212).
- Requires `collect-models.spec.ts` to have run and at least one provider API key
  in `.env`. Without keys/data, every target skips with a reason (no false pass).
- Run with `--workers=1` (agent specs create named flows that collide in parallel).
- File-level `test.describe.configure({ mode: "serial" })` — `load()` deletes all
  flows before loading the template, so parallel provider blocks would wipe each
  other.

---

## External dependencies

- **A live hosted model** — a real model call, no mock: a provider API key (e.g.
  `OPENAI_API_KEY`) in `.env` plus collected `providers.json` / `models.json`. The
  keyless local route is **not** available to this spec any more (see *Model
  strategy*); with `ANY_COMPLETION_PROVIDER=ollama` set, this spec still resolves
  hosted targets, because the routing only reaches `tier: "any-completion"`.
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

- **Why a sentinel code word?** It is the strongest signal that the instruction was
  applied: the assertion is a deterministic `contains`, not a fuzzy semantic match,
  and asserting a persona/language/format would be flakier across models.
  **Model-agnostic it is not**, and the older wording here ("even small models comply
  with 'always include this word'") was the premise #1187 adopted this spec on. It is
  refuted: through the Agent, `llama3.2:1b` complies in **9 of 15** runs and
  `llama3.1:8b` in 1 of 3, while the same 1B called directly complies **10/10**. So
  the sentinel is deterministic *given* a model that follows instructions reliably —
  which is a property of hosted-grade models, not of the assertion. A spec whose
  assertion needs the model to *choose a tool* (e.g. `agent-max-iterations`) is worse
  still, and this one is the same class: the #570 trap is a weak-model failure that
  reads as a product regression.
- **Per-run sentinel + negative control** are the two false-positive guards:
  randomising the sentinel each run rules out a cached/leaked match, and the
  negative-control test rules out the model emitting the stem spontaneously.
- `SimpleAgentTemplatePage.load()` deletes all flows before loading the template.
  Under rapid repeated runs the bulk-delete endpoint can 500 intermittently
  ("An internal error occurred while deleting flows") — a shared backend-under-load
  artifact caught by the fixture, not this spec's logic; single runs are clean and
  the config retries absorb it.
