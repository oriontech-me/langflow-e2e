# Issue Template Reference

This document defines the canonical template and rules for dedicated-issue triage in the `langflow-e2e-triage` skill.

> **The body is rendered from code, not composed by hand.** `renderDedicatedIssueBody()`
> and `assertDedicatedIssueBody()` in `scripts/lib/triage-core.mjs` own the structure;
> Phase 7 calls them before `gh issue create`. This document explains *what each section
> is for* and *what belongs in it* — the renderer enforces that the sections exist, that
> every affected test carries a signature, and that at least one backticked spec path is
> present. Editing the shape here without editing the renderer changes nothing.
>
> Why code and not prose: `gh issue create` bypasses `.github/ISSUE_TEMPLATE` entirely,
> and the primary author of these issues is an LLM. A Markdown reference is advice; the
> renderer is a guarantee. (The GitHub issue form at
> `.github/ISSUE_TEMPLATE/failure-root-cause.yml` mirrors this same shape for humans
> opening a cause issue by hand through the web UI.)

## Scope — which issues this covers

Two issues get opened around a red daily; only one is templated:

- The **umbrella** is created by `daily-stable.yml` through the GitHub API
  (`github.rest.issues.create`), which no template can govern. Not this.
- The **dedicated per-cause issues** are created here, in Phase 7. These.

## Dedicated-Issue Template

When opening a new issue to track a daily-failure cluster, use this structure:

### Title
```
[Daily #<umbrella>] <symptom>
```

The `#` number is the **umbrella issue number**, not the run_id.

Example: `[Daily #744] agent/flow execution does not complete — div-chat-message / 'built successfully' never render (3 specs)`

### Body

**Provenance (first line)**

```
Spun out of daily-failure triage #<umbrella> (run [<run_id>](<run_url>), <date>).
```

**Upstream (second line)**

```
**Upstream:** LE-1234
```

The seam to the treatment layer. **This issue tracks the failure, not the fix** —
what gets done about it is worked on the Jira board, so the card key has to be a
field the body always carries. It is rendered as `_not filed_` when no card exists
yet (the normal state at triage time, since the card follows the investigation),
and the renderer never omits the line: an always-present slot is what makes the
failure → issue → card walk possible, and what lets the link be swept for
mechanically. Accepts a DataStax Jira key (`LE-####`) or a
`langflow-ai/langflow#N` issue.

Do **not** rely on the `REGRESSIONS.md` deliverable checkbox to carry this. That
checkbox is an acceptance criterion — it records that a row is owed, not where the
card is, and it vanishes from any sweep if nobody ticks it.

**Sections**

#### Symptom

A Markdown table with spec location, wait point, and failure signature. Format:

```markdown
## Symptom

Brief description of what failed (e.g., "Three @stable tests hard-failed with the same shape — **the flow/agent execution never completes**, so the expected output never renders").

| Spec (line) | Waits for | Signature |
|---|---|---|
| `path/to/spec.spec.ts:123` ("test name") | `getByTestId('element-id')` | `expect(locator).toBeVisible() failed` |
```

Include:
- Full repo-relative path to the spec file
- Line number where the test fails
- Human-readable test name (from `test()` or `test.describe()`)
- The locator/selector being waited on
- The `error_signature` **copied verbatim** from the run's row in
  `reports/daily-history.jsonl`

**The signature is copied, never written.** It is the key the same-signature
recurrence rule matches on (`CONTRIBUTING.md` → *Monitoring rules driven by run
history*), and `normalizeSignature()` only strips ANSI, collapses whitespace and
lowercases — it does not understand paraphrase. So:

- Copy the value out of the history row unedited. Do not shorten it, do not
  reword it, do not merge two tests' signatures into one description.
- If the run recorded `"unknown"` — which happens when the failure carried no
  error message — write `unknown`. Substituting a description of what you think
  happened makes the next run's occurrence unmatchable, and the flake rule then
  reads a recurrence as a first occurrence.
- ANSI codes are stripped by the renderer; a literal `|` is escaped so it cannot
  break the table. Both are safe to leave in the value you copy.

A paraphrased signature is the single most likely way per-cause issues quietly
degrade back into one issue per day for the same cause.

