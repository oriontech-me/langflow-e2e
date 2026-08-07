# Collect Models

**Last validated:** Langflow 1.12.x (1.12.0.dev19)

---

## What this test validates *(required)*

This is a utility spec — not a regression assertion test. It exists to populate two local data files used by LLM agent and model-provider specs as preconditions:

- `tests/helpers/provider-setup/data/models.json` — list of models available per provider (collected from Settings → Model Providers UI)
- `tests/helpers/provider-setup/data/providers.json` — provider status (`active` / `inactive`), validated on two independent axes: the raw API key works, **and** the running Langflow build can actually instantiate that provider's component

If this spec is not run before the LLM agent specs, those specs fall back to a hardcoded model and may skip or fail due to missing provider configuration.

### The two axes, and why the second one exists (#900)

A provider is only usable when **both** hold, and they fail independently:

| Axis | Question | Failure it catches |
|---|---|---|
| **Key** | does the provider's own cloud API accept this key? | drained credit, revoked key, spend cap |
| **Build** | can *this Langflow image* instantiate the provider's component? | the component's distribution or its `langchain-*` runtime package is missing from the image |

Before #900 only the first was checked. The key probe calls the provider's API
**directly, upstream of Langflow**, so a perfectly valid key on an image that
cannot build the model recorded a false `active` — and the real failure surfaced
tens of layers downstream as a generic node-build timeout. It cost a full triage
cycle each time it happened: #898 (`langchain-google-genai`, upstream LE-1974,
~17 Google `@stable` specs) and #907 (`langchain-groq` / `langchain-mistralai`,
upstream LE-1987). The build axis converts that into one attributed failure at
collect time.

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

