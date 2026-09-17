# Ollama provider — configure and execute a flow on the local instance

**Last validated:** Langflow 1.13.x

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
Test 2: `@stable` `@regression` `@model-provider` `@components` `@playground`
— **restored, see the #1302 gate below.**

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

**Restoration gate for #1302 — SATISFIED 2026-09-08.** `@stable` was removed and
`test.fixme` added at triage on 2026-08-06 (#1296 → #1302). The bar was evidence
from the **real CI environment**, because the failure mode is a flow-state race
a dev box cannot reproduce at all — worse than in #931's case, since when the
gate was set this spec could not even RUN locally on an arm64 Mac
(1.12.0.dev18; it runs again on 1.13.x — see *Preconditions → local
reproduction*): a `manual.yml` dispatch, `-f retries=0`, green across several
consecutive runs, with the guard in place. Neither a local green nor a single CI
green was admissible — the mechanism fired on 2 of 26 dailies.

**Result — 40 dispatches at `-f retries=0` against nightly 1.13.0.dev5**, in two
batches, none of which reproduced the revert:

| Batch | Ref | Runs | Result |
|---|---|---|---|
| 1 | `main` (the #1347 guard, adds still hand-rolled) | 20 | 19 green; 1 red at `spec.ts:290` — a **different** mechanism, see below |
| 2 | this branch (adds routed through the repaired helpers) | 20 | **20/20 green**, both tests executing in every run |

Batch 2 measured, over the 20 runs of test 2:

| Step | min | median | max |
|---|---|---|---|
| build the 3-node flow | 6 569 ms | 7 796 ms | 8 818 ms |
| **execute through the Playground** | **3 390 ms** | **4 358 ms** | **5 418 ms** |
| whole test | 11 964 ms | 14 170 ms | 15 684 ms |

So the 180 s budget sits ~40× above the observed cost, which closes the issue's
last deliverable in the negative: the budget was never the cause and needs no
measured replacement. The id-scoped `DELETE /api/v1/flows/{id}` fired in all 20,
and in the red run of batch 1 too.

**The batch-1 red is recorded rather than absorbed**, because it is a different
cause and reading it as this one would misattribute both. Run 34176993263 died
at `spec.ts:290`, 30 s waiting for `input_outputChat Output` to be visible —
before the Ollama node existed, so the guard was never reached. Its snapshot
shows the sidebar search box **empty** (placeholder showing) with the category
list back to its collapsed default: the typed term was wiped by the sidebar's
own mount, the #1518/#1304 class, which an identical second fill repairs and a
longer timeout cannot. All three of this spec's adds were hand-rolled and
therefore bypassed that repair; they now go through
`addComponentFromSidebar` / `dragComponentFromSidebar`. The build step's spread
is the visible effect: 6.6-8.8 s across 20 runs, against a 125.8 s outlier and a
30 s death in the 20 unhardened ones.

**What this evidence does NOT establish, stated so it is not over-read.**
`manual.yml` runs this file ALONE at one worker; the daily runs it beside a full
shard, so the contention the race needs is weaker here than where it fired. 20
consecutive greens therefore bound the rate loosely rather than prove the race
gone — and the race is a product defect this suite does not control. Restoration
is right anyway for two reasons that do not depend on the rate: a persistent
revert now fails in ~1 s naming both fields it read, instead of as a 180 s
`toHaveCount` timeout three layers downstream (which is how this got filed as a
budget problem), and `daily-stable.yml`'s auto-removal is the backstop if it
returns. Which write reverts the node is still unpinned — see the #1347 record.

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

**Which of the instance's tags — the first COMPLETION tag (#1850).** "Whatever
the instance serves" used to mean the first tag `/api/tags` reports, and
`/api/tags` orders tags with no preference for chat models. The Ollama
component's live `model_name` list keeps a tag only when its `/api/show`
capabilities include `completion` (`get_models` in
`lfx_ollama/components/ollama/ollama.py`, `DESIRED_CAPABILITY = "completion"`,
read from the 1.13.0.dev12 image), so on an instance listing an embedding
model first test 2 waited for an option that cannot exist — and failed on the
assert its own comment calls the connectivity assert, which reads as "the
component could not enumerate the instance" when it had, and had correctly
filtered the tag out. The probe now reads the instance through
`helpers/provider-setup/ollama-capabilities.ts` — `/api/tags` plus every tag's
`/api/show`, from the test host, the same oracle
`assistant-ollama-provider.spec.ts` uses — and `resolveComponentTestModel`
decides:

| `OLLAMA_TEST_MODEL` | What the instance reports for it | Resolution |
|---|---|---|
| unset | at least one completion tag | the first completion tag, in `/api/tags` order |
| unset | no completion tag | **skip**, naming the tags by class (embedding-only, capabilities unreadable, no completion capability) |
| set | not served | **skip**, naming what is served (unchanged) |
| set | served, capabilities lack `completion` | **skip** — no dropdown can ever offer it |
| set | served as a completion model | that tag (unchanged) |
| set | served, capabilities unreadable from the test host | that tag — **not** a skip |

The rows about unreadable capabilities are the one place the resolution
deliberately differs from the component, decided rather than inherited. The
component lists a tag whose `/api/show` omits `capabilities` (older Ollama)
and drops one whose `/api/show` fails; the oracle cannot tell those apart and
files both as `unreadable`, never as completion (#1012). Unpinned, such a tag
is therefore never chosen — resolving from an unknown is exactly how the
embedding tag got chosen. Pinned, it is not a skip either: the pin is the
lane's explicit choice, every CI lane pins, and skipping a `@stable` run
because the test host failed one metadata read would trade the product's own
verdict (the dropdown) for a silent skip. On an Ollama that reports
capabilities — 0.32.1 locally, the 0.32.5 `docker/ollama-e2e/Dockerfile` pins
for CI — the oracle and the component agree on every tag, so neither lane
reaches those rows today.

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
barrier, and this paragraph used to describe it as guaranteeing "PATCH
quiescence for 700 ms": both halves are wrong and were still here after #1902's
first pass corrected the same claim eleven lines below. The window arms
IMMEDIATELY when nothing is in flight, so 700 ms against a 2000 ms debounce
guaranteed nothing about a save that was merely scheduled; it is derived from
the instance now (#1902). What was right is the second half — quiescence says
nothing about what persisted. **Which write reverts it is not pinned** — a stale autosave and the
bulk `DELETE /api/v1/flows/` that appears mid-test under `actualWorkers: 2` are
both candidates, and the artifacts do not separate them.

**The guard reads the WIDGET, not the API, and that is measured rather than
conventional:** the run is dispatched as `POST /api/v2/workflows` with a
**66 801-byte body** — the frontend's in-memory graph, not a reference to the
persisted flow. A guard that queried `GET /api/v1/flows/{id}` could therefore
pass while the run executes the reverted state.

It does two things, in this order:

1. **Converge** — after selecting the model, wait for the node's configuration
   to hold (widget value stable, no flow-save PATCH in flight **or still
   scheduled**), re-applying the selection at most once. This is condition-based
   waiting on a known product race, not a blind retry of a failed interaction.
   The quiet window is `nodeConfigDrainQuietMs()`, derived from
   `GET /api/v1/config.auto_saving_interval` for the run: it was a 700 ms
   constant until #1902, below every debounce upstream ships, so the drain
   returned before a revert the selection had merely scheduled and step 1
   returned `held` **without ever running the re-apply** — the repair it exists
   to perform. Step 2 still caught the revert, so no run ever started against a
   reverted node; what the short window cost was the recovery, which is the
   opposite of the trade this guard was built to make.
2. **Attribute** — immediately before `button-send`, assert the node still
   carries the model. If it does not, fail **there**, naming the revert and the
   two fields observed, in ~1 s instead of 180 s. This one takes no drain at all
   and is correct as it stands: it is a read at the last moment the graph that
   will execute can still be observed.

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
    spec derives it from the instance** — the first tag, in `/api/tags` order,
    whose `/api/show` capabilities include `completion`, the only kind the
    Ollama component lists (#1850) — and skips naming what the instance serves
    when it has no such tag. There is deliberately no hardcoded fallback tag —
    see *Model resolution* below.
  - Provisioning used for validation:
    `docker run -d --name ollama-e2e -p 11434:11434 ollama/ollama` +
    `docker exec ollama-e2e ollama pull llama3.2:1b`.
- **SSRF allowlist (dockerized Langflow):** `host.docker.internal` resolves to
  a private address, which the nightly's SSRF protection refuses unless it is
  allow-listed (discovered live on 1.11.0.dev36 while authoring this spec).
  `scripts/start-langflow-docker.sh` sets `LANGFLOW_SSRF_ALLOWED_HOSTS` to the
  RFC-1918 ranges (`172.16.0.0/12,10.0.0.0/8,192.168.0.0/16`, which all four CI
  lanes carry too), and that covers it — an instance started that way needs no
  extra flag. Re-measured on 1.13.0.dev12: with the variable **unset**,
  `validate-provider` answers `{"valid": false}` naming the blocked IP
  (`192.168.5.2`), the component's model-list fetch
  (`custom_component/update`) answers **400** `SSRF Protection: … resolves to
  blocked IP address(es)`, and both tests fail; allow-listing the bare hostname
  (`LANGFLOW_SSRF_ALLOWED_HOSTS=host.docker.internal`) is accepted as well as
  the ranges (`valid: true`, both tests green).
- **Local reproduction on an arm64 Mac — runs on 1.13.x; it did not on
  1.12.0.dev18.** Both measurements are kept, because the second reverses the
  first and the first is what a recurrence would be read against:
  - **1.13.0.dev12 (measured 2026-09-14) — runs.** A dockerized nightly under
    Colima, started with the env of `scripts/start-langflow-docker.sh` (so the
    RFC-1918 allowlist above), plus a **native** Homebrew Ollama (0.32.1,
    `ollama serve` on the host's loopback, `qwen2.5:0.5b` pulled) reached from
    the container as `http://host.docker.internal:11434` (`192.168.5.2` under
    Colima) — no `ollama/ollama` image involved. `POST
    /api/v1/models/validate-provider` answered `{"valid": true, "error": null}`,
    and the spec ran **4/4 consecutive `--retries=0` runs green**, both tests
    executing in each (`2 passed`, 0 skipped), the sentinel echoed every time,
    test 2 taking 10.1–15.4 s. It is not green by construction: the same setup
    without the allowlist fails both tests (bullet above). The
    `DNS resolution failed` answer recorded below did not reproduce, with the
    ranges or with the bare hostname; the build that fixed it was not bisected.
    One local trap, measured and since fixed (#1850): that instance lists two
    embedding tags (`all-minilm:latest`, `nomic-embed-text:latest`) before
    `qwen2.5:0.5b`, and the spec used to take the first tag `/api/tags`
    reports. The Ollama component drops a tag whose `/api/show` capabilities
    lack `completion` (0.32.1 reports them), so test 2 failed its live-dropdown
    assert on `all-minilm:latest` (2/2 then, 1/1 re-measured before the fix).
    The spec now resolves `qwen2.5:0.5b` on the same instance, so no pin is
    needed. Run with `PLAYWRIGHT_BASE_URL` pointing at that instance:
    `npx playwright test
    tests/tests-automations/regression/core-functionality/model-provider/ollama-provider.spec.ts
    --workers=1 --retries=0`.
  - **1.12.0.dev18 (measured 2026-08-06) — did not run, so the spec was
    treated as CI-only there.** A dockerized Langflow could not reach any
    Ollama in either topology (host instance via `host.docker.internal`; a
    sibling `ollama/ollama` container on a shared network with the CI's exact
    allowlist). Setting `LANGFLOW_SSRF_ALLOWED_HOSTS` made it worse rather than
    better: **without** it the layer answered `resolves to blocked IP
    address(es)` (so the name resolved), **with** it the same name answered
    `DNS resolution failed` — for a name `getent` and `socket.getaddrinfo`
    resolved inside that same container. Independently:
    `validate_model_provider_key("Ollama", …)` called directly in that
    container validated and connected, while `POST
    /api/v1/models/validate-provider` with the same argument did not — the
    allowlist was honoured by the library and not by the endpoint. The escapes
    were closed too: the amd64 image died with `Fatal glibc error: CPU does not
    support x86-64-v3`, and `start-langflow-pip.sh` installs the stable
    release, not the nightly line.
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

1. Probe `OLLAMA_BASE_URL` (`/api/tags` plus each tag's `/api/show`) and
   resolve the model (*Model resolution*); skip with the reason if the
   instance is unreachable or serves no model the component would list.
   (No component pre-flight here — see Build-side pre-flight for why.)
2. Open Settings → Model Providers → provider item **Ollama**.
3. Fill the provider's base-URL field with `OLLAMA_BASE_URL_FROM_LANGFLOW`
   (real field scouted live — never invented).
4. Arm both response waiters BEFORE clicking Save (validate-provider POST +
   variables save) with `armProviderSave`
   (`helpers/provider-setup/provider-panel-save.ts`), click Save.
5. **Assert, in the order the panel issues them (#1849):** first the
   validate-provider verdict — HTTP 200 **and** a body reporting
   `valid === true`, the failure carrying the body's `error`; only then the
   variables write, 2xx. The body check is what proves the URL reached the
   live instance: the endpoint answers **HTTP 200 with `{"valid": false,
   "error": …}`** for a URL it could not reach (measured on 1.12.0.dev9 with
   the SSRF allowlist absent), so an HTTP-status-only assert is weak in
   isolation. The order is what lets that check run at all: after a refusal
   the panel issues **no** variables write, so awaiting the two together
   (`Promise.all`) settled only when the write waiter timed out, and the
   verdict was never read.

**Test 2 — the Ollama component lists the local model live and executes (§7.6 execute half)**

1. Build-side pre-flight assert + reachability probe/skip as above.
2. Open a blank flow; add **Chat Input**, **Ollama**, **Chat Output** from
   the sidebar; connect ChatInput → Ollama (input) and Ollama → ChatOutput.
3. On the Ollama node: set `base_url = OLLAMA_BASE_URL_FROM_LANGFLOW`,
   refresh/open the `model_name` dropdown.
4. **Assert (configure/connectivity):** the dropdown lists the resolved model
   — a tag the instance reports as a completion model (or the pin, see *Model
   resolution*), so its absence means the component did not enumerate the
   local instance, not that it filtered out an embedding tag (#1850). Select
   it, then **wait for the selection to converge**
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
  not by a pre-existing configured state (family pattern). They are read
  verdict-first, so a refused base URL fails at the refusal, naming it (#1849).
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
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 saves a base URL
  the SSRF layer refuses even with the allowlist in place
  (`OLLAMA_BASE_URL_FROM_LANGFLOW=http://169.254.169.254:11434`) ⇒ must fail
  **at the validate-provider verdict, within seconds, naming the refusal** —
  not 60 s later at the variables waiter (#1849);
  M2 — test 2 expects a never-pulled model name in the live dropdown ⇒ must
  fail; M3 — test 2 asserts the reply is empty (inverted) ⇒ must fail; M4 —
  the pre-flight probe token is changed to a family absent from the build
  (e.g. `groq`) ⇒ must fail on the attributed pre-flight message; **M5 (#1302)
  — the model selection is cleared right before the pre-run guard ⇒ the guard
  must fail there, naming the revert, NOT 180 s later on
  `div-chat-message`.** M5 is the one that proves the guard is load-bearing:
  without it the same mutation still fails the test, but as the unattributed
  timeout this issue was filed under. **M6 (#1850) — the unpinned resolution
  is forced back to the instance's first tag (`classes.tags[0]`) against an
  instance listing an embedding model first ⇒ test 2 must fail at the
  live-dropdown assert**, which is the defect the resolution removes; its
  counterpart is behavioural, not a mutation: pointed at an instance serving
  only embedding models (`OLLAMA_BASE_URL` at a fake `/api/tags` + `/api/show`),
  both tests must **skip** naming those tags, never run and never pass.

  M1 was previously documented as "test 1 expects a **4xx** validate-provider
  (inverted)". That mutation could not fail as described: the endpoint answers
  **HTTP 200** with `{"valid": false}` for an unreachable URL, so `ok()` is
  true either way. Corrected above to mutate the body check. What actually
  reddened test 1 in that scenario was the *variables* persistence waiter
  timing out at 60 s (Langflow never persists a URL it could not validate) —
  verified live on 1.12.0.dev9 by running test 1 against a container without
  `LANGFLOW_SSRF_ALLOWED_HOSTS`: **1 failed in 1.1 min**. So the test was
  never a false positive, but it failed opaquely. The `valid === true` assert
  was added to make it fail fast and name the cause, and until #1849 it did
  neither: it sat behind `Promise.all([validate, persist])`, which settles only
  when both do, and the panel issues no write after a refusal. Re-measured on
  1.13.0.dev12 with the base URL refused (M1's address), the run still died at
  the persistence waiter after **64.6 s**, naming nothing. Reading the verdict
  first, the same run fails in **4.1 s** — the whole test, bootstrap and
  navigation included — with `validate-provider rejected the base URL: Access
  to IP address 169.254.169.254 is blocked by SSRF protection. …`.

---

## Cleanup *(required by the repo's flow-cleanup rule)*

- Test 2 deletes its blank flow by id in a `finally`.
- Both tests enter through `awaitBootstrapTest`, which creates `New Flow` +
  `Basic Prompting` whenever the default project is empty, and nothing deleted
  them: measured on a purged 1.13.0.dev12 instance, the first run of this file
  left exactly those two behind. `trackCreatedFlows` now captures every flow the
  page creates and deletes those ids in `afterEach` (#1850); test 2's blank flow
  is deleted twice, and `deleteFlow` treats the second DELETE's 404 as done.
- `OLLAMA_BASE_URL` is deleted **before** test 1 on purpose, so the save is a real
  first-time configure, and left configured afterwards.

---

## What this test does not cover *(optional)*

- Agent-surface selection of Ollama models (the Agent's options come from
  Langflow's static catalog, which is independent of the local instance —
  asserting it would test the catalog, not the provider path).
- Ollama embeddings component; tool calling on local models.
- Model quality/wording (soft sentinel only).

---

## External dependencies *(required)*

- **Local Ollama instance** serving a completion model — `OLLAMA_TEST_MODEL`
  when set, else the first tag whose `/api/show` capabilities include
  `completion` (no cloud key, no external network) — see Preconditions for the
  provisioning commands and env vars; absent ⇒ explicit skip.
- **The `lfx-ollama` distribution present in the Langflow image** — it ships
  in the stock nightly, so absence is a packaging regression ⇒ attributed
  hard failure, not a skip. Migration watch for the M4 shim removal: #1040.