**Name every spec you are claiming, in backticked repo-relative form, on every
`daily-failure` issue** — in this table at triage time, and in follow-up comments
as the scope grows. The QA Platform parses those paths to decide whether a failure
on a run page is already being worked on, and shows a `tracked · #NNN` chip on the
matching failures. Comments count as much as the body: a broad investigation
naturally accumulates specs over time (see #773, which took on the whole
`llm-agents` cluster across four comments), and that is the expected shape — not
something to fold back into the opening post. What does *not* work is naming a spec
in prose only, without the path: `agent-max-tokens` alone is unmatchable, while
`` `core-functionality/llm-agents/agent-max-tokens.spec.ts:249` `` is not.

#### Why these failures are one cause

The linking argument for this cluster. Format:

```markdown
## Why these failures are one cause

All five failed inside the same 40s window on shard 3, every one on the first request issued after `Collect models`. The signatures differ (timeout, `toBeVisible failed`, 502) and no test-level change is common to them — the shared dimension is the backend they all hit, not anything in the specs.
```

The team files issues **per root cause, not per failing test**. That only works if
the grouping is stated and checkable; otherwise a cause issue and a pile of
unrelated failures filed together are indistinguishable — at triage time and, worse,
six weeks later when someone tries to reopen the reasoning.

Rules:
- Name the **shared dimension**: same window, same shard, same provider, same
  dependency, same step, same normalized signature.
- Say it explicitly when the signatures **differ** and you are grouping anyway.
  One cause routinely produces several signatures (a wedged backend surfaces as
  timeouts, `toBeVisible failed`, 5xx and `unknown` at once) — that is a legitimate
  grouping, but it has to be argued, not assumed.
- Equally, the same signature across unrelated specs is **not** by itself a cause.
  `expect(locator).toBeVisible() failed` is the most generic string Playwright
  emits and it collides constantly.
- Stay **descriptive**. Name what is shared, not what is broken — the mechanism is
  the investigation's job, and the section below exists precisely to keep that
  line intact.
- One cluster whose argument splits into two arguments is two issues. Split it
  and cross-link.

#### Preliminary read (descriptive — NOT a verdict)

Observations that *describe* the failure without claiming root cause. Format:

```markdown
## Preliminary read (descriptive — NOT a verdict)

This surfaced on a **mass-failure day** (27 hard + 27 flaky, guard tripped) and the "execution never completes" symptom is consistent with **provider latency / instance saturation under load** — i.e. possible wave collateral. But these are genuine final hard failures (they did not recover on retry), and the day-level environmental signal must **not** be assumed as the cause.
```

Use this to:
- State the failure pattern and symptom shape
- Note the environmental context (mass-failure day, guard signal, etc.)
- Cite related issues or specs where applicable
- **Do not conclude cause** — that is the investigation's job

#### Investigation directive

Independent, product-first paths. Format:

```markdown
## Investigation directive

Investigate all paths independently, **product as prime suspect first**: on the current nightly, confirm whether these flows actually execute to completion (agent responds / loop builds) before concluding provider/latency. Only after ruling out a regression, consider: (a) transient saturation → prove on 3 environments and restore; (b) wait-strategy fragility → harden the completion wait to a deterministic observable.
```

Rules:
- Always suspect **the product (Langflow) first** — test changes come after confirming the product behavior changed
- List all plausible root paths as independent branches (not nested conclusions)
- Mention concrete verification steps (e.g., "confirm on the current nightly", "reproduce live")
- Avoid verdict language ("likely caused by", "probably due to") — use "confirm whether", "rule out", "prove"

#### Deliverables (Done when)

A checkbox list of concrete acceptance criteria. Format:

```markdown
## Deliverables (Done when)

- [ ] Root cause confirmed per spec (product regression vs. test/wait-strategy vs. environment) with evidence on the current nightly.
- [ ] Each spec passes reliably (multiple clean `--retries=0` runs), fixing waits/flow as needed.
- [ ] **Quarantine lifted** in the fix PR — remove `test.fixme` **and** restore `@stable` (both were applied at triage as prevention for recurrent flakes; hard failures had only `@stable` auto-removed). Re-validate per `CONTRIBUTING.md` before lifting. *(On a guard-tripped mass-failure day nothing was quarantined — then there is nothing to lift unless the cluster later reproduces on a clean daily and is quarantined.)*
- [ ] If the root cause is a **product (Langflow) regression**: recorded as such here, and this issue stays **open** until the upstream fix lands in `langflowai/langflow-nightly:latest` (or the `release-1.x.x` branch), is re-validated there, and `@stable` is restored — not on a test-side mute.
```

