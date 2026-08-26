# SSRF URL Validation — allow-list round trip

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates the **round trip of Langflow's SSRF guard on a URL-fetching component**: an address in a
blocked-by-default range is refused when `LANGFLOW_SSRF_ALLOWED_HOSTS` does not cover it, and is
**fetched normally when the allow-list does cover it** — and the refusal reaches the user as an
error, never as an empty result.

The guard lives in `lfx/utils/ssrf_protection.py` (`validate_and_resolve_url`) and the API Request
component calls it before every request, converting `SSRFProtectionError` into a build-time
`ValueError` prefixed `SSRF Protection:`. Only the *rejection* half of that mechanism is observable
anywhere in this suite today, and always as a side effect of something else:
`core-functionality/llm-agents/agent-tool-error-handling.spec.ts` uses an SSRF-blocked loopback
fetch as a deterministic *tool-error generator*, and `core-components/api-request-component-regression.spec.ts`
runs against `ECHO_BASE_URL` without ever asserting **why** that private address is reachable. The
allow-list itself — the mechanism `.github/actions/resolve-echo-endpoint` depends on for every lane
that self-hosts `go-httpbin` — is asserted nowhere. If a release silently stopped honouring it, the
whole suite would fail at once on an unrelated-looking symptom (echo specs timing out), and nothing
would name the cause.

The upstream regression this pins is `langflow-ai/langflow#14264` — *"New SSRF validation logic in
`ensure_url` ignores `LANGFLOW_SSRF_ALLOWED_HOSTS` for loopback addresses"*, reported on 1.10.2:
the guard was rewritten, the allow-list stopped being consulted, and every operator pointing a
component at a local service (LM Studio, Ollama, an internal API) lost it in a patch release. The
defect class is *"the allow-list is quietly ignored"*, and it is invisible to a suite that only ever
asserts the block.

Two directions are therefore asserted together, on the same instance, in the same component, with
the same configuration, differing **only in whether the address is covered by the allow-list**:

- **refused** — loopback (`127.0.0.1`) and the cloud-metadata address (`169.254.169.254`), neither
  of which any lane allow-lists;
- **admitted** — the private RFC-1918 address that `ECHO_BASE_URL` points at, which is inside a
  blocked-by-default range and is reachable **only** because a CIDR entry
  (`172.16.0.0/12,10.0.0.0/8,192.168.0.0/16`) admits it.

Asserting the refusal alone would keep passing on an instance where the allow-list was dropped
entirely; asserting the admission alone would keep passing on an instance where SSRF protection was
turned off. The pair is what carries the verdict.

Measured on the nightly `1.12.0.dev24` while designing this spec (probe containers, one allow-list
each, API Request run via `POST /api/v1/run/{id}`):

| `LANGFLOW_SSRF_ALLOWED_HOSTS` | `http://127.0.0.1:7860/…` | `http://172.17.0.2:7860/…` | `http://169.254.169.254/…` |
|---|---|---|---|
| *(unset)* | 500 `SSRF Protection:` | 500 `SSRF Protection:` | 500 `SSRF Protection:` |
| `172.16.0.0/12,10.0.0.0/8,192.168.0.0/16` | 500 `SSRF Protection:` | **200** | 500 `SSRF Protection:` |
| `172.17.0.2,127.0.0.1` | **200** | **200** | 500 `SSRF Protection:` |

The third row is `#14264`'s exact case and is **green on the nightly** — the allow-list *is* honoured
for loopback today. It is also the row this spec cannot assert on a shared lane; see *What this test
does not cover*.

---

## Tags *(required)*

Tests 1–3: `@stable` `@api` `@regression` · Test 4: `@stable` `@regression` `@components`

No **functional** tag applies — the tag table has no security area, and both sibling security specs
(`credential-secret-exposure.spec.ts`, `tweaks-injection.spec.ts`) carry cross-cutting tags only.
`@api` marks the layer for the three run-endpoint tests; `@components` marks Test 4, which drives the
API Request node on the canvas. `@regression` is the class: this pins a reported upstream defect.

