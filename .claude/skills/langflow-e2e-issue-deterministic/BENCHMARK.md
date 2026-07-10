# Benchmark protocol — pipeline vs prose skill

Compares `langflow-e2e-issue-deterministic` (state-machine CLI) against
`langflow-e2e-issues` (prose orchestrator) on real wave issues, to decide
whether the pipeline replaces, complements, or retires. Directional signal,
not statistics: ~5 runs per arm.

## Arms

| Arm | Skill | Instrumentation |
|---|---|---|
| A | `langflow-e2e-issue-deterministic` | automatic — `.claude/issue-pipeline/issue-NNN.json`, `metrics <NNN>` |
| B | `langflow-e2e-issues` (prose) | none — measured via gh proxies only (do NOT instrument it; it is the control and must run unmodified) |

## Pairing & ordering rules

1. Compare only issues of the same type class: pair new-spec with new-spec,
   validate-&-promote with validate-&-promote. Never cross types.
2. Target mix: 3 new-spec pairs + 2 validate-&-promote pairs (adjust to what
   the current wave offers). fix/daily-failure issues join only if both arms
   get one of similar shape.
3. Alternate arms strictly: A, B, A, B, … in issue-number order as picked from
   the wave. Prevents nightly/wave drift from loading one arm.
4. One session per run. If a run spans sessions (compaction, next day), note
   it — wall-clock becomes unreliable for that row.
5. An aborted/parked run still counts as a row (outcome = aborted). Silent
   retries with the other arm on the same issue are forbidden — that
   contaminates the pair; mark the pair broken instead.

## Metrics

**Primary (available for BOTH arms — the only basis for A-vs-B claims):**

| Metric | Source |
|---|---|
| Wall-clock: assigned → report delivered | gh timeline (`gh issue view NNN --json timelineItems` — assigned event) → time of the PT-BR report message |
| Wall-clock: assigned → PR opened / merged | gh timeline + `gh pr view --json createdAt,mergedAt` |
| User interventions (count) | corrections/redirections the user had to type mid-run (not approvals; count messages that changed course) |
| Gate misses | process errors caught AFTER the report: missing force-fail, unproven green, spec-doc gaps, PR checklist items — from user review or PR review |
| Outcome | merged clean / merged after fixes / parked / aborted |
| Tokens (if visible) | session usage for the run's span; mark "n/a" when unmeasurable |

**Secondary (arm A only — context, never A-vs-B evidence):**
per-phase durations, attempts, escalations, FF entries — from `metrics <NNN>`.

## Run log

Append one row per run. Machine-written half for arm A (`metrics` output),
hand-filled for arm B.

| # | Arm | Issue | Type | Assigned→Report | Assigned→PR merged | Interventions | Gate misses | Outcome | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A | #486 | new-spec | ~20 min (sum of step wall-clock 19.6 min; single session 2026-07-07) | PR #567 merged 2026-07-08T12:01:58Z (assigned→merged spans a user-deferred overnight park — not comparable as skill latency) | 0 (checkpoints were approvals only: "segue" ×3) | 0 (merged clean, issue auto-closed) | merged clean | 6 green retries=0 runs; 2 FF red+revert. Arm-A friction: 4 pipeline defects found & fixed mid-run (dep-check bold regex, Last-validated regex, untracked files missing from diff → burst/FF would have been silently skipped, pretty-JSON parser). VALIDATE attempts=4 includes the parser failure + false nightly-mismatch warning (base/arch tag picker). |
| 2 | B | #495 | new-spec | ~16 min (assign ~01:47Z → report 02:03Z, 2026-07-08; single session — gh AssignedEvent query returned empty, time approximated from session flow) | PR #572 merged 2026-07-08T13:27:29Z (assigned→merged spans user-deferred parking — not comparable as skill latency) | 0 (checkpoints were approvals only: "segue" ×2) | 0 (merged clean, issue auto-closed) | merged clean | 7 green retries=0 runs total (2 tests each; runs 5-7 re-burst after a user --debug session showed a retry — attributed to inspector pause eating expect timeouts, not flake); 2 FF red+revert (M1 impossible-date, M2 inverted-absence), revert proven (0 markers) + final green; typecheck/lint 0; @stable + §6.5 [x]. Source-dive found the {current_date} prompt-leak trap before implementation — zero debug cycles. No tooling friction (prose arm). |
| 3 | A | #487 | new-spec | ~35 min single session 2026-07-08 (per-step metrics undercount: SPECIFY/PLAN/IMPLEMENT show 0s because `complete` was called without an intervening `next` — instrumentation note, fix candidate) | PR #574 merged 2026-07-08T13:20:04Z (same-session, ~1h assigned→merged incl. user checkpoints) | 0 (approvals only: "segue" ×2 + 1 quality question answered pre-PR) | 0 (merged clean, issue auto-closed) | merged clean | 4 green retries=0 runs (3-burst first-try + post-FF green); FF M1/M2 red via ff-run; deterministic-by-design (no model-recall asserts, #482 lesson applied at design time); testids inferred from family pattern held first try. Zero pipeline defects this run (vs 4 in run 1) — the run-1 fixes held. |

