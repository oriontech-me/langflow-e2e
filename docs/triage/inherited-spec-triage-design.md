# Inherited spec triage — design

> **Status:** approved design, not yet scheduled. Written 2026-09-08.
> **Decisions locked before writing:** triage with three outcomes · a dedicated
> wave with a measurement item first · a prevention guard inside the same wave ·
> **OSS only**.
> **Next artifact:** an implementation plan; then the wave's GitHub milestone and
> issues.

## Why

`@stable` is what the daily runs. A test without it runs in the daily **never**,
and — unless something it imports changes — in the PR lane never either. So a
spec that is neither `@stable` nor owned by an issue is not "pending validation";
it is a file that costs review time and buys no signal.

Measured on 2026-09-08, the suite declares **821** tests, **598** of them
`@stable` (73 %). Of the 223 without the tag, **116** are lane-gated and correct
that way, **15** sit in specs that lost the tag per test (that is #1746's
scope), and **92** — in **55** spec files — have never carried it. Those 92 are
this design's subject.

Three places in `ROADMAP.md` already circle this population without owning it:
the pool's *Disabled-test triage* item, the pool's *auth & project-management
tail*, and the continuous *spec-doc backfill* track. #1350 additionally found the
`[-]` backlog premise to be 41 items smaller than the roadmap assumed. This
design replaces those three partial views with one derived population and a rule
for retiring it.

## 1. Scope and frozen inventory

**The predicate** (derived, never hand-maintained). A test is in scope when all
of the following hold:

1. it is a `test(...)` / `test.fixme(...)` / `test.skip(...)` **declaration**
   under `tests/tests-automations/regression/`, with an inline `tag:` array;
2. that array does **not** contain `@stable`;
3. it carries **no lane selector** — `@destructive`, `@enterprise`, `@authz`,
   `@sso`, `@serving`, `@governance`;
4. **no** test in the same file is `@stable`.

Clause 4 is what separates this from #1746: a file with a mix lost the tag per
test and has a removal to reconcile; a file with none never claimed it.

Today the predicate yields **55 specs / 92 tests**, and the population splits
into two that want different work:

| Tier | Specs | Tests | Signature | Work |
|---|---|---|---|---|
| **T1 — built under SDD** | 26 | 41 | has a spec doc and/or id-scoped cleanup | find *why* it is not `@stable`: promote or park |
| **T2 — inherited import** | 29 | 51 | no doc **and** no cleanup; entered 2026-03-11 | duplicate → delete, or harden (the Wave 4 recipe) |

**OSS only, and stated rather than inferred.** The predicate's clause 3 already
produces an all-OSS set — verified, not assumed: 0 of the 55 sit under
`enterprise/`, `serving/` or `governance/`, 0 carry a lane tag, and 0 reference
an Enterprise gate or surface. This is now a decision: the domain of this work is
the **OSS scheduled lanes**. The Enterprise backlog (88 tests, 104 checklist
bullets, recorded in the Coverage Summary as *not scheduled — decision*) is a
separate track that this plan explicitly does not touch.

