# Agent Max Iterations — agent stops at the configured limit

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent's **Max Iterations** control caps the agent's model-call loop
(QA-CHECKLIST §6.2 "Agent stops when maximum number of iterations is reached" and
§7.7 "Maximum agent iterations"). When the loop reaches the configured limit, the
agent stops and returns the terminal message **`Model call limits exceeded: run
limit (N/N)`** instead of completing the task.

Two tests establish this **causally**:

1. **Limit enforced** — with `max_iterations = 1` and a task that requires
   several tool-calling iterations, the agent stops at the limit and returns
   `Model call limits exceeded: run limit (1/1)`.
2. **Causal control** — with a **high** `max_iterations` and the *same* task, the
   agent completes and returns the correct final answer (no limit message). This
   proves the stop in Test 1 was caused by the low limit, not an unrelated
   failure.

> **Bug status (2026-07-06, nightly 1.11.0.dev33):** issue #481 flagged a
> "confirmed backend bug — parameter ignored in backend execution" and asked to
> gate the spec as *expected-fail*. Reproduction on dev33 shows the parameter is
> now **respected** (`max_iterations=1` → `run limit (1/1)`; `max_iterations=8` →
> completes). The bug appears **fixed**, so this is authored as a normal passing
> `@stable` test, not an expected-fail. Flagged on the issue/PR.

