# Failure-mode index — symptom → lever

Each recurring infra failure class maps to its **canonical fix pattern**, the
**authoritative in-repo doc**, and the **issue/PR IDs**. This index restates
nothing a linked doc already says — read the doc for the full reasoning; use this
to route a symptom to the right lever fast. Confirm the linked docs/issues are
still current before acting.

## 1. Single-backend saturation (load flakiness)

**Symptom:** specs time out / flake only under CI parallelism; daily duration
spikes; `expandFocusedNode` / modal clicks time out; not reproducible at
`--workers=1`. Root cause is one Langflow backend serializing concurrent work,
**not** CPU sizing and **not** a product regression.

**Levers:** shard the `@stable` suite across runners · isolate heavy live-LLM
specs into a low-concurrency lane · cap workers per shard · reproduce locally with
`--workers=N` before blaming the product · cap the **outage per wedge** with
`LANGFLOW_WORKER_TIMEOUT` on the service container (async worker ⇒ the value
watches the event-loop heartbeat, not request duration, so it bounds a blocked loop
without killing a slow live-LLM build — #1048; Langflow's own docs get this
backwards and advise raising it, so check the code, not `deployment-multi-worker.mdx`) ·
**measure** the mid-run outage instead of inferring it (`scripts/watch-backend.mjs`
probes the backend during each shard; `scripts/report-backend-outages.mjs` names the
wedge in the umbrella issue — #1030) and **keep** the measurement: the per-shard
`liveness-N` artifacts expire after 7 days, so since #1077 every scheduled daily
writes its outage totals and per-shard breakdown onto its `reports/daily-history.jsonl`
line as `backend` (`scripts/lib/backend-history.mjs`; schema in `reports/README.md`).
That series is the baseline any lever has to be compared against — read it with the
two `jq` queries in that README rather than re-deriving it from artifacts. **No lever
was ever applied and none is needed** — the wedge was the suite's own doing and #1679
removed it, measured below; that is what closed #1686, which still carries the candidate
list, the levers already rejected on measurement, and the credential-hang-vs-load
distinction any future benchmark has to preserve. Do **not**
reach for `--max-failures` or a detect-and-abort probe: on run 30444299314 the heavy
shards wedged 7-10 times and still passed ~100 specs each, so aborting costs more
coverage than it saves.

**The wedge was endogenous, and since 2026-09-11 it is measured absent.** Read this
before sizing a runner or a worker count against the series above: the levers listed
here are documented, not pending, and applying one now would size it against a signal
that is no longer there.

`update_enabled_models` validates the provider key once **per model, synchronously,
inside the request** (measured on an idle container, #1666: 1 model 0.4-1.0 s,
30 models **103 s**, the same 30 *disabled* 0.02 s), and the lanes run
`LANGFLOW_WORKERS: 1` — so a 30-model enable write blocks the only worker for 103 s,
past the helper's own 90 s flush budget and within reach of gunicorn's 120 s timeout
under any concurrent load. #1666 removed that sweep from `collect-models`; **#1679
removed it from the spec side** (PR #1805, merged 2026-09-10 15:35 UTC — after that
day's daily had already started at 12:41 UTC, so 09-10 is the last "before" row).
`enableAndSettleModelToggles` now clicks only the model the setup is about to pick,
via `planToggleTargets`.

Three consecutive scheduled dailies either side, read off `reports/daily-history.jsonl`
(`.backend`), with the gunicorn kill count grepped from each run's own shard job logs:

| daily | provider | run | outages | `down_seconds_total` | `collateral_attempts` | `WORKER TIMEOUT` kills | passed |
|---|---|---|---|---|---|---|---|
| 2026-09-08 | google | 34227075296 | 20 | 1644.2 s | 12 | **12** | 601 |
| 2026-09-09 | google | 34352667406 | 11 | 808 s | 6 | **4** | 608 |
| 2026-09-10 | openai | 34478166565 | 11 | 528 s | 5 | **3** | 629 |
| 2026-09-11 | google | 34599745145 | **0** | **0 s** | 0 | **0** | 644 |
| 2026-09-14 | openai | 34857401847 | 1 | 8 s | 0 | **0** | 657 |
| 2026-09-15 | anthropic | 34973003377 | 1 | 12 s | 1 | **0** | 660 |

Four things that make this a comparison rather than a coincidence:

- **The kill count is the discriminator, not the outage count** (#1048) — a liveness
  probe goes through the same forward the specs use and cannot tell a wedged worker
  from a dead socat. The counts above come from
  `gh run view <id> --log | grep -cE "critical.*WORKER TIMEOUT"`, and the instrument is
  validated by 2026-09-08 reproducing exactly the 12 kills that run's own triage had
  read by hand out of the four container logs.
- **The rotation covers all three providers** (#1185), google on both sides — google
  being the 30-model panel the write was measured on.
- **Neither side is a drained account.** Each "after" run's `providers.json` records
  openai and google active (anthropic inactive on 09-11 only), so this is not the
  credential-hang-vs-load confusion #1029 produced — a distinction these numbers
  cannot make on their own.
- **No lever was applied.** `LANGFLOW_WORKERS: "1"` and `LANGFLOW_WORKER_TIMEOUT: "120"`
  are unchanged across the whole window, and nothing moved in `playwright.config.ts` or
  the shard matrix.

**What is left is not the wedge, and reading it as one sends the next person after the
wrong lever.** `blips_total` did not move (23 / 31 / 23 before → 24 / 27 / 24 after):
single-probe failures below the 2-probe window threshold are a floor of the runner,
present on the 2026-08-27 near-control too (19), and #1549 owns them. And `wedged: true`
still renders on a day whose only window is 8 s long with `reason: "timeout>4000ms"` and
no kill behind it — the flag is a threshold on the probe, not a synonym for a worker
kill, so read `down_seconds_total` and the kill count rather than the boolean.

**Return condition — the rollback point a lever would have needed.** The mechanism is
intact in the product: one synchronous per-model key validation, inside one request, on
one worker. Any helper that goes back to writing N models in a single call reopens it,
and the daily's own row is the detector. If `backend.down_seconds_total` climbs back
into the hundreds of seconds on a **scheduled** daily, look for a whole-panel toggle
write **before** reaching for a worker count or a runner size. `LANGFLOW_WORKERS: 1`
stays pinned: it is what makes such a write fatal, but raising it trades a mid-run wedge
for the `collect-models` start-of-run starvation of #922/#927 gated by #1011 — and there
is no measured wedge left to buy with that trade.

**One gap to know if a benchmark is ever run here again.** History lines are written on
`schedule` only, so a lever measured through a `workflow_dispatch` of `daily-stable.yml`
produces **no durable row** — its "after" would again be a table typed by hand from
7-day artifacts. Either land the lever and compare across ≥2 scheduled dailies, or
extend the append step first.

**Docs:** `ISSUE-817-CI-RUNNER-SIZING.md`, `ISSUE-833-SHARDING-DESIGN.md`,
`ISSUE-833-SHARDING-PLAN.md`; `@stable`-removal rules → `CONTRIBUTING.md` →
*Tag @stable* / *Triage protocol*.
**Issues/PRs:** #817 · #830 · #833 · #867 · #882 · #816 · #773 · #818 · #1030 · #1048 · #1077 · #1549 · #1666 · #1679 · #1686 · PR #888 · PR #1805.

**`@stable` verdict routing** (when someone wants to drop `@stable` over this):
confirmed saturation (green at `--workers=1`, flakes at higher N) → **keep
`@stable`**, fix at the infra layer (shard / lane / cap workers); do NOT remove the
tag. Only a **confirmed product regression** justifies a tag change, and that
verdict belongs to `langflow-e2e-triage`, with the `.spec.ts`/tag edit delegated to
`langflow-e2e` (`scripts/remove-stable-from-failures.ts` automates the removal
path). This skill never removes `@stable` itself.

## 2. collect-models silent skip / 403

**Symptom:** whole provider's agent specs silently skip, or fail with 403; a
single inaccessible lead model disables the provider; PR impacted-specs gate picks
an inaccessible model; a raw API key probes OK but the model isn't Langflow-buildable;
a spec runs a live call against a provider already recorded `inactive` and hangs
the shard's worker.

**Levers:** build-probe the provider's model class (not just the raw key) ·
collect models **before** the impacted-specs gate · set `PREFLIGHT_SKIP_CREDENTIALS`
on PR collect-models · resolve model via alias/settled, never a hardcoded dated id ·
gate provider-hardcoded specs on recorded **health**, never on env-var presence
(`providerSkipGate` in `tests/helpers/provider-setup/provider-health.ts`).

**Docs:** `docs/collect-models.md` (→ *Who consumes the recorded health*).
**Issues/PRs:** #570 · #873 · #900 · #886 · #892 · #1029 · PR #878 · PR #887 · PR #893 · PR #901.

## 3. External-dependency hard-fail

**Symptom:** the suite hard-fails on an outage of an external service (httpbin.org,
postman-echo, `npx server-everything`, a pinned httpbin service tag, missing pip
package like `langchain-google-genai`).

**Levers:** decouple from the external echo endpoint · mock the dependency ·
assert the dependency is provisioned in a pre-flight gate rather than failing mid-run.

**Docs:** pre-flight gate `#884`; OpenAI-compatible echo mock PoC PR #889.
**Issues/PRs:** #462 · #463 · #639 · #600 · #898 · #883 (mocking) · #884 (pre-flight) · PR #881 · PR #885.

## 4. Isolation / cleanup race

**Symptom:** a spec's flows get deleted by a concurrent test; global `cleanAllFlows`
wipes siblings; flow creation/open hits an ambient `POST /api/v1/flows/` 500;
leaked "New Flow" orphans; SQLite lock on bulk delete.

**Levers:** id-scoped `afterEach` cleanup (never global wipe) · create flows via API ·
per-worker isolation · a shared `deleteFlow()` that surfaces failures · harden
create/open against the parallel 500 race.

**Docs:** `LANGFLOW-BUG-bulk-flow-delete-sqlite-lock.md`; `langflow-e2e`
`references/authoring-conventions.md` → Flow cleanup (test-side owner).
**Issues/PRs:** #515 · #547 · #588 · #589 · #605 · #877 · Memory: flow-cleanup-always.

## 5. Pre-flight / fail-fast gate coverage

**Symptom:** the suite runs to completion (or half-fails) on a broken environment —
backend down, wrong nightly version, missing credentials/flags, custom-components
flag off.

**Levers:** pre-flight fail-fast gate (backend health + nightly version + required
credentials & flags) before the suite; assert embedding credential before KB ingest.

**Docs:** custom-components flag — Memory: custom-components-flag-nightly (#668).
**Issues/PRs:** #884 · #880 · PR #885 · PR #881.

## 6. Run-history / reporting integrity

**Symptom:** history JSONL frozen / missing lines; push races on `main`;
`error_signature` not recorded; the run recorded without the resolved Langflow
version; coverage-summary push collides between concurrent PRs.

**Levers:** rebase/regenerate-retry the history push · backfill lost lines · record
`error_signature` · resolve the real version behind a moving tag · never
commit `coverage:summary` output in a PR (guard `#741`).

**Docs:** `reports/README.md`.
**Issues/PRs:** #728 · #385 · #741 · PR #849 · PR #850 · PR #896 · PR #875 · PR #874.

## 7. Triage-dispatch automation

**Symptom:** triage propose runs blind to skip reasons; recurrence counts are
signature-agnostic; approval phrase not anchored; skill guidance conflicts with
`CONTRIBUTING.md`.

**Levers:** wire `results.json` into propose · make recurrence signature-aware ·
anchor the approval phrase + actor check on propose · reconcile skill ↔ `CONTRIBUTING.md`.

**Docs:** `CONTRIBUTING.md` → Triage protocol; `langflow-e2e-triage` skill (owner).
**Issues/PRs:** #791 · #803 · #819 · #777 · #719 · Memory: triage-skill-branch.

---

**Not sure which class?** Reproduce under controlled `--workers=N` first (rules out
class 1), check whether the failing surface is a real product change vs a test-side
drift (that's a `langflow-e2e-triage` verdict, not this skill's), and grep open
`qa-infra` issues before proposing anything new.
