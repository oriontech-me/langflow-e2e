# Ollama provider — configure and execute a flow on the local instance

**Last validated:** Langflow 1.11.x

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
Test 2: `@stable` `@regression` `@model-provider` `@components` `@playground`

`@stable` added after 4 clean `--retries=0` runs against the local Ollama
(issue #498's "Done when"). In environments without a local Ollama (e.g. the
daily-stable CI), both tests `test.skip` with an explicit reason — the same
missing-dependency skip contract the keyed providers use for absent env keys.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- A **local Ollama instance** with at least one pulled chat model:
  - `OLLAMA_BASE_URL` — reachability probe from the TEST host
    (default `http://localhost:11434`);
  - `OLLAMA_BASE_URL_FROM_LANGFLOW` — the URL typed INTO Langflow, i.e. how
    the Langflow container reaches the instance (default
    `http://host.docker.internal:11434` for the dockerized nightly);
  - `OLLAMA_TEST_MODEL` — the pulled model (default `llama3.2:1b`).
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

---

## Step by step *(required)*

**Test 1 — Ollama base URL is configured via Settings → Model Providers (§7.6 configure half)**

1. Probe `OLLAMA_BASE_URL` (`/api/tags`); skip with reason if unreachable.
2. Open Settings → Model Providers → provider item **Ollama**.
3. Fill the provider's base-URL field with `OLLAMA_BASE_URL_FROM_LANGFLOW`
   (real field scouted live — never invented).
4. Arm response waiters BEFORE clicking Save (validate-provider POST +
   variables save), click Save.
5. **Assert:** both requests resolve 2xx — the URL authenticated against the
   LIVE local instance and was persisted.

**Test 2 — the Ollama component lists the local model live and executes (§7.6 execute half)**

1. Probe + skip as above.
2. Open a blank flow; add **Chat Input**, **Ollama**, **Chat Output** from
   the sidebar; connect ChatInput → Ollama (input) and Ollama → ChatOutput.
3. On the Ollama node: set `base_url = OLLAMA_BASE_URL_FROM_LANGFLOW`,
   refresh/open the `model_name` dropdown.
4. **Assert (configure/connectivity):** the dropdown lists
   `OLLAMA_TEST_MODEL` — the component genuinely enumerated the local
   instance's models. Select it.
5. Open the Playground, send a per-run sentinel prompt, wait for the run.
6. **Assert (execute):** the AI reply is non-empty (hard); log whether the
   sentinel round-tripped (soft, family pattern — model obedience is not the
   contract).
7. No `allowFlowErrors`.

---

## Validation criterion *(required)*

Configure half: saving the Ollama base URL fires `validate-provider` and the
variables persistence, BOTH 2xx, proving Langflow validated the URL against
the live local instance and stored it. Execute half: the Ollama component's
live model dropdown contains the locally pulled model (deterministic
connectivity proof), and a Playground run through that model returns a
non-empty AI reply. All asserts are request statuses, dropdown contents, and
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
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 expects a 4xx
  validate-provider (inverted) ⇒ must fail; M2 — test 2 expects a
  never-pulled model name in the live dropdown ⇒ must fail; M3 — test 2
  asserts the reply is empty (inverted) ⇒ must fail.

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