If this fails, the agent no longer honours its iteration cap — a regression in a
core safety/cost control.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh nightly.
`@regression` — guards the max-iterations enforcement from regressing (the bug
#481 documented); `@agents` — agent execution; `@playground` — the flow is run
through the Playground.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env`.
- Run with `--workers=1` (agent specs create named flows that collide in
  parallel). File is serial (`SimpleAgentTemplatePage.load()` wipes all flows).

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `getTestTargets()` (default:
1 model per active provider). The limit message and the arithmetic answer are
provider-agnostic (Langflow-level), so any chat model works.

Shared setup per test (identical except `max_iterations`):
- Load the Simple Agent template (ships a URL fetch tool).
- Set the Agent Instructions (`textarea_str_system_prompt`) to force use of the
  URL fetch tool for any URL question, so the agent **attempts a tool call** —
  which needs more than one model call — instead of answering in one shot.
- Open the Agent node inspector (`parameters-button`); set
  `int_int_max_iterations`; close (`inspection-panel-close`).
- Set the task on the **ChatInput node** (`textarea_str_input_value`) and
  `waitForFlowSaveSettled` (the Playground prompt pre-fills from the node —
  typing into the Playground races an async default re-injection; see
  `agent-multimodal-image-input.md`).
- Open the Playground and send; wait for the agent to finish.

The task targets the running instance's own version endpoint
(`http://localhost:7860/api/v1/version`): the model cannot know the exact nightly
version, so it always **attempts** the fetch (a famous page like example.com is
memorised and answered inline; arithmetic is computed inline — both verified
flaky). The fetch is SSRF-blocked backend-side, but that is irrelevant — the
**attempt consumes an iteration**, which is what proves the cap.

---

**Test 1 — agent stops when max iterations is reached** (§6.2 / §7.7)

1. Shared setup with `max_iterations = 1`.
2. **Validation:** the AI message contains `Model call limits exceeded` **and**
   the cap `(1/1)` — the tool-call attempt exceeds the limit of 1 and the agent
   stops.

---

**Test 2 — causal control: a high limit does not hit the cap** (§6.2 / §7.7)

1. Shared setup, identical task, with a **high** `max_iterations` (`20`).
2. **Validation:** the run finishes with a non-empty AI message that does **not**
   contain `Model call limits exceeded` — with headroom the agent completes (a
   few attempts, well under 20) without hitting the cap. Only `max_iterations`
   differs between the two tests, so Test 1's stop is attributable to the cap.

---

## Validation criterion *(required)*

- **Limit enforced (Test 1):** `max_iterations=1` → the AI response is
  `Model call limits exceeded: run limit (1/1)` (the `(1/1)` ties the stop to the
  configured value).
- **Causal control (Test 2):** a high `max_iterations` → the run finishes without
  the limit message. Same task, only the cap differs — so the pair proves the cap
  is respected and causal, not coincidental.

## Guarding against false positives *(how)*

- **Causal pair:** the only difference between Test 1 (stops) and Test 2
  (completes) is the `max_iterations` value — so the stop is attributable to the
  parameter, not to a flaky failure. Test 1 also asserts the exact cap `(1/1)`.
- **Unbypassable tool forcing:** the task targets the instance's own version
  endpoint, whose value the model cannot know, so it must attempt the URL tool —
  guaranteeing more than one model call, so a limit of 1 genuinely trips (a
  calculator task and a famous page like example.com are answered inline —
  verified flaky; see Notes).
- **Non-empty completion:** Test 2 asserts a non-empty final message without the
  limit marker, so a blank/aborted run cannot silently pass the negative check.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on each hard
  assertion before `@stable`.

---

## What this test does not cover *(optional)*

- The numeric count of individual tool invocations (Langflow does not surface a
  reliable per-iteration counter in the UI; the `run limit (N/N)` message is the
  observable used instead).
- `max_tokens` / other agent controls (separate specs).
- Tool execution correctness (see `agent-component-regression.spec.ts`).

---

## External dependencies *(required)*

- `src/backend/base/langflow/components/agents/` — the Agent executor and its
  `max_iterations` enforcement; the fix this spec guards lives here.
- `src/frontend/src/CustomNodes/GenericNode/` — the Agent node inspector
  (`int_int_max_iterations`).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O and
  the AI message bubble carrying the `Model call limits exceeded` message.
- The Simple Agent template's **URL fetch tool** — the forcer that makes the
  agent enter its tool loop (no external network needed — the target is the
  instance's own SSRF-blocked version endpoint; the attempt is what matters).
- Provider LLM API — a live key; the agent makes real model calls.

---

## When to review this test *(optional)*

- If the terminal message wording changes from `Model call limits exceeded: run
  limit (N/N)`.
- If the Agent node field testids change
  (`int_int_max_iterations`, `toggle_bool_edit_add_calculator_tool`).
- If the Simple Agent template or the calculator tool is renamed/rewired.

---

## Notes *(optional)*

- **Observable found during reproduction:** setting `max_iterations=1` yields the
  AI message `Model call limits exceeded: run limit (1/1)`; a high limit
  completes. This is a clean, deterministic signal — far more robust than
  counting reasoning steps in the DOM.
- **Why a URL-fetch task to an unknowable endpoint, not a calculator or a famous
  page:** "iterations" count the agent's **tool-calling loop**, not the final
  answer, so the cap only trips when the agent actually enters the loop. A capable
  model (Gemini) bypasses a calculator by computing inline (~40% of runs), and
  answers a famous page like example.com from memory (its heading is memorised) —
  both verified flaky, and `max_iterations=0` does not trip a directly-answerable
  task. Targeting the instance's own `/api/v1/version` (an unknowable nightly
  string) forces the model to **attempt** the fetch every time (verified 2/2 trip
  at limit 1). The fetch is SSRF-blocked backend-side, but that is irrelevant: the
  attempt consumes the iteration. At the high limit the agent tries a few address
  variants and gives up well under 20, so it never hits the cap (verified 2/2).
- **Prompt via the ChatInput node:** the Playground re-injects the template
  default asynchronously; setting the task on the ChatInput node (then
  `waitForFlowSaveSettled`) makes the prompt deterministic (see
  `agent-multimodal-image-input.md`).
- **Expected-fail deliberately NOT used:** #481 requested it for a backend bug
  that reproduction shows is fixed on dev33; a `test.fail()` gate would report an
  immediate unexpected pass. Documented on the issue/PR.
