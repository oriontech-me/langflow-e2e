# Decision Model and Smart Router's decision mode

**File:** `tests/tests-automations/regression/core-components/decision-model-and-smart-router.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev39`)

Owning issue: #2571 (Wave 12 — 1.14 OSS features).

---

## What this test validates *(required)*

Langflow 1.14 adds **decision models** (upstream langflow-ai/langflow#15861, #16330,
#16122). A typed question — Choice, Boolean or Score — is answered by a provider's decision
endpoint, and the distribution and confidence are kept as evidence. Two components use
them: the new **Decision Model** and **Smart Router**, which gained a *Decision Model*
routing mode next to its language-model one. Neither component had any spec, in either
mode.

Measured on `1.14.0.dev39`:

**The suite's OpenAI key reaches a decision model.** `POST https://api.openai.com/v1/decisions`
with `gpt-6-luna` answered `200` (`answers[0].probability: 1.0`), so the runtime half is
covered on the existing key, not split out.

**Configuration** goes through `POST /api/v1/custom_component/update`, exactly as the
editor does: it writes the field's new value into the template, then adopts the template
and outputs the endpoint returns. The value must be in the template *before* the call — the
endpoint recomputes visibility from the template's values, not from `field_value` alone —
and the adopted template matters at build time, because a field with `show: false` is not
passed to the component (`lfx/graph/vertex/param_handler.py`).

| Smart Router state | Shown | Outputs |
|---|---|---|
| Language Model (default) | `model` (language), `routes` | `category_1_result`, `category_2_result` |
| Decision Model · Choice | `decision_model`, `decision_kind`, `decision_question`, `minimum_probability`, `routes` — **`model` hidden** | `category_1_result`, `category_2_result`, `default_result` |
| Decision Model · Boolean | yes/no messages and descriptions — `routes` hidden | `yes_result`, `no_result`, `default_result` |
| Decision Model · Score | `score_levels` — `routes` and `minimum_probability` hidden | `level_1_result` … `level_3_result`, `default_result` |
| back to Language Model | as the default | as the default |

| Decision Model `kind` | Shown |
|---|---|
| Choice (default), Score | `candidates` |
| Boolean | `yes_description`, `no_description` — `candidates` hidden |

**The catalog.** `GET /api/v1/models?model_type=decision` lists only models whose
`metadata.model_type` is `decision`: OpenAI `gpt-6-luna` (capabilities `choice`, `boolean`,
`score`), Perplexity `pplx-decider-latest` and `pplx-decider-flash-latest`, TypeSafe
`jev-latest`. The component fields are typed apart: Decision Model's `model` and Smart
Router's `decision_model` are `model_type: "decision"`, Smart Router's `model` is
`"language"`. *Observation, not asserted:* the `llm` catalog also lists `gpt-6-luna`
(typed `llm`, from OpenAI's live model list); upstream declares it only as a decision model.

**Refusals before any model call.** Smart Router in decision mode refuses to build without
its Else output — *"Decision Model mode needs Include Else Output on and its Else output
connected."* — and, with the Else on, without a minimum probability — *"Enter a Minimum
Probability from 0 to 1, such as 0.7."* Both come back as a `failed` run with
`EXECUTION_ERROR`, so a misconfigured router never reaches the provider.

**Runtime** (a flow run through `POST /api/v2/workflows`, `mode: "sync"`; the Decision
Model's result reaches a Chat Output, since the v2 response carries a JSON output's
`content` as `null`):

- Boolean, *"Is this message about billing or payments?"* over *"I was charged twice…"* →
  `{kind: "boolean", provider: "OpenAI", model: "gpt-6-luna", status: "success",
  probability_true: 1.0}`.
- Choice between `billing` and `technical` over *"The app crashes with error 500…"* →
  `{kind: "choice", status: "success", selected_option: "technical", probabilities:
  {billing: 0.0, technical: 1.0}, confidence: 1.0}`.
- Smart Router, decision mode, Choice routes Billing / Technical, Else on, each output wired
  to its own Chat Output, over a refund request → the Billing output carries its route's
  value and the Technical and Else outputs carry none.

The inputs are deliberately unambiguous, and the assertions are on the **identity** of the
outcome (`selected_option`, which output fired), never on wording or on an exact
probability (#1187).

**The evidence in the editor.** After running a Choice node on the canvas, its output
inspection (`output-inspection-decision result-decisionmodel`) renders
`decision-inspection`: a distribution row per declared option (`decision-row-<id>`), the
chosen one marked *"Provider's pick"*, and facts — `decision-model` ("OpenAI ·
gpt-6-luna"), `decision-type`, `decision-question`, `decision-confidence`,
`decision-request-id`.

**A model's on/off setting decides whether it runs, and it has three states.** The setting
is per user (`POST /api/v1/models/enabled_models`), and `gpt-6-luna` ships `default: false`:

| State | API run | Editor |
|---|---|---|
| never toggled (the default) | runs | opening the flow **clears** the saved decision model to `[]` and autosaves it; the run then fails with *"Pick a Decision Model."* |
| switched **on** | runs | keeps it, runs |
| switched **off** (explicitly) | build refused: *"gpt-6-luna is switched off in Model Providers. Turn it on there, or pick another Decision Model."* | — |

So every runtime test switches the model on first, and switches it back off after when it
was not on before. "Never toggled" cannot be restored: the two stored sets live in internal
per-user variables (`__enabled_models__`, `__disabled_models__`) that the variables API does
not list. Ending on "off" is harmless — the derived flag reads `false` either way, and only
this spec uses decision models — but it is why the file runs its tests **in order**
(`mode: "default"`): the setting is shared by every worker on the superuser, and one test
switching it off while another runs would refuse that run.

**The evidence in the trace.** With tracing on, the run records a `Decision Model` span
(`GET /api/v1/monitor/traces/{id}` → `spans[]`) whose `outputs.result.data` carries the same
structure — `selected_option`, `probabilities`, `confidence`, `request_id` and the
original `request` (question and options). In the editor, the flow's traces
(`sidebar-nav-traces` → the run's row → `trace-detail-view`) list the spans as
`span-node-<span id>`; selecting the Decision Model span renders the same
`decision-inspection` inside `span-detail`, with a `decision-request-id` equal to the
span's `request_id`. Measured on a second `1.14.0.dev39` container started with
`LANGFLOW_DEACTIVATE_TRACING=false`: local instances run with tracing off **by decision**
(the start script), so a run there records no trace at all.

---

## Tags *(required)*

`@stable` `@components` `@model-provider`

Provider-dependent (#1216): tests 4–7 call OpenAI's decision endpoint and skip, naming the
reason, when the recorded OpenAI health is inactive (`providerSkipGate("openai")`). Tests
1–3 call no model and run everywhere. Test 7 also needs tracing on; being provider-dependent,
this spec runs with it in the PR lane (`needs_models`) and in the daily.

---

## Precondition *(required)*

- A Langflow **1.14+** instance at `PLAYWRIGHT_BASE_URL`, auto-login.
- For tests 4–7: OpenAI configured in Langflow (`npx playwright test
  tests/collect-models.spec.ts`), and an `OPENAI_API_KEY` with access to `gpt-6-luna`.
- For test 7: tracing on. Locally that is a container started with
  `LANGFLOW_DEACTIVATE_TRACING=false ./scripts/start-langflow-docker.sh`; on an instance with
  tracing off the test **fails** naming the variable, rather than skipping, because a skipped
  trace assertion would read as covered (#1012).

---

## Step by step *(required)*

Seven tests, run in order (the model setting is shared per user). Every flow is built from the live catalog (`build-catalog-flow.ts`) and deleted
by id in `afterEach`.

**Test 1 — `Smart Router's routing mode swaps the language model for the decision fields, per decision type`** (keyless)
1. Set `routing_mode` to `Decision Model` → `model` hidden; `decision_model`,
   `decision_kind`, `decision_question`, `minimum_probability` and `routes` shown; outputs
   `category_1_result`, `category_2_result`, `default_result`.
2. `decision_kind` Boolean → `routes` hidden, yes/no messages and descriptions shown; outputs
   `yes_result`, `no_result`, `default_result`.
3. `decision_kind` Score → `score_levels` shown, `routes` and `minimum_probability` hidden;
   outputs `level_1_result`, `level_2_result`, `level_3_result`, `default_result`.
4. `routing_mode` back to `Language Model` → `model` shown and every decision field hidden.

**Test 2 — `Decision Model's type decides which fields show`** (keyless)
1. `kind` Boolean → `candidates` hidden; `yes_description`, `no_description` shown.
2. `kind` Score, then Choice → `candidates` shown, the yes/no descriptions hidden.

**Test 3 — `decision models form their own catalog, and incomplete or switched-off decisions are refused`** (keyless)
1. `GET /api/v1/models?model_type=decision` → every model typed `decision`; OpenAI lists
   `gpt-6-luna` with capabilities `choice`, `boolean`, `score`.
2. The catalog types the fields apart: Decision Model `model` and Smart Router
   `decision_model` are `decision`, Smart Router `model` is `language`.
3. A Smart Router flow in decision mode with the Else off → the run `failed` with the
   *Include Else Output* message; with the Else on and no minimum probability → the
   *Minimum Probability* message.
4. With `gpt-6-luna` switched **off**, a Decision Model flow is refused at build with the
   *"switched off in Model Providers"* message — no provider is called, so this needs no key.

**Test 4 — `Decision Model answers a Boolean and a Choice question with structured evidence`** (OpenAI)
Tests 4–7 switch `gpt-6-luna` on first and back off after (see the state table above).
1. Boolean flow over the billing message → `status: "success"`, `kind: "boolean"`,
   `provider: "OpenAI"`, `model: "gpt-6-luna"`, `probability_true` above 0.5.
2. Choice flow over the crash message → `status: "success"`, `kind: "choice"`,
   `selected_option: "technical"`, `probabilities` keyed by exactly the two declared ids,
   `confidence` within 0–1.

**Test 5 — `Smart Router in decision mode fires the chosen route and leaves the others empty`** (OpenAI)
1. The router configured through the update endpoint (decision mode, Else on, minimum
   probability 0.5, routes Billing / Technical), each output wired to its own Chat Output.
2. A refund request → the Billing Chat Output carries the Billing route's value; Technical
   and Else carry none; the run `completed`.

**Test 6 — `the output inspection shows the decision evidence`** (OpenAI, editor)
1. With `gpt-6-luna` switched on, seed a Choice flow
   whose Chat Input holds the crash message.
2. Open it on the canvas, run the Decision Model node, open its output inspection.
3. `decision-inspection` shows `decision-row-technical` marked *Provider's pick*, a row for
   `billing`, `decision-model` "OpenAI · gpt-6-luna", `decision-type` "Choice" and the
   question.
4. Switch the model back off (unless it was on before).

**Test 7 — `the trace records the decision, and the trace view renders it`** (OpenAI, tracing)
1. Run a Choice flow over the crash message through the API.
2. `GET /api/v1/monitor/traces?flow_id=` lists the run (polled; none at all fails naming
   `LANGFLOW_DEACTIVATE_TRACING`); its detail has a `Decision Model` span whose
   `outputs.result.data` holds `selected_option: "technical"`, probabilities over the two
   declared ids and a `request_id`.
3. In the editor: `sidebar-nav-traces` → the run →
   `span-node-<span id>` → `span-detail` shows `decision-inspection` with
   `decision-row-technical` marked *Provider's pick* and `decision-request-id` equal to the
   span's `request_id`.

---

## Validation criterion *(required)*

Three consecutive passes at `--retries=0 --workers=1` with OpenAI active and tracing on, with:

- the configuration contract asserted on visibility **and** outputs for every mode and type;
- every runtime assertion on the outcome's identity, never on wording or an exact probability;
- the two refusals asserted on their messages, with no provider call needed;
- the editor evidence tied to the declared option ids, in the output inspection and in the
  trace view, and the trace view's request id equal to the trace API's;
- the model switched back off (unless it was on before) and every flow deleted.

---

## External dependencies *(required)*

- A running Langflow 1.14+ OSS instance at `PLAYWRIGHT_BASE_URL`.
- OpenAI configured in Langflow, with a key that reaches `gpt-6-luna` (tests 4–6).
- Upstream sources the contract was read from (`langflow-ai/langflow@release-1.14.0`):
  - `src/lfx/src/lfx/components/llm_operations/decision_model.py`
  - `src/lfx/src/lfx/components/llm_operations/llm_conditional_router.py`
  - `src/lfx/src/lfx/base/models/decisions/providers.py`
  - `src/lfx/src/lfx/base/models/decision_constants.py`
  - `src/lfx/src/lfx/graph/vertex/param_handler.py`
  - `src/frontend/src/components/core/decisionInspection/index.tsx`
- The component-catalog baseline (`tests/assets/catalog/component-catalog-baseline.json`)
  is refreshed so `DecisionModel` stops reading as drift.
