# Component distribution policy (`lfx-bundles`)

**Last measured:** 2026-08-05. Two different sources, and mixing them up is the
mistake this file already made once: the **image** (`1.12.0.dev10`,
`langflowai/langflow-nightly:latest`) is the authority for what is installed and for
`GET /api/v1/all`; the **upstream source tree** at `origin/release-1.12.0` — the line
the nightly is cut from, not `main` — is the authority for which directories are
shims. Written for #1040.

Since 1.12, **whether a component exists is a packaging decision, per image.** This
file is the standing answer to "a component family is missing from the build — now
what?", so that question stops being re-decided per incident. It has been decided
twice already, both times partly wrong (#898, #907 — see *History*).

---

## The mechanism

Most component families moved out of `lfx.components.*` into **per-vendor
distributions** (`lfx_openai`, `lfx_anthropic`, `lfx_google`, …) plus an aggregate
`lfx-bundles` package. The old import paths still exist as shims, which re-point at
the installed distribution and raise a `ModuleNotFoundError` when it is absent. The
shims are **deleted at M4** (see *The M4 deadline* — it has no published date).

**There are two kinds of shim, and the distinction changes the diagnosis:**

- `# lfx-bundles-shim` (**77** directories) — the family really moved to a
  distribution. Absent distribution ⇒ `ModuleNotFoundError` naming it, and no
  category in the catalog. This is the case the rest of this file is about.
- `# lfx-compat-shim` (**2** directories) — `cassandra`, which re-points at
  `lfx_datastax` (so it raises naming **`lfx-datastax`**, not `lfx-bundles`), and
  `knowledge_bases`, whose docstring calls it a *"backwards compatibility alias for
  files_and_knowledge"* — a pure internal rename, with no distribution and no
  `ModuleNotFoundError` at all. **Checking whether a distribution is installed
  answers nothing for an alias shim**, which is why the headline example below is
  about a rename and not a missing package.

One further `lfx-bundles-shim` lives **outside** `components/`
(`lfx/base/datastax/__init__.py`), so a `components`-only sweep understates the M4
surface by that one file.

Measured on `origin/release-1.12.0` at 2026-08-05 — the line the nightly image is
cut from, **not** `main`:

| | Count |
|---|---|
| `lfx/components/*` directories total | **106** |
| …that are shims (77 bundle + 2 compat) | **79** |
| …still core | **27** |
| `lfx-*` vendor distributions installed (image) | **21** (incl. `lfx` itself) |
| `lfx-bundles` installed (image) | **no** |
| Categories in `GET /api/v1/all` | **36** (20 vendor + 16 core) |
| Component types in `GET /api/v1/all` | **189** |

**The ref matters, and getting it wrong is easy:** on `origin/main` the split is
**78 / 28**, because `cassandra` became a shim on the release line only
(2026-07-30) and has not merged back. The nightly is cut from `release-1.12.0`, so
that is the ref to compare against; the running **image** is the final authority,
and the *How to re-measure* section reads it directly.

**The rule that matters**, stated in the direction that actually holds — the
biconditional is false and the honest form is two measured claims:

- every shim directory that **has** a category has its distribution installed (10
  of 10 on this image), and every shim **without** an installed distribution has no
  category (the other 69). That is the load-bearing half: *no category appears for a
  family the image does not ship.*
- the converse fails for core. **11 of the 27 core directories produce no category
  at all** (`chains`, `data`, `deactivated`, `documentloaders`, `helpers`,
  `link_extractors`, `logic`, `models`, `output_parsers`, `textsplitters`,
  `toolkits`), and three installed distributions have no category of their own —
  `lfx_datastax` supplies two (`cassandra`, `datastax`), while `lfx_vllm` and
  `lfx_openai_compatible` ship no `components/` directory. So "core ⇒ a category"
  and "installed ⇒ a category" are both wrong, and a directory count will not
  predict a catalog.

Two consequences that are easy to get wrong:

- **The source tree and the API do not correspond 1:1.** `knowledge_bases` is a
  *shim* directory on `1.12.0.dev10` while the `Knowledge` component is present and
  exposed under the **`files_and_knowledge`** category. So "the directory became a
  shim" does not imply "the component is gone", and reading the source tree to
  answer an availability question will mislead you. **The API catalog is the only
  observable that answers what a spec can actually place.**
- **Installed ≠ buildable.** With `lfx-bundles` installed but the provider's
  `langchain-*` package missing, the category is present and the component *is*
  placeable, then fails at run time with `ComponentBuildError: … langchain-groq is
  not installed`. Installing `lfx-bundles` alone can also leave a category present
  and **empty**. These are two independent gates (#1039), and this is why
  `tests/helpers/provider-setup/probe-component-available.ts` and `tests/helpers/provider-setup/probe-component-buildable.ts` both exist.

---

## Inventory: which of our specs depend on a vendor distribution

Two directions, because they fail differently and only one of them is visible today.

**(a) Specs that PLACE a component from a vendor distribution the image ships — 9 of 247.**
These pass today and are coupled to a packaging choice, not to a Langflow feature.
A *vendor* category is one that is not a core directory; there are 20 such
categories in the catalog, and the command that derives all of this is in
*How to re-measure* — read that before trusting the list, since the number depends
entirely on the criterion.

| Vendor category | Spec |
|---|---|
| `amazon` | `core-components/beta-components-toggle-regression.spec.ts` |
| `duckduckgo` | `core-functionality/llm-agents/duckduckgo.spec.ts` |
| `ollama` | `core-functionality/model-provider/ollama-provider.spec.ts` |
| `openai` | `flow-functionality/generalBugs-shard-3.spec.ts` |
| `ollama` | `flow-functionality/generalBugs-shard-7.spec.ts` |
| `datastax` | `ui-ux/filterSidebar.spec.ts` |
| `ollama` | `ui-ux/settings-shortcuts-edit.spec.ts` |
| `openai` | `ui-ux/sidebar-search-and-filter.spec.ts` |
| `openai` | `ui-ux/use-global-variable-in-component.spec.ts` |

**(b) Specs gated on a family the image does NOT ship — 3.**
`groq-provider.spec.ts` and `mistral-provider.spec.ts` skip on every run (#1039).
`ollama-provider.spec.ts` carries the same gate but Ollama **returned** to the default
image, so its gate currently passes — it is insurance, not an active skip.

**The criterion is "places a component", and mixing it with "mentions a provider"
is how the first version of this table got it wrong.** A spec that sends
`provider: "OpenAI"` in a tweaks payload, or picks `"Google Generative AI"` from a
model dropdown, does **not** place a component from `lfx_openai` / `lfx_google` — it
depends on the *provider resolver*, which is direction (a)'s blind spot below, not on
a sidebar card. The published grep matches the component testid
(`getByTestId("<vendorCategory><Display Name>")`) and the bundle disclosure
(`disclosure-bundles-<vendor>`), which are the two ways a spec actually reaches one.

**The 9 in (a) is a floor, not the blast radius.** The method matches source text,
so it only sees specs that name a component — and only components the image
currently exposes. Three known misses, the first of which is a real one already
found:

- a spec that keeps the testid in a **constant** rather than inline. The published
  grep finds `ui-ux/sidebar-search-and-filter.spec.ts` only because the constant's
  value (`"openaiOpenAI"`) is itself a string literal in the file; a testid composed
  at runtime from parts would be invisible;

- the **46 specs** tagged `@agents` or `@model-provider`, which reach a provider
  through `SimpleAgentTemplatePage` and the model-target resolvers rather than by
  naming a component. Every one of them depends on `lfx_openai` / `lfx_anthropic` /
  `lfx_google` / `lfx_ollama` being installed, without saying so anywhere;
- any spec depending on a family that is **already absent** — it matches nothing
  because the catalog it is matched against no longer contains the family. That is
  precisely the #1039 case, and the reason (b) had to be enumerated by grepping for
  the *gate* instead.

Which is the argument for the drift detector over a periodic re-inventory: the
inventory answers "what is coupled today", the detector answers "did the coupling
just break", and only the second scales.

---

## Policy: a component family absent from the tested image

Decide in this order; the first row that matches wins — **except that row 2 is
cumulative with row 1**, not an alternative to it. (Row 2 begins "Same, and…": read
as plain first-match-wins, row 1 would always shadow it and the `@stable` removal
would never fire. Rows 1, 3, 4 and 5 are the mutually exclusive set.)

**Which row you are in** is answered in this order: the pre-flight drift report
names a family that left the catalog (row 4 if the family is core or a component
moved, row 1 if a whole vendor category is gone); `tests/helpers/provider-setup/probe-component-available.ts`
answers presence for one component; `tests/helpers/provider-setup/probe-component-buildable.ts` answers row 3,
and only it can — a registry hit does not prove the component runs.

| Situation | Decision | Mechanism |
|---|---|---|
| The family's distribution is **not installed** in the image we test, and that is upstream's packaging choice (not a bug) | **Gate and skip, with an attributed reason.** Do not delete the spec, do not leave it failing. | `isProviderComponentAvailable()` before the first UI step; `test.skip()` naming the distribution and #1039 |
| Same, **and** the spec carries `@stable` (apply on top of row 1) | **Remove `@stable`** and demote the checklist bullet to `[-]`, stating in the bullet that the component is not on the tested image | A `@stable` spec that skips on every daily is a green that measures nothing (#1039/#570) |
| The family is installed but the component fails to **build** (missing `langchain-*`) | **Gate on buildability, not presence** | `tests/helpers/provider-setup/probe-component-buildable.ts` (#900) — a registry hit does not prove it runs |
| The family is core and vanished, or a component was **reparented** | **Fix the spec**, then accept the drift baseline | The pre-flight drift report names it (below) |
| We genuinely need coverage for a family the image does not ship | **A dedicated lane** that installs `lfx-bundles` plus the provider extras — not a change to the default lanes | Not built; open a scoped issue before assuming it |

**What is explicitly NOT the policy:** silently skipping. A spec that skips must say
which distribution is missing and why, because the alternative is the failure mode
this suite keeps re-learning — a green run that tested nothing (#570, #1012).

One known weakness in today's gate, recorded rather than fixed here:
`isProviderComponentAvailable()` returns `false` when the registry request itself
fails, so an unreachable backend is reported to the reader as "component not in this
build". The verdict is right (skip) and the attribution is wrong. Worth a scoped
follow-up.

---

## The drift detector

`globalSetup` compares `GET /api/v1/all` against a committed baseline on every suite
run and reports the difference. Cost: one request, measured 70–85 ms / 524 KB
compressed.

- Logic: `tests/helpers/other/component-catalog-drift.ts` (pure, covered by
  `npm run test:units`).
- Baseline: `tests/assets/catalog/component-catalog-baseline.json` — **committed**,
  so accepting drift is a reviewable diff. A self-updating baseline would make every
  catalog change invisible exactly once, which is the failure #1040 exists to stop.
- Accept expected drift: `npm run catalog:baseline` (refuses to write a near-empty
  catalog from a still-starting instance; `--force` to override).

It snapshots `category -> component types`, not just the category list #1040 asked
for, because a **reparented** component breaks a spec exactly as thoroughly as a
deleted one — the component is still there, under a name the spec does not look
under — and category-level drift shows nothing at all in that case. Such a component
is reported as `MOVED`, not as an unrelated removal plus addition.

**It warns, never fails.** Drift is not by itself a defect: a new category costs
nobody a test, and a removed one is legitimate when the image stopped shipping a
distribution we do not test. Aborting a run over a reporting feature would trade
coverage for tidiness (#980). But it never reads as clean when it has no verdict:
an unreadable baseline, a **malformed** one, a failed request and a 200 that carries
no categories at all each report `UNKNOWN` with the reason named (#1012).

The last two are there because they were reachable. The comparison is a pure
function (`catalogVerdict`) precisely so that it **cannot throw** — the version that
lived inline aborted the whole suite, zero tests executed, on a baseline
hand-repaired with the raw `GET /api/v1/all` body (whose values are `{type:
template}` objects, not arrays of type names). And a 200 with an empty body
normalises to zero categories, which diffed as *every* category gone: 36 lines each
claiming specs would time out. The writer refuses that state via `--min-categories`;
the reader now refuses it too.

One detail worth keeping: `component_display_names` is a key of `GET /api/v1/all`
that is a **metadata map, not a category** (189 entries, one per component, keyed by
the lowercased type name). Folding it into the snapshot would add a 37th
pseudo-category listing every component a second time. It would *not* make
reparenting undetectable in general — the keys are lowercased, so they do not
collide with the real cased type names, and exactly 1 of the 189 (`policies`) is
already all-lowercase. That one component would be masked; the rest would just be
duplicated. The exclusion is right either way, but the stronger claim is false.

---

## Hardcoded `lfx/components/...` paths and the M4 expiry

Measured across the whole repo (`*.ts`, `*.md`, `*.mjs`) with the grep in
*How to re-measure*: **29 occurrences across 21 files, and none of them points at a
shim.** They resolve to six families:

| Family | Occurrences | Core on `release-1.12.0` |
|---|---|---|
| `models_and_agents` | 8 | yes |
| `input_output` | 7 | yes |
| `processing` | 7 | yes |
| `flow_controls` | 4 | yes |
| `data_source` | 2 | yes |
| `agents` | 1 | **no — does not exist**, see below |

The 29th is this file quoting the bad path below as an example, which the grep
counts; the 28 the first version of this section reported was the same measurement
before that example was written down. Either way the conclusion is the one that
matters and it is unchanged: **the M4 shim deletion breaks zero of our recorded
paths today.** #1040 assumed otherwise ("anything of ours that reaches
`lfx.components.*` directly breaks silently at that point") — measured, it does not.
**Re-measure when M4 gets a date**, since core families keep moving.

### The dead paths this did find — 20 of them, not one

`docs/core-components/agent-component-regression.md` recorded
`src/lfx/src/lfx/components/agents/agent.py`. That path **no longer resolves on any
current ref** — it is stale, not fictional: it was added by *feat: introduce lfx
package* (#9133, 2025-09-02) and deleted by *refactor: Reorganize sidebar
categories* (#10180, 2025-11-12), and the component is at
`models_and_agents/agent.py` now. Corrected in #1040.

Widening the same question past the `lfx…/components` spelling finds **20 more of
the same class**, all inside the mandatory **External dependencies** section of a
spec doc:

- **18 occurrences across 16 files** of `src/backend/base/langflow/components/…` —
  the pre-`lfx` tree, absent upstream since #9133 on every ref checked
  (`release-1.10.0`, `1.11.2`, `1.12.0`, `main`). Examples:
  `docs/core-components/tool-mode.md`, `docs/core-components/webhook-component-regression.md`,
  `docs/core-functionality/llm-agents/agent-max-iterations.md`, `README.md`.
- **2 files** writing `src/lfx/components/models_and_agents/…`
  (`agent-max-tokens.md`, `agent-n-messages-limit.md`), which does not resolve
  either — the real prefix is `src/lfx/src/lfx/components/…`. The family is right,
  the path is not.

Fixing those 20 was **not** part of #1040 — it is a docs sweep across 18 files with
no bearing on the drift detector — but the count belongs here, because the first
version of this section said "one defect" and that reads as a clean bill of health.
It went to #1298 together with the guard, and **both shipped there** (PR #1314):
all 21 paths are corrected, and resolving *every* doc against four refs found **42**
unresolvable paths across 35 files rather than 21, since ~20 more were reorganised
`src/frontend/` paths outside the `lfx…/components` spelling grepped above.

That **was** the #1092 failure mode in a second place: a path that does not exist is
**silent**, because `git log --since -- <bad-path>` and a grep for it both return
nothing, which is indistinguishable from "nothing changed here". It is not silent
any more — and the two scripts must not be confused for each other, because reading
the wrong one led a review of PR #1570 to report a guard that had just failed that
very PR as nonexistent:

| Script | What it does | Where it runs |
|---|---|---|
| `scripts/validate-spec-deps.ts` | checks the **External dependencies** section exists and is populated; always exits 0, informational | `npm run validate:specs` only — nothing under `.github/` runs it |
| `scripts/watch-upstream-areas.mjs --mode=check-docs` | **resolves** every backticked `src/…` token in that section against the upstream trees | `pr-validation.yml` → **`Spec-doc dependency paths`**, on every PR |

The resolution extends `watch-upstream-areas.mjs` as a **sibling mode** rather than
as `--mode=check` itself, which is what this section predicted: `check` scans the
`lfx` subtrees and needs a real working tree, while `check-docs` reads through
`git ls-tree` and therefore runs against a blobless `--depth 1 --no-checkout` clone
(520 KB / 1.6 s, against ~117 MB to materialise the files). Severity follows the
diff (#980) — a path in a doc the PR changed fails, a pre-existing one is reported
as a `::warning::` — and since #1574 it resolves against `origin/main` **plus the
two release lines the nightly is cut from**, naming in a `::notice::` any path that
resolves on only some of them. Measured 2026-08-25: 502 paths, zero unresolved —
spread over the **145** docs that declare any, out of 261 scanned (1 exempt). The
guard's own line reads `from 261 doc(s)` because that is what it read, not what
declared; 116 of them name no path at all.

---

## The M4 deadline

**There is no published date, and this was searched for rather than assumed.** `M4`
appears in **79 files** on `origin/release-1.12.0`, and **none of them carries a
date**: the 77 bundle-shim `__init__.py` docstrings ("removed once the deprecation
window closes (M4)"), `lfx/base/datastax/__init__.py`, and two scripts —
`scripts/ci/check_components_frozen.py` ("the M4 shim cleanup later removes those
dirs") and `scripts/migrate/consolidate_bundles.py`, which is the generator that
writes those docstrings in the first place. So the label is machinery, not a plan.
It is absent from:

- every `.md` on `origin/release-1.12.0`, including `BUNDLE_API.md`, the migration's
  own design document — which *does* discuss M1 and M2, making the silence on M4
  informative rather than merely absent;
- any `\bM[0-9]\b` token in upstream markdown;
- upstream issues and PRs mentioning `lfx-bundles` with a deprecation date;
- upstream **milestones** — `langflow-ai/langflow` has none.

So the deadline cannot be turned into a date from the repository. Getting one
requires **asking the Langflow team** — tracked as #1297, and not something this
suite can resolve on its own. Until then, treat M4 as "not
before the next minor" and rely on the drift detector rather than the calendar.

---

## How to re-measure

Everything above is reproducible: the image answers the packaging questions, the
upstream clone answers the source-tree ones, and this repo answers the inventory.

Substitute your container runtime for `docker` if you use `podman` — the container
is named `langflow-e2e-runner` either way (`scripts/start-langflow-docker.sh`).

```bash
# shim vs core directories, inside the tested image — the authority for those counts
docker exec langflow-e2e-runner python -c '
import importlib.util, pathlib
root = pathlib.Path(importlib.util.find_spec("lfx").submodule_search_locations[0]) / "components"
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    init = d / "__init__.py"
    if not init.exists(): continue
    txt = init.read_text(errors="ignore")
    print("shim" if "lfx-bundles-shim" in txt or "lfx-compat-shim" in txt else "core", d.name)'

# installed lfx-* distributions
docker exec langflow-e2e-runner python -c '
import importlib.metadata as m
print(sorted({d.metadata["Name"] for d in m.distributions() if (d.metadata["Name"] or "").startswith("lfx")}))'

# the same split from the SOURCE, per ref — note release-1.12.0 and main disagree
cd <langflow-clone> && git ls-tree origin/release-1.12.0:src/lfx/src/lfx/components \
  | awk '$2=="tree"{print $4}' | sort > /tmp/dirs.txt
git grep -l "lfx-bundles-shim\|lfx-compat-shim" origin/release-1.12.0 \
  -- 'src/lfx/src/lfx/components/*/__init__.py' \
  | sed 's|.*components/||; s|/__init__.py||' | sort > /tmp/shims.txt
wc -l /tmp/dirs.txt /tmp/shims.txt          # 106 dirs, 79 shims -> 27 core
comm -23 /tmp/dirs.txt /tmp/shims.txt       # the core directories

# the catalog, and the accepted baseline
npm run catalog:baseline           # writes tests/assets/catalog/component-catalog-baseline.json

# VENDOR categories = catalog categories that are not a core directory (20 today)
node -e 'const b=require("./tests/assets/catalog/component-catalog-baseline.json");
const core=new Set(require("fs").readFileSync("/tmp/core.txt","utf8").split("\n").filter(Boolean));
console.log(Object.keys(b.categories).filter(c=>!core.has(c)).sort().join(" "))'

# the inventory: specs that PLACE a component from one of those vendor categories
V="amazon|anthropic|arxiv|azure|cassandra|cohere|datastax|docling|duckduckgo|empiriolabs|exa|firecrawl|google|ibm|nextplaid|ollama|openai|oracle|paddle|valkey"
grep -rlE "getByTestId\(\"($V)[A-Z]|data-testid=\"disclosure-bundles-($V)\"" \
  tests/tests-automations/regression --include="*.spec.ts" | sort

# specs gated on an ABSENT family (direction (b)) — grep the gate, not the component
grep -rln "isProviderComponentAvailable" tests/tests-automations/regression --include="*.spec.ts"

# specs that reach a provider through the resolvers instead of naming a component
grep -rlE '"@(agents|model-provider)"' tests/tests-automations/regression --include="*.spec.ts" | wc -l

# hardcoded component paths in this repo
grep -rnoE "lfx(/src/lfx)?/components/[a-zA-Z_]+" --include="*.ts" --include="*.md" --include="*.mjs" . | grep -v node_modules

# the two dead spellings the grep above does NOT cover
grep -rn "src/backend/base/langflow/components/" --include="*.md" . | grep -v node_modules
grep -rn "src/lfx/components/" --include="*.md" . | grep -v node_modules | grep -v "src/lfx/src/lfx"
```

---

## History — why this file exists

- **#898 / LE-1974** and **#907 / LE-1987** — components silently absent from the
  sidebar, both diagnosed as missing `langchain-*` extras. That was one of two
  gates; the packaging split was the other, and it went unnamed.
- **#1039** — corrected the record and demoted the Groq and Mistral specs: their
  distributions are not installed in the nightly, so those `@stable` specs were
  skipping on every daily. First concrete casualty.
- **#1040** — this file, the drift detector, and the measurements above.