`@stable` ships with the first delivery. The file needs no provider key and no LLM, the three API
tests are sub-second HTTP calls, and Test 4 is one blank flow with one node — nothing in it can fail
for a provider-outage reason. It is **not** `@destructive`: it creates and deletes only its own flows
and its own API key.

The four `QA-CHECKLIST.md` §17.1 bullets become `[x]`, with the loopback bullet's *"accepted when
present"* half satisfied by the private-address arm (Test 3) rather than by loopback itself — the
reason is recorded below and in the bullet.

---

## Step by step *(required)*

The spec runs **4 tests** in a serial describe. Tests 1–3 use the `request` fixture (no browser);
Test 4 uses the canvas. Every flow is created id-scoped and deleted in `afterEach`.

**Shared setup**

1. `getAuthToken(request)` → Bearer for flow creation/deletion.
2. `POST /api/v1/api_key/` in `beforeAll` → the key `POST /api/v1/run/{id}` authenticates with
   (`x-api-key`, not Bearer); deleted in `afterAll`.
3. `createApiRequestFlowViaApi(request, headers, { url })` (new helper) — reads the **live** catalog
   (`GET /api/v1/all`), takes the `APIRequest` component template from the `data_source` category,
   sets `template.url_input.value` to the URL under test and `template.method.value` to `GET`, and
   creates a single-node flow via `POST /api/v1/flows/`. Building the node from the running instance
   rather than a committed fixture is what makes an upstream rename of `url_input` fail here instead
   of silently testing an obsolete shape.

**Test 1 — a loopback address is refused, and the refusal names the allow-list** *(`@api`)*

1. Create the flow with `url_input = http://127.0.0.1:7860/api/v1/version` — an address that is live
   and would answer 200 if the request were made, so a failure cannot be "nothing listening".
2. `POST /api/v1/run/{id}` with `x-api-key` and `{ input_type: "text", output_type: "debug" }`.
3. Assert the call answered **500** and its `detail` matches `/SSRF Protection/` **and**
   `/LANGFLOW_SSRF_ALLOWED_HOSTS/` — the guard's own message, not a generic build failure.
4. Assert the response body carries **no** `"status_code": 200` and no `source` echo: the component
   produced no result at all, so nothing was fetched.

**Test 2 — a blocked address the allow-list does not cover is refused the same way** *(`@api`)*

1. Same flow shape, `url_input = http://169.254.169.254/latest/meta-data/` — the cloud-metadata
   endpoint, the canonical SSRF target, in a blocked range (`169.254.0.0/16`) that **no** lane
   allow-lists.
2. Run and assert the same two-part refusal as Test 1.
   This is the control for Test 3: a blocked-range address stays blocked on the very instance where
   Test 3's blocked-range address goes through, so Test 3's 200 can only come from the allow-list.

**Test 3 — an address inside a blocked range is admitted when a CIDR entry covers it** *(`@api`)*

1. **Precondition, asserted not assumed**, and resolved by the shared
   `tests/helpers/other/private-echo-endpoint.ts` rather than by logic local to this file:
   `ECHO_BASE_URL` is set and its host is a literal IPv4 in a blocked-by-default range (RFC-1918,
   loopback, link-local or CGNAT). If it is not — no echo service, or the lane fell back to a public
   host — the helper returns a `skipReason` naming the resolved value and the test `test.skip`s on
   it, because a public host proves nothing about the allow-list. The helper answers with the base
   URL only; the `/get` path is this spec's own.
2. Create the flow with `url_input = ${ECHO_BASE_URL}/get` and run it.
3. Assert **200**, and that the run output carries `status_code: 200` and `source` equal to the URL
   requested — the request really left the backend and came back.
4. Assert the run body contains no `SSRF Protection` string.
   Together with Test 2 on the same instance: same guard, same component, same blocked-address class,
   opposite verdicts — the difference is the CIDR entry.

**Test 4 — the refusal surfaces in the editor as an error, not a silent empty result** *(`@components`)*

