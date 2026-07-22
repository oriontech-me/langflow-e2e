# Agent max_tokens — caps generated output as configured

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent's **Max Tokens** control (`max_tokens`) caps how many tokens the
model may generate (QA-CHECKLIST §6.2 "max_tokens truncates response as
configured" and §7.7 "Maximum token count — response truncated as configured").
The cap is proven at the **token level**, using the Playground's per-response
token-usage tooltip as the observable:

1. **Limit enforced** — `max_tokens = 50` with a prompt requesting a ~500-word
   essay: the response's **Output** token count is **≤ 50**.
2. **Causal control** — same prompt with `max_tokens` unset (saved as `0` =
   unlimited): the response's Output token count is **> 50**. Only `max_tokens`
   differs, so Test 1's cap is attributable to the parameter. The proof is
   **token-level only** — the visible reply text is deliberately not asserted
   (see the causal-control note below).

> **Scope note — §7.7 "Temperature parameter (verify via network payload)" is
> NOT covered.** On nightly 1.11.0.dev33 the Agent has **no temperature
> parameter at all**: zero occurrences in the saved flow JSON, absent from
> `agent.py`'s inputs, and `update_build_config` injects no dynamic
> temperature field (the parameter left the Agent with the model-bundle
> refactor; the standalone Language Model component still has it). The bullet
> is left `[ ]` and flagged on the issue/PR for re-scoping — a test against a
> parameter that does not exist cannot be written, and covering the Language
> Model component instead would validate a different surface than the
> section's "(Agent)" scope. (The same applies to `reasoning_effort` — issue
> #484 — noted for later.)

If Test 1 fails, the Agent no longer bounds generation — a cost/latency
regression.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@regression` — guards the `max_tokens` passthrough (Agent →
provider's `max_tokens_field_name`, e.g. Google's `max_output_tokens`) from
regressing; `@agents` — Agent parameter behavior; `@playground` — the runs and
the token-usage observable live in the Playground.

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

The spec generates **2 tests per active model** via `getTestTargets()`
(default: 1 model per active provider).

Shared setup per test:
1. Load the Simple Agent template.
2. Set **Max Tokens** in the Agent node inspector
   (`parameters-button` → `int_int_max_tokens` → `inspection-panel-close`).
   **The int field rejects Playwright's `fill()`** (the controlled input keeps
   an empty DOM value) and swallows the first keystroke of an immediate
   `pressSequentially` (a typed "50" becomes a clamped "1") — the setter must
   click, let the field settle, type slowly, and **verify the DOM value**,
   retrying once if it diverges.
3. **Verify the saved value via the API** (`GET /api/v1/flows/{id}` →
   Agent node → `template.max_tokens.value`) before running — a silently
   unsaved value must fail the setup step, not corrupt the causal pair.
4. Seed the prompt on the **ChatInput node** (Playground prefill re-injection
   race — see `agent-multimodal-image-input.md`): *"Write a detailed 500-word
   essay about the history of the ocean. Do not use any tools — answer
   directly."*
5. Open the Playground, send, and wait for completion on the
   `chat-message-token-usage` badge count.
6. Hover the badge and read the **Output** token count from its tooltip
   (`Input: 1.0K / Output: 46` format; values may be plain integers, `N.NK`,
   or empty ⇒ 0).

---

**Test 1 — max_tokens=50 caps the output tokens** (§6.2, §7.7)

- `max_tokens = 50`.
- **Validation:** tooltip **Output ≤ 50**. The response *text* is NOT asserted:
  with a thinking model (e.g. `gemini-3.5-flash`) the 50-token budget is
  consumed by reasoning and the visible reply may legitimately be empty
  (rendered as the "Message empty." placeholder — graceful handling covered by
  `agent-empty-refusal-response.spec.ts`). The token cap itself is the
  contract.

---

**Test 2 — causal control: unset max_tokens generates freely** (§6.2, §7.7)

- `max_tokens` cleared (saved as `0` = no limit), identical prompt.
- **Validation:** tooltip **Output > 50**. Only `max_tokens` differs from Test 1,
  so Test 1's cap is caused by the parameter, not by the model choosing to
  answer briefly. **The visible reply text is NOT asserted** (no word-count
  floor): a thinking model spends the unbounded budget on reasoning and can
  legitimately return a terse visible reply while its Output token count is
  well above 50 — exactly Test 1's rationale, applied symmetrically here. The
  token count is the observable of the `max_tokens` contract; visible verbosity
  is a model trait, not part of it.

---

## Validation criterion *(required)*

- **Limit enforced (Test 1):** `max_tokens=50` → response Output tokens ≤ 50.
- **Causal control (Test 2):** `max_tokens` unset → Output tokens > 50 (no
  reply-text assertion). The pair proves generation is bounded by `max_tokens`
  and causally so at the token level.

## Guarding against false positives *(how)*

- **Saved-value API check before each run:** the int field's fill quirks make
  a silent `0` (no limit) possible; verifying
  `template.max_tokens.value === 50` via the API makes Test 1's setup
  trustworthy (and a saved `0` in Test 1 would also fail its `≤ 50` assertion
  — the guard is double).
- **Token-level assertion, not text-length:** reply text length varies with
  model verbosity; the provider-enforced output-token cap does not.
- **Causal pair:** identical prompt, only `max_tokens` differs.
- **Test 2 lower bound (> 50 Output tokens):** an aborted/empty run yields
  Output `0` (≤ 50) and cannot pass the control — the token floor subsumes the
  anti-empty guard, so no reply-word-count floor is needed. A word-count floor
  was intentionally **removed** (see the model-agnostic note below): it
  measured model verbosity, not the `max_tokens` contract, and produced a
  false negative on thinking models.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on each hard
  assertion before `@stable`.

---

## What this test does not cover *(optional)*

- Temperature (parameter absent from the Agent on 1.11 — see Scope note).
- Reasoning effort (same — issue #484).
- Exact truncation semantics of the visible text (thinking models may produce
  an empty reply under a tight cap).
- The Language Model component's own `max_tokens`/`temperature`.

---

## External dependencies *(required)*

- `src/lfx/components/models_and_agents/agent.py` — `max_tokens` IntInput and
  `_get_max_tokens_value()` (empty/`0` ⇒ `None` ⇒ unlimited).
- `src/lfx/base/models/unified_models/instantiation.py` — provider-specific
  mapping via `max_tokens_field_name` (Google ⇒ `max_output_tokens`).
- `src/frontend/src/CustomNodes/GenericNode/` — the Agent node inspector
  (`int_int_max_tokens`) and its int-field input handling.
- `src/frontend/src/components/core/playgroundComponent/` — the
  `chat-message-token-usage` badge and its Input/Output tooltip.
- Provider LLM API — a live key; real model calls.

---

## When to review this test *(optional)*

- If the node field testid changes from `int_int_max_tokens`.
- If the token-usage tooltip format changes (`Output:` label, `N.NK`
  abbreviation).
- If the Agent regains a temperature/reasoning parameter (re-scope the §7.7
  bullets and extend this spec).

---

## Notes *(optional)*

- **Int fields in the node inspector reject `fill()`** — Playwright's
  programmatic set never reaches the controlled component (DOM value stays
  `""`), and fast typing loses the first keystroke to a re-render, after which
  the remainder is clamped to the field's `range_spec` min (typed "50" →
  saved "1"). Slow `pressSequentially` after click + settle, with DOM-value
  verification and one retry, is reliable (scouted on dev33).
- **Closing the dialog can race the field's commit debounce** — even with the
  DOM showing "50", the persisted value came out `0` in ~half the burst runs.
  The setter blurs the field (`Tab` + settle) before closing AND verifies the
  persisted value via the flows API, reopening the dialog and retrying the
  whole cycle when the save was lost (observed: 3/5 burst failures before the
  persist-retry; 5/5 green after).
- **Tooltip Output may be empty** when the whole budget is consumed by
  reasoning before any visible token (observed with `max_tokens=1`); the
  parser treats missing/empty as `0`, which still satisfies `≤ 50`.
- **Model-agnostic by design — no reply-word-count floor (#866).** Test 2
  originally asserted the reply had `> 200` words on top of `Output > 50`. That
  word-count floor measured **model verbosity**, not the `max_tokens` contract,
  and was a latent false negative for thinking models. It stayed dormant from
  the spec's creation (#483, 2026-07-06) because the collected `google` model
  was `gemini-omni-flash-preview` (Interactions-API-only → the variant
  **skipped**); when `collect-models` began selecting the available
  `gemini-2.5-flash` (~2026-07-14) the variant executed and the model — a
  thinking model — spent the unbounded budget on reasoning (Output `> 50` ✓)
  yet returned a terse visible reply (8–36 words), failing the floor on 4
  dailies (07-14/15/16/21) while `openai`/`anthropic` passed under identical
  load. The floor was removed so the causal proof is token-level and holds for
  any collected model. `openai`/`anthropic` remain a real essay; that is a
  model trait, not a contract the suite pins.
- **Runtime honors the parameter** (verified two ways on dev33: an API run
  with a `max_tokens: 50` tweak returned an empty reply, and the UI-saved
  value produced Output = 46 ≤ 50), so unlike #481/#482 there is no
  fixed-bug/expected-fail question here — the risk this spec guards is the
  UI save path and the provider mapping.
