# Agent structured output — output_schema returns schema-shaped JSON

**Last validated:** Langflow 1.11.x (re-validated on 1.11.0.dev38, #724)

---

## What this test validates *(required)*

QA-CHECKLIST §6.5 "Agent returns output in structured JSON format
(output_schema)" and the JSON half of §7.7 "Output formatting (JSON via
output_schema, Markdown, plain text)".

The Agent component exposes an advanced `output_schema` TableInput (rows:
`name`, `description`, `type` ∈ {str,int,float,bool,dict}, `multiple`) and a
second output **`structured_response`** (`json_response` → `Data`). Verified
live on the 1.11 nightly source (`agent.py`): with **no tools** attached the
orchestrator takes the **native path** (`with_structured_output`,
provider-validated JSON, agent loop bypassed); with tools it falls back to a
schema-augmented prompt + parse. This spec pins the native path — the
strongest, least model-dependent form of the contract — by disabling the
Agent's built-in tool toggles (`add_current_date_tool`,
`add_calculator_tool`).

Two tests, both asserting **structure, never content quality**:

1. **Schema fields come back as typed JSON keys.** Schema
   `{name: str, age: int}` + an input whose extraction is trivial ("John is
   25 years old."): the `structured_response` output parses as JSON and has
   key `name` of type string and key `age` of type number. Values are the
   model's extraction — asserted only for presence and type, not exact
   content.
2. **The schema knob causally drives the shape.** Same machinery, one schema
   row with `multiple = true` (`colors: str`, As List) + "The flag is red,
   white and blue.": the parsed `colors` key is an **array** (of strings).
   Proves the returned shape follows the schema definition, not a fixed
   JSON habit of the model.

Determinism note: the model fills VALUES (non-deterministic), but the SHAPE
is enforced by the provider's structured-output mode on the native path —
the asserts touch only the shape (parse + key presence + typeof). Same
class as the merged agent specs: LLM in the loop, deterministic observable.

Boundary (flagged on the PR): §7.7 also names Markdown and plain-text
formatting — those are model content choices with no schema contract to
assert deterministically; this spec covers the bullet's `output_schema`/JSON
contract only.

If this test fails, `output_schema` no longer shapes the agent's structured
output — the structured-output contract (§6.5) is broken.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@components`

`@stable` added after 4 clean `--retries=0` runs on the fresh nightly (issue
#491's "Done when" includes `@stable`). `@regression` — guards the
output_schema → structured_response wiring; `@agents` — Agent surface;
`@components` — the assert reads the node's output inspector on the canvas.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- `models.json`/`providers.json` (collect-models) + an active provider key
  (one completion per test).
- Run with `--workers=1` — loads the Simple Agent template (agent-area
  rule). Flows are id-scoped-deleted in cleanup (`deleteFlow` helper).

---

## Step by step *(required)*

**Test 1 — output_schema fields return as typed JSON keys (§6.5)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Via API PATCH on the Agent node template (advanced fields, same
   mechanism as the context_id specs): set
   `output_schema = [{name: "name", type: "str"}, {name: "age", type: "int"}]`,
   set `add_current_date_tool = false` and `add_calculator_tool = false`
   (no tools ⇒ native structured-output path). Reload.
3. Set the Chat Input text to a trivially extractable sentence carrying a
   per-run nonce ("John is 25 years old. (nonce)").
4. Run the **Agent node** (node run button) and open the output inspector of
   the **Structured Response** output.
5. **Assert:** the inspector payload parses as JSON; the parsed object (or
   first element, if the orchestrator returns a list) has key `name` with a
   string value and key `age` with a number value.
6. No `allowFlowErrors`.

**Test 2 — a `multiple` (As List) schema row returns an array (§7.7 JSON shape)**

1. Same template load + PATCH mechanism; schema
   `[{name: "colors", type: "str", multiple: true}]`, tools off.
2. Chat Input: "The flag is red, white and blue. (nonce)".
3. Run the Agent node, open the Structured Response inspector.
4. **Assert:** parsed JSON has key `colors` whose value is an **Array** with
   length ≥ 1 and every element of type string.

---

## Validation criterion *(required)*

The Structured Response output of an Agent configured with an
`output_schema` parses as JSON whose keys and JS types match the schema rows
exactly as defined (str → string, int → number, multiple → Array). The
causal control is the schema itself: changing a row's `multiple` flag
changes the returned shape. All asserts are parse/typeof checks on the
persisted output — never on the model's wording.

## Guarding against false positives *(how)*

- **Shape-only asserts** — no expected VALUES from the model (no
  `age === 25`), so a differently-phrased extraction cannot flake the test;
  a missing/mistyped key always fails it.
- **Native path pinned** — tools disabled via the same PATCH, so the
  provider-validated structured output (not the looser prompt-fallback
  parser) is under test; a silent fallback regression that stops honoring
  the schema fails the typeof asserts.
- **Trivial extraction inputs** — the sentence literally contains the
  schema fields, removing extraction ambiguity as a flake source.
- **Per-run nonce** in the input pins any monitor/debug lookup to THIS run.
- **Error-shape guard** — `json_response` returns
  `{content: "", error: …}` on orchestration failure; the key/typeof
  asserts fail on that shape (no key `name`/`colors`), so an errored run
  cannot pass silently.
- **Model-selection guards (setup stabilization, found via live flake
  hunt).** The Agent's model choice lands via ASYNC autosave; a GET+PATCH
  that races it re-writes the template default (the leader/default provider's
  model, e.g. `claude-sonnet-5`) back over the selection. Two guards: the API
  PATCH polls the flow until the POM's model selection is autosaved before
  writing (write-clobber race), and the run helper re-checks the node's model
  widget right before running, reloading (bounded — 3 checks, at most 2
  reloads) until the selection is present. The structured-output asserts are
  untouched by both guards.
  - **#724 fix — the poll must check the SELECTED value, not the serialized
    field.** `template.model` embeds an `options` list of every enabled model
    (~59 on a multi-provider nightly), so the original substring check over
    the stringified field matched `expectedModel` inside `options` regardless
    of what was actually selected — the poll returned "ready" on the first
    GET even before the autosave, and the PATCH clobbered the selection with
    the leader model (daily #704 hard failure). The poll now inspects
    `template.model.value` (the array of selected model objects) only.
  - **Not a product bug (re-confirmed live on #724).** Selecting a non-leader
    model in the widget, waiting for autosave, and reloading persists the
    selection correctly on the nightly; the flake was entirely the test's own
    write-clobber, now fixed.
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 expects a key
  absent from the schema (`city`) ⇒ must fail; M2 — test 1 expects `age` to
  be a string (wrong type) ⇒ must fail; M3 — test 2 expects `colors` NOT to
  be an array ⇒ must fail.

---

## What this test does not cover *(optional)*

- Markdown / plain-text output formatting (the §7.7 remainder) — model
  content choices without a schema contract; no deterministic observable.
- The prompt-fallback path (tools attached) — weaker parser-based contract;
  the native path is the schema contract proper.
- Value correctness of the extraction (model judgment).
- The Response (unstructured) output — covered by the playground specs.

---

## External dependencies *(required)*

- **LLM provider API**: one completion per test (structured-output capable
  model — gemini/openai class).
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