1. `page.allowFlowErrors()` **and** `page.allowHttpErrors()` — the run is *meant* to fail, and the
   fixture's advisory backend-error log stays trustworthy only if a deliberate 5xx is declared.
2. Create the same loopback flow with `createApiRequestFlowViaApi`, then `openFlowById(page, id)`.
   The node is **not** added through the sidebar: the sidebar add silently drops the click under
   contention (#1301 and its three sibling surfaces), and this test is about the error surface, not
   about component insertion — which `api-request-component-regression.spec.ts` already covers.
3. Click `button_run_api request`.
4. Assert the in-canvas build-failure banner is visible and names the cause: the header
   (`/flow build failed|error building component/i` — both spellings, volatile across versions, as
   the sibling spec documents) **and** the SSRF detail (`/SSRF Protection/`). Measured on
   1.12.0.dev23 the banner reads *"Flow build failed · 0.2s · Retry · Dismiss · SSRF Protection:
   Hostname 127.0.0.1 resolves to blocked IP address(es) …"*. It carries **no `data-testid`** — the
   assertion is by text, which is why the helper must not put the token `SSRF` in the flow **name**
   (the name renders in `flow_name` and would satisfy the detail match on its own).
5. Assert the node produced no output: the output-inspection button
   (`output-inspection-api response-apirequest`) stays disabled — an error, not an empty success.

---

## Validation criterion *(required)*

- **Test 1:** `POST /api/v1/run/{id}` answers `500`; `detail` matches `/SSRF Protection/` and
  `/LANGFLOW_SSRF_ALLOWED_HOSTS/`; the body carries no fetched response.
- **Test 2:** identical verdict for `169.254.169.254`.
- **Test 3:** the same endpoint answers `200` for the allow-listed private address, the output
  reports `status_code: 200` with the requested URL as `source`, and no `SSRF Protection` string
  appears — or the test skips, naming the resolved `ECHO_BASE_URL` that made it inapplicable.
- **Test 4:** the flow editor renders a visible error whose text names SSRF protection.
- Across the file: **Tests 2 and 3 disagree on the same instance**, which is the round trip. Every
  flow created is deleted in `afterEach`; `GET /api/v1/flows/` returns the same count before and
  after the file runs.

---

## What this test does not cover *(optional)*

- **Loopback *admitted* by an allow-list entry** — `#14264`'s literal reproduction (row 3 of the
  table above). It is measured as working on 1.12.0.dev24 but cannot be asserted on a shared lane:
  admitting `127.0.0.1` there would let the instance under test call itself, and it would break
  `core-functionality/llm-agents/agent-tool-error-handling.spec.ts`, whose deterministic error
  generator *is* a loopback fetch being SSRF-blocked (allow-listing the literal IP also allow-lists
  the hostname path, since `is_host_allowed` matches the resolved IP). Test 3 asserts the same
  half of the round trip through a private address instead, which is the address class our lanes
  actually allow-list and the one `resolve-echo-endpoint` depends on.
- **The stable `langflowai/langflow:latest` line.** A probe container on the stable 1.12.0 image
  refused an *exact-IP* allow-list entry (`172.17.0.2,127.0.0.1`) that the nightly honoured. That
  observation was made mid-scout on a container whose provenance was later found ambiguous, so it is
  recorded here as an **open question, not a finding** — the suite targets the nightly, and
  re-measuring it deserves its own issue.
- **DNS-rebinding / redirect re-validation.** `api_request.py` re-validates each `Location` hop and
  pins the resolved IP; both are real surfaces and neither is a §17.1 bullet.
- **Other URL-fetching components** (URL, Web Search, RSS, and the connector paths with their own
  loopback exemptions — `connector_ssrf_allow_loopback`). The bullets name the API Request component;
  the connector policy is a different guard with different defaults and deserves its own spec.
- **`LANGFLOW_SSRF_PROTECTION_ENABLED=false`** (the global off switch). Turning the guard off on a
  shared instance would disarm it for every other spec in the run.
