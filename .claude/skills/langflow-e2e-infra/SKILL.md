---
name: langflow-e2e-infra
description: >-
  Use when the task concerns the E2E suite's INFRASTRUCTURE layer rather than
  test authoring (oriontech-me/langflow-e2e) — CI workflows
  (.github/workflows/*), scripts/*, playwright.config.ts, reports/ run-history,
  the daily's off-Actions reporting scripts, or a qa-infra-labelled GitHub issue.
  Triggers: "otimiza/melhora a
  infra dos testes", "resolve a issue qa-infra #NNN", daily slowdown, single-
  backend saturation, sharding, low-concurrency lane, collect-models skips/403,
  flaky-under-load, CI runner sizing, pre-flight gate, LLM mocking, external-
  dependency hard-fail, isolation/cleanup race.
---

# Langflow E2E — Infrastructure

Owns the **infrastructure layer** of this suite: continuous improvement of CI,
tooling, and harness reliability, plus end-to-end resolution of `qa-infra`
GitHub issues. It is the fifth team skill and the only one that owns the infra
layer — the four test-oriented siblings revolve around test authoring and
product-bug triage.

Repo: `oriontech-me/langflow-e2e`. Infra work is gated by `ROADMAP.md` waves like
any other work — resolve the current wave live, never hardcode it.

## Scope — owns vs. defers

**Owns:**
- `.github/workflows/*` — nightly, daily-stable, pr-validation, manual,
  file-watcher, update-coverage-summary, migration, triage-dispatch.
- `scripts/*` — start/stop Langflow, collect-models, history appender,
  coverage-summary, stable-tests, checklist guards.
- `playwright.config.ts` — parallelism, workers, retries, timeouts, reporters,
  lanes.
- `reports/` (run-history JSONL + schema).
- The `qa-infra` issue class end-to-end.

**Defers (invoke the owner, don't improvise):**
- `.spec.ts` authoring + spec docs under `docs/` → **`langflow-e2e`** (invoke it
  when an infra fix needs a test-side change, e.g. migrating a spec to API
  creation + id-scoped cleanup).
- Classifying a raw daily red into product-vs-infra issues → **`langflow-e2e-triage`**
  produces the issues; this skill consumes the `qa-infra` ones.
- QA-CHECKLIST generated blocks — never hand-edited (repo rule).

## When to use this vs. the test skills

| Task | Skill |
|---|---|
| Author/fix a `.spec.ts`, spec doc, POM, helper | `langflow-e2e` (+ `-issues` / `-issue-deterministic` to wrap an issue) |
| Triage a daily red into dedicated issues | `langflow-e2e-triage` |
| Change a workflow / script / `playwright.config` / reporting; resolve a `qa-infra` issue; make the suite faster/less flaky at the infra level | **this skill** |

Rule of thumb: if the diff lands in `.github/`, `scripts/`, `playwright.config.ts`,
or `reports/` — it's here. If it lands in `tests/` product logic — it's `langflow-e2e`.
A fix that spans both: drive it here, delegate the `tests/` edit to `langflow-e2e`.

## Language rule (always)

Talk to the user in **Portuguese (PT-BR)**; produce every technical artifact
(YAML, scripts, config, commit/PR/issue text, branch names, this skill) in
**English**. Repo rule — see `CLAUDE.md`.

## Hard gates (non-negotiable)

- **Propose → confirm, for issues AND PRs.** Present findings / the fix, then
  **wait**. Only run `gh issue create` or `gh pr create` / push when the user
  explicitly authorizes it ("abre a issue", "manda o PR"). Consistent with
  `langflow-e2e-triage` and the repo's external-action rule.
- **Evidence before assertions.** Never claim a workflow is fixed or the suite is
  faster without proof. Scripts/config are proven locally; workflow YAML that
  can't run locally is declared as such — its final proof is the next CI run.
  Confirm any test-run result from the run's final `N passed`/`N failed` summary,
  never a premature signal.
- **One issue at a time**, its own branch (`type/issue-NNN-desc`, never `main`).
- **Every final report ends with (user rule):** (1) what changed and why, per
  file; (2) the **copy-paste command** to reproduce/verify locally — including
  env overrides, the `--debug` variant where relevant, and the expected outcome.
  For infra with no local proof path, state exactly which CI run proves it and
  what to watch.
- **Touch a spec → clean its flows.** Any infra fix that edits a flow-creating
  spec ships id-scoped `afterEach` cleanup, checks the orphan count via
  `GET /api/v1/flows/` before reporting, and purges leaked orphans.

## Two modes

Track every phase with TodoWrite.

### Mode A — AUDIT (continuous improvement)

Trigger: `/langflow-e2e-infra`, "audita a infra", "onde melhorar a infra".

1. **Inventory** the live infra state:
   - workflows (`.github/workflows/*`), scripts, `playwright.config.ts` knobs;
   - recent daily durations + failure counts — `reports/daily-history.jsonl`
     (schema in `reports/README.md`; example `jq` queries there);
   - open `qa-infra` issues — `gh issue list --label qa-infra --state open`.
2. **Rank** improvement opportunities by leverage against the failure-mode index
   (`references/failure-modes.md`). Prefer levers that cut recurring pain
   (saturation, silent skips, external-dep hard-fails) over cosmetic wins.
3. **Dedup** against open `qa-infra` issues and in-flight roadmap items — never
   propose what's already tracked; link the existing issue instead.
4. **Propose → confirm.** Present ranked findings (leverage, effort, evidence).
   Open `qa-infra` issues only after explicit authorization, and only if they
   fit the current wave or trace to an approved exception (`ROADMAP.md` → Intake).

### Mode B — RESOLVE (issue → PR)

Trigger: `/langflow-e2e-infra #NNN`, "resolve a issue qa-infra #NNN".

1. **INTAKE** — load and assign:
   ```bash
   gh issue view <NNN> --repo oriontech-me/langflow-e2e --comments
   gh issue edit <NNN> --repo oriontech-me/langflow-e2e --add-assignee @me
   ```
   Confirm roadmap linkage (wave item or approved exception). Restate in PT-BR
   what the issue asks and which subtype you classified.
2. **CLASSIFY** the infra subtype (`references/failure-modes.md` maps each to its
   canonical lever + authoritative doc):

   | Subtype | Signal | Lever / owner doc |
   |---|---|---|
   | CI-workflow | `.github/workflows/*`, ci(...) | edit YAML; prove via `manual.yml` / next CI |
   | script | `scripts/*`, collect-models, history | run locally + `typecheck`/`lint` |
   | config | `playwright.config.ts`, workers/lanes/retries | parse-check + targeted run |
   | history-reporting | `reports/`, coverage-summary | `reports/README.md` |
   | external-dependency | httpbin/postman/npx-server hard-fail | decouple / mock (#462/#463/#639/#883) |
   | isolation-cleanup | cross-worker flow deletion, POST 500 race | id-scoped cleanup + API creation (#515/#588/#605) |
   | provider/collect-models | 403, silent skip, missing pip pkg | buildable probe + skip-credentials (#570/#873/#900) |

3. **DIAGNOSE** via `superpowers:systematic-debugging` + the failure-mode index.
   For a load/saturation symptom, reproduce with `--workers=N` locally before
   assuming a product regression (`ISSUE-817-CI-RUNNER-SIZING.md`).
4. **FIX** in the correct layer. If the root fix is a test-side change, delegate
   the `tests/` edit to `langflow-e2e`.
5. **VALIDATE** (below) → **propose → confirm** the PR.

## Validate before the PR

- **Scripts / config:** run locally — `npm run typecheck`, `npm run lint`,
  execute the script, parse-check `playwright.config.ts`, and a targeted
  `npx playwright test … --workers=1` when the change affects execution.
- **Workflow YAML:** validate structure; it can't fully run locally — **say so**.
  Dry-run via `manual.yml` (or `act` if available); otherwise state plainly that
  the final proof is the next daily / PR-CI run and name what to watch.
- **Never claim green without evidence.** End with the reproduce/verify command
  and expected outcome, or the exact CI run that will prove it.

## Companion skills — invoke when needed

- **`langflow-e2e`** — owns all test-authoring conventions; invoke when an infra
  fix needs a `tests/` edit (spec migration, helper, POM, cleanup).
- **`langflow-e2e-triage`** — upstream producer of `qa-infra` daily-failure
  issues; this skill consumes them.
- **`superpowers:systematic-debugging`** — root-cause before fixing any infra
  failure mode.
- **`playwright-cli`** — drive a live browser to reproduce a load/flake symptom
  under controlled concurrency.

## Knowledge base — thin indexes, not a new catalog

The repo already records resolved-infra context. These references **point** to
that source of truth and capture only the connective tissue not yet written down.
Same discipline as the skills `README.md` ("don't restate — point").

- **`references/infra-map.md`** — CI / scripts / config topology: one line per
  workflow, script, and key config knob, each linking to its file or owner doc.
- **`references/failure-modes.md`** — a **symptom → lever** index: each recurring
  infra failure class maps to the canonical fix pattern, the authoritative
  in-repo doc, and the issue/PR IDs. Restates nothing a linked doc already says.

Authoritative sources these link into: root `ISSUE-*.md` postmortems/designs,
`docs/collect-models.md`, `CONTRIBUTING.md` (@stable lifecycle, triage protocol,
run-history monitoring, false-positive anti-patterns, impacted-tests subset),
`reports/README.md`, `ROADMAP.md` (Wave 3), and the closed `qa-infra` issues/PRs.

## Red flags — STOP

- About to `gh issue create` / `gh pr create` / push without explicit authorization → stop, report & wait.
- Claiming a workflow is fixed with no local proof and no named CI run to watch → not validated.
- Diagnosing a load symptom as a product regression before reproducing under controlled `--workers=N` → reproduce first (`ISSUE-817`).
- Editing `tests/` product logic directly instead of delegating to `langflow-e2e` → wrong layer.
- Hand-editing QA-CHECKLIST generated blocks, or committing `npm run coverage:summary` output in a PR (issue #741 guard) → edit bullets/tags only.
- Restating a postmortem/doc inside a reference instead of linking it → indexes point, they don't copy.
- Touching a flow-creating spec without id-scoped cleanup + orphan check → clean flows, always.
- Picking up off-wave infra work with no approved exception issue → confirm roadmap linkage first.

## Boundaries

`CONTRIBUTING.md` and `ROADMAP.md` are repository conventions and outrank this
skill; on any conflict, follow them and fix the skill. This skill is versioned in
`.claude/skills/` and shared with the team — keep it accurate and English-only.
It owns the infra layer; the authoritative infra knowledge lives in the linked
repo docs and the two references — read them, don't restate them.
