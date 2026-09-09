# Inherited spec triage — design

> **Status:** approved design, not yet scheduled. Written 2026-09-08.
> **Revised 2026-09-09**, from the whole-branch review of the instrument's
> implementation: §2 now gives **every** test three observations (it gave a green
> one only one, which §3's promotion gate cannot be satisfied against); §2's
> mandated Output no longer asks the renderer for two facts a Playwright report
> cannot answer; §1 names the baseline file that actually exists; the
> title-collision argument records what it does **not** guard; and the
> `cleanAllFlows` retraction is dated now that the helper is retired.
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

1. it is a test **declaration** under `tests/tests-automations/regression/` with
   an inline `tag:` array — `test(...)` or any of its declaration modifiers
   (`.fixme`, `.skip`, `.fail`, `.only`, `.slow`). The enumeration is complete on
   purpose: the criterion is the *lane*, not the modifier, and a `test.fail`
   declaration without `@stable` runs in no scheduled lane exactly as a
   `test.skip` one does. An earlier revision named only the first three and the
   implementation admitted all five, which is a prose gap rather than a
   behaviour question — measured, the suite holds 4 `.fixme`, 6 `.skip` and
   **zero** `.fail` / `.only` / `.slow` declarations, so the two readings select
   the same 92 tests today;
2. it does **not** carry `@stable` — and `@stable` here means what the repo's own
   parser means by it (`scripts/lib/stable-tests.ts`): the tag on a declaration
   with **no** modifier. A `test.fixme(..., { tag: ["@stable"] })` is therefore
   in scope, which is also the right semantic — a quarantined declaration runs
   nowhere whatever its tags, and PARK below is how it exits;
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
**`tests/assets/triage/inherited-backlog-baseline.json`**, so the guard in §5 has
something to diff against and the wave is not aiming at a moving target. Written
and verified by `npm run triage:baseline` / `npm run triage:baseline -- --check`.
(That is the real path. An earlier revision of this line said
`inherited-spec-baseline.json`, which has never existed — §5 points the next
implementer here for "the frozen baseline of §1", so the wrong name sent them to
a file they would have to invent.)

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
§2 runs against the backlog as it stands.

And, **as observed on 2026-09-08**, `tests/helpers/flows/clean-all-flows.ts` was
dead code whose docblock still named `user-progress-track.spec.ts` as "the ONE
legitimate remaining caller" — a spec that is `@stable` and does not call it.
That was real debt and never this plan's. **It is now closed:** the helper was
retired on `origin/main` in #1772 (`79de9015`, 2026-09-08) and its two dead
references repaired in #1775 (`140d7d56`, 2026-09-09). Recorded as a dated
observation rather than a standing claim, because the lesson is the part that
outlives the file: **a substring grep over spec sources cannot answer a
call-site question in this repo** — the docblock culture over-reports it by
design.

## 2. Phase 1 — measurement (the wave's first item)

Nothing currently knows whether these 92 pass. The measurement produces that
fact, and it is the wave's scoping pass — which is what keeps the later items
from being invented inside the wave (`ROADMAP.md` Rule 1).

**Instrument.** Three passes over three shards — **nine** `manual.yml`
dispatches, all parallel. Each takes a `test_grep` holding an alternation over
one third of the 92 test titles, `retries: 0`, `provider: auto`, targeting the
OSS nightly image — the same image the daily runs. **Every test gets three
observations**, green ones included.

**Why every test and not only the reds, which is what an earlier revision of
this section said.** As written, §2 gave a green test ONE observation while §3's
PROMOTE gate demands "3/3 green, no exceptions" and §4 forbids re-measuring in
Phase 2 — three rules that cannot all be satisfied, whose failure mode is the
one the four promotion conditions exist to prevent: a quietly relaxed gate,
promoting on a single green run and calling it 3/3.

Resolved by **raising §2, not lowering §3**. Three reasons, in the order that
decided it. Runner minutes are free for this repo — the recorded constraint is
wall clock, not spend (#1183) — and the nine dispatches are parallel,
so wall clock is unchanged from three. Three observations for a *green* test is
precisely what makes `flaky` detectable **before** a promotion rather than
after it, which is the question §3's gate is asking in the first place. And the
alternative direction would have had to weaken the one gate Wave 4's imported
invisible reds are the argument for. Cost if this is wrong: six extra
dispatches of free runner minutes.

Two consequences. §3's gate stands exactly as written. And the **red-only
re-dispatch step is deleted** from the plan's Task 7 — it is redundant once
every test is measured three times, which also disposes of the review finding
that that step carried no shard-sizing rule of its own.

`retries: 0` throughout: a retry inside one dispatch hides the intermittence
this measurement exists to record, and the three observations are what separate
`flaky` from `hard-failure` instead.

Why the selector works with no repo change — and the trap that "unique titles"
hides. The 92 titles are unique among themselves (zero collision with any
out-of-scope test's title, zero template placeholders), and the 55 files contain
**no** `@stable` test. That is necessary and **not sufficient**, which cost Task 4
a real fix: Playwright's `--grep` does not match a test's isolated title. It
matches `TestCase._grepTitleWithTags()` — the file's relative path, every
enclosing `describe` title, the test's own title and its tags, space-joined into
one string. So a short title collides two further ways, both measured on this
suite: as a substring of an unrelated **kebab-case file path** (`save` inside
`save-flow-as-template.spec.ts`), and as the literal first word of an unrelated
`describe("save component tests", …)`. Unanchored, the 92 titles selected
**106** tests. `\b` does not close it either — `-` is a non-word character, so
`\bsave\b` still matches at the letter/hyphen boundary inside a path.

What closes it is anchoring on whitespace-or-string-edge (every segment
Playwright joins is delimited by exactly one literal space, and neither a path
nor a single word contains one internally) **plus** requiring the tail to be
nothing but space-`@token` pairs to the end of the string — because after a
test's own title only its own tags can follow, while after a describe title
there is always more plain text. With both, the selection is set-exact: 92
wanted, 92 selected, 0 missing, 0 extra. Two of the titles also contain regex
metacharacters and are escaped.

**Verified as a SET, and by one command.** The count is the wrong check and the
document used to prescribe it: 92 can be reached by dropping some tests and
adding others, so `npm run triage:verify` compares `--list`'s selected
`spec::title` **pairs** against the baseline's and reports
`wanted / selected / missing / extra` per shard. Pairs, not titles, because the
right title in the wrong file is a match under a title-only comparison. An
empty shard is called out by number too — a dispatch of one is a green run that
measured nothing, and it hides inside a correct total whenever another shard
over-selects. `--list` runs nothing, so this costs no instance and no key.

**Three residual collision classes, two of them unguarded — recorded because
the property holds today and nothing keeps it holding:**

1. **In-scope ↔ in-scope.** Two backlog tests sharing a title. *Guarded* —
   `classifyBacklog` records it in `titleCollisions` and the fragment builder
   refuses on it. It has to be, because that class is silent in three places at
   once: the title list dedupes it, the table renders two identical rows, and
   their observations fold into one verdict where a green can mask a red.
2. **A baseline title that is a whitespace-aligned SUFFIX of another test's own
   title.** The recorded minor names only the prefix direction, but the anchor
   is symmetric in the wrong way: `(?<=^|\s)` admits a match starting mid-title
   at a space boundary, and the tag-tail requirement is satisfied because the
   *other* test's tags are all that follows. So a backlog title `"as a
   template"` would also select a test titled `"saving a component as a
   template"` — confirmed against the real anchor, which matches that joined
   target. Unguarded. Measured 2026-09-09 over `--list`: **0** such pairs.
3. **Case folding.** Playwright compiles `--grep` as `new RegExp(pattern, "gi")`
   (`node_modules/playwright/lib/util.js`), so the selection is
   case-INSENSITIVE while `titleCollisions` compares titles case-sensitively.
   Two titles differing only in case are one selector and two rows. Unguarded.
   Measured 2026-09-09: **0** case-insensitive duplicate titles, and **0**
   exact duplicates, over both `--list` universes (726 titles in the normal
   lane, 744 with `@destructive`; every one distinct).

Both unguarded classes would be caught by `npm run triage:verify` **as extra
selections** rather than named as collisions, which is the reason they are minor
rather than open: the pre-dispatch verification does see them, it just cannot
say why. Re-measure both before quoting the zeros; they move with every merge.

Why three SHARDS and not one: 92 tests at a 5-minute per-test worst case over
2 workers is ≈230 minutes against this lane's 180-minute cap. A single dispatch
would be killed partway and return no merged report at all — the exact cost
#1174 measured. (Three *passes* is the observation count above; three *shards*
is this cap. The two multiply to nine dispatches and neither number is the
other's reason.)

Why this lane and not a local run: local spend is unmeasured here (tracing is off
in the start scripts, so token history exists only for CI), and the measurement
must run against the image the daily uses.

**Output.** `docs/triage/inherited-spec-triage.md`, committed, one row per test.
**Rendered from the reports** — `scripts/build-triage-table.mjs`, whose rows are
therefore exactly what a Playwright JSON report can answer:

- the **verdict** (`3/3 green` / `flaky N/3` / `hard failure` / `permanently
  skipped` / `UNKNOWN`), with skips reported *alongside* the ratio rather than
  inside it (`2/2 green, 1 skipped`) and a retried pass named as one
  (`0/3 green, 3 passed on retry`) — a retry is not a failure, and folding it
  into one is how a test that always passed on retry gets routed to PARK;
- the **failure signature** — the first line of `results[].error.message`, ANSI
  stripped and truncated. §4 clusters the follow-up issues by root cause read
  off this column, so without it whoever files them reopens the HTML report once
  per red;
- whether the run logged **`🚨 Backend Error`** (an HTTP error never fails a
  test on its own — #1084);
- the **quarantine marker**, because 7 of the 92 are `test.skip` / `test.fixme`
  on `main` and a row reading `3/3 green` without saying so is the most
  misleading row this table can produce.

**Two facts an earlier revision mandated here are NOT derivable from a report,
and are recorded as human work rather than left as a mandate nobody
implements:** *whether the spec leaked a flow* and *the duplicate candidate*.
The first needs the instance's flow list diffed around the run (the report says
nothing about it) and the second is a judgement over the `@stable` suite — §3's
DELETE outcome is *defined* by a human naming the replacing spec and test. Both
are read during triage and recorded in the **cause-cluster issue** (§4 already
requires the evidence to ship in the issue body), never as a column here: this
file is regenerated by a script, so a hand-added column would be destroyed by
the next render.

A red row is an input to §3, never a conclusion.

**Two ways the measurement itself lies, handled explicitly.** A green dispatch
that executed **zero** tests (the `--grep` matched nothing) is an **abort**, not
"all green" — a per-line `expected=N` read is what catches it. And a quarantined
spec records `0/N` and reads as clean, so the 7 disabled declarations inside the
backlog are **unmuted on
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

**The two facts the table cannot render live here** (§2 Output): the issue body
records, per spec, **whether it leaked a flow** — required by the promote
outcome's cleanup audit, and read by diffing the instance's flow list around a
run, not from any report — and **the duplicate candidate**, which is DELETE's
defining evidence: the replacing spec and the specific test inside it, named, or
delete is not an available outcome.

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

**Sizing — split across two waves, and deliberately undated.** The split is
measured; the dates are a review's call, and the roadmap already carries the
wording for a decided-but-undated tail (*"ready to date — coin at a review"*):

| Wave | Scope | Items |
|---|---|---|
| **Wave 8** | the triage instrument **and its pilot run**, **T1** (26 specs / 41 tests), and the guard | 2 instrument issues + 4–6 batches ≈ **6–8 issues** |
| **Wave 9** | **T2** (29 specs / 51 tests) — consolidate-and-harden | ~5–7 batches |

T2 is a full wave on its own: Wave 4 ran ~46 bullets with that same recipe. All
three in one wave is ~13 issues, well above what the recent waves carry (Wave 6
ran 10, Wave 7 ran 6), and the roadmap's discipline is *lock the time, flex the
scope*.

**The issue shape follows Wave 7's, which is the measured precedent for work of
exactly this kind.** #1692 shipped an entire instrument as ONE issue — a
committed router-table baseline, a drift verdict in `globalSetup`, a fixture, an
npm script, **and** the `files` family closed as its pilot — and its five
siblings were then filed off that instrument's own gap ranking, largest family
first. So the tooling plus the measurement run is one issue with the measurement
as its pilot, the guard is a second, and the cause-clustered batches are filed
off the committed verdict table the way #1699/#1700/#1707 were filed off the API
baseline: one table row per unit, the measured finding in the title.

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
