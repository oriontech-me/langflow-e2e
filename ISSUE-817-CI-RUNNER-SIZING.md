# Issue #817 — CI runner sizing & Playwright parallelism for the daily

**Type:** infra investigation (`qa-infra`, Wave 3 — Infra stabilization & test coverage)
**Status:** diagnosis + recommendation. **No infra change is made by this issue** — the
milestone rule is explicit: *act only after diagnosis/isolation rule out a product
regression.* Acting (changing the runner / sharding) is a separate follow-up.
**Last updated:** 2026-07-18

---

## TL;DR

> **The issue's premise is outdated, and a direct measurement disproves the CPU-contention
> theory.** The daily does **not** run on a 2 vCPU / 7 GB VM — GitHub has upgraded the free
> public-repo standard `ubuntu-latest` to **4 vCPU / 16 GB**. A resource sampler run
> (§3, run [29658914382]) shows the VM is **not resource-starved**: load1 mean 2.80 / max
> 5.42 on 4 cores, memory peak 47 %. Crucially, **the timeout failures do not correlate
> with CPU saturation** — during the 107 failing test-results the load averaged 2.57/4
> and only 16 of them were anywhere near saturation. So raw VM CPU/mem is **not** the root
> cause.

The real bottleneck is the **single shared `langflow` backend**: `workers=2` sends two
concurrent streams of requests to one Python backend, which serializes on graph
execution / model calls. The browser then waits past the 20 s `actionTimeout` even though
the VM has spare cores — which is exactly why the failures are timeout-dominated yet
uncorrelated with VM load. A share of the 34 hard failures is also genuine nightly
product slowness/regressions, not infra at all.

**Recommendation (revised after measurement):**
1. **Cheapest lever first — raise the `langflow` *service's* own backend concurrency.**
   If the service container runs a single backend worker, every request from both
   Playwright workers serializes through it. Investigate the langflow worker/thread
   setting and bump it. No matrix rework, no cost — targets the actual bottleneck.
