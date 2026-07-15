# Issue Template Reference

This document defines the canonical template and rules for dedicated-issue triage in the `langflow-e2e-triage` skill.

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
- The exact error message or timeout signature

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
- [ ] **`@stable` restored** in the fix PR — the tag was removed at triage as prevention (hard failures and recurrent flakes); re-validate per `CONTRIBUTING.md` before restoring. *(On a guard-tripped mass-failure day the tag is instead **kept** — then there is nothing to restore unless the cluster later reproduces on a clean daily and the tag is removed.)*
- [ ] If the root cause is a **product (Langflow) regression**: recorded as such here, and this issue stays **open** until the upstream fix lands in `langflowai/langflow-nightly:latest` (or the `release-1.x.x` branch), is re-validated there, and `@stable` is restored — not on a test-side mute.
```

Rules:
- Boxes are checkable (`- [ ]`)
- Each item is a single, verifiable outcome
- Include validation steps from `CONTRIBUTING.md` if the fix touches product code
- **Restoring `@stable` is always a deliverable** whenever the tag was removed at triage (the normal case) — "done" includes putting it back after the fix. Only a guard-tripped day, where the tag was kept, has nothing to restore.
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

## Flake-Signal Block

When an issue is opened to track a **recurrent flake** (a test failing on multiple separate daily runs, or a long-standing intermittent), include this block:

```markdown
## Flake signal

This test is confirmed recurrent (failed on dailies 2026-07-08, 2026-07-09, 2026-07-13). As prevention, `@stable` was removed at triage (PR #NNN) so it stops running in the daily until this issue is worked:

- `tests/tests-automations/regression/core-functionality/playground/playground-input-text-prefill.spec.ts` (test at line 97)

Restoring `@stable` after the fix is a deliverable of this issue.
```

Rules:
- Include only when the failure appears across multiple independent daily runs
- List **exact spec file paths** and test line numbers
- `@stable` removal is manual (the workflow never auto-removes flakes) and happens **at triage as prevention** — it is not deferred until after the fix; link the removal PR (`#NNN`)
- Restoring `@stable` after the fix is an explicit **deliverable** of this issue

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

**Symptom matching logic:**
- Same failure symptom (e.g., "div-chat-message timeout") across different specs → **same issue, comment**
- Same spec failing at different lines (different tests) → likely same issue, **comment** (unless it clearly branches into separate root paths, then split)
- Same directory/feature but different symptoms (e.g., one auth failure, one upload failure) → **separate issues**

---

## Guard-Tripped Rule

When a daily run trips the mass-failure guard (`guard_tripped: true` in the daily report), dedicated issues opened for clusters in that run must follow these rules:

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
- **Investigation as independent branches:** test the product first, then environment, then test design
- **Deliverables as checkboxes:** done when all items are ticked
- **`@stable` decisions are explicit:** removed at triage as prevention (or kept on a guard-tripped day), and **restored as a deliverable** after the fix — always documented

This ensures investigators inherit not just a failure, but the context and constraints needed to fix it efficiently.
