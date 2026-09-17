# Templates — every registered template instantiates as itself (§11.2)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-instantiate.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev12`, `langflowai/langflow-nightly:latest`,
measured 2026-09-15)

Owning issue: #1864 (row **S1** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Depends on:** #1862 (`templates-registration`, merged — this spec parametrizes over the
baseline it commits) · **Related:** #1002 (template-load concurrency), #1764 (a spec that
collects zero tests vanishes from the lane), #1812 (`unresolvedTitles`)

---

## What this test validates *(required)*

Picking a template's card creates a flow that **is** that template. One test per registered
template — 26 on this image — each asserting that `GET /api/v1/flows/{id}` for the created
flow equals that template's entry in `GET /api/v1/flows/basic_examples/` on five things:

| Compared | Read from |
|---|---|
| **Component types**, as a multiset | `data.nodes[]` where `type === "genericNode"`, taking `data.type` |
| **Edge count** | `data.edges.length` |
| **Note count** | every node whose `type !== "genericNode"` |
| **Wiring** — per component node, its type plus the sorted neighbour TYPES on each side | `data.edges[]` resolved through the node ids |
| **Name** | the template's own, or the template's plus a ` (N)` suffix the backend adds when the name already exists |

**The wiring row is not in #1864's list, and it is here because without it the spec
goes green while broken.** The instantiation path is `updateIds`
(`src/frontend/src/utils/reactflowUtils.ts`): it rewrites every node id and repoints
every edge through the id map, so "the edge landed on the wrong node" is a live
regression shape — and **7 of the 26 templates repeat a component type**, which is
where it hides. Moving an `Agent → Agent` edge between two of *Multi Agent Flow*'s
three Agents leaves the multiset, the edge count and the note count all identical.

Measured, rather than argued: expected == actual for the wiring on **26 of 26**
templates, so it is assertable today with no divergence to tolerate; of the 7
templates where a same-type rewire is constructible it catches **6**, where the
obvious weaker alternative — the multiset of `sourceType → targetType` pairs —
catches **0 of 7**. The one residual is *Deep Research Agent*, where the rewire
lands between two nodes whose one-hop neighbourhoods coincide; separating those
needs a second refinement round, which is not taken. 6 of 7 for one round is the
trade, and the residual is named rather than hidden.

Measured on `1.13.0.dev12`, across all 26 templates: **138 `genericNode`s and 29 `noteNode`s**.
The note nodes are why the count is "every other node" rather than `type === "noteNode"` —
one of *Basic Prompting*'s two notes carries `data.type: "note"` and the other carries none,
so a shape-based rule is the fragile spelling.

