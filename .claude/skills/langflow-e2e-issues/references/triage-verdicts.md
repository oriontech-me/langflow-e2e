# Failure-triage verdicts & evidence playbook

Loaded on demand from SKILL.md → CLASSIFY. Full decision framework for
routing a failing/suspicious behavior before "fixing" anything.

**Test defect vs Langflow regression — decide with evidence, at ANY phase.**
Not every failing test means the test is wrong: the product itself regresses
(this suite exists to catch exactly that). Whenever a failure/behavior looks
broken — in the issue body, during reproduction, or when a previously-green
spec starts failing — run this split before "fixing" anything:

1. **Reproduce OUTSIDE the test harness** — drive the same steps manually via
   `playwright-cli` and/or the REST API. Harness passes but manual fails (or
   vice-versa) ⇒ test defect. Both fail the same way ⇒ product candidate.
2. **Check the Langflow source in the container** (`docker exec … cat` the lfx
   backend / grep the frontend bundle) — does the code still implement the
   expected contract? A field/validation/endpoint that no longer exists is a
   product change, not a selector to "heal".
3. **Correlate with the nightly delta** — did the failure start with an image
   bump? (`reports/daily-history.jsonl`, `npm run check:nightly-delta`,
   upstream commits from `file-watcher` issues.)

Route by the verdict:

- **Test defect** ⇒ fix the test (spec doc first), normal flow.
- **Langflow regression (confirmed live)** ⇒ it routes to Langflow
  engineering — **flag it to the user with the reproduction evidence and
  wait for their decision; never silently weaken/adapt the test to accept
  broken behavior.** Typical outcomes the user may pick: report upstream,
  gate the test `expected-fail` referencing the bug, or park the issue.
  (Real case: #505 — credential delete→re-add poisons the provider-key cache
  backend-side; the test was redesigned to stop touching the broken surface
  and the bug flagged, not papered over.)
