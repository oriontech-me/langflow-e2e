# Model-provider base URLs — the connector SSRF policy at its single seam

**File:** `tests/tests-automations/regression/security/model-provider-base-url-ssrf.spec.ts`

**Last validated:** Langflow 1.12.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

A model-provider component's base-URL field is **tenant-editable and credential-bearing**: the
provider SDK performs a server-side request to whatever host it names, carrying the operator's
stored provider credential. `lfx/base/models/provider_ssrf.py` states the consequence itself —
the field is "both an SSRF primitive and a credential-exfiltration primitive". Upstream
[#14640](https://github.com/langflow-ai/langflow/pull/14640) created that module as the **single
seam** where those components apply the repository's existing connector SSRF policy, "so a new
provider bundle picks up the guard by importing one helper rather than copy-pasting a call site";
[#14704](https://github.com/langflow-ai/langflow/pull/14704) followed two days later to close the
call sites the first pass missed. Both are on `release-1.12.0`, the line the nightly is cut from.

**A seam whose whole value is that every provider goes through it, and which already needed one
follow-up for a missed call site, is the regression shape a spec exists for.** The failure is
silent by construction: a component that stops consulting the policy still builds, still runs, and
still returns a plausible error — it just sends the credential somewhere internal first.

**This is not `security/ssrf-url-validation.spec.ts` with a different component.** That file
(#1391) covers the allow-list round trip on the **API Request** component — an ordinary connector,
a different code path, and a deliberately laxer policy. Provider URLs are stricter, in the
module's own words: "literal loopback is blocked unless the operator explicitly trusts it through
`LANGFLOW_SSRF_ALLOWED_HOSTS`", while ordinary connectors ship `connector_ssrf_allow_loopback=True`
(read back from `Settings()` on `dev38`).

### The measured contract

Observable through `POST /api/v1/run/{id}` on a **single-node flow** — the provider model
components accept `input_value` directly, so no Chat Input or edge is needed — and with a **dummy
API key**, because the guard fires before the credential is used.

| component · field | `base_url` value | body of the `500` |
|---|---|---|
| both | `''` | the provider's own `401` — the call **left the box** |
| Anthropic · `base_url` | `https://api.anthropic.com` | the provider's own `401` — the canonical endpoint also skips |
| both | `http://localhost:8080/v1` | `SSRF Protection: Hostname localhost resolves to blocked IP address(es): ::1, 127.0.0.1` |
| both | `http://169.254.169.254/v1` | `SSRF Protection: Hostname 169.254.169.254 resolves to blocked IP address(es): …` |
| both | `file:///etc/passwd` | `SSRF Protection: Invalid URL scheme 'file'. Only http and https are allowed.` |
| both | `http://<rfc1918 echo>:8080/v1` | `404 page not found` — **admitted**, a real answer from a private host |

Four things make this contract worth pinning rather than one.

**The control and the assertion share a credential.** The *same dummy key* produces the provider's
own `401` on the skip path and an SSRF refusal on a blocked path. So "refused" is provably a verdict
about the **URL** and not about the key — and the `401` simultaneously proves the component builds
and genuinely attempts the request, which is what stops the refusal assertions from passing against
a component that is broken outright. A spec asserting only "the SSRF string appears" would pass on
an instance where every provider build fails for an unrelated reason.

**Two components, two different field names, one policy.** OpenAI's field is `openai_api_base`;
Anthropic's is `base_url`. Only three component files in the image import the seam
(`lfx_openai/components/openai/openai.py`, `…/openai_chat_model.py`,
`lfx_anthropic/components/anthropic/anthropic.py`), and both distributions are installed. A
per-component regression — precisely what #14704 fixed — passes a spec that checks one of them.

**`_is_provider_default` is a branch, not a detail.** Empty **and** the provider's own canonical
endpoint both skip the policy entirely: no clients minted, no DNS round trip. Measured on both
components (Anthropic with `https://api.anthropic.com` set explicitly). Asserting only refusals
would not notice that branch collapsing into "validate everything" — a DNS lookup on every build of
every provider component — or widening into "validate nothing".

**The admitted case is the non-vacuity control, and it must go through the seam.** An RFC-1918
address that `LANGFLOW_SSRF_ALLOWED_HOSTS` admits answers `404 page not found` from the echo
service: not an SSRF refusal, and a real HTTP response from a private host, which is only possible
because a CIDR entry admits it. Without this, every refusal above is equally consistent with "the
policy blocks every non-default URL", which would be a different — and also broken — product.

---

## Tags *(required)*

`["@api", "@regression"]`

`@api` for the layer — every call goes through the `request` fixture, no browser. `@regression`
because the file pins two upstream security fixes.

The sibling `security/ssrf-url-validation.spec.ts` carries the same pair, which is the precedent
this file follows: `security/` specs are area-by-directory, and no functional tag in `CLAUDE.md`'s
table names the SSRF surface. `@model-provider` was considered and rejected — that tag means
provider *configuration* (Settings UI, keys, the model modal), and a reviewer filtering on it would
get a security spec that never touches those screens.

**No `@stable` yet**, per the rule that the tag is added only after team validation. It is a strong
candidate: keyless, ~10 s, no model, and the only network it needs is one refused `401`.

---

## Preconditions *(required)*

- A running OSS nightly with `lfx-openai` and `lfx-anthropic` installed (both are, on `dev38`).
  A component the image does not ship must **fail** naming itself rather than skipping — an absent
  provider bundle is exactly the packaging change `docs/component-distribution-policy.md` exists
  for, and it would silently delete this coverage.
- `LANGFLOW_SSRF_ALLOWED_HOSTS` covering the RFC-1918 ranges — the value every lane and both start
  scripts already set.
- `ECHO_BASE_URL` (or `HTTPBIN_BASE_URL`) pointing at a **private** address, for the admitted case
  only. Every CI lane resolves it through `.github/actions/resolve-echo-endpoint`; locally,
  `docker run -d -p 8099:8080 ghcr.io/mccutchen/go-httpbin:latest` and pass the container's IP.
- **Outbound HTTPS to the two providers**, for the skip-path test only, and only far enough to be
  refused. No key, no tokens, no spend: a deliberately invalid key is sent and both providers answer
  `401` on the first request.

---

## Step by step *(required)*

Every test creates its own single-node flow, records the id **before** the assertions that can
throw, and deletes it in `afterAll`.

1. **Refusal — loopback, OpenAI.** One flow with `openai_api_base = http://localhost:8080/v1`, a
   dummy `api_key` (`load_from_db: false`, so no global variable is consulted), and
   `input_value = "ping"`. `POST /api/v1/run/{id}` answers `500` whose body names
   `SSRF Protection` **and both resolved addresses** — `::1` and `127.0.0.1`. Both, because the
   guard resolves the name and reports every address behind it; a message naming only one would mean
   the IPv6 leg went unchecked.
2. **Refusal — the cloud-metadata address, OpenAI.** `http://169.254.169.254/v1`. The canonical
   SSRF target, and the one address no lane allow-lists.
3. **Refusal — a non-`http(s)` scheme, OpenAI.** `file:///etc/passwd`; the body names
   `Invalid URL scheme 'file'`. A different branch of the validator from 1 and 2, which resolve a
   host — this one never gets that far.
4. **Refusal — the Anthropic component, through its differently-named field.** The same three
   values through `base_url`, asserted in three steps of one test. Separate from 1–3 so a
   per-component regression names the component rather than a value.
5. **Admitted — an allow-listed private base URL, through the seam.** `${ECHO_BASE_URL}/v1` as the
   OpenAI base URL. The run still fails — the echo service is not an OpenAI-compatible API — and
   that is the point: the body carries `404 page not found` and **no** `SSRF Protection`. Skipped,
   with the reason stated, when `ECHO_BASE_URL` is unset or resolves to a host Langflow does not
   block by default (reaching a public host would prove nothing about the allow-list). Same guard
   shape as `ssrf-url-validation.spec.ts`, for the same reason.
6. **The provider's own endpoint skips the policy.** Four runs: empty and the canonical endpoint, on
   each component. All four must fail with the **provider's own authentication error** and no
   `SSRF Protection`. This is the branch `_is_provider_default` guards, and the test that makes 1–4
   non-vacuous even with `ECHO_BASE_URL` unset.

---

## Validation criterion *(required)*

- Every refusal body carries `SSRF Protection` **and** the reason specific to its branch: both
  resolved addresses for the name, the literal address for the metadata IP, the scheme for `file:`.
- Every admitted body carries **no** `SSRF Protection` — and a positive observable of its own
  (`404 page not found` for the echo case, the provider's authentication error for the skip case),
  so "the string is absent" cannot pass on a run that never happened.
- Both components are asserted, through their two different field names.

**Force-fail evidence.** The mutation that matters is the inverse of the security property:
asserting a blocked URL is **admitted** — the reading a regressed seam produces. Its complement,
asserting the echo case is refused, covers the block-everything regression, which a refusal-only
spec would call healthy.

---

## What this test does not cover *(and why)*

- **A public attacker-controlled endpoint.** The module's own scope note: the policy blocks
  *internal* destinations and "cannot decide whether an arbitrary *public* host is a legitimate
  OpenAI-compatible provider, so pointing a provider component at an attacker-controlled public
  endpoint still forwards the configured credential". Restricting which hosts a stored credential
  may reach is a separate, additive control upstream — asserting it here would assert a product
  decision that has not been made.
- **DNS rebinding / TOCTOU.** `provider_httpx_clients` returns DNS-**pinned** clients precisely so
  the connection cannot drift from the validated IP, and `validate_provider_base_url` is documented
  as being only for paths that do **not** later connect. Proving the pin needs a DNS server that
  answers differently on the second lookup; out of scope, named so it reads as a decision.
- **The unified `LanguageModelComponent`.** Its `ollama_base_url` and `base_url_ibm_watsonx` fields,
  and the Ollama and Watsonx components' own `base_url`, are **measured as outside this seam** — the
  grep for `provider_ssrf` returns three component files and none of them is these. Consistent with
  the scoping (Ollama is keyless and its default *is* loopback, so a strict guard would break it out
  of the box), but recorded rather than assumed: the most-used model component carries two
  unguarded base-URL fields, and a future change that makes one of them credential-bearing would
  need this seam.
- **The status code.** The refusal is a `500`, wrapped as
  `Error running graph: Error building Component OpenAI: … SSRF Protection: …`, so a caller cannot
  tell "your URL is blocked by policy" from "the server broke" by status alone. The spec pins the
  observable that exists and states the shape here, so a future move to a `4xx` reads as an
  intentional improvement rather than a mystery.
- **The other two 1.12 security PRs**, each its own issue: #14646 (the caller-aware component policy
  on stored flow graphs — needs `LANGFLOW_CUSTOM_COMPONENT_ADMIN_ONLY=true`, hence a container
  variant) and #14216 (secret values across graph edges — partially adjacent to
  `security/credential-secret-exposure.spec.ts`, which covers one node rather than a chain).

---

## External dependencies *(required)*

- `src/lfx/src/lfx/base/models/provider_ssrf.py` — the seam itself: `validate_provider_base_url`,
  `provider_httpx_clients`, and the `_is_provider_default` skip. Added by #14640.
- `src/lfx/src/lfx/utils/ssrf_httpx.py` — `validate_strict_url_for_ssrf_or_raise` and
  `ssrf_protected_strict_openai_clients_for_url`, the strict variants the provider seam uses in
  place of the ordinary connector ones.
- `src/lfx/src/lfx/services/settings/groups/security.py` — declares
  `connector_ssrf_validation_enabled`, `connector_ssrf_allow_loopback` and `ssrf_allowed_hosts`.
  The loopback default being `True` there, while a provider loopback URL is refused, is the
  asymmetry this file relies on.
- `src/bundles/openai/src/lfx_openai/components/openai/openai.py` and
  `src/bundles/anthropic/src/lfx_anthropic/components/anthropic/anthropic.py` — the two call sites
  under test, and the two field names.
- **Langflow API** — `GET /api/v1/auto_login`, `GET /api/v1/all` (the component template the flow is
  built from), `POST /api/v1/api_key/`, `POST /api/v1/flows/`, `POST /api/v1/run/{id}`,
  `DELETE /api/v1/flows/{id}`.
- **`ghcr.io/mccutchen/go-httpbin`** via `ECHO_BASE_URL`, for the admitted case only.
- **No provider key and no model**: a deliberately invalid key is sent, and the only successful
  network call in the file is to the echo container.