| 4 | B | #488 | new-spec | ~14 min (assign ~13:33Z → report 13:47Z, 2026-07-08; single session — gh AssignedEvent query returned empty again, time approximated from session flow) | PR #575 merged 2026-07-08T13:56:14Z (same-session, ~23 min assigned→merged incl. user checkpoints) | 0 (approvals only: "segue" ×2 + quality question answered pre-PR) | 0 (merged clean, issue auto-closed) | merged clean | 4 green retries=0 runs per test (isolated + 3 full-file bursts + post-FF final); FF M1 (inverted negative) / M2 (never-seeded sentinel) / M3 (stale context) all red, revert proven (0 markers). 2 implementation defects found via red runs (inspector Close button; playground draft on reopen) — 2 debug cycles vs 0 in row 2 (source-dive there pre-empted them). Machinery reuse from #487 heavy (seed/PATCH/retrieval/monitor copied); closes pair 2. No tooling friction (prose arm). |

| 5 | A | #491 | new-spec | ~70 min work (per-step sum minus AWAIT_PR_AUTH park: INTAKE 0.5 + CLASSIFY 1.3 + SPECIFY 8.6 + PLAN 4.5 + IMPLEMENT 1.1 + VALIDATE 46.7 (attempts=4 — real flake hunt) + FF 6.3 + REPORT 0.7; single session 2026-07-08) | PR #578 merged 2026-07-08T17:22:18Z (same-session; opened→merged 9 min) | 0 (approvals only: "pode seguir"/"segue" + quality question answered pre-PR) | 0 (merged clean, issue auto-closed) | merged clean | Heaviest run yet: 2-mode flake root-caused (frontend drops model selection → legacy gpt-5.5-pro fallback; product-bug candidate flagged on PR) via build-payload capture + container-log timestamp correlation; 2 setup guards shipped, asserts untouched. 12 consecutive green t2 runs + 3 full-file post-guards. FF M1/M2/M3 via ff-run, revert gate (0 markers + final green; final-green gate caught 1 residual flake occurrence and forced a re-run — gate working as designed). Pipeline friction: leftover scout .spec.ts was auto-picked as a burst target (untracked-diff scan working as designed, but cost one burst cycle); FF complete gate correctly refused until a post-revert green ran. |

| 6 | B | #498 | new-spec | ~55 min work (single session 2026-07-08; includes infra provisioning: local Ollama container + model pull + SSRF root-cause + Langflow container restart) | PR #582 merged 2026-07-08T19:17:35Z (opened→merged ~2h incl. user questions on determinism + CI story) | 1 (docker rmi denied by permission classifier → user freed disk himself; plus quality question answered pre-PR) | 0 (merged clean, issue auto-closed) | merged clean | Closes pair 3. Infra-heavy run: provisioned Ollama (docker + llama3.2:1b), root-caused SSRF 400 on host.docker.internal (LANGFLOW_SSRF_ALLOWED_HOSTS), found Settings idempotency defect via burst (saved value → Save disabled; API variable reset). 6 green retries=0 runs + skip-path proven (dead URL → 2 skipped). FF M1/M2/M3 red + revert. Spawned follow-up #583 (CI Ollama service) + live CI experiment via manual.yml dispatch from branch. No tooling friction (prose arm). |