- **Product changed intentionally** (feature removed/renamed upstream) ⇒ the
  spec's premise died — flag as not-implementable / re-scope on the issue,
  don't write a test against a surface that no longer exists. (Real case:
  #484 — `reasoning_effort` left the Agent with the model-bundle refactor.)
  Closure shape: evidence comment on the issue + a small docs-only PR
  annotating the checklist bullet ("not implementable on 1.11 — pending
  re-scope, see #NNN") + close (#484→#540, #496→#563).
  **Steelman before declaring a surface dead/no-op.** A partial audit
  produces overstated verdicts: in #496 the first verdict ("dead knob") was
  wrong — the flag's middleware CAN fire on a path the experiment didn't
  cover (LLM-emitted malformed args raise `ValidationError` because
  `handle_validation_error` is a SEPARATE flag Langflow doesn't set).
  Enumerate every trigger path (component tools, arg validation, MCP
  in-protocol vs transport, flow-as-tool, BaseException classes) and give
  each a source-level or empirical verdict before flagging
  not-implementable — the audit table IS the issue-closure evidence.
- **Third verdict for daily-failure triage: TRANSIENT (CI saturation).** When
  the failing daily had MANY simultaneous unrelated failures + backend 500s
  on unrelated endpoints, suspect the shared Langflow container saturated
  under the full parallel suite. Prove it on three environments: (1) local
  burst on the fresh nightly (`--retries=0`); (2) **the same CI environment
  isolated** — dispatch `manual.yml` scoped with `test_grep` (the workflow
  is normally disabled: `gh workflow enable manual.yml`, dispatch, then
  `gh workflow disable` to restore state); (3) contrast with the saturated
  run. Green on 1+2 with a correlated-collapse signature on 3 ⇒ restore
  `@stable` with no test change — do NOT loosen timeouts to "fix" it, that
  masks real regressions. (Real case: #549 — local 6/6 ~13s, isolated CI
  1/1 58.5s, daily run had 18 problem tests at once.)
- **Fourth verdict: CROSS-WORKER DESTRUCTIVE CLEANUP.** Saturation look-alike
  with a tell: the victim's failing-attempt stdout shows `404 "Flow not
  found"` on ITS OWN flow id — another worker's pre-test cleanup
  (`cleanAllFlows`, or any shared-name delete) wiped the in-flight flow.
  Fix the WIPER (id-scoped cleanup per authoring-conventions), never the
  victim — a bigger timeout can't resurrect a deleted flow. Prove the
  mechanism with a saboteur loop (shell polling + deleting user flows while
  the victim runs → identical failure), and identify the collider by
  start-time overlap in the report JSON. (Real case: #553 — 3/3 failing
  attempts had a `memory-history-regression` test starting inside the
  failure window; its `loadTemplateByName` → `cleanAllFlows` was the wiper.)
  **Hunt wipers TRANSITIVELY** — a spec-level grep for `cleanAllFlows` misses
  indirection: in #520 the wiper was `model-provider-model-toggle` via
  `SimpleAgentTemplatePage.load()` → `loadTemplateByName` → `cleanAllFlows`
  (a POM hop that hid a 15-spec / 11-`@stable` wiper family). Grep the POMs
  and helpers a suspect imports, not just the spec body. Same class, roles
  swap freely: #553's wiper (memory-history) was #520's victim.
  GitHub quirk: a `Fixes #NNN` EDITED into an open PR's body may not
  auto-close that issue on merge — verify both issues' state post-merge and
  close manually with a reference comment if needed.

**Reading a daily flaky's evidence — artifacts before theories.** The failing
attempt's own artifacts usually name the killer; read them BEFORE designing
fixes: (1) `playwright-json-daily-<run>` artifact (small) → per-attempt
status/duration/error; (2) the big `playwright-report-daily-<run>` →
`index.html` embeds a base64 zip (script tag `id="playwrightReportBase64"`)
with per-test JSON naming each attempt's screenshot / `error-context.md` /
trace under `data/`; the attempt's **stdout** (fixture `🚨 Backend Error`
lines) and the error-context page snapshot are the highest-signal items;
(3) cross-reference `reports/daily-history.jsonl` for the flaky-tests list
per run. Count parallel-round results with `--reporter=json` + `jq .stats`,
never by grepping `\r`-interleaved output.

**Issue claims a "confirmed bug" / says to gate `expected-fail`? Reproduce it on
the live nightly FIRST — before designing.** A "confirmed bug" note can be stale:
the fix may have landed in a newer nightly. If reproduction shows the behavior now
**works**, do NOT ship a `test.fail()` gate (a `test.fail` on passing behavior
reports an immediate *unexpected pass* — a misleading, broken test). Instead flag
the fixed-bug to the user, write a **normal passing** test that proves the
behavior (a causal pair — the parameter set low vs high — beats a single
assertion), and note the deviation in the PR/issue. (Real case: `agent-max-iterations`
#481 — issue said "parameter ignored, gate expected-fail"; it was respected on the
current nightly.)

**Scout passes don't validate a spec — and a non-deterministic observable means
pivot, not iterate.** Two linked rules from `agent-n-messages-limit` #482:

- **Only bursts of the actual `.spec.ts` with `--retries=0` count as stability
  evidence.** Isolated scout runs of the same interaction passed 3/3 — then the
  spec-level burst failed 4/4. If a design's scout is green, still burst the real
  spec before trusting it.
- **When the target surface's only observable is inherently non-deterministic**
  (e.g. *model recall* of an old message at the memory-window threshold), and
  ~3 assertion/placement designs have failed bursts, stop redesigning the
  assertion — find a **deterministic observable of the same backend contract**
  (in #482: the Agent's `n_messages` and the Message History component resolve
  through the same `aget_messages(limit=n_messages)`; counting the component's
  retrieved messages replaced counting on the model to forget). This is the
  `systematic-debugging` "3+ failed fixes ⇒ question the architecture" rule
  applied to test design. A unit shift is a **deviation — flag it on the PR**
  with the flake evidence; don't ship the flaky design or silently weaken it.