**The expected side is read at run time, not committed.** If upstream edits a template, both
sides move together and nothing fails. What fails is an **instantiation path that changes the
graph**: a node type dropped or rewritten, an edge lost, a note discarded. That is the whole
value — this finds no defect on `1.13.0.dev12` (the #1860 scoping measured 26 of 26 exact),
so it is a regression detector and is only worth shipping with force-fails proving the
comparison bites.

### What it is **not** — including two things it could compare and does not

- It does not run the templates (§11.3–§11.5), does not assert the gallery (**G1**, #1863),
  and does not assert the registered **set** — that is **R1** (#1862), whose baseline this
  spec consumes.
- **Node ids and positions are not compared, by design.** `updateIds` rewrites every id on
  instantiation, so comparing them would fail on every healthy run; positions and the
  viewport are presentation.
- **Component PARAMETER VALUES are not compared** — and this one is a real omission rather
  than a non-observable, so it is named here rather than left for a reader of the `[x]`
  bullets to discover. Measured on `1.13.0.dev12`: **1398 `template.<field>.value` fields
  across the 26 templates, zero differing**, so it is assertable *on this instance*. It is
  declined because it is **instance-dependent by design**: `use-add-flow.ts` resolves the
  project's global variables and passes `unavailableFields` into `updateGroupRecursion`, so a
  field referencing a global variable the project does not have is handled differently — an
  account whose variables differ would go red on a legitimate state. The regression it would
  catch is real and guarded against upstream (*"a missing snapshot must never act like an
  empty one"*), so **it is worth its own issue** rather than a silent omission here: a run
  that blanks every referenced field leaves the graph shape untouched and all 26 tests green.

Concretely, then: this spec proves the template's **structure** arrives, not its
**configuration**.

---

## Where the test list comes from — the decision #1864 asks for

The list must exist when **Playwright collects the tests**, which rules out the live listing:
a spec whose test list comes from runtime state can drop out of the daily's shard listing and
run nowhere while the run stays green. That is #1764, which removed
`provider-invalid-auth-error.spec.ts` from the lane entirely.

So the list is **R1's committed baseline**, `tests/assets/templates/registered-templates-baseline.json`,
read at module scope. It is static, reviewable, the same set R1 enforces, and declared
absences are skipped by construction — *Research Translation Loop* is not in `templates[]`, so
no test is generated for a template the image does not register.

**Read with `fs.readFileSync` at module scope, not `import`.** `resolveJsonModule` is on and
the issue offers it, but R1 already reads this exact file that way and one spelling for one
file beats introducing a second. The practical difference is the failure mode, and it favours
the explicit read: a corrupt or absent baseline throws where this spec can attach a message
naming the file and `npm run templates:baseline`.

**A baseline yielding zero templates aborts collection rather than generating zero tests.**
This is the same #1764 hazard arriving by a different door: zero tests means the file is
absent from the shard listing, not red in it, and `--pass-with-no-tests` keeps the lane green.
A module-scope throw is a visible collection error; an empty loop is silence. (#1862's
`declared-stable-specs` detector would also name it, but a spec should not depend on another
mechanism to notice that it stopped existing.)

**The per-template titles are built from a variable**, so the `@stable` listing detector
reports them under `unresolvedTitles` (#1812) — accepted here for the same reason it is
accepted for the provider-parametrized specs, and stated so a reader of that report knows
this file is expected in it.

---

## Tags *(required)*

`@workspace` `@regression` `@templates` — per the scope doc's planned-spec table.

**`@stable` — measured, not assumed**, which #1864 asks for because the file creates 26 flows
through the UI and lands on the daily's duration-balanced shards. Measured on `1.13.0.dev12`
with a throwaway probe driving the real `loadTemplateByName` journey 26 times:

| Parallelism | What it models | Wall clock | Runs | Failures |
|---|---|---|---|---|
| `workers=1` | this file's tests running **serially**, which is how the daily schedules them | **1.3–1.4 min** | 3 | 0 |
| `workers=2` | the **PR lane** (`fullyParallel: true`), where two of THIS file's tests overlap | **1.0–1.2 min** | 4 | 0 |
| `workers=5` | local default (`cpus/2`) — no lane | 1.1–1.3 min | 4 | **2** |

**Neither row is "the daily" on its own, and reading the first one that way gets the lane
wrong.** `playwright.config.ts` sets `workers: SERIAL_LANE ? 1 : process.env.CI ? 2 :
undefined`, and the daily's shard sets `PW_SHARD_FILE_LEVEL=1`, which only flips
`fullyParallel` to **false**. So the daily runs **two workers**: this file's 26 tests
serialize inside one of them (row 1), while a *different* spec file runs concurrently in the
other against the same backend. The `workers=2` row is not that condition either — it
overlaps this file with itself, which is the heavier contention of the two for the shared
templates-modal helper. The daily's true condition sits between the two rows, and both were
green.

Per-pick: median **3.0 s**, min 2.6 s (*Knowledge Retrieval*), max 3.9 s (*Deep Research
Agent*), 77.3 s summed. So `@stable` is carried: ~1.4 min on a shard whose `@stable` selection
measures 55–140 min is a rounding error, the file is green in 7 of 7 probe runs across both
conditions, and the PR lane ran the real spec **26 of 26 green in 1.6 min** (run
[35049167652](https://github.com/oriontech-me/langflow-e2e/actions/runs/35049167652)).

**A contention flake exists above that, and it is recorded rather than filed.** At
`workers=5` — a parallelism no lane uses — 2 of 4 runs lost exactly one template with:

```
Timeout 30000ms exceeded while waiting on the predicate
  at helpers/flows/open-new-flow-templates-modal.ts:106   (dismissWelcomeOverlayAndWaitForModal)
```

a different template each time (*Content Aggregator*, *Custom Component Generator*), the test
burning 57 s against a 30 s budget. It is in the **shared** helper — 21 spec files reach that
path — and it is not #1002's failure, which is the creation `POST` answering 500 and the canvas
never opening; this one is earlier, the welcome panel never appearing at all.

It is **not filed as an issue**, deliberately: there is no observation of it under either
lane's parallelism (0 in 7), and what was measured is this file's own concentrated use — 26
consecutive calls, more than any existing spec — not the helper across its 21 callers. An
issue asserting "the helper is flaky" would generalise from a sample of one spec at a
parallelism nothing schedules. **File it the first time it appears at `workers=1` or
`workers=2`**; at that point it is a measured cost in a lane, and this paragraph is the
evidence to carry into it.

Not `@destructive`: each test creates and deletes exactly its own flow, by id.

---

## Validation criterion *(required)*

For each registered template, the spec passes when:

1. `loadTemplateByName(page, name)` returns a flow id (the creation `POST /api/v1/flows/`
   answered 201) and the editor is open (`canvas_controls_dropdown` visible).
2. `GET /api/v1/flows/{id}` returns 200 and its persisted graph equals the template's listing
   entry on the component-type multiset, the edge count, the note count and the wiring.
3. The persisted `name` is the template's own or `"<name> (N)"`.
4. `afterEach` deletes that id and `GET /api/v1/flows/{id}` then answers **404**. The
   assertion is per-flow, not a count of the account's flows: a count is not parallel-safe
   (other workers create and delete flows during the window) and would be a #553-shaped
   observation. The account-wide count is checked as a **validation activity** before the
   report, not asserted in the spec.

It fails, naming the template and the difference, when any of those does not hold — and a
failure is scoped to **one** template's test; the other 25 stay green.

**Falsifiability, to be executed before merge** (from #1864's *Done when*):

| Mutation | Expected |
|---|---|
| Remove one edge from one template's **expected** entry | RED for exactly that template; the other 25 green |
| Swap one component type in the expected multiset | RED, naming the type |
| Break the note count for one template | RED, naming the counts |
| Move one edge onto a different node of the **same type** | RED on the wiring alone, with every count unchanged — the case the edge count cannot see |
| Revert the `afterEach` delete | RED on the 404 readback, naming the surviving flow |
| Fail the comparison **and** the cleanup together | The PRODUCT failure is still reported; the cleanup problem is a warning beside it, never a replacement |

**No `🚨 Backend Error`** is part of the criterion, and it was not met by the first version:
the PR lane's run of it logged **57** (see *Build notes*, including why the local pair cannot
confirm the fix). The `about:blank` teardown is the suite's answer to that class; **the
verdict is the next PR-lane run**, and until it is green this criterion is recorded as
UNVERIFIED rather than met.

**Flow cleanup is proven, not assumed** — on a green run *and* on a forced-red run, because a
red test that leaks is the case a green-only check never sees. Already measured on the probe:
the account held **28 user flows before and 28 after**, across 7 runs and the 2 contention
failures above — `loadTemplateByName` deletes what it created on its own throw path too.

---

## Precondition

A running Langflow the suite can log into. **No provider key and no network egress** — the
spec creates 26 flows and deletes each one by id. No template is run.

---

## Step by step

For each template `T` in the committed baseline:

### 1.1 `<T.name>` instantiates as itself

1. Read `GET /api/v1/flows/basic_examples/` (`Accept-Language: en-US`) and take `T`'s entry by
   `name_key`. A template in the baseline but absent from the live listing fails here, naming
   it and pointing at R1 — that is a registration problem, not an instantiation one.
2. `loadTemplateByName(page, T.name)` — New Flow → welcome panel → *Browse more templates* →
   *All templates* → the card's heading. Returns the created flow's id.
3. `GET /api/v1/flows/{id}`.
4. Compare component types (multiset), edge count, note count and wiring.
5. Assert the persisted name is `T.name` or `T.name (N)`.
6. `afterEach`: navigate the page to `about:blank`, then delete the id and read it back.

**Validation:** the four comparisons are equal and the name matches.

---

## Build notes

- **`loadTemplateByName`** (`tests/helpers/flows/load-template-by-name.ts`) is exactly this
  journey, hardened for concurrency in #1002: it retries the creation POST on the upstream
  same-name 500, recovers a lost navigation, and deletes every other flow it created (the
  entry point's own `New Flow`). Its heading match does **not** use `exact`; on this build no
  template name is a substring of another (all 26 pairs checked in #1860), and asserting the
  persisted name is what stops a future collision from passing with the wrong template.
- **The name check tolerates ` (N)`** because the backend auto-suffixes a duplicate name, and
  under parallel workers two tests can ask for the same template. The suffix is therefore
  expected, not a defect — but the *stem* must still be the template's.
- **The comparison is a multiset, not a set**: several templates repeat a component type
  (*Multi Agent Flow* has three Agents, *Deep Research Agent* has three). A set comparison
  would pass with two of the three dropped.
- **The baseline is validated by R1's own `describeBaselineDefect`**
  (`tests/helpers/other/registered-templates-drift.ts`), not by a second check written in this
  spec. One validator for one file: it already rejects a non-string or whitespace `nameKey`
  (which would match no `name_key` in the listing and make a BASELINE defect read as a
  registration one), a whitespace `name` (an unusable card locator) and a **duplicate**
  `nameKey` (two generated tests with the same title) — none of which the first,
  hand-rolled check noticed.
- **The teardown navigates to `about:blank` before deleting**, the shape
  `api/flows/api-component-regression.spec.ts` and the folder specs already use (#1023/#1103).
  An editor left mounted over a flow being deleted keeps asking for it, and each of those 404s
  is logged as `🚨 Backend Error` — which fails no test (#1084) and is precisely the cost:
  that log is read by a human, and the deterministic pipeline's VALIDATE gate greps that
  string.

  **Honest scope, because the two measurements disagree.** The PR lane's run of this file
  logged **57 of them over 17 flows** (`/api/v1/models`, `/custom_component/update`,
  `/flows/{id}/events`, `/variables/`, `/note_translations` — all flow-scoped 404s for flows
  that run had created and deleted). It does **not** reproduce locally: 26/26 green against
  the same image at `workers=2`, **with and without** the navigation, logged **0 of that
  class either way** (3 unrelated 400s on a shared dev instance, identical in both runs). So
  the CI figure is the observation and this is the convention applied to it; the confirmation
  that it goes to zero is the next PR-lane run, not the local pair.

---

## External dependencies *(required)*

Resolved on `origin/main` and `origin/release-1.13.0`.

- `src/backend/base/langflow/api/v1/flows.py` — `read_basic_examples`, the listing the expected
  side is read from, and `create_flow`, whose name de-duplication produces the ` (N)` suffix.
- `src/backend/base/langflow/initial_setup/starter_projects/` — the shipped template JSONs; the
  graph each card creates.
- `src/frontend/src/modals/templatesModal/components/TemplateCardComponent/index.tsx` —
  `template_<slug>` on the card heading, which `loadTemplateByName` clicks.
- `src/frontend/src/modals/templatesModal/index.tsx` — the *All templates* tab this picks from.
- `src/frontend/src/utils/reactflowUtils.ts` — `updateIds`, which rewrites every node id on
  instantiation and repoints the edges through the id map. It is why node ids are not
  compared and why the wiring is.
- `src/frontend/src/hooks/flows/use-add-flow.ts` — `getUnavailableFields` /
  `updateGroupRecursion`, the global-variable-driven field handling that makes component
  parameter values instance-dependent, and therefore out of scope above.

Suite side: `tests/helpers/flows/load-template-by-name.ts`,
`tests/helpers/flows/open-new-flow-templates-modal.ts`, `tests/helpers/flows/delete-flow.ts`,
`tests/helpers/auth/get-auth-token.ts`, and the committed baseline
`tests/assets/templates/registered-templates-baseline.json` (#1862).

---

## Checklist bullet

`QA-CHECKLIST.md` §11.2 — all 26 bullets, one per registered template. The two `[~]`
(*Basic Prompting*, *Memory Chatbot*) are resolved to `[x]` here: their partial coverage was
"a non-empty graph" and "exactly 5 nodes", and this spec compares the composition those
bullets record as missing.
