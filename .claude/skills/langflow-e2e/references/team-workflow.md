# Team workflow — issues, milestones & daily triage

How the team organizes work on this repo. Apply when creating, labelling, or
closing issues, and when finishing a branch.

## Labels

- `Roadmap` — planned wave issues (the proactive test-authoring backlog).
- `Community` — issues sourced from upstream Langflow issues (regressions fed
  into this repo). Live **outside** any milestone but must still be handled.
- `daily-failure` — issues created from the daily-workflow triage. Carry
  inherent priority: they are test maintenance — ignoring them means silently
  losing real test coverage.
- Severity (optional, for `Community`/regression issues): `high` / `medium` /
  `low`.

## Milestones & waves

- Wave issues carry `Roadmap` and are grouped under their own milestone; the
  milestone view shows the % completed.
- **Wave 1** — milestone `Wave 1 — Agents & providers`, due **2026-07-14**.
- When you start an issue, set **yourself as assignee**.
- **Wave 1 review policy:** mandatory peer review is **not** required. Still run
  a self-review to confirm the test is sound; request another person's review
  when you judge it useful. **After merge, delete the branch** (clean up).

## Daily-failure workflow (from `weekly-stable.yml` / nightly triage)

Expect issues most days from the CI workflow. Triage procedure (Rafael owns the
first triage for now):

1. Create issues for **hard failures**. Manually remove `@stable` from tests
   that are **recurrently flaky**. Hard failures are expected to have had
   `@stable` removed automatically already.
2. Tag triage-created issues with `daily-failure`.
3. If the failure is a **regression** (real Langflow bug, not a test problem),
   route it to **Langflow engineering** — not a test fix here.
4. **On resolving the issue, always restore `@stable`** so the test rejoins the
   daily/stable suite. (See the `@stable` triage rules in `CONTRIBUTING.md`.)

## Upstream Langflow regression issues

- Alice Reis feeds these into this e2e repo.
- Label them `Community`; add a severity label (`high`/`medium`/`low`) when
  applicable.
- They sit outside the wave milestone but are still tracked and worked.

## General development guidance

- Develop and run tests against the **latest Langflow nightly**
  (`langflowai/langflow-nightly:latest` — `./scripts/start-langflow-docker.sh`).
