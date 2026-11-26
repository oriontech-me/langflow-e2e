# Ollama and watsonx base URLs — which SSRF policy each field applies

**Spec:** `tests/tests-automations/regression/security/ollama-watsonx-base-url-ssrf.spec.ts`

**Last validated:** Langflow 1.14.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`; `lfx 1.14.0.dev39`, `lfx-ollama 0.2.1`, `lfx-ibm 0.4.0`)

---

## What this test validates *(required)*

A model component's base-URL field is **tenant-editable**: the SDK behind it makes a server-side
request to whatever host the field names. `security/model-provider-base-url-ssrf.spec.ts` covers the
OpenAI and Anthropic components, the two that went through the provider seam
(`lfx/base/models/provider_ssrf.py`) when it was created. On `1.12.0.dev38` the Ollama and watsonx
fields were recorded as **outside** that seam, because none of their files imported it (§17.5,
#2561).

That is no longer the state. Re-measured on `1.14.0.dev38`, **every one of those fields is guarded**,
by three upstream changes:

- the unified Language Model path validates its effective endpoint against the connector SSRF policy
  (langflow-ai/langflow#14348), and since langflow-ai/langflow#16565 also checks where a watsonx
  credential may go;
- the Ollama components build DNS-pinned SSRF-protected clients and fetch their model list through
  the SSRF-safe helpers (in the bundle since langflow-ai/langflow#14248);
- the watsonx components go through `provider_ssrf` itself (langflow-ai/langflow#15587).

**They do not all apply the same policy, and that is what this spec pins.** Langflow has two SSRF
policies for an outbound URL:

- the **connector** policy, for ordinary connectors such as API Request: it refuses private and
  link-local addresses that are not allowlisted, and admits loopback because
  `connector_ssrf_allow_loopback` defaults to `true`;
- the **strict** policy, for credential-bearing provider URLs behind `provider_ssrf`: the same
  refusals, plus loopback unless `LANGFLOW_SSRF_ALLOWED_HOSTS` names it.

Each field applies one of the two, and the choice is per field, not per provider:

| Component · field | Policy | Loopback | `169.254.169.254` | `file:///etc/passwd` | Allow-listed private address |
|---|---|---|---|---|---|
| Ollama · `base_url` | connector | admitted: the connection is attempted (`All connection attempts failed`) | refused | refused | admitted: `404 page not found` from the echo service |
| Ollama Embeddings · `base_url` | connector | no refusal (the build does not connect) | refused | refused | no refusal (the build does not connect) |
| Language Model (Ollama) · `ollama_base_url` | connector | admitted: the connection is attempted | refused | refused | admitted: `404 page not found` |
| IBM watsonx.ai · `base_url` | **strict** | **refused**, naming `::1` and `127.0.0.1` | refused | refused | admitted: reaches the SDK (`validation error for ChatWatsonx`) |
| IBM watsonx.ai Embeddings · `url` | **strict** | **refused**, naming `::1` and `127.0.0.1` | refused | refused | admitted: reaches the SDK (`validation error for WatsonxEmbeddings`) |
| Language Model (IBM watsonx) · `base_url_ibm_watsonx` | connector | admitted: reaches the SDK | refused | refused | admitted: reaches the SDK |

Every refusal is a `500` from `POST /api/v1/run/{id}` whose body carries `SSRF Protection`. Measured
twice, identically, on a single-node flow with a dummy credential.

Three things in that table are worth a test each.

**Ollama admits loopback on purpose.** Ollama is keyless by default and its default address *is*
`http://localhost:11434`, so the strict policy would break every local install. Pinning "loopback is
admitted" keeps that true, and pinning "metadata and `file:` are refused" on the same fields keeps the
admission from being read as "no policy at all".

**The two watsonx entry points apply different policies.** The standalone watsonx components refuse
loopback; the Language Model's watsonx field admits it, like an ordinary connector. The Language
Model path does not lose the credential check: since #16565 an operator-provisioned watsonx
credential (from the server environment) may only go to IBM's own endpoints or to a host in
`LANGFLOW_PROVIDER_CREDENTIAL_ALLOWED_HOSTS`. What the connector policy admits is loopback with a
credential the tenant typed, which is what API Request admits too. The spec pins the asymmetry so a
change on either side fails and names itself: if the Language Model field starts refusing loopback,
upstream moved it to the strict policy and this spec and §17.5 need updating; if the watsonx
component starts admitting loopback, the provider seam regressed.

