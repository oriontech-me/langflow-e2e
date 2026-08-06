# Ollama provider — configure and execute a flow on the local instance

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §7.6 "Configure and execute flow with Ollama (local model)" as a
provider-centric journey, mirroring `openai-provider.spec.ts` /
`google-provider.spec.ts` for the one provider that is a LOCAL SERVICE rather
than a keyed cloud API:

1. **Configure** — Ollama appears in Settings → Model Providers; saving its
   base URL validates against the LIVE local instance (`validate-provider`
   2xx) and persists (variables save 2xx). Request-level asserts, same
   false-positive guard as the sibling specs: a no-op save cannot pass.
2. **Execute** — a canvas flow (Chat Input → **Ollama** component → Chat
   Output) pointed at the local instance lists the locally pulled model in
   its LIVE model dropdown (the component queries the instance — a
   deterministic connectivity proof, independent of Langflow's static Ollama
   catalog), selects it, and a Playground run returns a non-empty reply
   produced by that model. A per-run sentinel is sent and logged
   (soft, family pattern — small local models don't reliably echo).

**Build-side pre-flight (added for #931) — test 2 only.** Test 2 first asserts
that the running build actually EXPOSES the Ollama component, via
`isProviderComponentAvailable(request, "ollama")` (`GET /api/v1/all`). In
1.12 Langflow moved each component family into its own distribution:
`lfx.components.ollama` is now a `# lfx-bundles-shim` re-pointing at the
`lfx-ollama` package, and the shim's own docstring states it is *"removed
once the deprecation window closes (M4)"*. On the 07-23/07-24 nightlies
`lfx-ollama` was NOT in the image, the component vanished from the registry,
and test 2's `waitForSelector('[data-testid="ollamaOllama"]')` hard-failed
after 30 s with no indication of the cause (#931, spun out of #930).

Unlike the Groq/Mistral siblings — whose distributions are absent from the
image *by default*, so they `test.skip` (#1039) — `lfx-ollama` **ships in the
stock nightly**. Its absence is therefore an image-packaging regression that
must stay VISIBLE: this spec **fails** the pre-flight with an attributed
message instead of skipping, so a repeat reports "Ollama component not
exposed by this build (`lfx-ollama` not installed)" in ~1 s rather than an
unattributable 30 s selector timeout. A skip here would turn the regression
into a silent green nobody triages.

Test 1 is deliberately NOT gated on it: the Settings → Model Providers
surface is driven by the **provider catalog**
(`GET /api/v1/models/providers`), which is independent of the component
registry. Proof measured on 1.12.0.dev9 — `Groq` is listed there while the
Groq component bundle is absent from the image entirely. Gating test 1 on
component availability would redden a perfectly healthy surface, which is
exactly what happened on the 07-23/07-24 nightlies: the component was gone
and test 1 kept working.

Surface note (verified live on the 1.11 nightly): Langflow's Settings
catalog for Ollama is STATIC (`/api/v1/models?provider=Ollama` lists
llama3.3, qwq, …) and does not reflect what the local instance actually
serves — so the execution half drives the **Ollama component**, whose
`model_name` dropdown is refreshed from `base_url` live. This keeps every
assert deterministic and independent of catalog drift.

If this test fails, the Ollama provider path is broken: the base URL no
longer validates/persists, the component can't reach the local instance, or
a selected local model no longer executes.

---

## Tags *(required)*

Test 1: `@stable` `@model-provider` `@settings`
Test 2: `@regression` `@model-provider` `@components` `@playground`
— **`@stable` withheld again, see the #1302 gate below.**

`@stable` added after 4 clean `--retries=0` runs against the local Ollama
(issue #498's "Done when"). In environments without a local Ollama, both
tests `test.skip` with an explicit reason — the same missing-dependency skip
contract the keyed providers use for absent env keys. The daily-stable CI
does provide one (an `ollama` service container with `llama3.2:1b` baked in,
built by `build-ollama-image.yml`), so both tests really execute there.

**`@stable` history on test 2 — and why it is still withheld.** Auto-removed
at triage on 2026-07-24 (commit `4ee216d`, daily #930) when the missing
`lfx-ollama` distribution made the component unplaceable. That cause is gone:
on **1.12.0.dev9** the distribution is back and the spec runs 4/4 clean
`--retries=0` locally (13-20 s per run). The tag is **still not restored**,
because the daily's record shows a SECOND, independent failure mode that a
local run cannot reproduce:

| Daily | Attempts | Where it failed |
|---|---|---|
| 2026-07-15 | 3/3 failed, ~95-107 s each | Playground reply — `div-chat-message` never appeared within 60 s |
| 2026-07-22 | 3/3 failed | `ollamaOllama` 30 s (bundle); last attempt fell through to `sidebar-search-input` |
| 2026-07-23 / 07-24 | failed | `ollamaOllama` 30 s (bundle) |

07-15 reached the Playground with the component placed and the model
selected — what did not arrive was the model's answer. `llama3.2:1b` on CPU,
on a shared 2-core runner alongside the Langflow container and the rest of
the shard, is simply far slower than the ~13 s this spec takes locally. So a
local green says nothing about the daily, and `@stable` restored on local
evidence alone would predictably redden it again for an unrelated reason.

**Restoration gate for #1302 (the CURRENT one — the block below it is the
satisfied #931 gate, kept for the record).** `@stable` was removed again and
`test.fixme` added at triage on 2026-08-06 (#1296 → #1302). It is restored only
on evidence from the **real CI environment**, because the failure mode is a
flow-state race that a dev box cannot reproduce at all — worse than in #931's
case, since this spec now cannot even RUN locally on an arm64 Mac (see
*Preconditions → local reproduction*). The bar: a `manual.yml` dispatch on the
branch, `-f test_grep="Ollama"`, `-f retries=0`, green across several
consecutive runs, with the guard in place. A local green is not admissible
evidence here and neither is a single CI green — the mechanism fired on 2 of 26
dailies, so one run proves nothing about it.

**Restoration gate — SATISFIED (#931, historical).** The bar was a green sequence in the real CI
environment, not on a dev box, via `manual.yml` dispatched on the branch (it
carries the same `ollama` service container and SSRF allowlist):

```bash
gh workflow run manual.yml --repo oriontech-me/langflow-e2e \
  --ref <branch> -f langflow_target=latest -f langflow_image=nightly \
  -f test_grep="Ollama"
```

Result — **4 consecutive green runs**, each `Running 2 tests` → `2 passed`
(28.2 s, 29.2 s, 28.1 s, 23.8 s), with the sentinel line present, so the
playground genuinely answered: the step that failed 3/3 on 07-15. `@stable` is
restored on that evidence. A 5th run aborted before executing any test —
`globalSetup`'s credential pre-flight threw on a quota-drained `GOOGLE_API_KEY`
(#1058 / #976), a provider this spec never touches; it counts as neither pass
nor fail. **Expect that abort to cost this spec occasional days in the daily**
until #1058 is fixed.

The tag matters structurally, which is why this had to converge rather than be
dropped: `daily-stable.yml` runs `--grep @stable`, and `nightly.yml` (the only
full-suite workflow) is disabled — so while untagged, this test ran in **no**
recurring workflow at all.

**Residual known flake — it returned, and the fork this note named was the
right one (#1302).** The prediction stood: *"the root cause to chase is whether
the run starts at all versus the Ollama node failing to build"*. **The run never
starts.** It recurred on the 2026-07-30 and 2026-08-05 dailies with the same
signature, the spec was quarantined at triage (#1296), and the artifacts settle
it — see the *Why the run never starts* section below. What is NOT the cause is
the 180 s budget, which the issue's preliminary read proposed raising: the
budget is untouched here on purpose, and the measurements that justify leaving
it are recorded in that section.

**Model resolution — the image is the source of truth (#931).** The model the
CI exercises is BAKED into a dedicated image by
`.github/workflows/build-ollama-image.yml`
(`docker/ollama-e2e/Dockerfile`, `ARG OLLAMA_E2E_MODEL`), consumed as a service
container. That tag is currently pinned in **9 places** across the Dockerfile,
the build workflow, `nightly.yml`, `manual.yml`, `daily-stable.yml` and this
spec — and the Dockerfile itself documents the sync as manual ("update
`OLLAMA_E2E_MODEL` here AND `OLLAMA_TEST_MODEL` in the workflows/.env").

The spec's copy was the dangerous one: a hardcoded `?? "llama3.2:1b"` fallback.
If a workflow forgot to set `OLLAMA_TEST_MODEL`, or the baked model changed,
the probe would conclude *"model not pulled"* and the test would **skip
silently** — a skip nobody triages, on the very surface the spec exists to
guard. The fallback is gone: an unset `OLLAMA_TEST_MODEL` now means "use
whatever this instance actually serves", so the spec follows the image instead
of duplicating its choice. The CI workflows keep pinning the value explicitly,
so their executed path is unchanged.

**Run-completion signal (fixed for #931).** The old `waitForRunToFinish`
probed the Stop button with `isVisible({ timeout: 10000 })` and, when it did
not appear in time, skipped the wait entirely and fell straight into a 60 s
wait for the reply — which is exactly how a slow-starting CI run produces the
07-15 signature. It now waits on the deterministic pair **`button-stop`
hidden AND `button-send` visible**, with a window sized for CPU inference, so
a slow run is waited out instead of being mistaken for a finished one.

**Why the run never starts, and what guards it (#1302).** The failing attempt
waits 180 s for `div-chat-message` and sees 0 elements 183 times. Three
independent readings of the artifacts show that is not slowness:

| Evidence | Measurement |
|---|---|
| The retry, same run, same runner (07-30 / 08-05) | attempt 0 **180 445 / 180 482 ms failed**, attempt 1 **5 644 / 5 559 ms passed** |
| Green dailies, attempt 0 on a **freshly created** (therefore cold) Ollama container (08-04 / 08-03) | **5 408 / 6 503 ms passed** — there is no cold-start penalty |
| `div-chat-message` in the dev18 bundle | wraps `chat-message-${sender_name}-${index}` — it counts the **user's** bubble too, so 0 means the typed message never rendered |

The failure DOM says why: the Ollama node on the canvas has reverted to its
defaults — `Model Name` reads *"Select an option"* and `Ollama API URL` reads
`http://localhost:11434`, while the daily injects `http://ollama:11434`. The
model **was** selected and asserted one step earlier (that step passed in
1 059 ms). `Model Name` is required, so the run cannot start; consistently, the
token artifact holds one flow trace for two attempts and the failing attempt
logged zero backend errors in 191 s.

The mechanism is the one `helpers/flows/wait-for-flow-save-settled.ts`
documents: `PATCH /api/v1/flows/{id}` has no version check and the frontend
applies whichever response lands LAST, so a stale autosave overwrites the store
and the database (the root of #358, #357, #995). The spec already calls that
barrier; it guarantees PATCH quiescence for 700 ms and nothing about what
persisted. **Which write reverts it is not pinned** — a stale autosave and the
bulk `DELETE /api/v1/flows/` that appears mid-test under `actualWorkers: 2` are
both candidates, and the artifacts do not separate them.

**The guard reads the WIDGET, not the API, and that is measured rather than
conventional:** the run is dispatched as `POST /api/v2/workflows` with a
**66 801-byte body** — the frontend's in-memory graph, not a reference to the
persisted flow. A guard that queried `GET /api/v1/flows/{id}` could therefore
pass while the run executes the reverted state.

It does two things, in this order:

1. **Converge** — after selecting the model, wait for the node's configuration
   to hold (widget value stable, no flow-save PATCH in flight), re-applying the
   selection at most once. This is condition-based waiting on a known product
   race, not a blind retry of a failed interaction.
2. **Attribute** — immediately before `button-send`, assert the node still
   carries the model. If it does not, fail **there**, naming the revert and the
   two fields observed, in ~1 s instead of 180 s.

Step 2 does not mask the defect: a persistent revert still fails the test, just
quickly and with the cause named instead of as a bare `toHaveCount` timeout on a
locator three layers downstream.

**The 180 s budget is deliberately unchanged.** #1302's directive asks for a
measured replacement *if the budget is the cause*; it is not. Recorded so the
question is not reopened: the playground step costs **5 408 / 5 559 / 5 644 /
6 503 ms** across four dailies, cold and warm, and the run request itself
(`POST /api/v2/workflows`) took **4 063 ms**. Any budget above ~10 s is
equivalent for the healthy path, and for the broken path no budget works.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- A **local Ollama instance** with at least one pulled chat model:
  - `OLLAMA_BASE_URL` — reachability probe from the TEST host
    (default `http://localhost:11434`);
  - `OLLAMA_BASE_URL_FROM_LANGFLOW` — the URL typed INTO Langflow, i.e. how
    the Langflow container reaches the instance (default
    `http://host.docker.internal:11434` for the dockerized nightly);
  - `OLLAMA_TEST_MODEL` — the model to exercise. **Optional: when unset the
    spec derives it from the instance** (the first model `/api/tags` reports)
    and skips only when the instance has NO model at all. There is
    deliberately no hardcoded fallback tag — see *Model resolution* below.
  - Provisioning used for validation:
    `docker run -d --name ollama-e2e -p 11434:11434 ollama/ollama` +
    `docker exec ollama-e2e ollama pull llama3.2:1b`.
- **SSRF allowlist (dockerized Langflow):** the nightly's SSRF protection
  rejects `host.docker.internal` (private IP) with a 400 on the component's
  model-list fetch — start the Langflow container with
  `-e LANGFLOW_SSRF_ALLOWED_HOSTS=host.docker.internal` (discovered live on
  1.11.0.dev36 while authoring this spec).
- **Local reproduction is NOT possible on an arm64 Mac (measured 2026-08-06 on
  1.12.0.dev18)** — treat this spec as CI-only there and do not spend the cycle.
  A dockerized Langflow could not reach any Ollama in either topology (host
  instance via `host.docker.internal`; a sibling `ollama/ollama` container on a
  shared network with the CI's exact allowlist). Setting
  `LANGFLOW_SSRF_ALLOWED_HOSTS` makes it worse rather than better: **without**
  it the layer answers `resolves to blocked IP address(es)` (so the name
  resolved), **with** it the same name answers `DNS resolution failed` — for a
  name `getent` and `socket.getaddrinfo` resolve inside that same container.
  Independently: `validate_model_provider_key("Ollama", …)` called directly in
  that container validates and connects, while `POST
  /api/v1/models/validate-provider` with the same argument does not — the
  allowlist is honoured by the library and not by the endpoint. The escapes are
  closed too: the amd64 image dies with `Fatal glibc error: CPU does not support
  x86-64-v3`, and `start-langflow-pip.sh` installs the stable release, not the
  nightly line.
- If the probe fails, both tests skip with the reason — no false red.
- No collect-models / cloud key needed (local provider).
- **How CI satisfies all of the above** (`daily-stable.yml`): an `ollama`
  service container (`ollama-e2e:llama3.2-1b`, model pre-baked), the test job
  itself running inside `mcr.microsoft.com/playwright` so the service resolves
  by hostname — hence `OLLAMA_BASE_URL` and `OLLAMA_BASE_URL_FROM_LANGFLOW`
  are BOTH `http://ollama:11434` there — and `ollama` present in the Langflow
  service's `LANGFLOW_SSRF_ALLOWED_HOSTS`.

---

## Step by step *(required)*

**Test 1 — Ollama base URL is configured via Settings → Model Providers (§7.6 configure half)**

1. Probe `OLLAMA_BASE_URL` (`/api/tags`); skip with reason if unreachable.
   (No component pre-flight here — see Build-side pre-flight for why.)
2. Open Settings → Model Providers → provider item **Ollama**.
3. Fill the provider's base-URL field with `OLLAMA_BASE_URL_FROM_LANGFLOW`
   (real field scouted live — never invented).
4. Arm response waiters BEFORE clicking Save (validate-provider POST +
   variables save), click Save.
5. **Assert:** both requests resolve 2xx, **and** the validate-provider body
   reports `valid === true`. The body check is what proves the URL reached the
   live instance: the endpoint answers **HTTP 200 with `{"valid": false,
   "error": …}`** for a URL it could not reach (measured on 1.12.0.dev9 with
   the SSRF allowlist absent), so an HTTP-status-only assert is weak in
   isolation.

**Test 2 — the Ollama component lists the local model live and executes (§7.6 execute half)**

1. Build-side pre-flight assert + reachability probe/skip as above.
2. Open a blank flow; add **Chat Input**, **Ollama**, **Chat Output** from
   the sidebar; connect ChatInput → Ollama (input) and Ollama → ChatOutput.
3. On the Ollama node: set `base_url = OLLAMA_BASE_URL_FROM_LANGFLOW`,
   refresh/open the `model_name` dropdown.
4. **Assert (configure/connectivity):** the dropdown lists
   `OLLAMA_TEST_MODEL` — the component genuinely enumerated the local
   instance's models. Select it, then **wait for the selection to converge**
   (#1302): the widget still shows it with no flow-save PATCH in flight,
   re-applying at most once.
5. Open the Playground. **Immediately before sending, assert the Ollama node
   still carries the model** (#1302) — the run ships the frontend's in-memory
   graph, so a reverted node produces no message at all and the 180 s wait
   below would otherwise absorb it unattributed.
6. Send a per-run sentinel prompt, and wait for the run
   to COMPLETE on the deterministic signal — `button-stop` hidden **and**
   `button-send` visible — never on a short "did Stop appear?" probe.
7. **Assert (execute):** the AI reply is non-empty (hard); log whether the
   sentinel round-tripped (soft, family pattern — model obedience is not the
   contract).
8. No `allowFlowErrors`.

---

## Validation criterion *(required)*

Configure half: saving the Ollama base URL fires `validate-provider` and the
variables persistence, BOTH 2xx **and** the validate body reporting
`valid === true`, proving Langflow validated the URL against the live local
instance and stored it. Execute half: the Ollama component's
live model dropdown contains the locally pulled model (deterministic
connectivity proof), and a Playground run through that model returns a
non-empty AI reply — gated first on the build exposing the component at all,
so an absent `lfx-ollama` distribution fails immediately naming the cause. All asserts are request statuses, dropdown contents, and
reply presence — never model wording.

## Guarding against false positives *(how)*

- **Waiters armed before Save (test 1)** — the pass is caused by THIS save,
  not by a pre-existing configured state (family pattern).
- **Live dropdown assert (test 2)** — a broken base URL yields an empty /
  catalog-only dropdown and fails BEFORE any model runs; passing requires
  the component to have enumerated the real local instance.
- **Per-run sentinel** — logged (soft) to correlate the reply with THIS run;
  the hard assert is reply presence, immune to small-model obedience flake.
- **Skip ≠ pass** — missing local Ollama surfaces as an explicit skip with
  reason, never as a silent green.
- **Build-side pre-flight fails, never skips** — a missing `lfx-ollama`
  distribution is an image-packaging regression, so it must stay red and
  attributed (#931). Contrast with Groq/Mistral, absent by design ⇒ skip
  (#1039).
- **Pre-run configuration guard (#1302)** — a node that reverted to its
  defaults cannot produce any message, so without this the spec spends its
  whole 180 s budget on a locator that will never resolve and reports a
  `toHaveCount` timeout three layers away from the cause. The guard reads the
  widget, not the API, because the run ships the in-memory graph.
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 asserts the
  validate-provider body reports `valid === false` (inverted) ⇒ must fail;
  M2 — test 2 expects a never-pulled model name in the live dropdown ⇒ must
  fail; M3 — test 2 asserts the reply is empty (inverted) ⇒ must fail; M4 —
  the pre-flight probe token is changed to a family absent from the build
  (e.g. `groq`) ⇒ must fail on the attributed pre-flight message; **M5 (#1302)
  — the model selection is cleared right before the pre-run guard ⇒ the guard
  must fail there, naming the revert, NOT 180 s later on
  `div-chat-message`.** M5 is the one that proves the guard is load-bearing:
  without it the same mutation still fails the test, but as the unattributed
  timeout this issue was filed under.

  M1 was previously documented as "test 1 expects a **4xx** validate-provider
  (inverted)". That mutation could not fail as described: the endpoint answers
  **HTTP 200** with `{"valid": false}` for an unreachable URL, so `ok()` is
  true either way. Corrected above to mutate the body check. What actually
  reddened test 1 in that scenario was the *variables* persistence waiter
  timing out at 60 s (Langflow never persists a URL it could not validate) —
  verified live on 1.12.0.dev9 by running test 1 against a container without
  `LANGFLOW_SSRF_ALLOWED_HOSTS`: **1 failed in 1.1 min**. So the test was
  never a false positive, but it failed opaquely; the `valid === true` assert
  makes it fail fast and name the cause.

---

## What this test does not cover *(optional)*

- Agent-surface selection of Ollama models (the Agent's options come from
  Langflow's static catalog, which is independent of the local instance —
  asserting it would test the catalog, not the provider path).
- Ollama embeddings component; tool calling on local models.
- Model quality/wording (soft sentinel only).

---

## External dependencies *(required)*

- **Local Ollama instance** with `OLLAMA_TEST_MODEL` pulled (no cloud key,
  no external network) — see Preconditions for the provisioning commands and
  env vars; absent ⇒ explicit skip.
- **The `lfx-ollama` distribution present in the Langflow image** — it ships
  in the stock nightly, so absence is a packaging regression ⇒ attributed
  hard failure, not a skip. Migration watch for the M4 shim removal: #1040.
