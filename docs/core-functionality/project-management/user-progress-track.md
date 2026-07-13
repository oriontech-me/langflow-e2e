# Spec: Track user progress — getting-started tracker (§8.3 User State)

**Test file:** `tests/tests-automations/regression/core-functionality/project-management/user-progress-track.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

Langflow tracks each user's "Get started" onboarding progress across three
steps — star the GitHub repo, join the Discord server, create a flow — and
surfaces it as a percentage widget in the home sidebar. The tracked state is
**backend, per user** (`GET /api/v1/users/whoami` → `optins.github_starred` /
`optins.discord_clicked`; the flow step derives from the user having ≥1 flow).
The widget's percentage is the causal readout of those inputs
(33% per completed step; 3/3 renders as 100%).

One test drives the full causal chain on the auto_login superuser, from a
provably-zero baseline:

1. The user owns exactly the flow this test created (id-scoped), and both
   outreach optins are reset to `false`. The widget reads **33%** — only the
   flow step done — with neither outreach icon present.
2. Clicking the widget's GitHub button opens the repo in a new tab and flips
   `github_starred`; the widget advances to **66%** and the GitHub done-icon
   appears.
3. Clicking the widget's Discord button opens the invite and flips
   `discord_clicked`; the widget advances to **100%** and the Discord done-icon
   appears.
4. `whoami` confirms both optins persisted `true` — the tracked state the UI
   percentage is derived from.

## Why the superuser, not a fresh user (design rationale)

The pre-#690 spec had a superuser/admin variant and a normal-user variant, both
failing 2/2 on the current nightly and structurally unpromotable:

- **Parallel-suite wiper (#553/#520 class).** It called `cleanAllFlows` twice
  on the shared superuser, deleting every other worker's in-flight flows.
  `clean-all-flows.ts` documents the spec as "NOT safe under concurrent
  neighbors". `@stable` runs fully parallel, so promoting it as-is would
  reintroduce the wiper. This spec was `cleanAllFlows`'s **last legitimate
  caller**; the redesign drops it, leaving no `@stable` spec that wipes flows
  globally.
- **Not repeatable.** `optins` persist per user across runs, so a second local
  run of the old assertions yielded 100%, not 66%.
- **Dead product path.** On the 1.11 nightly `new_project_btn_empty_page` opens
  a blank canvas directly — the old templates-modal sequence times out.

A **fresh-user** redesign (create a user via the Admin Page, log in, assert an
isolated 0%→66% journey) was built and rejected: it was **flaky, 1-of-2 runs
failing** in the multi-user creation/login flow itself
(`addNewUserAndLogin` → `waitForSelector('mainpage_title')` timeouts; a full
`page.goto` after the mocked-auto_login login logs the user back out to
`/login`). Multi-user login is too fragile a foundation for an `@stable` test,
and per-worker user isolation (#589 item 3) does not exist yet.

The superuser design avoids both failure modes: the auto_login session is
stable (no login step to flake), and the tracked state is **not contended** —
no other spec touches the superuser's optins or the getting-started widget, and
the flow step only needs ≥1 flow (this spec owns one; other workers' flows keep
it true, never break it). The optin reset in `beforeEach`/`afterEach` makes it
repeatable. The empty-page/0%-baseline assertions from the old spec are dropped
because they require global flow-emptiness, which the parallel suite cannot
promise; the tracker's core contract (optin → percentage causality) is what
this validates.

---

## Tags

`@stable` `@release` `@database` `@mainpage` `@ui-ux`

(`@database`: asserts persistent per-user backend state via the users API.
`@stable` applied by #690 after deterministic burst validation.)

---

## Step by step

1. `beforeEach`: reset the superuser's optins (`github_starred`,
   `discord_clicked`, `dialog_dismissed`) to `false` via
   `PATCH /api/v1/users/{id}`.
2. Create a flow via `POST /api/v1/flows/` (id-scoped, captured for cleanup) so
   the flow step is done and the ≥1-flow home renders the sidebar widget.
3. `page.goto("/")`; assert `get_started_progress_title` visible,
   `get_started_progress_percentage` = **33%**, and neither
   `github_starred_icon_get_started` nor `discord_joined_icon_get_started`
   present.
4. Click `github_starred_btn_get_started`; await + close the popup (repo URL);
   assert percentage **66%** and `github_starred_icon_get_started` visible.
5. Click `discord_joined_btn_get_started`; await + close the popup (invite URL);
   assert percentage **100%** and `discord_joined_icon_get_started` visible.
6. `GET /api/v1/users/whoami`; assert `optins.github_starred` and
   `optins.discord_clicked` are both `true`.

---

## Validation criterion

| Step | Criterion |
|---|---|
| Baseline (flow only, optins reset) | percentage = **33%**; no outreach icons |
| After GitHub step | percentage = **66%**; GitHub done-icon visible |
| After Discord step | percentage = **100%**; Discord done-icon visible |
| Backend | `whoami.optins.github_starred` and `.discord_clicked` both `true` |

Each transition is causal: exactly one tracked input changes and the percentage
moves by one 33% step, from a provably-zero baseline. A regression in optin
persistence, flow-step derivation, or widget rendering fails a specific step.

---

## External dependencies

- Widget testids: `get_started_progress_title`,
  `get_started_progress_percentage`, `github_starred_btn_get_started`,
  `discord_joined_btn_get_started`, `github_starred_icon_get_started`,
  `discord_joined_icon_get_started` (scouted live on 1.11.0.dev41).
- `GET /api/v1/users/whoami` → `optins` (tracked state);
  `PATCH /api/v1/users/{id}` accepts an `optins` reset;
  `POST /api/v1/flows/` (via the `createFlow` helper, which absorbs the #588
  concurrent-creation 500).
- External `github.com` / `discord.com` open in the popup; assertions do not
  require the external page to finish loading.

---

## What this test does not cover

- The **empty-page 0% baseline** and **fresh-user isolation** — dropped: both
  need global flow-emptiness / stable multi-user login, neither promotable
  under the parallel suite today (see rationale).
- The widget dismiss (`close_get_started_dialog` / `dialog_dismissed` optin).
- The GitHub star **count** display (`githubStars` localStorage cache).
- Non-superuser rendering of the widget (the tracker plumbing is identical
  per user; the superuser is the parallel-safe stable session to assert on).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` in auto_login mode (default
  superuser session).
- No model provider credentials required.

---

## Flow cleanup

The test owns exactly one flow (created via API, id captured). `afterEach`
deletes it id-scoped (404-tolerant) and resets the superuser optins, so neither
flows nor tracked state accumulate across runs. No `cleanAllFlows` — this spec
was its last caller; the helper can now be retired separately.
