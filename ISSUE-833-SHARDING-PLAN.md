# Shard the `@stable` Daily Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `.github/workflows/daily-stable.yml` so the `@stable` suite runs across N parallel shards (default 4), each with its own dedicated single-worker `langflow` stack, and a merge job aggregates the N blob reports into one `results.json` that feeds every existing downstream step unchanged.

**Architecture:** Three jobs — `prep` (emits a dynamic shard matrix from a `shards` input, default 4) → `test` (matrix; each leg is today's job with its own services, `workers=1`, `--shard=i/N --reporter=blob`) → `merge` (`needs: test, if: always()`; `playwright merge-reports` → one `results.json`, then all downstream). File-level sharding (`fullyParallel:false` via a `PW_SHARD_FILE_LEVEL` env toggle) keeps every `test()` of a spec file in one shard so `@database` state-sharing holds.

**Tech Stack:** GitHub Actions (matrix, `fromJSON`, job outputs, `needs`), Playwright 1.58.2 (`--shard`, blob reporter, `merge-reports`), Node, `actionlint` for workflow linting.

## Global Constraints

- All repo content in **English** (`CLAUDE.md`).
- Playwright pinned to **1.58.2**; the container tag `mcr.microsoft.com/playwright:v1.58.2-noble` MUST match `@playwright/test` (existing version guard step stays, per shard).
- **Standard `ubuntu-latest` runners only** — no larger/paid runners (free on this public repo).
- **No silent truncation** — a run must never read green having lost a shard's tests.
- Downstream scripts (`scripts/append-weekly-history.mjs`, `scripts/build-run-payload.mjs`, `.github/actions/auto-remove-stable`) are **not modified** — each still receives a single `results.json`.
- Preserve invariants: exactly **one** `daily-history.jsonl` entry, **one** QA-Platform POST, **one** `@stable` auto-removal per scheduled run.
- **Test-first:** all work on branch `feat/issue-833-shard-daily-stable`, **not merged**; the production daily (cron on `main`) keeps running the current single-shard version until validated + user-authorized.
- Default shard count **N=4**, adjustable via the `shards` `workflow_dispatch` input with no YAML edit.

---

### Task 1: `playwright.config.ts` — file-level sharding toggle

**Files:**
- Modify: `playwright.config.ts:15` (the `fullyParallel` line)
- Test: `scripts/__check__/fullyparallel-toggle.mjs` (throwaway assertion, removed in Step 5)

**Interfaces:**
- Produces: environment contract `PW_SHARD_FILE_LEVEL` — when set to any non-empty value, `fullyParallel` resolves to `false`; when unset, `true`. Consumed by the `test` job in Task 3.

- [ ] **Step 1: Write a failing assertion of the toggle**

Create `scripts/__check__/fullyparallel-toggle.mjs`:

```js
// Throwaway check: the config's fullyParallel must flip with PW_SHARD_FILE_LEVEL.
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const read = (env) =>
  execFileSync("node", ["-e",
    "const c=require('./playwright.config.ts');" // will fail: TS require
  ], { env: { ...process.env, ...env } }).toString();

// Instead of importing TS, assert on the source expression directly:
import { readFileSync } from "node:fs";
const src = readFileSync("playwright.config.ts", "utf8");
assert.match(
  src,
  /fullyParallel:\s*process\.env\.PW_SHARD_FILE_LEVEL\s*\?\s*false\s*:\s*true/,
  "fullyParallel must be gated on PW_SHARD_FILE_LEVEL"
);
console.log("OK: fullyParallel toggle present");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/__check__/fullyparallel-toggle.mjs`
Expected: FAIL — `AssertionError: fullyParallel must be gated on PW_SHARD_FILE_LEVEL` (config still has the literal `fullyParallel: true`).

- [ ] **Step 3: Apply the toggle**

In `playwright.config.ts`, change:

```ts
  fullyParallel: true,
```
to:
```ts
  // File-level sharding for the daily's sharded run keeps every test() of a spec
  // file in one shard (so @database state-sharing holds). The sharded job sets
  // PW_SHARD_FILE_LEVEL=1; local dev / nightly / manual keep test-level parallelism.
  fullyParallel: process.env.PW_SHARD_FILE_LEVEL ? false : true,
```

- [ ] **Step 4: Run the check + typecheck to verify pass**

Run: `node scripts/__check__/fullyparallel-toggle.mjs && npm run typecheck`
Expected: `OK: fullyParallel toggle present` then a clean `tsc --noEmit`.

- [ ] **Step 5: Remove the throwaway check and commit**

```bash
rm -rf scripts/__check__
git add playwright.config.ts
git commit -m "test(ci): gate fullyParallel on PW_SHARD_FILE_LEVEL for sharding (#833)"
```

---

### Task 2: `prep` job — dynamic shard matrix

**Files:**
- Modify: `.github/workflows/daily-stable.yml` (add `shards` input; add `prep` job; rename the existing job body — done in Task 3)

**Interfaces:**
- Produces: `needs.prep.outputs.shard_list` (JSON array string, e.g. `"[1,2,3,4]"`), `needs.prep.outputs.shard_total` (e.g. `"4"`). Consumed by `test` (Task 3) and `merge` (Task 4).

- [ ] **Step 1: Add the `shards` dispatch input**

Under `on.workflow_dispatch.inputs`, after `langflow_image_tag`, add:

```yaml
      shards:
        description: "Number of parallel shards for the @stable run (default 4)."
        required: false
        default: "4"
```

- [ ] **Step 2: Add the `prep` job**

As the first job under `jobs:`, before the (renamed) test job:

```yaml
  prep:
    name: Prepare shard matrix
    runs-on: ubuntu-latest
    outputs:
      shard_list: ${{ steps.mk.outputs.shard_list }}
      shard_total: ${{ steps.mk.outputs.shard_total }}
    steps:
      - name: Compute shard matrix
        id: mk
        shell: bash
        run: |
          N="${{ github.event.inputs.shards || '4' }}"
          case "$N" in ''|*[!0-9]*) N=4 ;; esac      # non-numeric → default 4
          if [ "$N" -lt 1 ]; then N=4; fi
          LIST="$(seq -s, 1 "$N")"                    # 1,2,3,4
          echo "shard_list=[$LIST]" >> "$GITHUB_OUTPUT"
          echo "shard_total=$N"    >> "$GITHUB_OUTPUT"
          echo "shards=$N list=[$LIST]"
```

- [ ] **Step 3: Lint the workflow**

Run: `actionlint .github/workflows/daily-stable.yml`
Expected: no errors (the `test`/`merge` jobs are still the old single job at this point; actionlint passes on valid YAML/refs).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/daily-stable.yml
git commit -m "ci(daily): add shards input + prep job emitting a dynamic matrix (#833)"
```

---

### Task 3: `test` job — sharded matrix with per-shard services

**Files:**
- Modify: `.github/workflows/daily-stable.yml` (convert the existing `e2e-daily-stable` job into the sharded `test` job; STRIP the downstream steps — they move to `merge` in Task 4)

**Interfaces:**
- Consumes: `needs.prep.outputs.shard_list`, `needs.prep.outputs.shard_total`.
- Produces: artifacts `blob-<shard>` (each a `blob-report/` dir); job output `langflow_version` (best-effort, any shard).

- [ ] **Step 1: Convert the job header to a matrix**

Rename the job key `e2e-daily-stable:` → `test:` and set:

```yaml
  test:
    name: "Shard ${{ matrix.shard }}/${{ needs.prep.outputs.shard_total }} (${{ inputs.langflow_image || 'langflowai/langflow-nightly' }}:${{ inputs.langflow_image_tag || 'latest' }})"
    needs: prep
    runs-on: ubuntu-latest
    timeout-minutes: 90
    strategy:
      fail-fast: false
      matrix:
        shard: ${{ fromJSON(needs.prep.outputs.shard_list) }}
    outputs:
      langflow_version: ${{ steps.lfver.outputs.version }}
```

Keep the existing `container:`, `services:` (langflow + ollama + go-httpbin), and job-level `env:` blocks **unchanged** — each matrix leg gets its own isolated copy.

- [ ] **Step 2: Keep all setup steps; add the file-level env to the test step**

Leave these steps as-is: checkout, Install dependencies, Verify Playwright version, Forward localhost:7860, Resolve go-httpbin endpoint, Collect models. Keep the "Resolve Langflow version" step (`id: lfver`) **in this job** (it needs the langflow service) so the matrix output above is populated.

Replace the "Run @stable tests" step with:

```yaml
      - name: Run @stable tests (shard ${{ matrix.shard }})
        run: npx playwright test --grep "@stable" --pass-with-no-tests --shard=${{ matrix.shard }}/${{ needs.prep.outputs.shard_total }} --reporter=blob
        env:
          CI: "true"
          PW_SHARD_FILE_LEVEL: "1"
          PLAYWRIGHT_BASE_URL: "http://localhost:7860/"
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
```

- [ ] **Step 3: Replace ALL downstream steps with a single blob upload**

Delete every step after "Run @stable tests" (Upload report ×3, Compute coverage, Resolve Langflow version stays, Build payload, POST, Append/Commit history, Auto-remove, Create issue) EXCEPT keep "Resolve Langflow version". They are re-added in the `merge` job (Task 4). Append only:

```yaml
      - name: Upload blob report (shard ${{ matrix.shard }})
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: blob-${{ matrix.shard }}
          path: blob-report/
          retention-days: 7
          if-no-files-found: error
```

- [ ] **Step 4: Lint**

Run: `actionlint .github/workflows/daily-stable.yml`
Expected: no errors. (The workflow now has `prep` → `test`; `merge` comes next.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/daily-stable.yml
git commit -m "ci(daily): shard the @stable run across the matrix, upload per-shard blobs (#833)"
```

---

### Task 4: `merge` job — aggregate blobs + all downstream

**Files:**
- Modify: `.github/workflows/daily-stable.yml` (add the `merge` job carrying the downstream steps removed in Task 3)

**Interfaces:**
- Consumes: artifacts `blob-*`; `needs.test.result`; `needs.test.outputs.langflow_version`; `needs.prep.outputs.shard_total`.
- Produces: merged `results.json` + HTML report; all side effects (artifacts, QA POST, history commit, auto-remove, failure issue).

- [ ] **Step 1: Add the merge job skeleton (checkout, deps, download, merge)**

After the `test` job:

```yaml
  merge:
    name: Merge shard reports & report
    needs: [prep, test]
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      issues: write
      contents: write
    container:
      image: mcr.microsoft.com/playwright:v1.58.2-noble
    steps:
      - uses: actions/checkout@v7
      - name: Install dependencies
        run: npm ci

      - name: Download all shard blobs
        uses: actions/download-artifact@v7
        with:
          pattern: blob-*
          path: all-blobs

      - name: Guard — every expected shard produced a blob
        shell: bash
        run: |
          EXPECTED="${{ needs.prep.outputs.shard_total }}"
          FOUND="$(find all-blobs -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
          echo "Expected $EXPECTED shard blobs, found $FOUND."
          if [ "$FOUND" -lt "$EXPECTED" ]; then
            echo "::warning::Only $FOUND/$EXPECTED shard blobs present — the merged report is INCOMPLETE (a shard died before producing a blob). Failures may be under-counted."
          fi

      - name: Merge blob reports
        run: npx playwright merge-reports --reporter=html,github,json ./all-blobs > /dev/null
        env:
          PLAYWRIGHT_JSON_OUTPUT_NAME: results.json
          PLAYWRIGHT_HTML_REPORT: playwright-report
```

- [ ] **Step 2: Re-add the three report uploads (unchanged content, now in merge)**

Copy the three upload steps from the old job verbatim (`Upload Playwright report (full, heavy)` → `playwright-report/`; `Upload report index (lightweight, long-lived)` with `id: upload_index`; `Upload Playwright JSON report` → `results.json`), each `if: always()`, same artifact names/retention as today.

- [ ] **Step 3: Re-add coverage, payload, QA POST (unchanged) — using the matrix version output**

Copy `Compute coverage counts` (`id: cov`) and `POST run to QA Platform` verbatim. Copy `Build run payload` verbatim EXCEPT source the version from the matrix output instead of a local resolve:

```yaml
          LANGFLOW_VERSION: ${{ needs.test.outputs.langflow_version }}
```

(Do NOT re-add a "Resolve Langflow version" step here — the merge job has no langflow service; the value comes from `needs.test.outputs.langflow_version`. If empty, the payload's existing best-effort fallback applies.)

- [ ] **Step 4: Re-add history append + commit (unchanged, schedule-only)**

Copy `Append daily history` and `Commit daily history` verbatim (both `if: always() && github.event_name == 'schedule'`, same env: `HISTORY_FILE=reports/daily-history.jsonl`, `WORKFLOW=daily-stable`).

- [ ] **Step 5: Re-add auto-remove + failure issue, gated on the matrix result**

Copy `Auto-remove @stable from hard failures` (`id: auto_remove`) and `Create issue on failure` verbatim, but change their `if:` from `failure() && ...` to key off the matrix result:

```yaml
        if: needs.test.result == 'failure' && github.event_name == 'schedule'
```

(applies to both steps). Everything inside them is unchanged.

- [ ] **Step 6: Lint the full workflow**

Run: `actionlint .github/workflows/daily-stable.yml`
Expected: no errors across `prep` → `test` → `merge`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/daily-stable.yml
git commit -m "ci(daily): add merge job aggregating shard blobs + all downstream (#833)"
```

---

### Task 5: Validate via branch dispatch, compare against the last daily

**Files:** none (integration validation).

**Interfaces:**
- Consumes: the pushed branch `feat/issue-833-shard-daily-stable`.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/issue-833-shard-daily-stable
```

- [ ] **Step 2: Dispatch the sharded workflow on the branch (N=4)**

```bash
gh workflow run daily-stable.yml --repo oriontech-me/langflow-e2e --ref feat/issue-833-shard-daily-stable -f shards=4
```

Then capture the run id:
```bash
gh run list --repo oriontech-me/langflow-e2e --workflow daily-stable.yml --branch feat/issue-833-shard-daily-stable --limit 1 --json databaseId,status
```

- [ ] **Step 3: Wait for completion**

Run: `gh run watch <run_id> --repo oriontech-me/langflow-e2e` (≈16–20 min expected).
Expected: 4 `test` legs + 1 `merge` complete; `merge` produces `playwright-json-daily-<run_id>`.

- [ ] **Step 4: Correctness gate — same failures as the last non-sharded daily**

Download the merged JSON and diff its failing specs against the last non-sharded reference (run 29658914382 / the latest `daily-history.jsonl` entry):

```bash
gh run download <run_id> --repo oriontech-me/langflow-e2e -n playwright-json-daily-<run_id> -D /tmp/shard-check
jq -r '[.. | objects | select(has("specs")) | .specs[] | select(.tests[]?.status=="unexpected") | .title] | unique | .[]' /tmp/shard-check/results.json | sort > /tmp/shard-fails.txt
# Compare against the reference failing set (allow for the known product regression churn).
```

Expected: the sharded run's failing set matches the reference within normal flake tolerance — **no new class of failure introduced by sharding** (e.g. no `@database` test failing because its state landed in another shard). Investigate any sharding-specific failure before proceeding.

- [ ] **Step 5: Speed + downstream gates**

- Speed: `merge` job wall-clock ≈ the slowest shard (~16 min), well under 90 min.
- Downstream: exactly one merged `results.json`; because this is a **dispatch** (not `schedule`), history/auto-remove/QA-POST-history steps are correctly skipped (verify they show as skipped in the run). The merge/upload/merge-reports path is exercised.

- [ ] **Step 6: Record the result on #833; request authorization to merge**

Post the duration, failing-set comparison, and per-shard balance to #833. Do **not** open/merge the PR until the user authorizes (per the deterministic/prose issue rules — PR only after explicit user authorization).

---

## Self-Review

**Spec coverage:**
- prep/dynamic matrix → Task 2 ✓; per-shard services + `--shard` + blob → Task 3 ✓; merge + downstream aggregation → Task 4 ✓; file-level affinity toggle → Task 1 ✓; blob-count guard (no silent truncation) → Task 4 Step 1 ✓; version via matrix output → Task 3/Task 4 ✓; validation/rollout test-first → Task 5 ✓; downstream scripts untouched → constraints + Task 4 copies verbatim ✓.

**Placeholder scan:** No TBD/TODO. "copy verbatim" refers to concrete existing steps in `daily-stable.yml` (identified by their exact step names) — the engineer copies the current file's blocks; not a placeholder for new logic.

**Type/name consistency:** `shard_list`/`shard_total` (prep) used identically in `test` and `merge`; `langflow_version` output produced in `test` (`steps.lfver`) and consumed in `merge` payload; `PW_SHARD_FILE_LEVEL` set in Task 3 matches the toggle from Task 1; artifact name `blob-<shard>` (Task 3) matches the `blob-*` download pattern (Task 4).