| 7 | A | #501 | validate-&-promote | ~14 min work (per-step: INTAKE 0.3 + CLASSIFY 2.3 + SPECIFY 3.4 + PLAN 0.2 + IMPLEMENT 0.9 + VALIDATE 2.2 + FF 3.1 + REPORT 0.4; single session 2026-07-08 — first promote-type run) | PR #587 merged 2026-07-08T21:33:29Z (opened→merged ~3 min) | 1 mid-run interrupt NOT charged to the arm (webhook WIP from the user's OWN parallel session blocked the spec-first gate — parked, later merged by that session as PR #591; the gate catching it is arm-A value, the interrupt itself is environmental) | 0 (merged clean, issue auto-closed) | merged clean | Promote path exercised gates well: FF-audit correctly failed the baseline (utility spec had ZERO force-failability — "never throws" contract), hardening = spec-level outcome asserts (helper stays tolerant); 4 PT log strings fixed (language rule). FF M1 phantom-provider / M2 inactive-needs-models / M3 behavioral file-delete all red via ff-run; revert gate + final green (regenerated the M3-deleted models.json). 4 green retries=0 runs. User validated manually mid-AWAIT (asked debug cmd; one cosmetic ✗ step explained — swallowed 15s toggle wait on keyless provider). |

| 8 | B | #503 | validate-&-promote | ~15 min to first report (assigned 00:43Z → report ~00:58Z, 2026-07-09) + ~20 min cleanup addendum after user intervention (see Gate misses) | PR #592 opened 01:59:25Z, merged 2026-07-09T02:06:19Z (opened→merged ~7 min; assigned→merged ~1h23 incl. user checkpoints) | 1 (user had to ask for flow cleanup after the report — "no final o flow precisa ser excluido"; the delivered spec leaked 2 flows/run. Not counted: pre-work env blocker — first ANTHROPIC key valid but unfunded, user saved a second key; and a classifier denial on deleting the #464 SURVIVOR flow, resolved by narrowing scope) | 1 (missing id-scoped flow cleanup caught by user post-report — the EXACT class of the pair-1 shared fix and #501's arm-A FF-audit territory; prose arm re-missed a known lesson) | merged clean (after pre-PR fix) | Closes pair 4. Resolved as a dedicated spec (issue delegated the choice) completing the provider family §7.2/§7.4/§7.6: configure (causal request asserts) + select+execute (sentinel) + switch Haiku→Sonnet→Opus (exact-name dropdown asserts; Opus selection-only for cost). Zero-credit key trap found live and documented (unfunded key passes configure, fails inference — collect-models is the gate). 6 green retries=0 full-file runs; FF M1 garbage-key / M2 wrong-family regex / M3 stale-dropdown / M4 behavioral cleanup-no-op (2 orphans observed) all red + revert (0 markers) + skip-path proven. 12 pre-existing orphans purged. Collateral find: google/openai-provider specs share the same leak (no afterEach) — follow-up candidate. No tooling friction (prose arm). |

| 9 | A | #499 | new-spec | ~40 min work (assigned ~02:59Z → report ~03:40Z, 2026-07-09; single session. Per-step metrics again undercount — CLASSIFY/SPECIFY/PLAN/IMPLEMENT read ~0 because `complete` fired without an intervening `next`; the row-3 instrumentation defect, still unfixed. VALIDATE 1.4 min + FF 1.8 min are real) | PR #601 opened 2026-07-09T13:30:19Z, merged 13:33:39Z (opened→merged ~3 min; assigned→merged spans a user overnight park — not comparable) | 0 (approvals "segue" ×2 + "gere a PR"; 4 quality questions answered pre-PR: test command, what it does, FF done?, deterministic?, latest nightly? — same checkpoint class arm B receives) | 0 (merged clean, issue auto-closed) | merged clean | Extension pair 5 (new-spec — the issue turned out Create-new-spec, not promote as assumed when picking Groq/Mistral). PREMISE CHANGE caught in PLAN by live scout: Groq absent from Settings → Model Providers UI while GET /api/v1/models/providers lists it — spec doc rewritten to a component-only journey (Ollama-mirror) and re-confirmed with the user before IMPLEMENT (spec-first honored); UI/API divergence flagged on the PR as a product observation. Scout also verified the live-catalog refresh behavior (dropdown gains live-only llama-4-scout after key fill). 4 green retries=0 runs (3-burst + final-green gate); FF M1 garbage-key / M2 wrong exact-name via ff-run, revert (0 markers); probe-gated skip path; 0 orphan flows (finally cleanup, applied without user prompting — the pair-4 lesson HELD in arm A). .env.example gained GROQ_API_KEY/GROQ_TEST_MODEL. Friction: playwright-cli scout fought the canvas UI a bit (stale refs, hotkey modal, fill-vs-search race) — scouting cost ~10 min of the 40. |