**An admission needs its own positive observable.** "No `SSRF Protection` in the body" also holds for
a run that never got as far as the guard. So every admitted case asserts what happened next: the
connection attempt for Ollama on loopback, the echo service's own `404` for Ollama on a private
address, and the SDK's own validation error for watsonx, which only runs after the SSRF check has
passed the URL.

---

## Tags *(required)*

`["@stable", "@api", "@regression"]`

The same tags and reasons as the sibling `security/model-provider-base-url-ssrf.spec.ts`: `@api`
because every call goes through the `request` fixture, `@regression` because the file pins upstream
security fixes, and no functional tag because none in `CLAUDE.md`'s table names the SSRF surface
(`@model-provider` means provider configuration screens, which this file never opens).

`@stable` from this PR, per `CONTRIBUTING.md`. The allow-listed private-address test is
`test.skip`-gated on a reachable RFC-1918 `ECHO_BASE_URL`, the same gate and the same accepted
limitation as both `@stable` siblings in `security/`: where the daily resolves the echo endpoint in
`mode: warn`, a resolution failure leaves that one test skipped, not red. The other four tests need
no echo and always run.

---

## Preconditions *(required)*

- A running OSS nightly with `lfx-ollama` and `lfx-ibm` installed (both are, on `1.14.0.dev38`). A
  component the image does not ship must **fail** naming itself rather than skip: an absent bundle is
  a packaging change (`docs/component-distribution-policy.md`), and skipping would delete this
  coverage without a trace.
- `LANGFLOW_SSRF_ALLOWED_HOSTS` covering the RFC-1918 ranges, the value every lane and both start
  scripts set.
- `ECHO_BASE_URL` (or `HTTPBIN_BASE_URL`) pointing at a **private** address, for the allow-listed
  test only. Every CI lane resolves it; locally,
  `docker run -d --name echo --network bridge ghcr.io/mccutchen/go-httpbin:latest` and pass
  `http://<its IP>:8080`.
- Nothing listening on port `9` (discard) of the Langflow host. The loopback cases use
  `http://localhost:9` so the connection is refused at once on any lane, including the QA VM, where
  Langflow runs natively and an arbitrary port such as `8080` may belong to another service.
- No provider key, no egress, no model.

---

## Step by step *(required)*

One API key is minted in `beforeAll`. Each run creates its own single-node flow from the component's
template in `GET /api/v1/all`, records the id **before** any assertion that can throw, and `afterAll`
deletes every flow and the key. Each flow sets the field under test, a dummy literal credential
(`load_from_db: false`) where the component has one, and what the SDK needs to get as far as its own
validation: a model, and for watsonx a project id. Every run is `POST /api/v1/run/{id}` with
`input_value: "ping"`.

1. **The watsonx components apply the strict policy.** For `IBM watsonx.ai · base_url` and
   `IBM watsonx.ai Embeddings · url`, one step per component:
   1. `http://localhost:9` → `SSRF Protection` naming `::1`, `127.0.0.1` and
      `LANGFLOW_SSRF_ALLOWED_HOSTS`.
   2. `http://169.254.169.254` → `SSRF Protection` naming `169.254.169.254`.
   3. `file:///etc/passwd` → `SSRF Protection` naming the scheme `'file'`.
2. **The Ollama fields refuse the metadata address and a non-http scheme.** For `Ollama · base_url`,
   `Ollama Embeddings · base_url` and `Language Model · ollama_base_url` (provider Ollama), one step
   per component: `http://169.254.169.254` → `SSRF Protection` naming the address;
   `file:///etc/passwd` → `SSRF Protection` naming `file:///etc/passwd`.
3. **The Ollama chat fields admit loopback.** `http://localhost:9` on `Ollama · base_url` and
   `Language Model · ollama_base_url`: no `SSRF Protection`, and `All connection attempts failed`,
   the client's own failure to connect, which only happens after the policy let the URL through.
4. **The Language Model's watsonx field applies the connector policy.** On
   `Language Model · base_url_ibm_watsonx` (provider IBM watsonx):
   1. `http://169.254.169.254` → `SSRF Protection` naming the address.
   2. `file:///etc/passwd` → `SSRF Protection`.
   3. `http://localhost:9` → **no** `SSRF Protection`, and `validation error for ChatWatsonx`, the
      SDK's own refusal of a non-IBM URL without a username, which runs only after the URL passed.