Rules:
- Boxes are checkable (`- [ ]`)
- Each item is a single, verifiable outcome
- Include validation steps from `CONTRIBUTING.md` if the fix touches product code
- **Lifting the quarantine is always a deliverable** whenever a test was quarantined at triage (the normal case) — "done" includes removing `test.fixme` and putting `@stable` back after the fix. Only a guard-tripped day, where nothing was quarantined, has nothing to lift.
- A **product regression** closes only when the product is fixed where the suite runs (nightly / release branch), not on a test-side workaround

---

## Worked Example: Issue #751

Below is a real issue that exemplifies the template above:

---

**Title:**
```
[Daily #744] agent/flow execution does not complete — div-chat-message / 'built successfully' never render (3 specs)
```

**Body:**

Spun out of daily-failure triage #744 (run [29323509096](https://github.com/oriontech-me/langflow-e2e/actions/runs/29323509096), 2026-07-14). Surfaced while tracing serial-skip collateral during the skip review.

## Symptom

Three `@stable` tests hard-failed (final status, after retries) with the same shape — **the flow/agent execution never completes**, so the expected output never renders:

| Spec (line) | Waits for | Signature |
|---|---|---|
| `core-functionality/llm-agents/agent-component-regression.spec.ts:145` ("agent interaction suite") | `getByTestId('div-chat-message')` | `expect(locator).toBeVisible() failed` |
| `core-functionality/llm-agents/agent-input-sources.spec.ts:235` ("input via ChatInput handle drives the agent response") | `getByTestId('div-chat-message')` | `expect(locator).toBeVisible() failed` |
| `core-components/loop-component-regression.spec.ts:358` ("Loop component — stops after exhausting input DataFrame and emits aggregated done") | `text=built successfully` | `waitForSelector 60000ms timeout` |

All three load a template/pre-built flow and run it; the AI/agent message (or "built successfully") never appears within the timeout.

The serial siblings `agent-input-sources:271` and (unrelated) others were auto-skipped as a consequence.

## Preliminary read (descriptive — NOT a verdict)

This surfaced on a **mass-failure day** (27 hard + 27 flaky, guard tripped) and the "execution never completes" symptom is consistent with **provider latency / instance saturation under load** — i.e. possible wave collateral. But these are genuine final hard failures (they did not recover on retry), and the day-level environmental signal must **not** be assumed as the cause. Note: `loop-component`'s "Research Translation" variant is tracked separately in #722; this is a **different** loop test.

## Investigation directive

Investigate all paths independently, **product as prime suspect first**: on the current nightly, confirm whether these flows actually execute to completion (agent responds / loop builds) before concluding provider/latency. Only after ruling out a regression, consider: (a) transient saturation → prove on 3 environments and restore; (b) wait-strategy fragility → harden the completion wait to a deterministic observable.

## Deliverables (Done when)

- [ ] Root cause confirmed per spec (regression vs. provider/latency vs. wait-strategy) with evidence on the current nightly.
- [ ] Each spec passes reliably (multiple clean `--retries=0` runs), fixing waits/flow as needed.
- [ ] `@stable` was **left in place** (not confirmed a durable break; likely wave collateral) — if any is later fixed with a code change, re-validate per `CONTRIBUTING.md`.

Note: `@stable` was **kept** on these three (the mass-failure guard tripped and the driver for this cluster is not confirmed non-environmental). Quarantine only if the failure reproduces on a clean (non-wave) daily.

---

## Labels

Apply exactly two labels to every dedicated issue:

1. **`daily-failure`** — Always present; identifies this as a daily-run triage issue
2. **`area:<x>`** — One area label per issue, derived from the failing spec's directory path

### Area Label Mapping

| Spec directory | Label |
|---|---|
| `api/` | `area:api` |
| `core-components/` | `area:components` |
| `core-functionality/auth/` | `area:auth` |
| `core-functionality/llm-agents/` | `area:llm-agents` |
| `core-functionality/model-provider/` | `area:model-providers` |
| `core-functionality/observability-monitoring/` | `area:observability` |
| `core-functionality/playground/` | `area:playground` |
| `core-functionality/knowledge-ingestion-management/` | `area:knowledge` |
| `mcp/` | `area:mcp` |
| `ui-ux/` | `area:ui-ux` |
| `tests/pages/`, `tests/helpers/` | `area:pages-helpers` |