2. **If insufficient — shard the `@stable` suite across N standard runners**, each with
   its **own dedicated `langflow`** stack. Standard runners are **free/unlimited on this
   public repo**. Its value here is *one backend per shard* (kills the serialization),
   not more CPU. Needs blob-merge + downstream-aggregation rework → own Wave impl issue
   (#833).
3. **Reject the "larger runner" option** — the runner is **already 4-core**, memory is at
   47 %, and failures don't track CPU saturation, so more cores/RAM won't help.
4. **Reject** raising timeouts / dropping to `workers=1` as the primary lever (masks the
   root cause / doubles wall-clock).
5. Keep triaging genuine product-finding failures separately (§2.3).

---

## 1. Current configuration (as-is)

Source: `.github/workflows/daily-stable.yml`, `playwright.config.ts`.

| Dimension | Value | Source |
|---|---|---|
| Runner | `ubuntu-latest` — **actually 4 vCPU / 16 GB** (measured `nproc`=4, mem total 15988 MB; GitHub upgraded the free public-repo standard runner. The issue's "2 vCPU / 7 GB" premise is outdated.) | `daily-stable.yml:34` + §3 |
| Test container | `mcr.microsoft.com/playwright:v1.58.2-noble` | `daily-stable.yml:43` |
| Workers | **2** in CI (`process.env.CI ? 2 : undefined`) | `playwright.config.ts:18` |
| Per-test timeout | 5 min; `actionTimeout` 20 s | `playwright.config.ts:19,28` |
| Retries | 2 in CI | `playwright.config.ts:17` |
| Co-tenant services | `langflow` (single instance), `ollama` (llama3.2:1b, CPU inference), `go-httpbin` | `daily-stable.yml:45-128` |
| `@stable` tests | **353** (`scripts/stable-tests.ts --count`) | live |

**The core problem — a single shared `langflow` backend, NOT VM CPU.** A run concurrently
loads 2 Playwright workers + 2 Chromium browsers, **1 shared `langflow`** backend serving
*both* workers, `ollama` (CPU inference), and `go-httpbin`. The original theory was that
these oversubscribe the CPU. **The §3 measurement refutes that** — on 4 cores the VM runs
at ~70 % mean load with spare headroom, and the timeout failures do not line up with the
load peaks. The real serialization point is the **single `langflow` backend**: two workers
issue concurrent graph-execution / model-call requests to one Python process, which
handles them serially, so a worker's UI action can wait past the 20 s `actionTimeout`
while the CPU sits idle. That is the timeout-dominated-yet-uncorrelated pattern §2/§3 show.

---

## 2. Evidence of contention (indirect, from `reports/daily-history.jsonl`)

13 scheduled runs, 2026-07-01 → 2026-07-17.

### 2.1 Failures are timeout-dominated

Clustered `error_signature` across all runs (`failures[]`, N = normalized digits):

| Count | Signature | Contention-type? |
|---|---|---|
| 42 | `TimeoutError: locator.click: Timeout Nms exceeded` | ✅ |
| 18 | `expect(locator).toBeVisible() failed` | ✅ (slow render) |
| 15 | `TimeoutError: page.waitForSelector: Timeout Nms exceeded` | ✅ |
| 8 | `TimeoutError: locator.hover: Timeout Nms exceeded` | ✅ |
| 9 + 9 | `toContain` / `toBe` equality | mixed |
| 3 | `locator.waitFor` timeout | ✅ |
| 2 | `page.waitForResponse` timeout | ✅ |
| … | (product-specific: MCP 4xx, provider probe, tool indicator) | ❌ real findings |

**~86 of 142 hard-failure entries (≈60%) are timeout / slow-render** — plus 38 of 175
flaky entries carry a timeout signature. A suite where the *dominant* failure mode is
"the browser could not act within 20 s" is starved for CPU, not broadly broken.

### 2.2 Timeout volume tracks run load / duration

`date · duration · hard-failures(of which timeout) · flaky(of which timeout)`:

```
2026-07-01  31m  F=2(to=1)    FL=1(to=0)
2026-07-02  25m  F=4(to=4)    FL=1(to=0)
2026-07-03  21m  F=1(to=0)    FL=1(to=0)     ← short/clean
2026-07-06  20m  F=1(to=0)    FL=1(to=0)     ← short/clean
2026-07-07  38m  F=5(to=1)    FL=1(to=0)
2026-07-08  41m  F=28(to=27)  FL=1(to=0)     ← heavy → 27 timeout fails
2026-07-09  25m  F=4(to=4)    FL=1(to=0)
2026-07-10  34m  F=4(to=0)    FL=1(to=0)
2026-07-13  58m  F=12(to=1)   FL=1(to=0)
2026-07-14  60m  F=27(to=9)   FL=27(to=12)   ← heavy → 21 timeout total
2026-07-15  47m  F=15(to=2)   FL=29(to=14)
2026-07-16  52m  F=6(to=0)    FL=13(to=8)
2026-07-17  67m  F=34(to=24)  FL=10(to=4)    ← longest → 28 timeout total
```

Duration grew **20 → 67 min** as the passing count grew **214 → 373** (suite growth).
The heaviest/longest runs (07-08, 07-14, 07-17) are exactly the timeout spikes; the
short runs (07-03, 07-06) are clean. **Load ↑ → timeouts ↑** is the contention
signature. The clean short runs also prove the infra *can* go green — so a large share
of the failures is contention/transient, not a standing product regression.

### 2.3 Isolation caveat (Done-when: "rule out a product regression")

Not every timeout is contention: some entries are genuine product findings (MCP 4xx
mismatches, provider-probe failures, "agent answered without invoking any tool"). Those
must keep failing and be triaged on their own dedicated issues — they are **not** what an
infra fix addresses. The recommendation targets the ~60% timeout/serialization bucket only.

---

## 3. Direct measurement (Done-when #1, DONE)

A temporary resource sampler (loadavg + mem at ~1 Hz → CSV artifact) was added to
`daily-stable.yml` and a manual `workflow_dispatch` run executed against
`langflowai/langflow-nightly:latest`: **run 29658914382** (2026-07-18, 55 min, 324
expected / **34 unexpected** / 7 flaky / 46 skipped — a normal heavy day). 3312 samples.

### 3.1 The VM is NOT resource-starved

| Metric | Value (4 cores / 16 GB) | Reading |
|---|---|---|
| `nproc` | **4** | runner is 4-core, not 2 |
| load1 mean | **2.80** | ~70 % of 4 cores |
| load1 max | **5.42** | brief 135 % bursts |
| samples load1 > 4 (saturated) | **16 %** | saturation is the exception |
| samples load1 > 6 | **0 %** | never severely pegged |
| memory peak | **7.5 GB / 16 GB (47 %)** | never a constraint |

### 3.2 Failures do NOT correlate with CPU saturation

Correlating the 107 failing test-*results'* `startTime`+`duration` windows against the
sampler:

| Metric during failing tests | Value | vs overall |
|---|---|---|
| load1 mean while failing | **2.57** | ≈ overall 2.80 — no elevation |
| failing-window samples > 4 cores | **12 %** | ≈ overall 16 % |
| failures with any peak > 4 cores | **16 / 107** | most failed at normal load |

If CPU contention drove the timeouts, the failing windows would sit at saturation. They
don't — they sit at the *same* load as the passing ones. **Conclusion: raw VM CPU/mem is
not the cause.** The single shared `langflow` backend (serialization) + genuine nightly
product slowness explain the timeout-dominated failures, consistent with §1 and §2.3.

*(The sampler step is temporary instrumentation — see PR #832; remove after the decision.)*

---

## 5. Options & trade-offs

### Option 0 — Raise the `langflow` service's own backend concurrency (NEW, cheapest)

The §3 data points at the shared backend, not the VM. If the `langflow` service container
runs a single backend worker, both Playwright workers' requests serialize through it.
Investigate the langflow worker/thread setting (e.g. a `LANGFLOW_WORKERS`-style env or the
container's uvicorn/gunicorn worker count) and raise it — the 4-core / 47 %-mem headroom
measured in §3 can absorb it.

| | |
|---|---|
| ✅ Pro | **Free, no matrix rework, no test change**; targets the actual serialization point; keeps one runner + one report (all downstream steps untouched). |
| ❌ Con | Needs verification that the nightly image exposes a worker knob and that concurrent requests are safe against the single SQLite DB (WAL is on). Must be proven with a repeat sampler + failure-count run, not assumed. |

### Option A — Larger runner — **REJECTED by §3**

Was: bump `runs-on` to a bigger runner for more CPU.

| | |
|---|---|
| ❌ Reject | The runner is **already 4-core / 16 GB**, memory peaks at 47 %, and failures do **not** correlate with CPU saturation (§3.2). More cores/RAM would not move the timeout rate — and larger runners are **paid** even on this public repo. No reason to pursue. |

### Option B — Shard the `@stable` suite across N standard runners

Matrix of N jobs (`--shard=i/N`), each on a standard `ubuntu-latest` with its **own**
`langflow`/`ollama`/`go-httpbin` services; merge the N blob reports at the end. (#833)

| | |
|---|---|
| ✅ Pro | **Free** — standard runners are unlimited on this public repo; wall-clock drops ~N×; each shard gets a **dedicated `langflow`** (removes the single-backend serialization, the actual root cause per §1/§3); scales with suite growth by raising N. |
| ❌ Con | Real engineering: (1) merge N blob reports into one `results.json` before the downstream steps; (2) the **auto-remove-`@stable`**, **history append**, **QA-Platform POST**, and **failure-issue** steps all assume a single `results.json` → must run post-merge; (3) N× langflow boots (~90 s each) + N service stacks; (4) `@database` state-sharing tests must stay **within one shard** (shard by file with affinity, never split a dependent pair). → Own Wave implementation issue (#833). |

### Option C — Reduce per-instance load

- **`workers=1`**: ✅ removes the 2-workers-vs-1-backend contention, free, one line. ❌
  roughly doubles wall-clock — 67 min → ~2 h, breaching the 90 min job timeout. Wrong
  direction on the current single-runner setup.
  **Note — `workers` is not an independent lever; it is coupled to the runner/shard
  decision:** dropping to `workers=1` on today's single 2-core runner is the wrong
  trade (doubles wall-clock). The clean design is **`workers=1` *per shard*** under
  Option B — each shard gets one dedicated `langflow` and one worker, so cross-worker
  backend contention disappears and parallelism comes from the shard count, not the
  worker count. Under the Option A stopgap, `workers=2` stays fine (the 4-core doubles
  the CPU headroom). Do not tune `workers` in isolation.
- **Raise `actionTimeout`/test timeout**: ✅ trivial. ❌ masks the root cause, slows
  every test, and violates the repo rule *never add waits/retries to go green*. Reject
  as a primary lever.
- **Stagger heavy services** (e.g. gate ollama/agent specs to a separate window): partial
  relief but fragile and doesn't address the shared-backend contention.

---

## 6. Recommendation

Direct measurement (§3) reframed the whole issue: the runner is **already 4-core / 16 GB
and not resource-starved**, and the timeout failures **do not correlate with CPU load**.
The bottleneck is the **single shared `langflow` backend**, not runner sizing.

1. **Try Option 0 first — raise the `langflow` service backend concurrency.** Cheapest,
   free, no rework; targets the serialization point directly. Verify with a repeat
   sampler + failure-count run.
2. **If Option 0 is insufficient, implement sharding (Option B, #833)** — one dedicated
   `langflow` per shard removes the serialization *and* cuts wall-clock; free on this
   public repo. It carries the blob-merge + downstream-aggregation rework and the
   `@database` shard-affinity rule.
3. **Reject the larger runner (Option A)** — §3 shows more CPU/RAM won't help, and it is
   paid.
4. **Do not** raise timeouts or drop to `workers=1` as the primary lever.
5. Keep triaging the genuine-product-finding failures (§2.3, e.g. the nightly MCP 4xx /
   provider-probe / tool-indicator failures) on their own issues — out of scope for
   runner sizing.

**This issue delivers the diagnosis + recommendation only. The only workflow change is
the temporary §3 sampler (PR #832), to be removed once the fix path is chosen.**
