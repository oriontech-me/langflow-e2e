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
flow equals that template's entry in `GET /api/v1/flows/basic_examples/` on four things:

| Compared | Read from |
|---|---|
| **Component types**, as a multiset | `data.nodes[]` where `type === "genericNode"`, taking `data.type` |
| **Edge count** | `data.edges.length` |
| **Note count** | every node whose `type !== "genericNode"` |
| **Name** | the template's own, or the template's plus a ` (N)` suffix the backend adds when the name already exists |

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

What it is **not**: it does not run the templates (§11.3–§11.5), does not assert the gallery
(**G1**, #1863), and does not assert the registered **set** — that is **R1** (#1862), whose
baseline this spec consumes.

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

| Parallelism | Where that is the real condition | Wall clock | Runs | Failures |
|---|---|---|---|---|
| `workers=1` | the **daily** (`PW_SHARD_FILE_LEVEL=1` ⇒ `fullyParallel: false`) | **1.3–1.4 min** | 3 | 0 |
| `workers=2` | the **PR lane** (`fullyParallel: true`) | **1.0–1.2 min** | 4 | 0 |
| `workers=5` | local default (`cpus/2`) — no lane | 1.1–1.3 min | 4 | **2** |

Per-pick: median **3.0 s**, min 2.6 s (*Knowledge Retrieval*), max 3.9 s (*Deep Research
Agent*), 77.3 s summed. So `@stable` is carried: ~1.4 min on a shard whose `@stable` selection
measures 55–140 min is a rounding error, and the file is green in 7 of 7 runs across both lane
conditions.

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
   entry on the component-type multiset, the edge count and the note count.
3. The persisted `name` is the template's own or `"<name> (N)"`.
4. `afterEach` deletes that id, and the account's user-flow count is what it was before.

It fails, naming the template and the difference, when any of those does not hold — and a
failure is scoped to **one** template's test; the other 25 stay green.

**Falsifiability, to be executed before merge** (from #1864's *Done when*):

| Mutation | Expected |
|---|---|
| Remove one edge from one template's **expected** entry | RED for exactly that template; the other 25 green |
| Swap one component type in the expected multiset | RED, naming the type |
| Break the note count for one template | RED, naming the counts |
| Revert the `afterEach` delete | The flow-count check goes RED (cleanup is load-bearing, so it gets a behavioural force-fail of its own) |

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
4. Compare component types (multiset), edge count and note count.
5. Assert the persisted name is `T.name` or `T.name (N)`.
6. `afterEach`: delete the id.

**Validation:** the three comparisons are equal and the name matches.

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
