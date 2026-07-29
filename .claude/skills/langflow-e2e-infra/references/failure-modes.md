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
backwards and advise raising it, so check the code, not `deployment-multi-worker.mdx`).

**Docs:** `ISSUE-817-CI-RUNNER-SIZING.md`, `ISSUE-833-SHARDING-DESIGN.md`,
`ISSUE-833-SHARDING-PLAN.md`; `@stable`-removal rules → `CONTRIBUTING.md` →
*Tag @stable* / *Triage protocol*.
**Issues/PRs:** #817 · #830 · #833 · #867 · #882 · #816 · #773 · #818 · PR #888.

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
`error_signature` not recorded; Flakiness.io not tagged with the Langflow version;
coverage-summary push collides between concurrent PRs.

**Levers:** rebase/regenerate-retry the history push · backfill lost lines · record
`error_signature` · tag Flakiness.io uploads with the resolved version · never
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
