# Agent Max Iterations — agent stops at the configured limit

**Last validated:** Langflow 1.13.x (`1.13.0.dev4`)

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

> **#1264, second pass (2026-08-26, nightly 1.12.0.dev39) — still a TEST defect,
> but NOT the one the first pass recorded.** The first pass blamed the run's
> *target* (an SSRF-blocked URL putting every run on the tool-error path, where
> LangGraph's `recursion_limit` was said to fire before the model-call cap). That
> mechanism is **refuted as an explanation of this spec's failures**, and the
> refutation matters because the recurrence happened with the fix already merged:
> the test hard-failed 3/3 attempts on the 2026-08-13 daily
> ([run 31685261355](https://github.com/oriontech-me/langflow-e2e/actions/runs/31685261355))
> with commit `9792bed` an ancestor of the run's `headSha`, and that run's own job
> log records `ECHO_BASE_URL: http://172.18.0.5:8080` — the target was reachable.
>
> **The real mechanism is that the cap can only fire on a SECOND model call, and
> the second model call is elected by the MODEL.** Read
> `langchain/agents/middleware/model_call_limit.py` in the image:
>
> - `after_model` increments `run_model_call_count` **after** each call;
> - `before_model` compares `run_count >= run_limit` **before** the next one and,
>   when it holds, jumps to `end` injecting the `AIMessage` under test.
>
> So with `run_limit = 1`: `before_model` #1 sees `0 >= 1` (false) and the first
> call happens; the graph then re-enters `before_model` **only through the tools
> node**, i.e. only if that first call emitted a `tool_use` block. A model that
> answers in prose ends the run after one call and no limit message is ever
> produced. That is exactly what the failing run did — its token-attribution
> artifact (`tokens-4`) records `calls: 1`, `status: ok`, 934 prompt / 77-82
> completion tokens on `claude-haiku-4-5`, with the rendered bubble reading
> *"I'll fetch that URL for you."*
>
> **There is no product surface that forces the second call**, so this dependence
> cannot be engineered away: `lfx/components/models_and_agents/agent.py` declares
> `max_iterations` with `range_spec(min=1)` and clamps `run_limit = max(1, …)` (a
> cap of 0 is impossible by design — it is a safety cap, never an "unlimited"
> toggle), and the component exposes **no `tool_choice` input** — Langflow
> deliberately dropped the legacy `create_granite_agent` path *because* it
> hardcoded `tool_choice='required'`, which the WatsonX API now rejects.
>
> **What the product does, measured on dev39** (`google / gemini-3.6-flash`,
> reachable target, `max_iterations = 1`): exactly one chat bubble reading
> `Model call limits exceeded: run limit (1/1)`, with the *Agent Steps* block
> showing an executed `tool_use` (`fetch_content`) ahead of it. So the cap **is**
> enforced, the wording is **unchanged**, and the injected message **is** the last
> and only bubble — which also refutes the competing reading of the 08-13 failure
> ("the cap fired but its message did not render last").
>
> **The tool-error runaway is real history but is NOT this spec's failure mode.**
> The 733,990-token blow-up below happened, on `gemini-3.5-flash`; that model now
> answers `404 … no longer available`, and on dev39 the same SSRF-blocked target
> produces no runaway at all — at `max_iterations = 5` the agent makes one tool
> call and reports the SSRF error to the user in plain text (2 model calls), and
> at `max_iterations = 1` the cap still fires first. Keep the reachable target for
> cost hygiene; do not read a failure of this spec as that path.
>
> Consequence encoded here: Test 1 asserts the **precondition it depends on** —
> an executed `tool_use` in *Agent Steps* — before asserting the limit message, so
> a model that declines to call a tool is reported as such instead of as a broken
> cap; and the Agent Instructions state the contract the previous wording left
> satisfiable by an announcement.

If this fails, the agent no longer honours its iteration cap — a regression in a
core safety/cost control.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh nightly.

**Both tests carry `@stable`. Test 1's tag was decided by measurement, not by the
fix landing** — the daily triage auto-removed it on 2026-08-13 (`1bb9425`), and
Test 1 is the half whose assertion depends on the model electing to call a tool
(see the #1264 note), which #1187 established a run-count gate cannot certify.
Measured before restoring it, on `manual.yml` at `retries=0`, both tests of the
pair per run:

| When | Provider / model | Runs | Result |
|---|---|---|---|
| Pre-fix (unmodified spec), CI | `openai` / `gpt-4o-mini` | 3 | 3/3 clean |
| Pre-fix (unmodified spec), CI | `google` / `gemini-3.5-flash` | 3 | 3/3 clean |
| Post-fix, local `1.12.0.dev39` | `google` / `gemini-3.5-flash` | 3 | 3/3 clean, `flaky=0 skipped=0` |
| Post-#1380 refactor, local `1.13.0.dev4` | `openai` / `gpt-4o-mini` | 1 | 2/2 clean, `flaky=0 skipped=0` |

10 runs, 20 tests, zero failures (the last is the #1380 helper extraction, a
pure refactor — its force-fails are recorded in that PR, not here). **`anthropic` could not be measured at all** — the
key is out of credit in CI as well as locally (`Your credit balance is too low`;
three `provider=anthropic` dispatches exited 1 at *Resolve the run's provider
selection*), so the one recorded non-compliance (2026-08-13,
`claude-haiku-4-5`, a single daily) is currently unreproducible.

**Residual risk, stated rather than implied.** `daily-stable.yml`'s weekday
rotation advances past an inactive provider, so anthropic (Tue/Fri) does not run
in the daily while its key is dry — which is why restoring the tag costs nothing
today, and also why the risk returns the day the credential is funded. If that
happens and Test 1 reds on an anthropic day, read the failure text before
triaging: a declined tool call now fails with *"the model answered without
calling any tool … This is model non-compliance with the Agent Instructions, NOT
a broken max_iterations (#1264)"*, and belongs in this section as a measured rate,
not in a new product issue.
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
- Set `max_iterations` through the shared helper
  `tests/helpers/ui/set-agent-max-iterations.ts`: it selects the Agent node,
  opens the inspector (`parameters-button`), exposes the advanced field on the
  node body (`inspector-add-max_iterations`), closes the panel
  (`inspection-panel-close`), fills `int_int_max_iterations` **and asserts the
  field holds the value**. The read-back is part of the contract: a fill that
  silently no-ops would leave the template default (15) in place and this spec
  would then assert its limit message against a cap it never set. The helper is
  shared with `agent-multi-tool-selection.spec.ts`, which drove the same four
  handles as a copy until #1380.
- Set the task on the **ChatInput node** (`textarea_str_input_value`) and
  `waitForFlowSaveSettled` (the Playground prompt pre-fills from the node —
  typing into the Playground races an async default re-injection; see
  `agent-multimodal-image-input.md`).
- Open the Playground and send; wait for the agent to finish.

The task targets the **echo endpoint's `/uuid`** (`ECHO_BASE_URL` /
`HTTPBIN_BASE_URL`, defaulting to the public `https://httpbin.org` — CI resolves
it to the in-network go-httpbin service, #1128). Three properties matter, and the
third is what #1264's second pass taught:

1. **Unknowable ⇒ the model has no answer without the tool.** `/uuid` returns a
   fresh random UUID per request, so the model cannot answer from memory (a
   famous page like example.com is memorised, arithmetic is computed inline —
   both verified flaky) and cannot decode it out of the URL either.
2. **Reachable ⇒ the loop terminates.** The fetch **succeeds**, so a normal run
   is exactly two model calls (tool call → final answer): the cap at 1 trips on
   the second, and a high cap completes. Cost hygiene, not the failure mode — the
   previously blamed SSRF-blocked target does not reproduce a runaway on dev39.
3. **The tool call is still ELECTED, and the spec says so.** No amount of task
   design makes the `tool_use` block structurally mandatory — the product exposes
   no `tool_choice` and the cap is only checkable on the second `before_model`
   (see the #1264 note). "Unknowable" raises compliance; it does not guarantee
   it. `claude-haiku-4-5` satisfied the previous instruction wording with the
   announcement *"I'll fetch that URL for you."* and no tool call. The Agent
   Instructions therefore state the contract as an ordering rule ("your FIRST
   action must be a tool call; never answer in text before calling one"), and
   Test 1 asserts the resulting `tool_use` step **before** the limit message so a
   declined tool call is never reported as a broken cap.

---

**Test 1 — agent stops when max iterations is reached** (§6.2 / §7.7)

1. Shared setup with `max_iterations = 1`.
2. **Precondition, asserted first:** the run's persisted AI message carries at
   least one `tool_use` entry in its `content_blocks` — read from
   `GET /api/v1/monitor/messages?flow_id=<id>`, the same monitor-API route
   `agent-multi-tool-selection.spec.ts` already uses for tool observables, because
   the *Agent Steps* disclosure is collapsed and its text is **not** in the
   bubble's `innerText` (measured: the passing bubble is 43 characters, the limit
   message alone). This is the condition the cap needs in order to be reachable at
   all, and it is the model's choice — so it gets its own assertion, with its own
   failure text, rather than being read back through a missing limit message.
   Without it, a model that answers in prose fails this test with *"expected
   `/model call limits exceeded/`, received `I'll fetch that URL for you.`"*, which
   reads as a broken cap and mis-triages (#1264's whole second pass).
   **Any** tool counts, not specifically `fetch_content`: the cap is reached by
   *entering the tool loop*, whichever of the template's two tools the model
   picks, and pinning the name would add a second election dependency for no gain
   — tool *selection* is `agent-multi-tool-selection.spec.ts`'s assertion, not
   this one's. The tool names actually called are printed in the failure text.
3. **Validation:** the AI message contains `Model call limits exceeded` **and**
   the cap `(1/1)` — the second model call the tool step implies is refused by the
   limit of 1 and the agent stops.

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

- **Tool loop entered (Test 1, precondition):** the run's persisted AI message
  (`GET /api/v1/monitor/messages?flow_id=<id>`) carries ≥1 `tool_use` entry in its
  `content_blocks`. Without it the cap is unreachable by construction, so its
  absence is reported as "the model declined to call a tool", never as a cap
  failure.
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
- **Tool forcing is asserted, not assumed.** The task targets `/uuid`, whose value
  the model cannot know or derive, which is what makes calling the URL tool the
  only way to answer — but it does not *force* the call, and the previous version
  of this section claimed it did. `claude-haiku-4-5` answered in prose instead
  (#1264). Test 1 therefore asserts the executed tool step first, so the two
  outcomes stay distinguishable: no tool step ⇒ the model declined and the cap was
  never exercised; tool step but no limit message ⇒ the cap really is broken.
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
- **The tool-error runaway — out of scope, and no longer reproducible here
  (#1264).** On 2026-08-12 a `gemini-3.5-flash` run against an unreachable target
  burned LangGraph's whole `recursion_limit` (`max_iterations * 2 + 5` = 45) over
  11 model calls / 733,990 tokens and ended in a bare `GraphRecursionError` with
  no chat message. It is kept on record because the cost was real, but it is
  **model-specific and does not reproduce on 1.12.0.dev39**: that model id now
  answers `404 … no longer available`, and with the settled `gemini-3.6-flash` the
  same SSRF-blocked target yields one tool call and a plain-text SSRF error to the
  user at `max_iterations = 5`, and the limit message at `max_iterations = 1`.
  Asserting a runaway would still mean a spec whose *purpose* is to burn tokens,
  so it stays out of scope; there is now no measured product defect behind it to
  file upstream.
- **Whether a given model complies with the tool-call instruction.** That is a
  model property, not a Langflow one. Test 1 detects non-compliance and names it,
  but the spec does not assert a compliance rate for any provider.

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
- If the Agent node field testids change: `int_int_max_iterations` and
  `inspector-add-max_iterations`, both owned by
  `tests/helpers/ui/set-agent-max-iterations.ts` since #1380, or
  `textarea_str_system_prompt`.
- If the Simple Agent template or its URL fetch tool is renamed/rewired — the
  template ships **two** tools (`URLComponent` and `UnifiedWebSearch`, both wired
  to the Agent's `tools` handle), and the asserted step name comes from the URL
  one (`fetch_content`).
- **If the Agent component ever gains a `tool_choice` input, or `max_iterations`
  loses its `min=1` floor.** Either would make the second model call structural
  instead of model-elected, which is the single change that would let this test
  stop depending on the model's choice — see the #1264 note.
- If `ModelCallLimitMiddleware` moves the check out of `before_model` (e.g. to
  `after_model`), which would change *when* the cap can fire.

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
  completes. The *message* is a clean, exact signal — far more robust than
  counting reasoning steps in the DOM. **Reaching it is not deterministic, and an
  earlier version of this line said it was.** The message is only produced once
  the agent has entered its tool loop, and entering it is the model's decision;
  #1264's recurrence is exactly the case where a model declined. The two halves
  are now asserted separately so the distinction survives into the failure text.
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
