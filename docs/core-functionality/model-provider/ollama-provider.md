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
— `@stable` **withheld pending CI proof**, see the history below.

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

**Restoration gate:** the tag goes back only after the spec passes in the
real CI environment, proven by dispatching `manual.yml` on the branch (it
carries the same `ollama` service container and SSRF allowlist):

```bash
gh workflow run manual.yml --repo oriontech-me/langflow-e2e \
  --ref <branch> -f langflow_target=latest -f langflow_image=nightly \
  -f test_grep="Ollama"
```

The tag matters structurally, which is why this must converge rather than be
dropped: `daily-stable.yml` runs `--grep @stable`, and `nightly.yml` (the only
full-suite workflow) is disabled — so while untagged, this test runs in **no**
recurring workflow at all.

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
   instance's models. Select it.
5. Open the Playground, send a per-run sentinel prompt, and wait for the run
   to COMPLETE on the deterministic signal — `button-stop` hidden **and**
   `button-send` visible — never on a short "did Stop appear?" probe.
6. **Assert (execute):** the AI reply is non-empty (hard); log whether the
   sentinel round-tripped (soft, family pattern — model obedience is not the
   contract).
7. No `allowFlowErrors`.

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
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 asserts the
  validate-provider body reports `valid === false` (inverted) ⇒ must fail;
  M2 — test 2 expects a never-pulled model name in the live dropdown ⇒ must
  fail; M3 — test 2 asserts the reply is empty (inverted) ⇒ must fail; M4 —
  the pre-flight probe token is changed to a family absent from the build
  (e.g. `groq`) ⇒ must fail on the attributed pre-flight message.

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
