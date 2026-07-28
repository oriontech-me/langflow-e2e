# Collect Models

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

This is a utility spec — not a regression assertion test. It exists to populate two local data files used by LLM agent and model-provider specs as preconditions:

- `tests/helpers/provider-setup/data/models.json` — list of models available per provider (collected from Settings → Model Providers UI)
- `tests/helpers/provider-setup/data/providers.json` — provider status (`active` / `inactive`) validated via real API calls

If this spec is not run before the LLM agent specs, those specs fall back to a hardcoded model and may skip or fail due to missing provider configuration.

---

## Tags *(required)*

`@stable` `@model-provider` `@settings`

Promoted by issue #501 (QA-CHECKLIST §7.1 ×4: key validation via real call,
model collection via UI, Save Configuration, Replace/Disconnect state).
Historically untagged as "just a setup helper" — promotion required a
force-failability hardening pass (see Validation criterion): the previous
contract ("never throws") meant a fully broken Model Providers UI still
produced a green run with empty JSONs, which would blind the daily on this
surface (the #505 lesson).

---

## Step by step *(required)*

1. Navigate to Settings → Model Providers
2. For each configured provider (OpenAI, Anthropic, Google):
   a. Click the provider entry to open its configuration panel
   b. If an API key is present in the environment and the panel is visible, enter the key and click Save / Replace
   c. Wait for model toggles to load; enable any that are unchecked
   d. Record each model name paired with the provider
3. Write the collected model list to `data/models.json`
4. For each provider, call its API directly to confirm the key is active. The
   probe walks the collected catalog in preference order rather than trusting a
   single lead model, so one gated/preview model cannot disable a whole provider
   (#570). It stops early on the first model that validates — or, when the SAME
   error repeats 3× in a row, on the conclusion that the error does not depend on
   the model at all (#1011; see Validation criterion).
5. Write the provider status records to `data/providers.json`

---

## Validation criterion *(required)*

Hard asserts in the spec, executed AFTER `collectAll` (the helper itself
stays tolerant — writing "inactive" records instead of throwing is its
contract; the SPEC now verifies the outcome):

- `data/providers.json` exists and contains exactly one record per known
  provider (`openai`, `anthropic`, `google`), each with
  `status ∈ {active, inactive}` and a `checkedAt` timestamp;
- every provider recorded `active` contributed **at least one model** to
  `data/models.json` (an active key with an empty model collection means the
  Settings UI collection broke — the exact silent failure the old contract
  hid);
- every provider with its env key set that came back `inactive` carries a
  non-empty `error` (the probe's reason is visible, never silently dropped).

A provider with a key that genuinely fails its probe (e.g. a model the
account cannot access) is a legitimate `inactive` — recorded, logged, not a
test failure.

### Who consumes the recorded health

Writing `inactive` is only half the mechanism — a spec has to obey it. Two kinds
of spec do:

- **Provider-parametrized** specs (the `agent-*` family, `mcp-client-agent`) build
  their target list from `models.json` and drop a target whose provider is
  `inactive`, quoting the recorded reason.
- **Provider-hardcoded** specs gate through
  `providerSkipGate(...)` in `tests/helpers/provider-setup/provider-health.ts`
  (#1029). That helper is the single implementation of the rule: missing env key
  first, then the recorded `inactive` reason. It **fails open** when
  `providers.json` is absent or unparseable — a fresh clone has no file (it is
  gitignored) and CI is allowed to run with a failed `Collect models` step (#980),
  so "no signal" must never skip the suite. `IGNORE_PROVIDER_HEALTH=1` overrides a
  stale local file.

Before #1029 the hardcoded specs gated on env-var presence, so a key that existed
but was drained still made the live call. On run 30374528125 that hung two Google
tests past gunicorn's 300s timeout, killed shard 2's Langflow worker six times, and
produced 14 collateral timeouts in specs that never touch Google.

### Env-keyed provider must be ACTIVE — with one exception

A provider whose key IS configured but that ends `inactive` silently
`test.skip()`s every spec parametrized on it, and a skip never trips the
daily-failure gate — coverage erodes with a green run (#570). So that case
**fails the spec loudly**, with one exception: a *transient billing/quota*
outage (drained credit, exhausted quota, an exceeded spend cap, 402/429) is an
ops state, not a code or config defect. Failing on it reddens every LLM PR,
including the ones that never touch the drained provider, until someone tops up
the account. It is therefore downgraded to a loud **warning** while at least one
provider is still active; genuine key rot still fails loud, and a total wipeout
(zero active providers) still fails.

**The candidate probe stops early when the error is model-independent** (#1011).
A model-scoped failure names the model it is about, so consecutive candidates
produce different messages; an account-scoped one (spend cap, drained credit,
dead key) is byte-identical for every candidate, because the request never
reached a model. Three identical errors in a row therefore mean no remaining
candidate can pass — unless the repeated error is a **transport** failure
(`fetch failed`, a refused connection, a DNS blip), which repeats identically
without saying anything about the account. Those do not count toward the streak:
a runner-side hiccup on three consecutive probes must not turn into an
`inactive` provider, which is a hard failure plus the silent skips the fallback
exists to prevent. Two consequences, both load-bearing:

- **Cost.** On 2026-07-28 a capped Google key made the loop probe all 36
  candidates to learn what candidate #1 already said — three times over, since
  the CI step retried. That load wedged the daily's Langflow and cost the entire
  run (#1007). Measured after the change, against a live 1.12.0.dev7 with the
  same capped key: 3 probes, spec green in 8 s.
- **Correctness.** The aggregate error used to keep only the LAST candidate's
  message. With a capped Google key that was a trailing model-level 404, so the
  provider was classified as key rot and the billing downgrade never fired.
  Stopping on the repeat records the real reason. When the sweep does run to the
  end (the errors never repeat 3× consecutively — a catalog that interleaves
  valid models with ones that reject the probe endpoint), the aggregate now
  reports the **most frequent** error instead of the last, on the same signal the
  early exit uses: a model-scoped message names its model and so occurs once,
  while an account-scoped one occurs for every candidate.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/index.tsx` — Settings navigation; if the `sidebar-nav-Model Providers` testid changes, the spec cannot reach the provider list
- `src/frontend/src/components/core/modelProviderTag/` — provider list items (testids like `provider-item-OpenAI`) and model toggles (`llm-toggle-*`); any rename breaks model collection
- `src/frontend/src/components/ui/button` — Save / Replace button labels; if these change the API key save step is silently skipped and `models.json` ends up empty

---

## What this test does not cover *(optional)*

- Does not assert that specific models are returned — only that the collection and file-write succeed
- Does not validate provider responses in detail — only checks HTTP status 2xx vs non-2xx
- Does not configure providers that lack an API key in the environment
- **Does not verify Langflow can BUILD a provider's model — only that the raw API key works.** The status probe calls the provider's own API directly, upstream of Langflow, so it cannot detect a missing server-side integration package. A nightly that ships without `langchain-google-genai` still records google `active` here, yet every Google chat/embedding build inside Langflow raises an `ImportError` and the affected `@stable` specs fail downstream as a misleading node-build timeout (root cause + impact: [#898]; upstream: LE-1974). A faithful check would have to build a Language Model flow per provider and inspect the error — no standalone endpoint triggers the class import (`/api/v1/models/*` return static metadata only) — so that build-probe hardening was deferred to [#900].

---

## Preconditions *(optional)*

- Langflow instance running and accessible at `PLAYWRIGHT_BASE_URL`
- At least one provider API key set in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`)

---

## When to review this test *(optional)*

- Whenever the Settings → Model Providers UI changes button labels, testids, or layout
- Whenever a new provider is added to Langflow and should be included in the model collection

---

## Notes *(optional)*

- In CI (`daily-stable.yml`) this spec runs as a dedicated **Collect models** step before the `@stable` suite, ensuring `models.json` is on disk before Playwright's collection phase. The step uses `continue-on-error: true` so a missing API key does not block the rest of the run.
- **Double-run in the daily (analyzed, benign):** with `@stable` the spec ALSO runs inside the suite. The in-suite run re-saves the same keys (the exact flow `openai-provider`/`google-provider` test 1 already exercise in-suite) and rewrites the JSONs with equivalent content; workers read the files at module load, so a mid-suite rewrite does not change already-collected test targets.
- Run this spec locally before any LLM agent or model-provider specs: `npx playwright test tests/collect-models.spec.ts`
- If `models.json` is empty after running, check that the provider panel animates in before the form is read and that button labels match (`Save` / `Replace`)