5. **An allow-listed private address is admitted on every field that connects** (skipped, with the
   reason, when `ECHO_BASE_URL` is unset or not private). With `${ECHO_BASE_URL}`:
   1. `Ollama · base_url` and `Language Model · ollama_base_url` → no `SSRF Protection`, and
      `404 page not found`, a real answer from the private host.
   2. `IBM watsonx.ai · base_url`, `IBM watsonx.ai Embeddings · url` and
      `Language Model · base_url_ibm_watsonx` → no `SSRF Protection`, and the SDK's
      `validation error for ChatWatsonx` / `for WatsonxEmbeddings`.

   This is the control that makes the strict refusals in step 1 mean "this address is blocked"
   rather than "every non-default URL is blocked".

---

## Validation criterion *(required)*

Fails when any of these fields stops refusing the cloud-metadata address or a non-`http(s)` scheme;
when a watsonx component stops refusing loopback; when an Ollama field starts refusing loopback or an
allow-listed private address; when the Language Model's watsonx field changes policy in either
direction; or when a refusal stops naming what it refused. Every admitted case also needs its own
positive observable, so the spec fails if a run dies before reaching the guard.

**Force-fail evidence.** The mutation that matters is the inverse of each row: asserting a refused
case is admitted (what a regressed guard produces), and asserting an admitted case is refused (what a
block-everything regression produces, which a refusal-only spec would call healthy).

---

## What this test does not cover *(and why)*

- **The model-list fetch.** Editing an Ollama or watsonx base URL in the UI makes the backend fetch
  that host's model list (`/api/tags`, `/api/show` for Ollama) through
  `POST /api/v1/custom_component/update`, a second server-side request path that does not run the
  flow. It goes through the same SSRF-safe helpers, but a refused fetch and an unreachable host both
  leave the options list unchanged, so a black-box assertion cannot tell them apart.
- **The operator-credential destination check.** `ensure_credential_endpoint_allowed` refuses to
  send a credential that comes from the **server environment** to a non-default endpoint
  (langflow-ai/langflow#15211, #15587, #16537, #16565). Observing it needs a provider credential in
  the Langflow process environment, which no lane sets for watsonx. It is also the control the §17.5
  *public endpoint* bullet asks about, and belongs in its own issue.
- **DNS rebinding.** The Ollama clients are DNS-pinned so the connection cannot drift from the
  validated address; proving the pin needs a DNS server that answers differently on the second
  lookup. Same scope decision as the sibling spec.
- **The unified OpenAI path.** The Language Model component has no tenant-editable base URL for
  OpenAI: it comes from the `OPENAI_BASE_URL` provider variable or the environment, which is
  provider configuration rather than a field on the node.
- **The status code.** A refusal is a `500` wrapping `Error building Component …`, as in the sibling
  spec; the spec pins the body, which is the observable that exists.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/base/models/unified_models/instantiation.py` — `_protect_model_connection`, which
  gives `ChatOllama`/`OllamaEmbeddings` SSRF-protected clients and validates every other provider's
  effective URL against the connector policy; and the watsonx credential-destination call.
- `src/lfx/src/lfx/components/models_and_agents/language_model.py` — the Language Model component,
  which passes `ollama_base_url`, `base_url_ibm_watsonx` and `project_id` to `get_llm`.
- `src/bundles/ollama/src/lfx_ollama/components/ollama/ollama.py` and
  `src/bundles/ollama/src/lfx_ollama/components/ollama/ollama_embeddings.py` — the Ollama components'
  SSRF-protected clients and model-list helpers.
- `src/bundles/ibm/src/lfx_ibm/components/ibm/watsonx.py` and
  `src/bundles/ibm/src/lfx_ibm/components/ibm/watsonx_embeddings.py` — the watsonx components,
  through `validate_provider_base_url` and `ensure_credential_endpoint_allowed`.
- `src/lfx/src/lfx/base/models/provider_ssrf.py` — the strict provider seam.
- `src/lfx/src/lfx/utils/ssrf_httpx.py` — the connector and strict SSRF validators and the pinned
  client factories.
- `src/lfx/src/lfx/base/models/model_utils.py` — `ensure_watsonx_credential_endpoint_allowed`.
- `src/lfx/src/lfx/services/settings/groups/security.py` — `connector_ssrf_allow_loopback`
  (default `true`) and `ssrf_allowed_hosts`, the two settings the table above depends on.
- **Langflow API** — `GET /api/v1/auto_login`, `GET /api/v1/all`, `POST /api/v1/api_key/`,
  `POST /api/v1/flows/`, `POST /api/v1/run/{id}`, `DELETE /api/v1/flows/{id}`,
  `DELETE /api/v1/api_key/{id}`.
- **`ghcr.io/mccutchen/go-httpbin`** via `ECHO_BASE_URL`, for step 5 only.
