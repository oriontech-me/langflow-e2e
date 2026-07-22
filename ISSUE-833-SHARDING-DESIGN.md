# Design — Shard the `@stable` daily suite across N standard runners

**Issue:** #833 (Wave 3 — Infra stabilization & test coverage)
**Date:** 2026-07-19
**Status:** design approved; implementation on branch `feat/issue-833-shard-daily-stable`, **not merged** (test-first).

## Problem

The daily `@stable` suite runs on a single `ubuntu-latest` with `workers=2` against one
shared `langflow` backend. Per #817's measurement the VM is a 4-core/16 GB box that is
**not** CPU-starved; the bottleneck is the **single backend serializing both workers'
requests**, and wall-clock has grown to ~56 min (07-17: 67 min) as the suite grew
(353 `@stable` tests). Left alone it will breach the 90 min job timeout as the suite
keeps growing.

Sharding across N independent runners gives each shard its **own dedicated
`langflow` + SQLite** (the known-good config), removing the serialization **without**
Redis/Postgres (which raising `LANGFLOW_WORKERS` would require — see #817 Option 0), and
cuts wall-clock ~N×. Standard runners are **free/unlimited on this public repo** — zero
financial cost.

## Goal

Restructure `daily-stable.yml` into a sharded matrix + merge job that:
- runs the `@stable` suite across **N shards** (N parametrized, default **4**),
- keeps every downstream invariant (one `daily-history.jsonl` entry, one QA-Platform POST,
  one `@stable` auto-removal per run) by aggregating on a single merged report,
- changes **nothing** for local dev, `nightly.yml`, `manual.yml`, or `weekly-stable.yml`.

## Non-goals

- Not the paid larger-runner option (rejected in #817).
- Not raising `LANGFLOW_WORKERS` (needs Redis+Postgres; rejected in #817).
- Not fixing the concurrent Langflow product regression (dev41–dev47; flagged upstream via
  #816/#830) — sharding only changes *how fast* the suite runs, not *what* it finds.
- No composite-action refactor of the shared setup steps (YAGNI; keep inline for now).

## Architecture

Three jobs replace today's single job: `prep` (dynamic matrix) → `test` (matrix) → `merge`.

### Job `prep` (dynamic matrix)

- A tiny leading job reads the `shards` `workflow_dispatch` input (default **4**) and emits
  two outputs: `shard_list` (a JSON array `[1,2,…,N]` for `fromJSON` into the matrix) and
  `shard_total` (N, for the `--shard=i/N` flag). This makes N adjustable from the dispatch
  UI with no YAML edit. On scheduled runs the input is absent → default 4.

### Job `test` (matrix)

- `needs: prep`, `strategy: { fail-fast: false, matrix: { shard:
  ${{ fromJSON(needs.prep.outputs.shard_list) }} } }`. The `--shard` denominator is
  `needs.prep.outputs.shard_total`.
- Each shard is a copy of today's job: same Playwright container, **its own `services`
  block (dedicated `langflow` + `ollama` + `go-httpbin`)**, same envs (SQLITE_PRAGMAS,
  SSRF allowlist, custom-components, tracing), same setup steps (npm ci, version guard,
  socat forward, go-httpbin resolve, collect-models).
- Isolation is automatic: each matrix leg runs on its own runner VM → N independent
  langflow instances, no cross-shard contention.
- Test step: `npx playwright test --grep "@stable" --shard=${{ matrix.shard }}/${SHARDS}
  --reporter=blob`, with `PW_SHARD_FILE_LEVEL=1` set (see Sharding granularity).
- Uploads `blob-report/` as artifact `blob-${{ matrix.shard }}`.
- **Exposes the resolved Langflow version as a job output** (captured once; all shards use
  the same image tag) so the merge job — which has no langflow service — can label the run.

### Job `merge`

- `needs: test`, `if: always()`, runs in the Playwright container (no services).
- `checkout` + `npm ci`.
- Downloads all `blob-*` artifacts.
- **`npx playwright merge-reports --reporter=json,html,github blob-report/`** → one
  `results.json` + one HTML + GitHub annotations, identical in shape to today's output.
- Runs **all downstream steps, moved here, operating on the merged report**: upload report
  (heavy + lightweight index + JSON), coverage counts, build payload, QA-Platform POST,
  append `daily-history.jsonl` + commit, `auto-remove-stable`, create failure issue.
- Failure gating: with `fail-fast:false`, `needs.test.result == 'failure'` when any shard
  failed. `auto-remove` and `create-issue` gate on that + `schedule` (as today). Manual
  dispatch never writes history nor mutates `@stable`.

## Sharding granularity & `@database` affinity

`playwright.config.ts` currently has `fullyParallel: true` → Playwright shards at the
**individual test** level, so one spec file's tests can split across shards. That breaks
files whose tests share state (a `beforeAll`-created flow, or `test.describe.serial` — the
suite has one: `provider-invalid-auth-error.spec.ts`).

**Fix — file-level sharding.** With `fullyParallel: false`, Playwright distributes **whole
files** across shards, so every `test()` in a file lands in the same shard. This resolves
`@database` affinity **without a manual affinity list**.

- Applied via env toggle in the config:
  `fullyParallel: process.env.PW_SHARD_FILE_LEVEL ? false : true`.
- Only the sharded `test` job sets `PW_SHARD_FILE_LEVEL=1`. Local dev, `nightly.yml`,
  `manual.yml` keep `fullyParallel: true` — unchanged.
- **Workers per shard — `workers=2` (revised after benchmark).** The initial design
  called for `workers=1` per shard, reasoning that a 2nd worker would re-introduce the
  #817 contention. The N=4 benchmark disproved that: #817's contention was 2 workers
  hitting ONE langflow serving the whole 353-test suite; with a **dedicated langflow per
  shard** (~90 tests each) the 2nd worker is a net win. Measured at N=4: **workers=2 →
  ~28 min (2×)** vs **workers=1 → ~39 min (1.4×)**, with identical correctness (32 vs 33
  failing specs; the workers=2 run's single extra flake was a UI-timeout, not
  contention). So the daily keeps `workers=2` (`process.env.CI ? 2 : undefined`); only
  `fullyParallel` is toggled by `PW_SHARD_FILE_LEVEL`. With `fullyParallel:false` +
  `workers=2`, a shard runs two whole *files* concurrently (file-level parallelism) while
  keeping each file's tests together — affinity holds.
- **Balance:** file-level split skews (benchmark: slowest shard ~2× the fastest). Playwright
  balances by per-file test count, not per-file *duration*, so shards holding the slow
  agent/playground specs run longer. This — not N — is what caps the speedup at ~2×.
  Tuning levers (empirical, "not carved"): raise N so each shard holds fewer heavy files,
  or split the heaviest spec files. Revisit with real timings.

## Error handling & edge cases

- **`fail-fast: false`** — a shard dying at boot/pull does not abort the others; merge runs
  on whatever blobs exist.
- **Missing blob** — a "count downloaded blobs vs expected N" step emits `::warning::` and
  marks the run incomplete when a shard produced no blob. **No silent truncation** — a run
  must never read as green having lost ¼ of the suite (repo rule).
- **Mass-failure guard** (`auto-remove-stable`, `max_auto_remove=5`) operates on the merged
  report = global view of all 353 tests; behavior unchanged by sharding.
- **Langflow version output empty** — payload falls back to today's best-effort behavior;
  never breaks the run.
- **Job timeout** — each shard keeps `timeout-minutes: 90` (huge headroom at ~16 min real);
  merge job is light (~2–3 min).
- **Commit concurrency** — only the merge job commits to `main` (history + auto-remove), one
  per run, so the N-concurrent-commit risk is eliminated.

## Validation & rollout (test-first)

- Implementation lives on branch `feat/issue-833-shard-daily-stable`, **not merged** → the
  production daily (cron on `main`) keeps running the current single-shard version intact.
- The sharded workflow is exercised only via **`workflow_dispatch` on the branch**.
- Compare the sharded dispatch run against the last non-sharded daily:
  - **Correctness gate:** the sharded run finds the **same failures** — sharding must not
    hide a regression nor invent one.
  - **Speed gate:** wall-clock drops to the expected ~16 min.
  - **Downstream gate:** one merged report, one history entry (dry — dispatch does not write
    history), auto-remove operates on the global merged report.
- **Only after those pass and the user authorizes** does the PR merge and the sharded
  version become the production daily.

## Files touched

- `.github/workflows/daily-stable.yml` — restructured into `test` matrix + `merge` job.
- `playwright.config.ts` — `fullyParallel` env toggle (`PW_SHARD_FILE_LEVEL`).
- No changes to `scripts/append-weekly-history.mjs`, `scripts/build-run-payload.mjs`, or the
  `auto-remove-stable` action — they still receive a single `results.json`.
