# Issue #817 — CI runner sizing & Playwright parallelism for the daily

**Type:** infra investigation (`qa-infra`, Wave 3 — Infra stabilization & test coverage)
**Status:** diagnosis + recommendation. **No infra change is made by this issue** — the
milestone rule is explicit: *act only after diagnosis/isolation rule out a product
regression.* Acting (changing the runner / sharding) is a separate follow-up.
**Last updated:** 2026-07-18

---

## TL;DR

The daily `@stable` suite runs on a **standard `ubuntu-latest` runner (2 vCPU / 7 GB)**
with **`workers=2`**, sharing that single 2-core VM with the `langflow` backend, a
CPU-inference `ollama`, and `go-httpbin`. That is heavy CPU oversubscription. The run
history shows failures are **timeout-dominated** and their volume **scales with run
duration / suite load** — the signature of CPU contention, not (mostly) product bugs.

**Recommendation:**
1. **Durable, cost-free fix — shard the `@stable` suite across N standard runners**
   (each shard with its own dedicated `langflow`/`ollama`/`go-httpbin` stack). Standard
   Linux runners are **free and unlimited on this public repo**; larger runners are
   **paid even on public repos**. Sharding both removes per-worker backend contention
   *and* keeps pace with suite growth. It needs real workflow rework (blob-report merge
   + aggregation of history/auto-remove/QA-POST across shards) → **track as its own Wave
   implementation issue.**
2. **Immediate stopgap (optional, paid) — bump `runs-on` to a 4-core larger runner.**
   One-line change, instant relief, keeps the single-`langflow` semantics that
   state-sharing `@database` tests depend on. Billed per-minute; only worth it if relief
   is needed before sharding lands.
3. **Reject** raising timeouts or dropping to `workers=1` as the primary lever — the
   first masks the root cause (repo rule: never add waits to go green), the second
   roughly doubles wall-clock (already up to 67 min against a 90 min job timeout).