- **Wildcard allow-list entries** (`*.example.com`) — supported by `is_host_allowed`, not part of
  the bullets, and not used by any lane.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`; superuser credentials for
  `getAuthToken`; API-key creation allowed (`POST /api/v1/api_key/`).
- **Tests 1, 2 and 4 need no allow-list at all** — loopback and the metadata address are refused
  whether or not `LANGFLOW_SSRF_ALLOWED_HOSTS` is set (rows 1 and 2 of the table), so they run
  unchanged on a stock local instance and on every CI lane.
- **Test 3 needs the lane's allow-list and a private echo endpoint.** Every CI lane already has
  both: `LANGFLOW_SSRF_ALLOWED_HOSTS="…172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"` on the Langflow
  service and `ECHO_BASE_URL` resolved to the `go-httpbin` container IP by
  `.github/actions/resolve-echo-endpoint`. Locally, `scripts/start-langflow-docker.sh` sets **no**
  allow-list today, so the test skips unless the instance is started with one:

  ```bash
  # local equivalent of a CI lane
  docker run -d --name go-httpbin ghcr.io/mccutchen/go-httpbin
  ECHO_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' go-httpbin)
  LANGFLOW_SSRF_ALLOWED_HOSTS="172.16.0.0/12,10.0.0.0/8,192.168.0.0/16" \
    ./scripts/start-langflow-docker.sh
  ECHO_BASE_URL="http://${ECHO_IP}:8080" npx playwright test \
    tests/tests-automations/regression/security/ssrf-url-validation.spec.ts --workers=1 --retries=0
  ```

  This spec therefore proposes adding the same default to `scripts/start-langflow-docker.sh` (and
  the pip script), for the same reason `LANGFLOW_ALLOW_CUSTOM_COMPONENTS` and `LANGFLOW_A2A_ENABLED`
  are set there (#668/#1240): a local instance that differs from every CI lane makes a lane-green
  test locally inapplicable, and the divergence is silent. The change is additive — with no echo
  container `ECHO_BASE_URL` stays unset and Test 3 skips exactly as it does today.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`.
- `tests/helpers/flows/create-api-request-flow-via-api.ts` (new) — builds the single-node API Request
  flow from the live catalog; owns the `url_input` / `method` field shape.
- `tests/helpers/flows/delete-flow.ts` — id-scoped teardown.
- `tests/helpers/flows/open-flow-by-id.ts` — Test 4's canvas entry (`canvas_controls_dropdown` +
  writability gate), avoiding the sidebar-add race.
- `tests/helpers/other/private-echo-endpoint.ts` — the canonical `ECHO_BASE_URL` guard
  (`isBlockedRangeIpv4` + `privateEchoUrl`): decides whether the resolved endpoint is an address
  Langflow blocks by default, and returns the skip reason when it is not. Shared with
  `security/model-provider-base-url-ssrf.spec.ts`, which asserts the same non-vacuity control
  through the provider seam.
- `ECHO_BASE_URL` — resolved per lane by `.github/actions/resolve-echo-endpoint`
  (`scripts/resolve-echo-endpoint.mjs`); Test 3 reads it through the helper above and skips when it
  is not a private IP.
- `src/lfx/src/lfx/utils/ssrf_protection.py` — `validate_and_resolve_url`, `is_host_allowed`,
  `get_allowed_hosts`, `is_ip_blocked` and the blocked-range table: the code under test.
- `src/lfx/src/lfx/components/data_source/api_request.py` — calls `validate_and_resolve_url` and
  wraps `SSRFProtectionError` into `ValueError("SSRF Protection: …")`, the string both the run
  endpoint and the UI surface.
- `src/lfx/src/lfx/utils/ssrf_transport.py` — the DNS-pinned client the component builds from the
  validated IPs.
- `src/lfx/src/lfx/services/settings/groups/security.py` — `ssrf_protection_enabled`,
  `ssrf_allowed_hosts` and the connector-specific flags that make the connector paths behave
  differently from this one.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`, the surface Tests
  1–3 read the verdict from.
- Upstream reference: `langflow-ai/langflow#14264`.
