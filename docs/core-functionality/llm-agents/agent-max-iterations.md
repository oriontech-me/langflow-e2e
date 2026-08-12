# Agent Max Iterations — agent stops at the configured limit

**Last validated:** Langflow 1.12.x (`1.12.0.dev23`)

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

> **Quarantine lifted (2026-08-12, nightly 1.12.0.dev23) — #1264 was a TEST
> defect, not a product regression.** The cap **is** enforced: with
> `max_iterations = 1` and a fetch target the URL tool can actually reach, the
> agent returns `Model call limits exceeded: run limit (1/1)` in **3.3 s**
> (measured on `google / gemini-3.5-flash`, dev23). What produced #1264's
> signature was this spec's own fetch target — the instance's own
> `http://localhost:7860/api/v1/version`, which Langflow's SSRF layer **blocks**.
> A tool call that can never succeed puts the run on the **tool-error path**,
> where the cap is not what stops the loop:
>
> - `ModelCallLimitMiddleware(run_limit=max_iterations)` counts **model calls**
>   (`after_model` increments), and
> - `_compute_recursion_limit()` gives LangGraph `max_iterations * 2 + 5`,
>   budgeting **2 graph steps per iteration** (model node + tools node)
>   — `lfx/components/models_and_agents/agent.py:559`.
>
> With a failing tool each model call costs more than two steps (the error
> ToolMessage plus `ToolRetryMiddleware(max_retries=2)`), so **LangGraph's limit
> trips first** and the run dies with `GraphRecursionError` instead of the
> graceful limit message. Measured on the 2026-08-12 daily
> ([run 31581590030](https://github.com/oriontech-me/langflow-e2e/actions/runs/31581590030),
> `google / gemini-3.5-flash`): `Recursion limit of 45 reached without hitting a
> stop condition` — 45 being exactly `20 * 2 + 5` for Test 2's cap of 20 — after
> **11 model calls / 733,990 tokens** on one trace, ending in a collapsed
> "An error occurred" card with no chat message at all (attempt 0 failed, the
> retry passed). Earlier reproductions of #1264 on Anthropic models hit the same
> path with `max_iterations = 1` (`recursion_limit = 7`) and surfaced the model's
> pre-tool text instead of the limit message.
>
> Consequences encoded here: the task now targets a **reachable** echo endpoint,
> so the loop the cap is supposed to bound is the loop that actually runs; Test 1
> is no longer `test.fixme`; and the tool-error/recursion interplay is explicitly
> **out of scope** for this spec (see *What this test does not cover*) — it is a
> product-side cost defect, tracked on #1264, not a max-iterations assertion.

If this fails, the agent no longer honours its iteration cap — a regression in a
core safety/cost control.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh nightly.
Both tests carry it as of the #1264 fix: Test 1 is no longer `test.fixme` (the cap
is enforced — see the note above) and, with a reachable fetch target, it is the
cheap half of the pair (~3 s, ~1k tokens), so the daily gains the enforcement
assertion it never ran.
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
  parallel). File is serial. `SimpleAgentTemplatePage.load()` does **not** wipe
  existing flows — the cross-worker delete-all was removed in #553 — and cleanup
  is id-scoped via the shared tracker (see *Notes* → flow cleanup).

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `resolveTestTargets()` (default:
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

The task targets the **echo endpoint's `/uuid`** (`ECHO_BASE_URL` /
`HTTPBIN_BASE_URL`, defaulting to the public `https://httpbin.org` — CI resolves
it to the in-network go-httpbin service, #1128). Two properties make it the right
forcer, and the second is what #1264 taught:

1. **Unknowable ⇒ the tool is really called.** `/uuid` returns a fresh random
   UUID per request, so the model cannot answer from memory (a famous page like
   example.com is memorised, arithmetic is computed inline — both verified flaky)
   and cannot decode it out of the URL either.
2. **Reachable ⇒ the loop terminates.** The fetch **succeeds**, so a normal run
   is exactly two model calls (tool call → final answer): the cap at 1 trips on
   the second, and a high cap completes. The previous target — the instance's own
   SSRF-blocked `/api/v1/version` — could never succeed, which put every run on
   the tool-error path where LangGraph's `recursion_limit` fires before the cap
   (see the note above): a runaway of 11+ model calls, 733,990 tokens and no
   final message, instead of the behaviour under test.

---

**Test 1 — agent stops when max iterations is reached** (§6.2 / §7.7)

1. Shared setup with `max_iterations = 1`.
2. **Validation:** the AI message contains `Model call limits exceeded` **and**
   the cap `(1/1)` — the tool-call attempt exceeds the limit of 1 and the agent
   stops.

---

**Test 2 — causal control: a high limit does not hit the cap** (§6.2 / §7.7)

1. Shared setup, identical task, with a **high** `max_iterations` (`5`).
2. **Validation:** the run finishes with a non-empty AI message that does **not**
   contain `Model call limits exceeded`, and **does** contain a UUID-shaped token
   (the value only the fetch can supply) — with headroom the agent completes in
   its two calls without hitting the cap. Only `max_iterations` differs between
   the two tests, so Test 1's stop is attributable to the cap.

`5` rather than the previous `20`: the headroom only has to exceed the two calls a
successful fetch needs, and the cap also sets LangGraph's `recursion_limit`
(`max_iterations * 2 + 5`), so a lower cap bounds the blast radius of any future
model that does loop — 15 graph steps instead of 45.

---

## Validation criterion *(required)*

- **Limit enforced (Test 1):** `max_iterations=1` → the AI response is
  `Model call limits exceeded: run limit (1/1)` (the `(1/1)` ties the stop to the
  configured value).
- **Causal control (Test 2):** a high `max_iterations` → the run finishes without
  the limit message and carries the fetched UUID. Same task, only the cap differs
  — so the pair proves the cap is respected and causal, not coincidental.
- **Cost is part of the criterion.** With the reachable target both tests are two
  model calls; a run that costs materially more than that is the tool-error
  runaway (#1264), not a slow model.

## Guarding against false positives *(how)*

- **Causal pair:** the only difference between Test 1 (stops) and Test 2
  (completes) is the `max_iterations` value — so the stop is attributable to the
  parameter, not to a flaky failure. Test 1 also asserts the exact cap `(1/1)`.
- **Unbypassable tool forcing:** the task targets `/uuid`, whose value the model
  cannot know or derive, so it must call the URL tool — guaranteeing a second
  model call, so a limit of 1 genuinely trips (a calculator task and a famous page
  like example.com are answered inline — verified flaky; see Notes).
- **Non-empty completion plus a positive observable:** Test 2 asserts a non-empty
  final message without the limit marker **and** a UUID-shaped token, so neither a
  blank/aborted run nor a refusal ("I cannot fetch URLs") can pass the negative
  check — the failure mode a pure `not.toMatch` assertion is blind to.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on each hard
  assertion before `@stable`.

---

## What this test does not cover *(optional)*

- The numeric count of individual tool invocations (Langflow does not surface a
  reliable per-iteration counter in the UI; the `run limit (N/N)` message is the
  observable used instead).
- `max_tokens` / other agent controls (separate specs).
- Tool execution correctness (see `agent-component-regression.spec.ts`).
- **The tool-error path — deliberately out of scope (#1264).** When the tool can
  never succeed, LangGraph's `recursion_limit` (`max_iterations * 2 + 5`) fires
  before the model-call cap, so the user gets a bare `GraphRecursionError` ("An
  error occurred", no message) after burning the whole budget — 733,990 tokens on
  the 2026-08-12 daily. That is a product-side cost/UX defect, and asserting it
  would mean a spec whose *purpose* is a runaway: every run of it costs ~320× the
  rest of this file. Tracked on #1264 for an upstream ask instead.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/models_and_agents/` — the Agent executor and its
  `max_iterations` enforcement; the fix this spec guards lives here.
- `src/frontend/src/CustomNodes/GenericNode/` — the Agent node inspector
  (`int_int_max_iterations`).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O and
  the AI message bubble carrying the `Model call limits exceeded` message.
- The Simple Agent template's **URL fetch tool** — the forcer that makes the
  agent enter its tool loop; it must be able to **complete** the fetch (see the
  echo endpoint below).
- **Echo endpoint** — `ECHO_BASE_URL` / `HTTPBIN_BASE_URL`, resolved by
  `.github/actions/resolve-echo-endpoint` to the lane's go-httpbin service and
  falling back to public `https://httpbin.org` locally (#1128). Langflow is the
  one calling it, so in CI the value must be the container **IP** — its
  `validators.url()` rejects a single-label host and its SSRF layer blocks
  loopback outright, which is exactly what this spec used to depend on.
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

- **Flow cleanup is id-scoped, captured from the creation POST** (#1108's shared
  tracker, wired in #1346). The spec previously had no cleanup at all, which cost
  twice: an orphan `Simple Agent` per test on the shared instance, and — because
  token attribution lives on the delete path (#1197) — tokens that reached the QA
  platform with no spec to claim them (2026-08-06 daily: trace `e7c60610`, 2,266
  tokens over 2 `claude-haiku-4-5` calls, in the run's `unattributed` bucket). The
  tracker rather than `load()`'s returned id, because `load()` can throw **after**
  creating the flow (the #751/#1072 credential-settle guard throws exactly there).
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
  task. `/uuid` keeps that property and adds a **terminating** fetch.
- **Unknowable is not enough — the fetch must also SUCCEED, and "the attempt is
  what matters" was wrong.** The first version of this spec reasoned that an
  SSRF-blocked target was fine because the attempt consumes an iteration. It does
  — but a tool that can never succeed also gives the model nothing to finish on,
  so the run's length stops being a property of the cap and becomes a property of
  the model's appetite for retrying. Measured across the daily's provider
  rotation: `claude-haiku-4-5` / `gpt-4o-mini` gave up after 2 calls (711–2,276
  tokens), while `gemini-3.5-flash` retried address variants (`127.0.0.1`,
  `169.254.169.254`, …) until LangGraph's `recursion_limit` killed the run —
  733,990 tokens on one trace, 94% of that day's entire suite spend, and a red
  attempt 0 that only passed on retry. Same spec, same cap, 320× the cost,
  decided by which weekday the rotation landed on.
- **Prompt via the ChatInput node:** the Playground re-injects the template
  default asynchronously; setting the task on the ChatInput node (then
  `waitForFlowSaveSettled`) makes the prompt deterministic (see
  `agent-multimodal-image-input.md`).
- **Expected-fail deliberately NOT used:** #481 requested it for a backend bug
  that reproduction shows is fixed on dev33; a `test.fail()` gate would report an
  immediate unexpected pass. Documented on the issue/PR.