| 10 | B | #500 | new-spec | ~12 min to report (assigned 13:38:50Z → report ~13:50Z, 2026-07-09; single session) | PR #602 opened 2026-07-09T13:52:16Z, merged 13:55:28Z (opened→merged ~3 min; assigned→merged ~17 min — fastest full cycle of the benchmark) | 0 (approvals + 1 preemptive user REMINDER at spec-confirm — "nao esqueca do force fail e de ser deterministico, excluir flow ao final" — which changed nothing: the confirmed doc already contained all three; noted because it shows the user no longer trusts arm B's memory unprompted after pair 4) | 0 (merged clean, issue auto-closed) | merged clean | Closes pair 6 / the extension. Completes §7.6 (Ollama+Groq+Mistral). Heavy reuse of #499's skeleton and discovery (component-only journey, probe pattern, handle-wiring); source-dive found the deviations up front (static 6-option dropdown, api_key not real_time_refresh, default codestral-latest → exact-name assert has real bite). Live scout for mistralaimodelcomponent testids (~4 min, no friction this time). 4 green retries=0 runs (~11-13s); FF M1 garbage-key / M2 wrong exact-name / M3 behavioral cleanup-no-op (1 orphan observed → reverted → 0 orphans); probe-gated skip; .env.example updated. Cleanup was in the spec doc BEFORE the user's reminder — the pair-4 lesson held in arm B this time. No tooling friction (prose arm). |

**Post-report shared fix (2026-07-08, applies to BOTH pair-1 rows):** user
question ("are created flows deleted?") exposed a leak — the whole Simple
Agent spec family lost cleanup when #553 removed the wipe from
`loadTemplateByName` (POM discards the returned id; stale comments claimed the
wipe still existed). Both pair-1 specs got id-scoped `afterEach` cleanup
(collect-all flows-POST listener — the first-POST id is transient and 404s),
behavioral FF per spec (cleanup no-op → 1 orphan observed; revert → 0 orphans
across 4 runs), +3 green retries=0 runs each, 38 pre-existing orphans purged.
Counts as 1 shared post-report intervention for BOTH arms (defect inherited
from the family sibling, not arm-specific). Family-wide leak = follow-up issue
candidate (not yet opened). Upstream converged: #547 shipped the canonical
`deleteFlow` helper (throw-on-failure, 404=done) the day after — the #495 spec
swapped to it pre-PR (1 green run + 0 orphans reconfirmed); the merged #486
spec keeps the raw delete (candidate for the family follow-up).

**Post-merge drift event (2026-07-08, row 1, NOT a gate miss):** hours after
#567 merged, gemini-3.5-flash drifted server-side (verification search call
appended after a correct fetch) and broke the sibling-tool-absent assert —
proven external via control run on the previous day's dev34 image (identical
failure; sources byte-identical). Fix PR #571 (first-tool-call assert,
anchored to #486, no tracking issue by user decision) merged
2026-07-08T12:53:02Z — before the next daily-stable run, so no auto-issue. Charged to neither
arm: external provider drift, detectable only by re-running post-merge.

## Collection commands

```bash
# assigned timestamp
gh issue view NNN --repo oriontech-me/langflow-e2e --json timelineItems \
  --jq '[.timelineItems[] | select(.__typename=="AssignedEvent")][0].createdAt'
# PR timestamps
gh pr view <url> --json createdAt,mergedAt
# arm A per-step detail
npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts metrics NNN
```

## Decision criteria (after ≥4 completed pairs)

- Pipeline wins a pair when: fewer gate misses, AND interventions ≤ prose,
  AND wall-clock within 1.5× of prose (slower is acceptable if it buys
  correctness; 1.5×+ slower with no correctness gain is a loss).
- 3+ pairs won → pipeline becomes the default for wave issues; prose kept for
  types the pipeline handled poorly.
- Split or noisy → keep coexistence, extend by 2 pairs.
- 3+ pairs lost → park the pipeline, write down why per-pair.

## Decision analysis — 2026-07-09, after 4 completed pairs (8 runs, all merged clean)

Per-pair scoring against the criteria above (win = fewer gate misses AND
interventions ≤ prose AND wall-clock within 1.5×):

| Pair | Type | A | B | Verdict |
|---|---|---|---|---|
| 1 | new-spec | #486: 20min, 0/0 | #495: 16min, 0/0 | **Tie** — identical quality; wall-clock within 1.25×. Post-report cleanup fix was a SHARED miss (charged to both). |
| 2 | new-spec | #487: 35min, 0/0 | #488: 14min, 0/0 | **Nominal loss for A** (2.5× slower, no correctness delta) — but heavily confounded: #487 built the seed/PATCH/retrieval machinery from scratch, #488 copied it. Difficulty asymmetry, not skill latency. |
| 3 | new-spec | #491: 70min, 0 int, 0 miss | #498: 55min, 1 int, 0 miss | **Tie** — both heavyweight for different reasons (flake root-cause vs infra provisioning); wall-clock 1.27×; A had fewer interventions but equal gate misses. |
| 4 | validate-&-promote | #501: 14min, 0/0 | #503: ~35min, 1 int, 1 miss | **Clean win for A** — same type and scale; prose re-missed the flow-cleanup class (the pair-1 lesson AND the exact territory #501's FF-audit gate mechanically enforces); A was also faster. |