**Directories with no matching area label:** For spec directories without a corresponding `area:` label (e.g., `flow-functionality/`, `core-functionality/project-management/`, `core-functionality/templates/`, `smoke/`), apply `daily-failure` alone rather than creating a new area label. If the analyst judges one of the existing area labels a close fit, add that one in addition to `daily-failure`.

**No assignee** — leave blank. The issue is assigned to the wave/triage queue, not an individual.

---

## Quarantine mechanism

Quarantining a broken test (recurrent flake at triage) is **two edits, always applied together**, on the test's `test()` call:

1. **Remove `@stable`.** `QA-CHECKLIST.md` Phase 0 ("validated") is generated from `@stable` `test()` calls (`scripts/stable-tests.ts`); leaving the tag on keeps counting a quarantined test as validated.
2. **Add `test.fixme`.** Wrap the test with the Playwright-native quarantine primitive, carrying the reason + issue number:

```ts
// before
test("... title ...", { tag: ["@stable", "@components"] }, async ({ page }) => { ... });
// after (quarantined for #NNN)
test.fixme("... title ...", { tag: ["@components"] }, async ({ page }) => { ... });
```

**Why both — `@stable` removal alone is incomplete.** Removing `@stable` only stops the **daily** (`daily-stable.yml` runs `@stable` only). The test keeps running — and going red — in every other context: the `pr-validation.yml` **impacted-specs gate** (selects specs by *file diff*, not by tag, so any PR touching the file runs the broken test), `test:features`, `adaptive-impacted.yml`, and manual full runs. This is why a `@stable`-removal-only quarantine PR itself goes red on the impacted-specs gate (#871, seen on PR #870, merged red). `test.fixme` skips the test in **all** contexts, so the quarantine PR merges green and the noise stops everywhere.

**Restoration** (the dedicated issue's deliverable) is the exact inverse, in one PR after the fix: remove `test.fixme`, restore `@stable`, re-validate per `CONTRIBUTING.md`.

**Scope:** quarantine is for **recurrent flakes** removed manually at triage. Hard failures are auto-removed by the workflow (tag only, committed straight to `main` — no PR gate, so no red-PR problem); a hard-failure test that also needs `test.fixme` gets it when its dedicated `fix` issue is worked. On a **guard-tripped** day nothing is quarantined (tags kept).

---

## Flake-Signal Block

When an issue is opened to track a **recurrent flake** (a test failing on multiple separate daily runs, or a long-standing intermittent), include this block:

```markdown
## Flake signal

This test is confirmed recurrent (failed on dailies 2026-07-08, 2026-07-09, 2026-07-13). As prevention, it was **quarantined** at triage (PR #NNN) — `@stable` removed **and** `test.fixme` added — so it stops running in **every** context (daily, PR impacted-specs gate, full suite) until this issue is worked:

- `tests/tests-automations/regression/core-functionality/playground/playground-input-text-prefill.spec.ts` (test at line 97)

Lifting the quarantine after the fix (remove `test.fixme` + restore `@stable`) is a deliverable of this issue.
```

Rules:
- Include only when the failure appears across multiple independent daily runs
- List **exact spec file paths** and test line numbers
- Quarantine is manual (the workflow never auto-removes flakes) and happens **at triage as prevention** — not deferred until after the fix; link the quarantine PR (`#NNN`)
- Lifting the quarantine after the fix is an explicit **deliverable** of this issue

---

## Enrich vs Create Rule

**Before creating a new dedicated issue**, run:

```bash
gh issue list --state open --repo oriontech-me/langflow-e2e --label daily-failure
```

Then:

1. **If an open issue with the same root cause exists**, add a comment (do not create a new issue):
   ```markdown
   **Run [<run_id>](<run_url>)** – <date>
   
   Reproduced in this daily run (run <run_id>). Occurrence #N.
   
   **Signature:** <symptom signature, e.g., "getByTestId('div-chat-message') timeout (240s)">
   ```
   Cite the run ID (the GitHub Actions workflow run number) and link it. Include the occurrence count so investigators can see whether the flake is worsening.

2. **If the subject (symptom, specs, or root path) is genuinely new**, create the issue using the template above.

**Match on the normalized signature, not on a description of the symptom.**
Run each candidate's `error_signature` and the open issues' recorded signatures
through `normalizeSignature()` and compare the results. Matching on prose is what
lets the same cause read as new every morning — and one new issue per day for one
cause is per-test issues wearing a hat, which is the exact outcome the per-cause
policy exists to avoid.

**Matching logic:**
- Same normalized signature across different specs → **same issue, comment**
- Same spec failing at different lines (different tests) → likely same issue, **comment** (unless it clearly branches into separate root paths, then split)
- Same directory/feature but different signatures → **separate issues**, unless the *Why these failures are one cause* argument holds across them (a shared backend, provider or step can produce several signatures — see that section)
- Generic signatures (`expect(locator).toBeVisible() failed`, `unknown`) are **too weak to match on alone**. They collide across unrelated specs, and `unknown` is a null key that would cluster every message-less failure together. Require a second shared dimension — same spec, same provider, same run window — before treating them as one cause.

**Merge, not just split.** The rule runs both ways: two *open* dedicated issues
later found to share a cause get merged (keep the older number, close the newer
as a duplicate, cross-link both and carry over any spec paths the closed one
claimed — the QA Platform matches on those paths, so a path dropped in the merge
stops being tracked).

---

## Guard-Tripped Rule

When a daily run trips the mass-failure guard (`guard_tripped: true` in the daily report), the day is a mass-failure day — most likely environment-wide — so most failures are **collateral**, not independent regressions.

**0. Decide which clusters get a dedicated issue at all — this is the guard-day split:**

   - **Cross-day-recurrent clusters** (the same test + error signature also failed on other, *non-adjacent* dailies — `recurrence.same_signature` true with dates beyond today) reproduce on days that were **not** mass-failure days, so they are **durable** signals, not pure collateral. These **do** get a dedicated issue (create) or enrich their existing tracker — following rules 1–3 below.
   - **Today-only collateral** (failed only on this run, no cross-day recurrence) does **not** get a dedicated issue. Filing one is a throwaway tracker for what most likely vanishes when the instance recovers — the same reason a first-occurrence flake is noted, not filed. Instead, **note** it in the triage proposal (aggregated, with counts) and leave it under the umbrella.
   - **Keep the umbrella open.** On a guard-tripped run the umbrella issue is **not** closed at the end of triage — it is the standing record of that day's noted-not-filed collateral. It stays open, with a comment to recheck on the next clean, non-guarded daily; that later triage closes it once it confirms recovery, or promotes any cluster that persists into a durable dedicated issue.

Dedicated issues you **do** open on a guard day (the cross-day-recurrent ones) must follow these rules:

1. **Prefer aggressive grouping** — fold related failures (e.g., all sidebar-entry timeouts, all agent-execution timeouts) into a single issue rather than splitting by spec. A shared environmental signal is more parsimonious than many independent regressions on the same day.

2. **Note the environmental signal descriptively, never as a verdict:**
   ```markdown
   This surfaced on a **mass-failure day** (27 hard + 27 flaky, guard tripped) and the "execution never completes" symptom is consistent with **provider latency / instance saturation under load** — i.e. possible wave collateral. But these are genuine final hard failures (they did not recover on retry), and the day-level environmental signal must **not** be assumed as the cause.
   ```
   - State the guard signal (count, guard threshold crossed)
   - Name the plausible environmental cause (saturation, API outage, etc.)
   - Do not conclude it is the cause — only that it is consistent and must be ruled out

3. **State that `@stable` was left in place:**
   ```markdown
   Note: `@stable` was **kept** on these three (the mass-failure guard tripped and the driver for this cluster is not confirmed non-environmental). Quarantine only if the failure reproduces on a clean (non-wave) daily.
   ```
   When the guard trips, the triage scripts do **not** auto-remove `@stable` tags. The issue itself documents why they were left. If the cluster fails again on a non-guarded daily, then `@stable` is a candidate for quarantine.

---

## Summary

Every dedicated issue embodies this philosophy:

- **Provenance first:** readers know where the issue came from and when
- **Description before diagnosis:** symptom table + preliminary observations, no verdict
- **Signatures verbatim:** copied from the history row, `unknown` included — recurrence is matched mechanically, and a paraphrase breaks it
- **Grouping is argued, not assumed:** one issue per cause only means something if the issue says why these failures are one cause
- **Investigation as independent branches:** test the product first, then environment, then test design
- **Deliverables as checkboxes:** done when all items are ticked
- **Quarantine decisions are explicit:** quarantined at triage as prevention — `@stable` removed **+** `test.fixme` added (or nothing quarantined on a guard-tripped day) — and **lifted as a deliverable** after the fix — always documented

This ensures investigators inherit not just a failure, but the context and constraints needed to fix it efficiently.