The one gap: this analysis proves contention from **indirect** evidence (the run
history). A **direct** CPU/mem measurement (Done-when #1) requires instrumenting the
workflow and triggering one real run — proposed in §4, not yet executed.

---

## 1. Current configuration (as-is)

Source: `.github/workflows/daily-stable.yml`, `playwright.config.ts`.

| Dimension | Value | Source |
|---|---|---|
| Runner | `ubuntu-latest` — standard hosted Linux, **2 vCPU / 7 GB / 14 GB SSD** | `daily-stable.yml:34` |
| Test container | `mcr.microsoft.com/playwright:v1.58.2-noble` | `daily-stable.yml:43` |
| Workers | **2** in CI (`process.env.CI ? 2 : undefined`) | `playwright.config.ts:18` |
| Per-test timeout | 5 min; `actionTimeout` 20 s | `playwright.config.ts:19,28` |
| Retries | 2 in CI | `playwright.config.ts:17` |
| Co-tenant services | `langflow` (single instance), `ollama` (llama3.2:1b, CPU inference), `go-httpbin` | `daily-stable.yml:45-128` |
| `@stable` tests | **353** (`scripts/stable-tests.ts --count`) | live |

**The core problem — CPU oversubscription on 2 vCPUs.** A single run concurrently loads:

- 2 Playwright **worker processes** (Node) + 2 **Chromium** browsers (each browser is
  several processes),
- **1 shared `langflow`** backend (Python/uvicorn) serving *both* workers' requests —
  graph execution, model calls, DB writes,
- **`ollama`** running `llama3.2:1b` **inference on CPU** (pegs a core whenever an
  agent/model spec fires),
- **`go-httpbin`**.

That is ~6–8 CPU-hungry processes contending for **2 cores**. When `ollama` infers or
`langflow` executes a heavy graph, the browser's event loop starves; UI actions miss the
20 s `actionTimeout` and `waitForSelector` windows → timeout failures.

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
must keep failing and be triaged on their own dedicated issues — they are **not** what a
bigger runner fixes. The recommendation targets the ~60% contention-shaped bucket only.

---

## 3. What is NOT yet measured (Done-when #1, direct numbers)

The history gives **indirect** evidence. It does **not** contain per-run CPU/mem
samples, so we cannot yet state "langflow used X% CPU while a worker timed out." §4
proposes the instrumentation to capture that directly.

---

## 4. Proposed instrumentation to close Done-when #1 (direct CPU/mem)

Add a **background resource sampler** step to the daily (or a manual dispatch), writing
a CSV artifact, then correlate spikes against the failure timestamps in `results.json`.
Sketch (no product/test change; artifact-only):

```yaml
# Before "Run @stable tests": start a detached sampler.
- name: Start resource sampler
  shell: bash
  run: |
    ( while true; do
        echo "$(date -u +%FT%TZ),$(cat /proc/loadavg | cut -d' ' -f1-3 | tr ' ' ';'),\
$(free -m | awk '/Mem:/{print $3"/"$2}')"
      done ) >/tmp/resource-samples.csv 2>&1 &   # ~1 Hz loadavg + mem
    disown
# After the test step: upload /tmp/resource-samples.csv as an artifact.
```

Load average > number of cores (2) sustained during the test window = CPU saturation.
This is cheap (a few KB) and fail-soft. **Cost: one manual `workflow_dispatch` run
(~60 min of runner time).** Only run it if the team wants the direct number before
acting — the indirect evidence in §2 is already conclusive for the *direction*.

---

## 5. Options & trade-offs

### Option A — Larger runner (4+ vCPU)

Change `runs-on: ubuntu-latest` → a 4-core larger runner (single line).

| | |
|---|---|
| ✅ Pro | Trivial one-line change; instant 2× CPU headroom; directly relieves oversubscription; **keeps the single shared `langflow`**, so `@database`/state-sharing tests are unaffected; no aggregation rework. |
| ❌ Con | **Paid per-minute even on a public repo** (standard 2-core is the only free tier). Doesn't stop the growth curve — at ~4× the current suite it will contend again. A stopgap, not a ceiling. |

### Option B — Shard the `@stable` suite across N standard runners

Matrix of N jobs (`--shard=i/N`), each on a standard `ubuntu-latest` with its **own**
`langflow`/`ollama`/`go-httpbin` services; merge the N blob reports at the end.

| | |
|---|---|
| ✅ Pro | **Free** — standard runners are unlimited on this public repo; wall-clock drops ~N×; each shard gets a **dedicated `langflow`** (kills cross-worker backend contention, the actual root cause); scales with suite growth by raising N. |
| ❌ Con | Real engineering: (1) merge N blob reports into one `results.json` before the downstream steps; (2) the **auto-remove-`@stable`**, **history append**, **QA-Platform POST**, and **failure-issue** steps all assume a single `results.json` → must run post-merge; (3) N× langflow boots (~90 s each) + N service stacks; (4) `@database` state-sharing tests must stay **within one shard** (shard by file with affinity, never split a dependent pair). → Deserves its own Wave implementation issue. |

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

1. **Adopt sharding (Option B) as the durable fix** — it is the only option that is both
   *free on this public repo* and *removes the real root cause* (one `langflow` serving
   two contending workers). Open a dedicated Wave implementation issue covering the
   blob-merge + downstream-aggregation rework and the `@database` shard-affinity rule.
2. **If relief is needed before B lands, apply Option A (4-core) as a paid stopgap** —
   one line, reversible, keeps single-`langflow` semantics. Decommission once B is live.
3. **Do not** raise timeouts or drop to `workers=1` as the primary lever.
4. **Optionally run the §4 sampler once** (manual dispatch) to attach direct CPU/mem
   numbers to this issue before committing budget to A.
5. Keep triaging the genuine-product-finding failures (§2.3) on their own issues — they
   are out of scope for runner sizing.

**This issue delivers the diagnosis + recommendation only. No workflow file is changed
here.**
