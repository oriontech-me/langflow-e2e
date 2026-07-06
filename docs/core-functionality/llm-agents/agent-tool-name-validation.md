# Agent tool name — invalid name blocks execution with a clear error

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.4 "Tool with invalid name — validation prevents execution with
clear message". A tool attached to the Agent can be renamed through the tool
component's actions modal; the rename sets the **function name** sent to the
LLM provider. When that name contains characters no provider accepts (e.g.
`!`), the flow must **not** execute the agent — the run fails fast with a
clear, user-visible error identifying the invalid function name.

1. **Invalid name blocks execution** — rename the URL tool's slug to
   `invalid tool name!!` and send a Playground message: the build fails and
   the Playground shows an error whose text identifies the invalid function
   name (provider 400, e.g. Google's *"Invalid function name. Must start with
   a letter or an underscore…"*).
2. **Causal control — a valid rename executes normally** — rename the same
   tool to `fetch_content_renamed` and send the same message: the agent
   answers with no error. The pair proves the failure in Test 1 is caused by
   the invalid characters, not by the rename machinery itself.

> **Scope note — where the "validation" actually lives on 1.11.** Langflow
> performs **no edit-time validation** of tool names: the tools modal accepts
> `invalid tool name!!` with no inline error or toast. The frontend only
> normalizes case and spaces (persisted as `invalid_tool_name!!` — the `!!`
> passes through), and the backend assigns the name verbatim to the LangChain
> tool (`component_tool.py` → `update_tools_metadata`, no pattern check). The
> rejection observed by the user comes from the **provider's request
> validation** (deterministic HTTP 400 before any inference — Google
> `INVALID_ARGUMENT`, OpenAI `string does not match pattern`). This satisfies
> the checklist bullet's observable ("prevents execution with clear message"),
> and the absence of edit-time validation is flagged on the PR as a potential
> upstream improvement, not asserted against.

If Test 1 fails, an invalid tool name silently reaches the provider with no
clear error (or executes), leaving users with an undiagnosable broken agent.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@regression` — guards the error surfacing path (tool rename →
provider rejection → Playground error message); `@agents` — Agent tool-calling
configuration; `@playground` — the runs and the error observable live in the
Playground.

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
(default: 1 model per active provider — same machinery as
`agent-max-iterations.spec.ts`).

Shared setup per test:
1. Load the Simple Agent template (`SimpleAgentTemplatePage.load()` — wipes
   existing flows, configures the target provider/model).
2. Open the URL tool's actions modal: the button is scoped to the node —
   `[data-testid^="rf__node-URLComponent"]` → `button_open_actions` — and the
   modal is ready when `btn_close_tools_modal` renders.
3. Rename the tool: double-click the grid's name cell
   (`[role="dialog"] .ag-cell[col-id="name"]`), fill `input_update_name`,
   press `Enter` to commit, and assert the slug cell
   (`.ag-cell[col-id="name_1"]`) reflects the new value before closing
   (`Escape`).
4. **Verify the persisted name via the API** (`GET /api/v1/flows/{id}` → URL
   node → `template.tools_metadata.value[0].name`) before running — the modal
   normalizes case/spaces, so the assertion targets the normalized form; a
   silently unsaved rename must fail the setup step, not produce a
   false-positive run.
5. Open the Playground and send a fixed message.

---

**Test 1 — invalid tool name blocks execution with a clear message** (§6.4)

- Rename to `invalid tool name!!` (persisted as `invalid_tool_name!!` — the
  `!` characters violate every provider's function-name pattern).
- `page.allowFlowErrors()` — the failure is intentional.
- **Validation:** the Playground surfaces an error state for the run and its
  text matches `/invalid function name|does not match pattern|INVALID_ARGUMENT/i`
  (covers Google and OpenAI wording). No agent answer is produced.

---

**Test 2 — causal control: a valid rename executes normally** (§6.4)

- Rename to `fetch_content_renamed` (valid pattern), identical message.
- **Validation:** the agent produces a normal AI response and no build-error
  surface appears. Only the name's validity differs from Test 1, so Test 1's
  failure is attributable to the invalid characters.

---

## Validation criterion *(required)*

- **Blocked (Test 1):** invalid tool name → run fails with a visible error
  identifying the invalid function name; no AI answer.
- **Control (Test 2):** valid custom tool name → run completes with an AI
  answer and no error. The pair proves execution is gated by tool-name
  validity and causally so.

## Guarding against false positives *(how)*

- **Persisted-name API check before each run:** proves the rename actually
  reached the flow document; without it a lost rename would make Test 1 run a
  valid flow (provider answers → assertion on the error would fail correctly)
  but would make Test 2 vacuous.
- **Message-content assertion, not just "an error happened":** the fixture
  already fails tests on backend errors; Test 1 uses `allowFlowErrors()` and
  asserts the *specific* invalid-function-name wording, so an unrelated crash
  (auth, quota) cannot pass as this scenario.
- **Causal pair:** identical flow, prompt, and rename flow — only name
  validity differs.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on each hard
  assertion before `@stable`.

---

## What this test does not cover *(optional)*

- Edit-time validation in the tools modal (does not exist on 1.11 — see Scope
  note; flagged upstream rather than asserted).
- Provider-specific error wording beyond the regex (the exact message text is
  the provider's contract, not Langflow's).
- Tool renames on components other than URL (same modal machinery).

---

## External dependencies *(required)*

- **LLM provider API** (per `models.json` target): Test 1 consumes **zero
  tokens** (the request is rejected at validation, before inference); Test 2
  performs one real completion.
- `tests/helpers/provider-setup/data/models.json` +
  `providers.json` (collect-models).