1. **Probe the BUILD axis first** (#900), on a still-idle backend. The order is
   load-bearing — see *The build axis must run BEFORE the UI load* in the Notes. This
   step needs only the component registry: not `models.json`, not the keys. Two
   layers:

   a. **Catalog.** One `GET /api/v1/all` for every provider at once. Each provider
      declares the exact component keys it needs (chat + embeddings); a key absent
      from the registry means its distribution is not installed.
   b. **Buildability.** Every component that passed (a) goes into **one** throwaway
      flow as a disconnected vertex, and each is then built **individually** via
      `POST /api/v1/build/{flow_id}/flow?stop_component_id=<node>`, with its own
      20 s budget. On timeout the job is **cancelled** and that component is
      recorded `unknown`. The flow is deleted in a `finally`. A registry hit does
      **not** prove the component can build — see the contract table below.
2. Navigate to Settings → Model Providers
3. For each configured provider (OpenAI, Anthropic, Google):
   a. Click the provider entry to open its configuration panel
   b. If an API key is present in the environment and the panel is visible, enter the key and click Save / Replace
   c. Wait for the credential **write** to answer and for the panel to reach the
      configured state, both **against a sweep-wide deadline** rather than a
      per-provider clock — see *A stalling provider must not cost the sweep* below
   d. Wait for model toggles to load; enable any that are unchecked
   e. Record each model name paired with the provider
4. Write the collected model list to `data/models.json`
5. **Probe the KEY axis:** for each provider, call its API directly to confirm the
   key is active. The probe walks the collected catalog in preference order rather
   than trusting a single lead model, so one gated/preview model cannot disable a
   whole provider (#570). It stops early on the first model that validates — or, when
   the SAME error repeats 3× in a row, on the conclusion that the error does not
   depend on the model at all (#1011; see Validation criterion).
6. Write the provider status records to `data/providers.json`, merging both axes:
   a build-axis failure records `inactive` with a reason that names the missing
   **layer** (distribution vs. runtime package) and, when Langflow reports it, the
   exact module

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
  non-empty `error` (the probe's reason is visible, never silently dropped);
- a provider the **collector** never managed to configure is reported as that,
  and never as a key/account/config failure — see *A stalling provider must not
  cost the sweep* (#1370).

A provider with a key that genuinely fails its probe (e.g. a model the
account cannot access) is a legitimate `inactive` — recorded, logged, not a
test failure.

### The build axis — what makes it force-failable

- **A provider whose component is missing from the registry is `inactive`**, with a
  reason naming the *distribution* layer. Distinctive observable: the provider's
  declared component key is absent from `GET /api/v1/all`.
- **A provider whose component IS in the registry but cannot build is `inactive`**,
  with a reason naming the *runtime package* layer. Distinctive observable: the
  vertex's `errorMessage` carries a packaging signature
  (`No module named '<pkg>'` / `not installed in this environment` /
  `Could not import`), as opposed to any other build error.
- **A credentials error is a PASS on this axis, not a failure.** It proves the
  client class was imported and constructed — the probe got as far as rejecting a
  blank key, which is exactly what "the package is present" looks like. Treating it
  as a failure would make the gate permanently red.
- **A build-axis `inactive` fails the spec loudly, on its own assert.** Every reason
  this axis writes is stamped with a `build axis: ` prefix, and a dedicated step —
  *"this Langflow build can instantiate every provider's component"* — asserts that
  no provider carries one. It is deliberately **not** folded into the existing
  "every env-keyed provider is ACTIVE" check: that check skips any provider whose
  env key is unset, but an unbuildable component is a broken **image**, a verdict
  that does not depend on whether anyone configured a key. Without the separate
  step, a run without `ANTHROPIC_API_KEY` would let a genuinely unbuildable
  Anthropic component pass in silence — the very silent-skip class this issue
  removes. (A packaging reason also fails the env-keyed check, since it does not
  match `BILLING_OR_QUOTA`; the two overlap for keyed providers and only the new
  step covers unkeyed ones.)
- **The probe fails OPEN on its own infrastructure — but never SILENTLY.** An
  unreachable registry, a build-endpoint error, or a component that does not build
  within its budget yields a third state, **`unknown`**, distinct from both `ok` and
  `failed`. It leaves the key-axis verdict untouched, is never written to
  `providers.json`, and is logged as `⚠️ … [NOT PROVEN — this run gives no build
  signal for it]`. The gate must never convert a runner-side hiccup into an
  `inactive` provider (the rule `readProviderHealth` and `TRANSIENT_TRANSPORT`
  (#1011) already encode) **and must never report an unproven component as
  proven** — see *The `unknown` state is not decoration* below.

### No paid call, ever

Every `SecretStrInput` on the probed components is neutralised before the build
(`value: ""`, `load_from_db: false`). This is load-bearing, not hygiene: the
registry template ships `api_key` as `{ value: "OPENAI_API_KEY", load_from_db:
true }`, so an un-neutralised probe would load the **global variable
`collect-models` itself just saved** and the default `text_output` output would
invoke the model for real. Measured on 1.12.0.dev8 with the neutralisation in
place: all five components fail on missing credentials, none reaches the network.

### Who consumes the recorded health

Writing `inactive` is only half the mechanism — a spec has to obey it. Two kinds
of spec do, and since #1043 **both go through
`tests/helpers/provider-setup/provider-health.ts`**, which is the single
implementation of the rule:

- **Provider-parametrized** specs (the `agent-*` family, `mcp-client-agent`) build
  their target list from `models.json` and call `providerSkipReasons()` for the
  `provider → reason` map, dropping a target whose provider is `inactive` and
  quoting the recorded reason. Each of them used to carry its own inlined copy of
  that map (18 of them, already drifted); #1043 deleted the copies.
- **Provider-hardcoded** specs gate through `providerSkipGate(...)` (#1029), which
  adds one precedence rule the map does not need: a missing env key is reported
  before a recorded `inactive`, because without the key the provider cannot be
  configured at all.

Both **fail open** when `providers.json` is absent or unparseable — a fresh clone
has no file (it is gitignored) and CI is allowed to run with a failed
`Collect models` step (#980), so "no signal" must never skip the suite. And both
honour `IGNORE_PROVIDER_HEALTH=1`, which overrides a stale local file.

> **The escape hatch is local-only, and it is now blunter than it was.** The
> variable is set in no workflow, script or config — only ever exported by hand.
> Before #1043 it affected the hardcoded specs alone; it now also un-skips every
> provider-parametrized target. Since these specs load `.env` whenever `CI` is
> unset, leaving `IGNORE_PROVIDER_HEALTH=1` in a `.env` file will send the whole
> agent family at a dead key on your next local run.

Before #1029 the hardcoded specs gated on env-var presence, so a key that existed
but was drained still made the live call. On run 30374528125 that hung two Google
tests past gunicorn's 300s timeout, killed shard 2's Langflow worker six times, and
produced 14 collateral timeouts in specs that never touch Google.

### What the health gate does NOT cover

`collect-models` records a **point-in-time probe**. The gate therefore covers a
provider that is *durably* unusable — spend cap, revoked key, drained balance —
and cannot cover a provider that is healthy when probed and limited minutes later.
Run 30410211167 is the reference case: Google was recorded `✅ active` at 00:11:11
and returned `429 RESOURCE_EXHAUSTED` (`retryDelay ~13.5s`, a per-minute limit) at
00:15:46, inside the specs run. The record was 4 minutes old and correct when
written, so no amount of gate logic — including expiring stale records via the
`checkedAt` field `ProviderHealthRecord` omits — would have skipped those tests.

The second half of the defence is therefore not prevention but a **bound on the
damage**, and it lives in CI config, not here: `LANGFLOW_WORKER_TIMEOUT: "120"` on
the service containers (#1048). Langflow's default is 300 s, handed to gunicorn as
its `timeout`; because the worker class is async (`LangflowUvicornWorker`), that
timeout watches the **event loop's heartbeat** rather than request duration. Build
duration cannot trip it: a component's sync method runs off the loop in a thread
(`asyncio.to_thread` in `custom_component/component.py`, `_get_output_result`), so
even a blocking provider call keeps the heartbeat ticking. It fires on a stalled
loop and nothing else. A wedged worker does not recover on its own (gunicorn's kill
is what restores service), so the lower ceiling turns each wedge from a 150–300 s
outage into a 60–120 s one — the spread, in both cases, is because gunicorn hands
the worker `timeout / 2` and uvicorn refreshes the heartbeat only that often, so
detection costs up to one notify interval.

⚠️ Langflow's published docs describe this setting incorrectly:
`deployment-multi-worker.mdx` calls it "how long a worker may handle a single
request" and advises **raising** it for long agent runs (its heavy-agent profile
uses `600`). That reading does not survive the code above — do not restore a higher
value on the strength of those docs.

That bounds collateral without eliminating it: a spec whose own API call has a 20 s
timeout still fails inside that window. Removing the collateral entirely means
not letting provider-heavy specs share a backend with unrelated ones — a
serialization / low-concurrency lane, tracked in #1048.

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

### A stalling provider must not cost the sweep (#1370)

One provider's credential write can stay in flight far longer than the others' —
measured at **103 s** locally (#1355/#1357) and past **240 s** in CI, always
anthropic, whichever position it holds in the loop. That is a backend cost this
spec does not control. What it does control is the three separate defects that
turned one slow write into a **lost PR lane**, each with its own fix and its own
unit coverage. Read them in this order; the third is the one that costs coverage.

**1 — A wait that never ran must not report a measurement.** The two waits after
the Save click (the credential response, and the panel reaching `Disconnect`) ended in
`.catch(() => null)` / `.catch(() => false)`, which makes *"the deadline expired"*
and *"the page was closed under me"* the same observation. On run
[31188034419](https://github.com/oriontech-me/langflow-e2e/actions/runs/31188034419)
attempt 2 the test hit its own 5-minute Playwright timeout, the context closed,
and both pending waits rejected at once:

```
14:49:14.871  ⚠️ anthropic ... collected ZERO models
14:49:30.036  ⚠️ no credential write observed for provider "google" within 180s
14:49:30.048  ⚠️ provider "google" never showed the configured state ("Disconnect") within 60s
14:49:30.088  Error: locator.count: Target page, context or browser has been closed
```

A 180 s wait and a 60 s wait completed **12 ms apart**, at most 15.2 s after the
click. Neither observed anything. The log nonetheless read as two measured
negatives — which is why the issue's own preliminary question ("is 180 s simply
short?") is unanswerable from those runs. An aborted wait is **unknown**, not a
negative (#1012, and the same `read-failed` distinction #1261 needed).

**2 — Per-provider ceilings that the test's own budget cannot pay.** 60 s
(waiting for `Save` to become actionable) + 180 s (write) + 60 s (`Disconnect`) +
15 s (toggles) is **315 s spent on a single provider**, inside a spec whose
timeout is **300 s**. One stall therefore consumes the run by arithmetic, before
any judgement about whether any single wait was right. The sweep needs the same
pair of bounds the toggle confirmation already has (`TOGGLE_CONFIRM_BUDGET_MS`,
mirroring #1197 §4.4): a per-item timeout bounds ONE wait and can never see the
sum. Attempt 2 died exactly this way; attempt 3 survived with ~3 s to spare.

The first of those three waits is also the one that used to **throw**, and that
half was found on this fix's own first CI run rather than in the original
incident: with anthropic's write still in flight, google's `Save` never became
actionable inside its own fixed 60 s, and `collect-models` ended there. A busy
`Save` is now recorded as that provider's stall and the sweep moves on — which
loses no signal, because a stall still fails the gate on every lane that requires
the provider, and on the daily that is all of them.

**3 — `no models collected` is a collector verdict, not a key verdict.** When the
panel never confirms the credential, `validateProviderWithFallback` receives
**zero candidates** and records
`error: "no models collected from the providers panel"`. That string does not
match `BILLING_OR_QUOTA`, so it lands in `hardFailures` and fails the spec under
the message *"real key/account/config problem"* — for a provider whose key was
**never probed at all** and whose build axis reported ✅. It is the #1011 mistake
in a new place: the loud failure names the wrong layer. A provider the collector
never managed to configure gets its own verdict, distinct from both a working key
and a rotten one, and the spec asserts on it separately.

**What follows for the PR lane, and why this is not a weakened assertion.**
`pr-validation.yml` pins its run to one provider's settled model (`PR lane pinned
to openai / gpt-4o-mini`, #1169); the daily rotates and keeps the multi-provider
coverage. So on the PR lane a stalled anthropic changes **no spec that lane will
execute**, and yet it exits the shared `Collect models` pre-flight non-zero, which
on that lane is a hard gate — the impacted-specs step never runs and the PR gets
no E2E coverage of its own diff. #570's guarantee is preserved where it bites: a
provider that silently collects nothing still fails **any lane that would have
used it**, and a total wipeout still fails everywhere. What changes is that the
gate stops failing on a provider the lane has already excluded from its own run.

The daily makes the opposite trade deliberately (`continue-on-error: true`, #980
— a day of coverage outweighs a diagnostic red). That asymmetry is intentional and
is now stated in both workflows rather than implied by one of them.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/index.tsx` — Settings navigation; if the `sidebar-nav-Model Providers` testid changes, the spec cannot reach the provider list
- `src/frontend/src/modals/modelProviderModal/` — provider list items (testids like `provider-item-OpenAI`) and model toggles (`llm-toggle-*`); any rename breaks model collection
- `src/frontend/src/components/ui/button.tsx` — Save / Replace button labels; if these change the API key save step is silently skipped and `models.json` ends up empty
- `GET /api/v1/all` — the component registry the catalog layer reads. It returns
  `{ category: { ComponentType: template } }`; note the **`component_display_names`
  pseudo-category**, a lowercased echo of every type that the probe must skip so a
  component is not counted twice
- `POST /api/v1/build/{flow_id}/flow` + `GET /api/v1/build/{job_id}/events` +
  `POST /api/v1/build/{job_id}/cancel` — the build layer. Three properties it
  depends on, all measured rather than assumed:
  - it requires a **persisted** flow (passing `data` inline against a random UUID
    returns `404 Flow with id … not found`), which is why the probe creates and
    deletes one;
  - `stop_component_id=<node>` restricts the build to that single vertex — verified
    on 1.12.0.dev8, where each call emitted exactly one `end_vertex`, for the
    requested node;
  - `event_delivery` defaults to **`polling`**, and the events `GET` is a
    **long-poll**: it blocks until the build finishes and then returns the whole
    event list at once. There is no incremental read to lean on, which is why the
    budget is enforced per component and paired with `cancel`
- The component keys themselves — `ext:openai:OpenAIModelComponent@official`,
  `ext:openai:OpenAIEmbeddingsComponent@official`,
  `ext:anthropic:AnthropicModelComponent@official`,
  `ext:google:GoogleGenerativeAIComponent@official`,
  `ext:google:GoogleGenerativeAIEmbeddingsComponent@official`. These are the
  1.12 `lfx-bundles` per-vendor names (#1040); a rename upstream makes the catalog
  layer report the provider absent, which is a loud failure by design rather than a
  silent pass

---

## What this test does not cover *(optional)*

- Does not assert that specific models are returned — only that the collection and file-write succeed
- Does not validate provider responses in detail — only checks HTTP status 2xx vs non-2xx
- Does not configure providers that lack an API key in the environment
- **Does not prove the model produces a good answer.** The build axis stops at "the
  component instantiates"; whether Langflow's Agent can actually drive the settled
  model is the `agent-*` family's job (the #570 lesson — `gpt-5.6` passed the key
  probe and returned empty replies through the Agent).
- **Does not cover providers outside `providerConfigMap`.** Groq and Mistral are
  deliberately not bundled in the image (product decision, #1039); they are gated
  per-spec by `isProviderComponentAvailable` instead. Keeping them out of this gate
  is what makes a *declared per-provider expectation map* unnecessary — every
  provider this spec knows about is one the image is expected to ship, so "component
  missing" is unambiguously a failure here.
- **Does not detect a package that is present but broken at call time.** An
  incompatible `langchain-*` version that imports cleanly and fails on `invoke`
  (the #643 class) builds fine and passes this axis.

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

### Why the catalog check alone is NOT enough (measured, 1.12.0.dev8)

The obvious cheap design — "scan `GET /api/v1/all`, done" — is wrong, and the
reason is an upstream implementation detail that varies **per component**: where
the `langchain-*` import sits. Read from the installed sources in the running
container:

| Component | `langchain-*` import site | Package missing ⇒ |
|---|---|---|
| `OpenAIModelComponent` | module level (`from langchain_openai import ChatOpenAI`) | module fails to import → **absent from the registry** |
| `OpenAIEmbeddingsComponent` | module level | absent |
| `GoogleGenerativeAIComponent` | module level, transitively via `lfx.base.models.google_generative_ai_model` | absent |
| `GoogleGenerativeAIEmbeddingsComponent` | module level | absent |
| `AnthropicModelComponent` | **lazy, inside `build_model()`** | **registers normally, fails at BUILD** |

So the failure mode #1039 first hit on Groq is **not** a Groq quirk — among the
three providers this spec covers, Anthropic has exactly that shape today.

Proven end to end rather than reasoned about: hiding
`site-packages/langchain_anthropic` and restarting the backend leaves
`ext:anthropic:AnthropicModelComponent@official` **present** in `/api/v1/all` (the
catalog layer returns *available* — a false positive) while the build layer
reports

```
No module named 'langchain_anthropic'. This flow needs a Python package that is
not installed in this environment.
```

A restart is required to observe it: the import is cached in `sys.modules`, so
hiding the package under a warm worker changes nothing.

**Do not "simplify" this back to one layer.** Each layer catches a shape the other
cannot, and which shape a given provider produces is decided upstream, without
notice, by where a maintainer happens to put an `import`.

### The build axis must run BEFORE the UI load

`collect-models` saves three provider keys through the Settings UI, and each save
makes Langflow validate the provider and fetch its model list. On the single-worker
CI backend that is enough load to wedge it — `pr-validation.yml` and
`daily-stable.yml` both carry a dedicated *"Wait for the backend to recover from the
collect-models load"* step immediately after this spec for exactly that reason
(#922/#927/#1044).

The build probe was first placed *after* that load, concurrently with the key probe.
Measured on PR #1051's CI run, twice: **every** component timed out at 20 s — several
on the `POST` that merely *starts* the build — so the axis reported `unknown` for all
three providers and delivered no signal at all, while gunicorn logged two
`WORKER TIMEOUT`s. Locally, against an idle backend, the same probe takes ~9 s.

The probe depends on nothing the UI collection produces — not `models.json`, not the
saved keys, only the component registry. So it runs first, on an idle backend. **Do
not move it back after the collection**; the failure is not subtle but it is silent
in the sense that matters: the axis degrades to `unknown` and the run still goes
green.

### The `unknown` state is not decoration — it is a CI regression made permanent

The first CI run of this mechanism (PR #1051) built all five components in **one**
request. It exceeded the budget, the axis fell back to fail-open — and still logged
`build axis: ✅ openai / ✅ anthropic / ✅ google`, because fail-open and real
success produced identical output. The probe had proven nothing and said everything
was fine. Two things went wrong, both now fixed and both worth stating plainly
because they are easy to reintroduce:

1. **Fail-open must never look like a pass.** A verdict the probe could not reach
   is `unknown`, printed as `⚠️ … [NOT PROVEN]`, never `✅`. A gate whose failure
   mode is indistinguishable from its success is ceremony.
2. **Stopping waiting and stopping working must be the same act.** The client gave
   up at its timeout while the server kept building; gunicorn hit `WORKER TIMEOUT`
   and the next CI step found the backend unreachable for 120 s. The probe now
   `POST`s to `/api/v1/build/{job_id}/cancel` on timeout.

The batching was the third mistake: one over-budget component discarded the signal
for *all* of them, and the log could not even name which one was slow.

### Cost

One flow holds every component as a disconnected vertex; `stop_component_id` then
builds them **one at a time**, each with its own 20 s budget. Measured on
1.12.0.dev8, isolated: 1.5 s / 1.5 s / 3.3 s / 1.3 s / 0.9 s — **~9 s total**, zero
paid calls, same as the batched version but with per-component attribution and a
bounded blast radius. A 90 s ceiling covers the whole axis.

Do not re-batch it to "save a round trip". The round trips are not the cost; losing
the ability to say *which* component failed to build is.

- In CI (`daily-stable.yml`) this spec runs as a dedicated **Collect models** step before the `@stable` suite, ensuring `models.json` is on disk before Playwright's collection phase. The step uses `continue-on-error: true` so a missing API key does not block the rest of the run.
- **Double-run in the daily (analyzed, benign):** with `@stable` the spec ALSO runs inside the suite. The in-suite run re-saves the same keys (the exact flow `openai-provider`/`google-provider` test 1 already exercise in-suite) and rewrites the JSONs with equivalent content; workers read the files at module load, so a mid-suite rewrite does not change already-collected test targets.
- Run this spec locally before any LLM agent or model-provider specs: `npx playwright test tests/collect-models.spec.ts`
- If `models.json` is empty after running, check that the provider panel animates in before the form is read and that button labels match (`Save` / `Replace`)
