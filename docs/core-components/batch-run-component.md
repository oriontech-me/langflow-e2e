# Core Components — Batch Run

**File:** `tests/tests-automations/regression/core-components/batch-run-component.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2572)

Owning issue: #2572.

---

## What this test validates *(required)*

**Batch Run** (`BatchRunComponent`, category `llm_operations`) sends one model call per row of a table column and
returns the table with the model's answer added. Since 1.14 (upstream #16024) it runs the rows in batches of
`batch_size`, can wait `delay_between_batches` between them, and when the provider answers `429` it retries only the
rate-limited rows, halving the batch size, up to `max_rate_limit_retries` times. No spec covered Batch Run before.

The spec builds **Create List → Batch Run** over the API (Create List's *Table* output gives a one-column table,
`text`) and builds Batch Run, reading its result rows from the build's `end_vertex` event.

- **Test 1** runs on a **real provider**, the lane's any-completion target: N rows in, N non-empty answers out, in
  order, each with its metadata. The wording of an answer is never asserted.
- **Tests 2–4** point the model at a **local OpenAI-compatible mock** (`tests/helpers/mocks/rate-limit-openai-mock.ts`)
  that Langflow calls. It echoes each row (`ECHO:<row>`), so outputs are exact. It records every request with its
  arrival time, so batches and retries are observed, not inferred. It answers `429` on demand, which no real provider
  does. The issue left the choice between a mock and "not covered" open; the mock was chosen (Wave 12, 2026-11-27).

**Measured (`1.14.0.dev39`), and what changed relative to the issue:**

1. **The OpenAI SDK under the model retries a `429` by itself**: 3 attempts per request, honouring `Retry-After`.
   Batch Run only sees a `429` that came back 3 times in a row; 2 in a row succeed with `max_rate_limit_retries: 0`.
   So the mock's `429` count is per row, and the retry tests use 3.
2. With 3 rows each refused 3 times, `batch_size: 3` and `max_rate_limit_retries: 1`, Batch Run retries every row
   once more and succeeds. Each row sees 3 × `429` then `200`, and after the retry the requests run **one at a time**
   (the batch size halved from 3 to 1): with a 300 ms response they arrive ≥ 300 ms apart.
3. With `max_rate_limit_retries: 0`, the same 3 refusals fail the build: `valid: false`, and the error is *"Error
   building Component Batch Run: … Error code: 429 - {… 'message': 'Rate limit reached (mock)' …}"*. The mock sees
   only the SDK's 3 attempts.
4. **Batching is observable** (the issue left it open): 5 rows with `batch_size: 2` and `delay_between_batches: 1`
   arrive as 2, 2 and 1, each batch together, the next one after the slowest response plus the delay.
5. Output rows carry the input column, `model_response` (renamable through `output_column_name`) and `batch_index`
   (the row's position). With `enable_metadata`, each also carries `metadata: {has_system_message, input_length,
   input_format: "column", response_length, processing_status: "success"}`; without it, no `metadata` key.
6. The model field (`ModelInput`) has no options in the component catalog: the editor reads them from
   `POST /api/v1/custom_component/update` (`field: "model"`), per user. The spec reads them the same way and puts the
   matching option in `model.value`.
7. Langflow reaches the mock at the test host's RFC-1918 address: loopback is blocked by its SSRF layer, and the
   private ranges are admitted by `LANGFLOW_SSRF_ALLOWED_HOSTS` on every lane. Measured from the Podman container to
   the Mac's LAN address. `E2E_MOCK_HOST_FROM_LANGFLOW` overrides the address.

---

## Tags *(required)*

All four tests: `@stable` `@components` `@model-provider`.

`@model-provider` is the provider tag the issue asked for (#1216): it makes the file provider-dependent for the PR
lane (`scripts/provider-dependent-specs.mjs`), which forces the *Collect models* sweep when the file changes and
excludes it when only an import changed. Test 1 is parametrized over `resolveTestTargets({ tier: "any-completion" })`
and skips with the provider-health reason on a dry or unchecked provider. Tests 2–4 need no key.

---

## Step by step *(required)*

**Test 1 — on a real provider: N rows in, N non-empty outputs in order, with metadata.** For each target (provider,
model), as the superuser (the sweep configured the provider there):

1. Read the model options (`custom_component/update`) and take the target's (`provider` from the provider config's
   name, `name` the model). Missing means the provider is not configured, and fails saying so.
2. Run 4 rows (`"Reply with one word: red"` …) with `batch_size: 2` and `enable_metadata: true`.
3. The build succeeds with 4 rows; `text` is the input in order, `batch_index` is 0–3, each `model_response` is a
   non-empty string, and `metadata` matches `processing_status: "success"`, `input_format: "column"`,
   `input_length` (the row's length), `response_length` (the answer's length), `has_system_message: false`.

**Setup of tests 2–4 (`beforeAll`, serial block).** Start the mock; create a throwaway user; store its
`OPENAI_COMPATIBLE_BASE_URL` (the mock) and `OPENAI_COMPATIBLE_API_KEY` (a dummy), base URL first; read its model
options and take `OpenAI Compatible / e2e-mock-model`, which proves Langflow reached the mock.

**Test 2 — batches and the delay, in order, with and without metadata.**

1. 5 rows, `batch_size: 2`, `delay_between_batches: 1`, `enable_metadata: true`, mock responses taking 300 ms. Each
   row comes back as `[text, "ECHO:" + text, index]`, in order, with exactly the five metadata fields.
2. The mock's requests, grouped by arrival (< 500 ms apart), are the rows `{1,2}`, `{3,4}`, `{5}`, each batch
   starting ≥ 1 250 ms after the previous one.
3. 2 rows with `enable_metadata: false`: no row has a `metadata` key.

**Test 3 — a `429` the client gives up on is retried by Batch Run.** 3 rows, each refused 3 times
(`Retry-After: 0`), `batch_size: 3`, `max_rate_limit_retries: 1`, responses taking 300 ms.

1. The build succeeds; every row is echoed, in order.
2. Each row's requests are exactly `429, 429, 429, 200`.
3. The three `200`s arrive ≥ 250 ms apart: the retry ran one request at a time.

**Test 4 — with no retries left, the rate limit fails the build.** 1 row refused 3 times,
`max_rate_limit_retries: 0`: the build is invalid, its error holds `Error code: 429` and the mock's message, and the
mock saw exactly 3 requests, all `429`.

**Teardown.** Test 1 deletes its flows. The block deletes the throwaway user (its flows and variables go with it)
and stops the mock.

---

## Validation criterion *(required)*

- **Real provider:** the row count, the input order, `batch_index`, a non-empty answer per row and its metadata. A
  Batch Run that dropped, duplicated or reordered rows fails here.
- **Batches:** the exact grouping of the mock's requests and the gap between groups. A Batch Run that ignored
  `batch_size` (one batch of 5) or the delay fails here.
- **Retry:** the exact sequence of statuses per row and the one-at-a-time retries. A Batch Run that stopped
  retrying would fail the build (as test 4 does), one that stopped halving would send the retries together.
- **Exhaustion:** an invalid build naming the `429`, with no extra request.

---

## Notes

- Test 2's timing thresholds have margin: the measured gap between batches is ~1 310 ms against 1 250 asserted, and
  the one-at-a-time retries ~310 ms apart against 250. Requests of one batch arrive within a few ms (grouped at
  500 ms).
- The 3-attempt figure belongs to the OpenAI SDK's default (`max_retries=2`), which Batch Run does not expose. If a
  release changes it, tests 3 and 4 fail on the per-row sequence, which names the new count; `CLIENT_ATTEMPTS` is the
  one constant to update.
- Each throwaway user costs one login (OSS limits logins to 5 per minute per client IP); the block makes one.
- The mock listens on an ephemeral port on every interface for the duration of the block.

---

## What this test does not cover *(and why)*

- **A rate-limit error wrapped by another exception** (upstream's "retry wrapped provider quota errors"): the
  wrapping happens inside provider SDKs, which a mock speaking plain HTTP cannot make wrap.
- **`Retry-After` values above 0** and the 300 s cap: the waits would cost the test that long.
- **A system message and the TOML input** (no `column_name`): they change the prompt, not the batching or retry.
- **Other providers' rate limits**: the retry logic is provider-agnostic (it reads a status code or the error text);
  the mock is OpenAI-compatible.

---

## Preconditions *(required)*

- Langflow 1.14 with the rate-limit-aware Batch Run (`1.14.0.dev39` measured), the `OpenAI Compatible` provider
  (bundle `lfx_openai_compatible`) and `LANGFLOW_SSRF_ALLOWED_HOSTS` admitting the RFC-1918 ranges (every lane sets
  it).
- Test 1: a configured provider (the *Collect models* sweep) and a fresh health record, or it skips with the reason.
- Tests 2–4: the test host reachable from Langflow at an RFC-1918 address, or `E2E_MOCK_HOST_FROM_LANGFLOW` set.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/llm_operations/batch_run.py` — the component: batches, delay, retry, halving, metadata, the output rows
- `src/lfx/src/lfx/components/processing/create_list.py` — the table source (its *Table* output)
- `src/lfx/src/lfx/base/models/unified_models/build_config.py` — `handle_model_input_update`, which fills the model options
- `src/lfx/src/lfx/base/models/unified_models/instantiation.py` — `get_llm`, which builds the model from the selected option
- `src/backend/base/langflow/api/v1/endpoints.py` — `custom_component/update`, which fills the model options
- `tests/helpers/mocks/rate-limit-openai-mock.ts` — the mock and the address Langflow reaches it at
- `tests/helpers/provider-setup/test-targets.ts` — the real-provider targets and their skip reasons
- `tests/helpers/flows/build-catalog-flow.ts` — the flow, built from the live catalog
- `tests/helpers/auth/throwaway-user.ts` — the user the mock provider is configured on