Aggregate: **1 win, 1 confounded loss, 2 ties → split/noisy.** Per the
criteria: **keep coexistence, extend by 2 pairs.**

Qualitative signal accumulated across arm A (context, not score): the gates
did real work in every A run — spec-first blocked a foreign WIP (#501),
final-green caught a residual flake (#491), FF-audit failed a
zero-force-failability baseline (#501), the ff-run ledger refused unproven
FF reports (#486). Prose matched A's quality whenever the operator
remembered the lessons; the one divergence (pair 4) is exactly the case
where a mechanical gate remembers and prose recall didn't. Directional, n=1.

Extension plan (2 more pairs to break the split):
- Candidates: #499 Groq / #500 Mistral (validate-&-promote shape, both need
  user-provided API keys) — a natural same-type pair, one per arm, strict
  alternation continues (next run = A).
- Fix before extending (arm-A backlog, none block a run): per-step metric
  undercount when `complete` fires without an intervening `next` (row 3);
  untracked scout-spec pickup as burst target (row 5 — consider excluding
  `scout-*` globs).

## FINAL decision — 2026-07-09, after 6 pairs (12 runs, all merged clean)

Extension pairs:

| Pair | Type | A | B | Verdict |
|---|---|---|---|---|
| 5 | new-spec | #499: ~40min, 0/0 | — | Paired with 6 (same §7.6 shape). |
| 6 | new-spec | — | #500: ~12min, 0/0 | **Tie on quality; A 3.3× slower — the SAME first-mover confound as pair 2**: #499 (A, first) paid the discovery (premise change, component-journey design, scout friction); #500 (B, second) copied the skeleton and deviations were found by a cheap source-dive. |

**Final tally: A 1 win (pair 4) · 2 nominal speed losses (pairs 2, 5/6 — both
first-mover-confounded) · 3 ties. Split → per the criteria, COEXISTENCE is the
formal outcome.**

What 12 runs actually established:

1. **Quality is indistinguishable when the operator's memory holds** — 12/12
   merged clean, 1 gate miss total (B, pair 4).
2. **The one real differentiator is memory decay**: B's single miss was
   re-forgetting an already-learned lesson (flow cleanup); A's FF-audit gate
   covers that class mechanically. After pair 4, B held the lesson (pair 6 —
   cleanup was in the doc before the user's preemptive reminder), but the
   user's trust shifted: they now remind B unprompted.
3. **Wall-clock differences are dominated by issue order, not by arm** —
   whoever goes first on a new pattern pays discovery; the second run reuses.
   Never compare A-vs-B speed without checking who moved first.
4. **A's gates fired usefully in every A run** (foreign WIP, residual flake,
   zero-force-failability, unproven FF) at near-zero marginal cost once the
   run-1 defects were fixed. A's remaining friction: metrics undercount
   (unfixed) and scout-file pickup (unfixed).

**Adopted policy (proposed to the user):** coexistence with a role split —
**pipeline (A) as the default for wave issues**, because its wins are on
correctness-enforcement classes and its cost is now marginal; **prose (B)
for repeat-pattern issues on well-trodden ground** (family siblings, docs-only
closures) where its lower ceremony is the whole difference, and for shapes the
pipeline doesn't encode (daily-failure triage, infra-heavy provisioning).
Fix the two open A defects (metrics undercount, scout-glob exclusion) before
the next wave.

## Known biases (accept, don't correct mid-flight)

- Issue difficulty varies within a type — pairing softens, doesn't remove.
- Arm B wall-clock includes the user's reading/typing cadence; so does A's.
  Interventions metric partially controls for it.
- The operator (Claude + user) learns across runs — alternation spreads the
  learning effect over both arms.
- n≈5 per arm: report results as directional ("pipeline missed 0 gates in 5
  runs vs 4 in 5"), never as percentages.

## Boundaries

Git-ignored like everything in this directory — never commit or reference
from tracked files. Fill the run log here; arm A's raw JSONs stay in
`.claude/issue-pipeline/` (don't delete them until the benchmark closes).
