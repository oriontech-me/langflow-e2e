# Agent tool error — handled as an observation, execution continues

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.4 "Tool returns error — agent handles it and continues
execution". When a tool call fails at runtime, the Agent must not crash the
flow: the error is converted into an observation for the model
(`handle_tool_error=True` on every component tool —
`component_tool.py` → `_build_tools`), the agent keeps executing, and the run
ends with a normal AI answer that reports the failure.

A single test proves both halves of the bullet in one run (the pair is
intrinsic — error *and* continuation happen in the same execution):

1. **The tool really errored** — the persisted AI message's `tool_use`
   content block for `fetch_content` has an `output.content` containing the
   backend's SSRF rejection (`"SSRF Protection: Hostname localhost resolves
   to blocked IP address(es)…"`), asserted via the monitor API.
2. **The agent handled it and continued** — the Playground shows a final AI
   reply starting with the instructed `TOOL_FAILED:` sentinel, and the run
   produces **no flow error** (the fixture fails the test on any — no
   `allowFlowErrors`).

> **Error generator — deliberate use of SSRF protection.** The tool failure
> is produced by asking the agent to fetch
> `http://localhost:7860/api/v1/version`: Langflow's SSRF protection (an
> intentional security feature, not a bug) blocks fetches to internal IPs,
> so the URL tool fails **always, instantly, offline, with a stable
> message** — the most deterministic tool-error source available (same
> technique validated in `agent-max-iterations`, #481). Any failing URL
> would exercise the same `handle_tool_error` path; this one does it without
> external network or DNS-timeout variance.

> **Rendering note (scouted on 1.11.0.dev33).** The `Error using **tool**`
> header (`events.py` → `handle_on_tool_error`) does NOT fire on this path:
> with `handle_tool_error=True` the exception becomes a normal tool output,
> so the chat block renders "Executed **fetch_content**" with the error text
> as the tool's output. Assertions therefore target the tool output content
> and the agent's final reply — not the transient error header.

If this test fails, a failing tool crashes or silently ends agent runs — the
core resilience contract of tool-calling agents.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@regression` — guards the `handle_tool_error=True` wiring and the
agent's continue-after-error loop; `@agents` — agent tool-calling behavior;
`@playground` — the run and the reply observable live in the Playground.

`@stable` was removed by the daily triage #704 (recurrent flake on healthy
days, 07-07 and 07-10) and **restored in #992**. Because the removal reason was
a flake, isolation evidence alone does not refute it: the restoration required
7/7 clean at `--retries=0` — 4 serial rounds plus 2 rounds with a second spec
running as concurrent load.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env`.
- Run with `--workers=1` — the spec is serial
  (`SimpleAgentTemplatePage.load()` wipes all flows).

---

## Step by step *(required)*

The spec generates **1 test per active model** via `resolveTestTargets()` (same
machinery as `agent-max-iterations.spec.ts` / `agent-tool-name-validation.spec.ts`).

**Test — agent handles a tool error and continues execution** (§6.4)

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set the Agent Instructions: force the fetch tool for URL questions and
   instruct the failure sentinel — *"If a tool call fails or returns an
   error, reply with a message that starts with `TOOL_FAILED:` followed by
   the reason."*
3. Seed the task on the ChatInput node (Playground prefill re-injection
   race): *"Fetch http://localhost:7860/api/v1/version and tell me the exact
   version value it returns. (probe `<nonce>`)"* — the per-run nonce keys the
   monitor-API lookup to THIS run's session.
4. Open the Playground, send, wait for the run to finish.
5. **Continuation assert (two-stage):** first gate on the **persisted** final
   reply (monitor API, nonce-keyed session) containing `TOOL_FAILED` — a
   race-free completion signal, because the live bubble shows the empty
   placeholder ("Message empty.") mid-run and a run can outlast the assert window
   (the #634 flaky symptom). **Then**, with the run confirmed complete,
   re-assert the live bubble also contains `TOOL_FAILED` — this keeps end-to-end
   UI coverage (a bubble stuck on "Message empty." while the reply persisted is a
   real frontend bug and must still fail) without reintroducing the stream race.
6. **Tool-error assert (API):** poll `GET /api/v1/monitor/messages` — find
   the user message containing the nonce, take its `session_id`, find that
   session's AI message, and assert its `fetch_content` `tool_use` block's
   output contains `SSRF Protection`.
7. No `allowFlowErrors`: any flow error fails the test via the fixture —
   that IS the "handled without crashing" guarantee.
8. **Teardown:** `afterEach` deletes the Simple Agent flow created by
   `loadAgent()` by id via `DELETE /api/v1/flows/{id}` (id-scoped, #515 —
   never a global `cleanAllFlows`). Added in #992: `loadAgent()` discarded
   `load()`'s returned id and the spec had no teardown, leaking one flow per
   run. A stale comment claiming `SimpleAgentTemplatePage.load()` "deletes all
   flows before loading the template" — false since #553 — is why it went
   unnoticed.

---

## Validation criterion *(required)*

In one run: the fetch tool's persisted output contains the SSRF rejection
(the tool really failed) **and** the agent still produced a final reply
carrying the `TOOL_FAILED` sentinel (it handled the error and continued),
with zero flow errors. Both must hold; either alone is insufficient.

## Guarding against false positives *(how)*

- **Nonce-keyed session lookup:** monitor messages persist across wipes and
  earlier runs of this very spec leave identical SSRF outputs behind — the
  per-run nonce pins every API assertion to the current run's session.
- **Two-layer pair:** the API assert alone could pass with a crashed UI run;
  the UI sentinel alone could pass if the tool never errored (model
  hallucinating a failure). Together they close both gaps.
- **Sentinel-based continuation proof:** an instructed `TOOL_FAILED:` prefix
  is model-followable and specific; a bare "bubble is non-empty" check would
  pass on any reply. (Fallback if the sentinel proves flaky across models:
  assert non-empty reply + `/SSRF|blocked|fail/i` content — weaker, noted
  here so the deviation is a spec change, not a silent one.)
- **Force-failure checks** (CONTRIBUTING §2): M1 — replace the target with a
  fetchable public URL ⇒ the SSRF assert must fail; M2 — demand an
  impossible sentinel ⇒ the continuation assert must fail.

---

## What this test does not cover *(optional)*

- The transient `Error using` streaming header (does not fire on the
  handled-error path — see Rendering note).
- Agent behavior when ALL tool calls fail repeatedly across many iterations
  (covered indirectly by `agent-max-iterations`).
- `handle_parsing_errors` (LLM output parsing — separate bullet, #496).

---

## External dependencies *(required)*

- **LLM provider API** (per `models.json` target): one completion with one
  failed tool round-trip — no external network is reached (the fetch is
  blocked before egress).
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