**"OSS only" does not widen the scope, and reading it that way is the likely
error.** Of the 116 lane-gated tests, 88 are Enterprise and **28 are OSS** — 18
`@destructive` / `@governance` (governance is an OSS operator surface as of 1.12)
plus 10 `@serving` (the same OSS nightly image under a different configuration).
Those 28 stay out, and not because they are Enterprise: having no `@stable` is
the **correct** state for them. There is no scheduled lane for any of the three,
so the tag would make such a test run nowhere at all, silently (#1010). They are
not debt.

**The inventory is frozen.** At wave open, the predicate's output is committed as
`tests/assets/triage/inherited-spec-baseline.json`, so the guard in §5 has
something to diff against and the wave is not aiming at a moving target.

### This population absorbs a second roadmap item

`ROADMAP.md` carries a continuous *spec-doc backfill* track sized at "~129 specs
without a matching doc (worst: `flow-functionality` ~39, `ui-ux` ~28)". Measured
2026-09-08: of **314** specs, **41** lack a mirrored doc — and **33 of those 41
(80 %)** are in this backlog. Only 8 sit outside it, and for those a missing
mirrored file is not a defect at all: docs resolve by content reference, not by
filename, so a spec can be documented inside a shared doc under another name
(`check-checklist-coverage.ts` says so in its header and does not report them).

So that track is not a separate ~129-item queue running alongside this work; it
is mostly the same 55 files, and it retires as a side effect of §3's promote
outcome. The stale figure is the same class of error #1350 found in the `[-]`
premise, and it is recorded here so the next wave is not sized against it.

### A hazard this design claimed, and the measurement that retracted it

An earlier revision of this document opened a "fast lane" for five backlog specs
said to call `cleanAllFlows` — a global flow wipe the helper's own docblock marks
DEPRECATED and unsafe across parallel workers — and made fixing them a
precondition of the measurement.

**That was wrong, and the retraction is recorded rather than deleted**, because
the same bad instrument is what anyone re-checking would reach for first. The
finding came from a substring grep for `cleanAllFlows|clean-all-flows` over spec
sources: 5 hits inside the backlog, 26 across `regression/`. Parsed for the call
form instead, `regression/` holds **one** `cleanAllFlows(` occurrence — inside
the comment *"never a global cleanAllFlows()"* — and **zero** importers. Across
all of `tests/` and `scripts/`, the helper has **no caller at all**.

Every one of the 26 is a comment, and that is not an accident: this suite
documents *why a spec does not* wipe globally, so its sources carry the
deprecated name far more often than any caller would. **A substring grep over
spec sources cannot answer a call-site question here** — it structurally
over-reports by the size of the docblock culture. Ask it of the AST, or at
minimum of the call form.

Two consequences. There is no fast lane and no precondition: the measurement in
§2 runs against the backlog as it stands. And `tests/helpers/flows/clean-all-flows.ts`
is dead code whose docblock still names `user-progress-track.spec.ts` as "the ONE
legitimate remaining caller" — a spec that is now `@stable` and does not call it.
That is real debt, it is **not** this plan's, and it is recorded here only so the
next reader does not rediscover it as a hazard.

## 2. Phase 1 — measurement (the wave's first item)

Nothing currently knows whether these 92 pass. The measurement produces that
fact, and it is the wave's scoping pass — which is what keeps the later items
from being invented inside the wave (`ROADMAP.md` Rule 1).

**Instrument.** Three parallel `manual.yml` dispatches. Each takes a `test_grep`
holding an alternation over one third of the 92 test titles, `retries: 0`,
`provider: auto`, targeting the OSS nightly image — the same image the daily
runs. Red tests are then re-dispatched twice, for three observations each.

Why the selector works with no repo change: the 92 titles are **unique** (zero
collision with any out-of-scope test, zero template placeholders — measured), and
the 55 files contain **no** `@stable` test, so a title-level selection is
file-exact. Two of the titles contain regex metacharacters and are escaped.

Why three dispatches and not one: 92 tests at a 5-minute per-test worst case over
2 workers is ≈230 minutes against this lane's 180-minute cap. A single dispatch
would be killed partway and return no merged report at all — the exact cost
#1174 measured.

Why this lane and not a local run: local spend is unmeasured here (tracing is off
in the start scripts, so token history exists only for CI), and the measurement
must run against the image the daily uses.

**Output.** `docs/triage/inherited-spec-triage.md`, committed, one row per test:
verdict (`3/3 green` / `flaky N/3` / `hard failure` / `permanently skipped`), the
failure signature, whether the run logged `🚨 Backend Error`, whether the spec
leaked a flow, and the duplicate candidate if any. A red row is an input to §3,
never a conclusion.

**Two ways the measurement itself lies, handled explicitly.** A green dispatch
that executed **zero** tests (the `--grep` matched nothing) is an **abort**, not
"all green" — a per-line `expected=N` read is what catches it. And a quarantined
spec records `0/N` and reads as clean, so the 10 disabled tests are **unmuted on
the measurement branch** and their rows marked as such.

## 3. Decision rules — the three outcomes

Applied in this order, per **spec** rather than per test:

1. **DELETE (consolidate)** — available only when an `@stable` spec asserts the
   same subject *and* the same failure condition. The PR must name the replacing
   spec and the specific test inside it; without that named replacement, delete
   is not an available outcome and the review rejects it.
2. **PROMOTE to `@stable`** — requires all four, with no exceptions: 3/3 green;
   id-scoped cleanup (deletes only the flow ids it created); a spec
   doc with the four mandatory sections; and a force-fail run. Green alone is not
   enough — promoting a green inherited spec without the cleanup audit is how
   Wave 4 imported invisible reds.
3. **PARK** — a reproducible hard failure whose cause is the product: an issue
   filed (this repo or Jira `LE-####`), `test.fixme` carrying the link, and the
   reason written into the doc. Out of `@stable` **with an owner** is a
   legitimate terminal state, not a deferral.

The order is deliberate: DELETE is evaluated first, because measuring and
hardening a duplicate is precisely the spend this triage exists to avoid.

There is no fourth outcome. A test that fits none of the three is `UNKNOWN` in
the table with the reason named — never omitted (#1012).

## 4. Phase 2 — cause-clustered batches

**Granularity.** One issue per root-cause cluster, filed **the same day** the
table lands. One issue per branch per PR — two issues on one branch deadlock the
first one's PR gate.

**Ceiling per issue.** Closable in a single PR; a cluster past ~8 specs splits. A
one-spec cluster with its own product bug is its own issue, because parking is
cheap.

**Clusters expected** — hypotheses from history, confirmed or refuted by the
table and not before:

- **testid drift** — #818 measured that most daily reds are drift rather than
  regression, so one fix clears a cluster;
- **duplicate of a hardened spec** → DELETE;
- **missing cleanup** — a spec that creates a flow and never deletes it, which
  leaks one flow per run and eventually reddens a neighbour;
- **product bug** → PARK, one issue per bug;
- **provider packaging** — `groq-provider`, `mistral-provider`: **no work**.
  #1039 and `docs/component-distribution-policy.md` already decided these; they
  are parked citing the standing declaration;
- **provider-dependent specs (9 specs / 10 tests)** — a mandatory separate
  batch. A provider spec cannot be judged during a drained-credit window: the
  error persists as a run row and reads as a product bug. Check the credential
  before theorising.

**Definition of done per issue.** Every spec in the batch reaches one of the
three outcomes; its Part II bullet is updated; a doc is written for promotions;
and the PR names, per spec, the outcome and the evidence row it came from. No
item re-measures — the evidence ships in the issue body.

## 5. The guard — the item that stops the backlog regrowing

**Invariant.** Every spec with **zero** `@stable` tests must have either an
**open** issue that owns it, or a committed exemption declaring a reason (the
`groq` / `mistral` pattern).

**Verified in both directions** (#1084's lesson). An exemption whose reason has
expired — its linked issue closed, or the component's distribution now installed
— is **reported**. A justification that expires silently is the failure #1084 was
raised about.

**Where it runs, with severity following the diff** (#980):

- a **pre-existing** unowned spec → a `::notice::` on the PR lane, never a
  failure: it is not that author's fault, and failing would redden unrelated PRs
  until someone runs an audit;
- a spec the **PR is adding** with no `@stable`, no issue and no exemption →
  **fails**. That is the prevention half, and it is the author's own diff;
- the enforcing home is the **daily**, beside `shardguard` and `runguard`, and
  its output goes into an **issue body** rather than a log line — `mode=count`
  sat in the daily's prep log for weeks unread (#1252).

**Negative scope, explicit and pinned.** The 116 lane-gated tests are out by
construction, or the guard is born firing 116 times; Enterprise is the largest
such population (88 tests, zero `@stable`, correct). This is asserted by a unit
test — fed a fixture of Enterprise specs, the guard reports **zero** findings —
so a later edit cannot widen the domain silently. The *removed*-tag question
belongs to **#1746**: same thesis, separate reports, cross-linked. One guard
answering both with a single heuristic would answer both badly.

**Fail-closed.** A verdict the guard cannot produce — unreadable history, a
failed issue lookup — is `UNKNOWN` with the reason named, never silence
(#1012 / #1035). Unit tests live next to the code and run in `npm run test:units`.

**Compatibility, verified.** `scripts/check-checklist-coverage.ts` deliberately
exempts a spec that is neither `@stable` nor documented, on the grounds that
requiring bullets for the inherited suite would be busywork. This guard does not
re-litigate that: it fires against the **frozen baseline** of §1. The 55 known
specs are born declared as *in triage, owned by the Wave 8 / 9 issues*; what
fails a PR is what goes **beyond** the baseline. When the wave closes, the
baseline shrinks to the parked set.

## 6. Accounting, sizing, anti-goals

**Checklist.** A promotion is `[-]` → `[x]` **and needs a Part II bullet** — the
existing guard requires every `@stable` spec to be referenced there. A deletion
removes the bullet when it referenced only that spec. PRs edit **manual bullets
only**: committing regenerated counts collides between concurrent PRs (#741).

**The coverage percentage may fall, and that is not a regression.** Deleting a
duplicate removes numerator. `ROADMAP.md` already has the wording for this
(`Convergence: directional`). Stated before the work starts, or the end of the
wave gets read as a failure.

**Sizing — split across two waves.** This is measured, not preference:

| Wave | Scope | Items |
|---|---|---|
| **Wave 8** (2026-09-17 → 10-01) | measurement + **T1** (26 specs / 41 tests) + the guard | 1 measurement + 4–6 batches + 1 guard ≈ **6–8 issues** |
| **Wave 9** | **T2** (29 specs / 51 tests) — consolidate-and-harden | ~5–7 batches |

T2 is a full wave on its own: Wave 4 ran ~46 bullets with that same recipe.
Forcing T1 + T2 + guard into 09-17 → 10-01 gives ~13 issues, above the capacity
band, and the roadmap's discipline is *lock the time, flex the scope*.

**Anti-goals**, written down so they are not re-decided:

- do not chase 100 % `@stable`. Parked with an owner is a legitimate state;
- do not promote to hit a number: a test engineered to pass catches no
  regression;
- do not delete without a named replacement;
- do not measure locally against a real key: local spend is invisible.

## Risks

- **A drained-credit window during the measurement.** This account has three
  recorded drains (#772, #1029, #1169), and Google's per-minute embedding quota
  has already cost knowledge specs a red. Mitigation: verify the credential
  before interpreting any provider-spec red, and keep the provider-dependent
  specs in their own batch (§4).
- **The wave being filled in flight.** Mitigation: the measurement *is* the
  scoping pass, and the batches are filed the same day the table lands.
- **A promotion that skips the cleanup audit.** Mitigation: §3's four conditions
  are all required, and the PR review rejects a promotion missing any of them.

## Exit criteria — Wave 8

- the triage table is committed;
- T1 is empty: every one of its 26 specs has reached promote / delete / park;
- the guard runs in the daily and reports into an issue body;
- the frozen baseline has shrunk to the parked set;
- Wave 9 is datable with a concrete list.

## Provenance

Every count here was derived from the spec ASTs on 2026-09-08 with the same
parser `QA-CHECKLIST.md`'s generated blocks use — its `@stable` total (598)
matches this design's independently, which is the cross-check. The tier split
comes from a per-spec audit of doc presence and cleanup style; the added-date
histogram from `git log --follow --diff-filter=A` per file; the title-uniqueness
and metacharacter figures from the same pass that builds the `--grep`
alternation. Re-derive rather than quote: the numbers move with every merge.
