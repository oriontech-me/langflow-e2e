# Langflow Assistant — a local Ollama provider opens the Assistant and supplies its models

**Last validated:** Langflow 1.13.x

---

## What this test validates *(required)*

The **Langflow Assistant** is the canvas panel whose whole entry condition is
model-provider configuration (#1810). Until this spec, the suite asserted none of it.
This spec covers that gate with **one real, keyless provider: a local Ollama
instance**. Choosing Ollama means:

- **No key to break.** No API key, no token spend, and no dependence on an account
  that can drain (#772 and #1450 openai, #1029 google, #1169 anthropic).
- **An observable no static catalog can fake.** Ollama is a **live** provider in the
  Assistant. `check-config` builds the Ollama entry from the models **installed on the
  instance**: `list_installed_tool_calling_models` calls `fetch_live_ollama_models`,
  which reads `/api/tags` and keeps the tags whose `/api/show` capabilities include
  `completion`. A locally installed tag (`llama3.2:1b` in CI) can only reach the
  Assistant through a working configuration. The provider playbook calls this the
  connectivity proof: the live list contains something the static fallback cannot.

The Assistant has **two independent surfaces**, and this spec asserts each against its
own source:

| Surface | What feeds it | Test |
|---|---|---|
| API contract | `GET /api/v1/agentic/check-config`, the ungated probe | 1 |
| UI gate | `GET /api/v1/models?flow_id=<id>&purpose=use` and `GET /api/v1/models/enabled_models?flow_id=<id>&purpose=use`, joined in `useEnabledModels` | 2 |

The frontend **never calls `check-config`** (measured on `1.13.0.dev12`: zero calls
from app boot through opening the panel). A pass on one surface says nothing about the
other.

**Test 1 — the API contract.** Once Ollama is configured, `check-config` returns:

- an `Ollama` provider entry whose models are exactly what the instance serves;
- no embedding-only tag in that entry;
- a `default_model` taken from that list;
- `default_provider` and `default_model` fields consistent with the rest of the
  response.

"Exactly what the instance serves" is checked against an oracle **outside Langflow**:
the Ollama API, called from the test host.

**Test 2 — the UI gate.** On a canvas:

- The Assistant panel renders its **composer**, not the no-models or disabled state.
- The model selector's `Ollama` group lists exactly the Ollama LLMs Langflow reports
  enabled for that flow, including the local test model.
- Selecting that model arms **Send** once a draft exists.
- The weak-model hint is shown for a small local model.

The spec never sends: the live assist run stays out of scope (see *What this test does
not cover*).

**If this spec fails:**

- **Test 1:** the Assistant's provider contract lost the live Ollama enumeration. It
  fell back to the static catalog, dropped the provider, admitted embedding models, or
  broke `default_provider` / `default_model`.
- **Test 2:** a configured Ollama no longer reaches the Assistant's composer, or the
  selector disagrees with Langflow's own enabled-model state.

**Scope note — #1810 is only partly delivered here.** The user scoped this work to the
Ollama-driven, real-backend spec. The issue's **mocked** half stays open:

- the keyless `check-config` contract on an unconfigured instance;
- the no-models state and its CTA;
- the feature gate outranking a configured provider;
- the narrowing of the `/api/v1/agentic/` exclusion in
  `tests/assets/api/api-surface-baseline.json`.

That half needs route interception, not a live provider, and belongs to its own spec.

---

## Tags *(required)*

- **Test 1:** `@stable` `@api` `@model-provider`
- **Test 2:** `@stable` `@model-provider`

`@stable` ships in this PR, on the evidence recorded in the PR's Validation block. The
tag only has effect where an Ollama is present:

- **`daily-stable.yml`** runs an `ollama` service (`ollama-e2e:llama3.2-1b`, model baked
  in), so both tests really execute there.
- **`manual.yml`** runs the same service.
- **`pr-validation.yml`** starts no Ollama, so both tests **skip with an explicit
  reason**. This is the missing-dependency contract `ollama-provider.spec.ts` already
  follows. A skip here never reads as a pass.

No `@agents`: nothing is executed through an agent. No provider rotation: the spec never
reads `models.json` or `providerSkipGate`, so the daily's weekday rotation (#1185) does
not apply.

---

## Preconditions *(optional)*

- **Langflow nightly** at `PLAYWRIGHT_BASE_URL`.
  - `LANGFLOW_AGENTIC_EXPERIENCE` left at its default (`True`).
  - `LANGFLOW_SSRF_ALLOWED_HOSTS` covering the Ollama address, since Langflow validates
    the base URL server-side:
    - **CI:** `ollama` plus the RFC-1918 CIDRs.
    - **Local dockerized instance:** the RFC-1918 CIDRs for `host.docker.internal`,
      the value `scripts/start-langflow-docker.sh` sets.
- **A local Ollama** with at least one completion-capable model. The spec uses the same
  three variables as `ollama-provider.spec.ts`, read through
  `tests/helpers/provider-setup/ollama-endpoint.ts`:
  - `OLLAMA_BASE_URL` — reachability and oracle calls from the **test host**
    (default `http://localhost:11434`).
  - `OLLAMA_BASE_URL_FROM_LANGFLOW` — the address **Langflow** is given
    (default `http://host.docker.internal:11434`).
  - `OLLAMA_TEST_MODEL` — optional. CI pins `llama3.2:1b`. When unset, the spec uses
    the first tag, in the instance's order, whose capabilities include both
    `completion` and `tools`, and only then the first plain completion tag. A
    tool-capable tag is listed by the Assistant whether or not upstream ever makes its
    tool-calling filter real for Ollama. A pinned model is never substituted: if the
    instance does not serve it as a completion model, the spec skips and names what the
    instance does serve. It never falls back to a hardcoded tag.
- **No cloud key**, and `collect-models` is not needed.
- **Local reproduction on an arm64 Mac works again on `1.13.0.dev12`** (measured
  2026-09-14). The setup was a dockerized nightly plus the native Homebrew Ollama
  serving `qwen2.5:0.5b`:
  - `validate-provider` on `http://host.docker.internal:11434` answered
    `{"valid": true}`;
  - the live catalog listed the installed tags.

  This contradicts the *"not possible on an arm64 Mac"* note in `ollama-provider.md`,
  which was measured on `1.12.0.dev18`.

---

## Step by step *(required)*

### Test 1 — `check-config` lists exactly the completion models the local Ollama instance serves

1. **Oracle.** From the test host, call `GET {OLLAMA_BASE_URL}/api/tags`, then
   `POST {OLLAMA_BASE_URL}/api/show` for every tag. Build three sets from the
   `capabilities` arrays:
   - **completion** — the capabilities include `completion`;
   - **completion + tools** — they include both;
   - **embedding-only** — they include `embedding` and not `completion`.

   Resolve the test model. **Skip with the reason** when any of these holds:
   - the instance is unreachable;
   - it serves no completion-capable tag;
   - the pinned `OLLAMA_TEST_MODEL` is absent or not completion-capable.
2. **Configure Ollama through the API.** These are the calls the Settings save issues,
   plus explicit enablement:
   - The `Global` variable `OLLAMA_BASE_URL` is set to `OLLAMA_BASE_URL_FROM_LANGFLOW`:
     created when absent, patched when it holds another address. Langflow validates
     that write server-side.
   - The test model is enabled with `POST /api/v1/models/enabled_models`. Only the
     first five live tags are enabled by default.

   If Langflow rejects the address, the test **fails** (it does not skip) and names the
   rejection. An Ollama the test host reaches but Langflow cannot is a lane
   misconfiguration, typically the SSRF allowlist.
3. **Read the contract.** Call `GET /api/v1/agentic/check-config`, polled for up to
   30 s until `configured_providers` names `Ollama`. This bounded wait exists for a
   concurrent reset of the shared variable (see *Cross-spec hazard*). On timeout, the
   failure reports whether `OLLAMA_BASE_URL` exists at that moment.
4. **Assert.**
   1. `enabled === true`. The message names `LANGFLOW_AGENTIC_EXPERIENCE`: a flipped
      default would remove the Assistant from every default deployment.
   2. `configured === true`, and `configured_providers` contains `Ollama`.
   3. `providers` holds **exactly one** entry named `Ollama`, with `configured === true`.
   4. That entry's model names, taken as a set, satisfy
      **completion + tools ⊆ models ⊆ completion**. In both CI and on the dev box every
      completion tag also has `tools`, so this is set equality in practice. The reason
      for the two bounds is under *Guarding against false positives*.
   5. Every model has `display_name === name`, and no embedding-only tag appears.
   6. The entry's `default_model` is one of its model names.
   7. **Internal agreement.**
      - `default_provider` is one of `providers[].name`.
      - `default_model` equals that provider entry's `default_model`.
      - When `providers` holds only the Ollama entry, `default_provider === "Ollama"`.
        Ollama is not in `PREFERRED_PROVIDERS`, so this exercises the `providers[0]`
        fallback. On a lane where `collect-models` configured other providers, this
        clause does not apply. The condition is read from the same response, never from
        the environment.

### Test 2 — the Assistant composer offers the local Ollama model and arms Send for it

1. **Oracle and configuration** as in Test 1, steps 1–2.
2. **Create an empty flow** through the API, with a unique name. Its id is recorded for
   teardown. The panel's catalog queries are flow-scoped
   (`enabled: Boolean(currentFlowId)`), so a flow is required.
3. **Open the flow by id** with `openFlowById`:
   - the assistant-onboarding tooltip is suppressed before the load (#1220);
   - the canvas is rendered and the flow is writable before any interaction.
4. **Open the Assistant.** Click `assistant-button`, then wait for the panel
   (`assistant-panel`) to reach a terminal state:
   - **composer** — `assistant-input-textarea` is **enabled**;
   - **no-models** — `assistant-no-models-configure-providers`;
   - **disabled** — `assistant-disabled-state`.

   Assert the composer. The textarea is disabled while the catalog loads
   (`disabled={!isCatalogReady || !hasEnabledModels}`), so "enabled" is the
   catalog-ready signal.
5. **Read the selector.** Click `assistant-model-selector`, then read the menu grouped
   by its provider labels. The model items have no testid and are read by role
   (`menuitem`). Assert:
   1. an `Ollama` group exists;
   2. its items, as a set, equal **Langflow's enabled Ollama LLMs for that flow**,
      computed from the same two reads the panel makes:
      - the provider list's `Ollama` entry has `is_enabled`;
      - each model in it has `metadata.model_type === "llm"`;
      - the model is enabled in `enabled_models_by_type.Ollama.llm`, or in the flat
        `enabled_models.Ollama` map when there is no typed map
        (`isModelEnabledForType`);
   3. every item is completion-capable per the oracle;
   4. the set contains the test model.
6. **Select the model.** Click the test model's `menuitem` (exact name). Assert the
   `assistant-model-selector` trigger now reads that model name.
7. **Send arms on a draft.**
   - With an empty draft, `assistant-send-button` is **disabled**.
   - Type a short draft into `assistant-input-textarea`.
   - `assistant-send-button` is now **enabled**. The Send gate is
     `message.trim() && isCatalogReady && isModelEnabled(selectedModel)`.

   Nothing is sent.
8. **Weak-model hint.**
   - When the test model's tag declares a parameter count of at most 13B (`:1b`,
     `:0.5b`, `:7b`, …), assert `assistant-model-weak-hint` is visible. Both the CI tag
     `llama3.2:1b` and the dev-box tag `qwen2.5:0.5b` take this branch.
   - For any other tag, record the hint's visibility as a test annotation without
     asserting. The spec does not re-implement the whole `classifyModelStrength`
     heuristic.
9. **Teardown** deletes the flow by id.

---

## Validation criterion *(required)*

**Test 1** passes when `check-config` meets all of the following:

- `enabled` is true.
- `configured_providers` names `Ollama`.
- `providers` holds exactly one `Ollama` entry.
- That entry's model names lie between the instance's completion + tools tags and its
  completion tags. Both sets come from Ollama's own `/api/show`, called from the test
  host.
- No embedding-only tag appears in the entry, and its `default_model` is one of its
  models.
- `default_provider` and `default_model` agree with the `providers` entries.

**Test 2** passes when, in the Assistant panel on a real flow:

- the composer renders, with the textarea enabled;
- the selector's `Ollama` group equals Langflow's enabled Ollama LLMs for that flow and
  contains the local test model;
- selecting that model turns `assistant-send-button` from disabled (empty draft) to
  enabled (typed draft);
- `assistant-model-weak-hint` is visible for a tag of 13B or less.

Every assert rests on request bodies, the Ollama API, and DOM state. None depends on
model output.

## Guarding against false positives *(how)*

- **The oracle is outside Langflow.** Test 1 compares `check-config` with Ollama's own
  `/api/tags` and `/api/show`, not with another Langflow endpoint. If the live fetch
  fails, `check_assistant_config` keeps the provider's **static** catalog names instead
  (for Ollama, `llama3.3`, `qwq`, …). Those are not installed tags, so they violate
  *models ⊆ completion*.
- **Why two bounds and not strict equality.** For Ollama, `fetch_live_ollama_models`
  sets `tool_calling = model_type == "llm"`, so every completion tag counts as
  tool-calling. The Assistant's "tool-calling models only" filter is therefore a no-op
  for Ollama (read from source on `1.13.0.dev12`, not measured).
  - Strict equality with the completion set would encode that no-op, and a legitimate
    upstream fix would redden the spec.
  - Equality with the completion + tools set would redden it today, on an instance
    that serves a completion model without `tools`.
  - The two bounds accept both behaviours. They still catch a static-catalog fallback,
    a dropped installed model, and an admitted embedding model.
- **The exclusion half is real where it can be.** An embedding-only tag must be absent
  from the entry. The dev box exercises this with two embedding tags. The CI image bakes
  only `llama3.2:1b`, so this check has nothing to exclude there.
- **The UI oracle is the panel's own inputs.** Test 2 compares the rendered menu with
  the two reads `useEnabledModels` joins, issued with the same `flow_id` and
  `purpose=use`. A selector that renders a stale or unrelated list cannot pass.
- **Send is checked disabled, then enabled.** Asserting only "enabled" would pass on a
  control that never gates at all.
- **Ollama is shown to be the cause, even beside other providers.** In CI,
  `collect-models` configures keyed providers, so the composer would render without
  Ollama. The Ollama-specific proof is that the locally installed tag appears under the
  `Ollama` label and arms Send. No static catalog contains that tag.
- **The terminal-state wait polls the three states** (`expect.poll` over
  `isVisible()`). It never races or uses `or().first()` (#599).
- **Skip is not pass.** A missing Ollama is an explicit skip with its reason. A Langflow
  that cannot reach a host-reachable Ollama is a **failure** that names the rejection.
- **Force-failure checks** (CONTRIBUTING §2):
  - **M1 (T1)** — add a never-installed tag to the oracle's completion + tools set.
    The lower bound must fail.
  - **M2 (T1)** — assert the entry holds an embedding-only tag. The exclusion must fail.
  - **M3 (T1)** — skip the configuration step on an instance where `OLLAMA_BASE_URL`
    was deleted first. The poll must time out with an attributed message.
  - **M4 (T2)** — expect a never-installed tag in the `Ollama` group. The set equality
    must fail.
  - **M5 (T2)** — assert `assistant-send-button` is enabled **before** typing. It must
    fail, proving the disabled-to-enabled pair has bite.
  - **M6 (T2)** — invert the weak-hint assert. It must fail.
  - **M7 (cleanup)** — no-op the flow delete. The run stays green but the flow survives
    (`GET /api/v1/flows/`). Revert, and the orphan count is back to 0.

## Cross-spec hazard — the shared `OLLAMA_BASE_URL` variable

`ollama-provider.spec.ts` Test 1 **deletes** the same `Global` variable, then re-saves
it through the Settings UI. The reset is deliberate: with the value pre-filled, Save
stays disabled and its request asserts could never fire.

On the daily, two spec files on one shard can run concurrently (`workers: 2`). If this
spec reads while that variable is absent, `check-config` drops Ollama, or the panel
boots without it. This spec does not work around that silently:

- Each test **ensures** the variable immediately before its reads (step 2).
- Test 1's read is a **bounded 30 s poll** for `Ollama` to appear. The other spec
  re-saves within seconds, and a genuinely missing provider still fails after the
  bound.
- **Every poll interval stays under 2 s**, and this is measured, not stylistic. The
  backend closes an idle keep-alive connection at about 2 s. A request that reuses the
  socket at that instant dies with `socket hang up`.
  - Measured on `1.13.0.dev12`: alternate reads at exactly 2000 ms threw; reads at
    1500 ms and 3000 ms never did.
  - `expect.poll` does not retry a callback that throws. At the first draft's
    500 / 1000 / 2000 ms cadence, force-fail M3 therefore ended after 5 s on a
    transport error instead of the 30 s timeout it was built to prove.
- Every miss is **attributed**: the failure states whether `OLLAMA_BASE_URL` existed
  at the moment of the read.
- No UI interaction is retried.

Also relevant: Langflow caches an Ollama model list for **30 s** per base URL
(`_OLLAMA_MODEL_LIST_TTL_SECONDS`). A tag pulled or removed mid-run can therefore
disagree with the oracle for up to 30 s. The lanes never do that.

---

## Cleanup *(required by the repo's flow-cleanup rule)*

- **Test 2's flow** is deleted by id in teardown (`deleteFlow`), whether the test passes
  or fails.
- **`OLLAMA_BASE_URL` is deliberately left configured**, with the test model enabled.
  It is instance-level provider configuration that `ollama-provider.spec.ts` also leaves
  in place. Deleting it would open the hazard above for every other Ollama consumer.
- The selector choice is stored in the browser context's `localStorage`
  (`langflow-assistant-selected-model`) and is discarded with the context.

---

## What this test does not cover *(optional)*

- **The live assist run** (`POST /api/v1/agentic/assist*`). Its outcome depends on the
  model, and the backend's own `is_probably_small_model` states that models of 13B or
  less emit no native tool calls under the Assistant prompt. A `llama3.2:1b` run would
  assert nothing reliable.
- **The mocked branches**, which remain in #1810: the unconfigured `check-config`
  contract, the no-models state and its CTA, and the feature gate outranking a
  configured provider.
- **Removing** Ollama's configuration and watching the Assistant drop it. That needs
  deleting the shared variable (see the hazard above).
- **Governance filtering** of the Assistant's provider list (`@governance @destructive`).
- **The backend `404`s** under `LANGFLOW_AGENTIC_EXPERIENCE=false`, which need a
  container variant.
- **The `0/2000` character counter**, an Assistant limit rather than a provider
  behaviour.

---

## External dependencies *(required)*

**Runtime**

- **A local Ollama service** (`ollama/ollama` 0.32.x; CI image
  `ghcr.io/<repo>/ollama-e2e:llama3.2-1b`). Its `/api/show` must return `capabilities`.
  When the service is absent, both tests skip with the reason.
- **`LANGFLOW_SSRF_ALLOWED_HOSTS`** on the Langflow container, covering the Ollama
  address.

**Upstream code**

- `src/backend/base/langflow/agentic/api/router.py`:
  - `check_assistant_config` — the ungated probe, its `providers` loop and the
    `PREFERRED_PROVIDERS` / `providers[0]` default choice;
  - `require_agentic_experience`.
- `src/backend/base/langflow/agentic/services/provider_service.py`:
  - `get_enabled_providers_for_user` — a keyless provider counts as configured through
    its non-secret variable;
  - `list_installed_tool_calling_models`;
  - `build_live_only_provider_entries`;
  - `PREFERRED_PROVIDERS`.
- `src/lfx/src/lfx/base/models/model_utils.py`:
  - `fetch_live_ollama_models` (`tool_calling` set for every LLM tag);
  - `get_ollama_models` — `/api/tags` plus `/api/show`, the `completion` filter, and
    the 30 s list / 600 s capability caches;
  - `MIN_DEFAULT_MODELS`.
- `src/frontend/src/components/core/assistantPanel/hooks/use-enabled-models.ts` — the
  join of the two flow-scoped catalog reads and `isCatalogReady`.
- `src/frontend/src/components/core/assistantPanel/components/model-selector.tsx`:
  - `assistant-model-selector`;
  - per-provider labels and `menuitem`s;
  - `assistant-model-weak-hint`;
  - the default-model choice.
- `src/frontend/src/components/core/assistantPanel/helpers/model-strength.ts` —
  `classifyModelStrength`, the parameter-count rule.
- `src/frontend/src/components/core/assistantPanel/assistant-panel.tsx` — the
  disabled / no-models / composer branch order.
- `src/frontend/src/components/core/assistantPanel/components/assistant-input.tsx` —
  `assistant-input-textarea`, `assistant-send-button` and its `canSend` gate.
