# Agent current-date tool — add_current_date_tool toggle

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.5 "Toggle add_current_date_tool works (enables/disables date
tool)". `add_current_date_tool` is an **advanced** BoolInput on the Agent
(default `true`, display "Current Date" — `agent.py`): when true, the agent's
toolkit gains the CurrentDateComponent tool (`get_current_date`); when false,
the tool is never appended, so the model **cannot** call it.

Causal pair, one test per side of the toggle:

1. **ON (template default)** — a date question must produce a
   `get_current_date` `tool_use` block whose persisted **output contains
   today's UTC date** (`YYYY-MM-DD`, computed at assert time) — the tool
   exists AND returns the real date.
2. **OFF (toggle flipped in the controls dialog)** — the same question must
   persist **zero** `get_current_date` `tool_use` blocks for the run's
   session: with the toggle off the tool is not in the toolkit, so its
   absence is deterministic, independent of what the model answers.

> **Trap — the default system prompt leaks the date.** The Simple Agent
> template's default `system_prompt` contains the `{current_date}`
> placeholder, which `agent.py` substitutes with the real UTC datetime at
> run time — with the toggle OFF the model would still "know" the date via
> the prompt, and a naive "does it know the date?" design would pass either
> way. Both tests therefore set a **custom system prompt without the
> placeholder**; the observable is the `tool_use` block, never the model's
> knowledge.

Naming the date tool in the instructions is legitimate here (unlike
`agent-multi-tool-selection`, where free choice IS the contract): this
bullet's contract is tool **availability** — instructing "use the date tool
if available" maximizes the ON signal without affecting OFF, where the tool
simply doesn't exist.

If this test fails, the toggle either doesn't wire the tool in (ON broken)
or doesn't remove it (OFF broken) — a config surface lying to the user.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added after 4 clean `--retries=0` runs on 1.11.0.dev34, revalidated
with 3 more on 1.11.0.dev36 after the 2026-07-08 gemini drift event (the
assertions are drift-resilient by design: presence-anywhere on ON, structural
absence on OFF — see agent-multi-tool-selection's "Why first-call" note for
the event; issue #495's "Done when" includes `@stable`). `@regression` —
guards the toggle→toolkit wiring; `@agents` — agent tool configuration;
`@playground` — the run happens through the Playground.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env`.
- Run with `--workers=1` — area rule for agent specs (shared instance state).
  Each test captures its flow id from the template-instantiation
  `POST /api/v1/flows/` response and deletes exactly that id in `afterEach`
  (`loadTemplateByName` does no cleanup — post-#553 contract).

---

## Step by step *(required)*

The spec generates tests per active model via the `resolveTestTargets()`
machinery (family standard). Per model, a serial describe with two tests:

**Test 1 — toggle ON (default): the date tool exists and returns today (§6.5)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set Agent Instructions (`textarea_str_system_prompt`) to a prompt
   **without `{current_date}`**: *"If a date/time tool is available you MUST
   use it to answer date questions — never answer date questions from
   memory. If no such tool is available, reply that you cannot verify the
   date."*
3. Seed the task on the ChatInput node (`textarea_str_input_value`):
   *"What is the current date? (probe `<nonce>`)"*.
4. Open the Playground (`playground-btn-flow-io`), send, wait for the run to
   finish (Stop button hidden).
5. **Tool assert (API):** poll `GET /api/v1/monitor/messages` — nonce →
   `session_id` → the session's AI message must have a `get_current_date`
   `tool_use` block whose `output` contains today's **UTC** date
   (`YYYY-MM-DD` computed at assert time; the day-boundary edge accepts
   today-or-yesterday UTC to survive a midnight flip mid-run).
6. No `allowFlowErrors` — any flow error fails via the fixture.

**Test 2 — toggle OFF: the date tool is removed from the toolkit (§6.5)**

1–2. Same template load and Instructions (fresh load; new nonce).
3. Open the Agent node inspector (`parameters-button`), assert the
   pre-flip default is ON (`toggle_bool_add_current_date_tool` has
   `aria-checked="true"` — a changed template default fails loudly instead
   of silently inverting the test), click it, assert `aria-checked="false"`,
   close (`inspection-panel-close`), wait for the flow save to settle.
4. Seed the same task (new nonce); open the Playground, send, wait.
5. **Absence assert (API):** the session's AI message(s) must contain
   **zero** `get_current_date` `tool_use` blocks. The final AI bubble must
   be visible and non-empty (the run completed; what the model *says*
   about the date is deliberately not asserted).
6. No `allowFlowErrors`.

---

## Validation criterion *(required)*

Toggle ON: a `get_current_date` `tool_use` block persisted for the run's
nonce-keyed session, with its output containing today's UTC `YYYY-MM-DD`.
Toggle OFF (after a proven `aria-checked` true→false flip): zero
`get_current_date` `tool_use` blocks in that run's session, with the run
still completing normally. The pair is causal — only the toggle differs
between the tests, so a regression on either side of the wiring flips
exactly one of them.

## Guarding against false positives *(how)*

- **Prompt controls the date leak** — custom system prompt without
  `{current_date}` in BOTH tests; otherwise OFF passes/fails on model
  phrasing instead of toolkit contents.
- **Nonce-keyed session lookup** — monitor messages persist across flow
  wipes; the nonce pins assertions to THIS run (family technique).
- **Tool OUTPUT asserted, not model prose** — the ON assert reads the
  tool block's persisted output (backend-generated date string), so model
  formatting/hallucination can't fake it; the reply text is not the
  observable.
- **Proven write on the flip** — asserting `aria-checked` before AND after
  the click makes the OFF test fail loudly if the template default ever
  changes (pattern from `agent-config-persistence`).
- **Force-failure checks** (CONTRIBUTING §2): M1 — ON test expects an
  impossible date sentinel in the tool output ⇒ must fail; M2 — OFF test
  inverted to require a `get_current_date` block ⇒ must fail.

---

## What this test does not cover *(optional)*

- The CurrentDateComponent's timezone input (tool default; standalone
  component behavior is a §"utilities" concern).
- The `{current_date}` system-prompt placeholder substitution (separate
  surface — deliberately excluded from both prompts here).
- Free tool *selection* among peers (`agent-multi-tool-selection.spec.ts`).
- The sibling `add_calculator_tool` toggle (same wiring, own bullet).

---

## External dependencies *(required)*

- **LLM provider API** (per `models.json` target): one completion with at
  most one tool round-trip per test.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
- No external network beyond the provider — the date tool is local.
