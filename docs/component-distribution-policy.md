# Component distribution policy (`lfx-bundles`)

**Last measured:** Langflow Nightly `1.12.0.dev10` (`langflowai/langflow-nightly:latest`),
2026-08-05. Written for #1040.

Since 1.12, **whether a component exists is a packaging decision, per image.** This
file is the standing answer to "a component family is missing from the build — now
what?", so that question stops being re-decided per incident. It has been decided
twice already, both times partly wrong (#898, #907 — see *History*).

---

## The mechanism

Most component families moved out of `lfx.components.*` into **per-vendor
distributions** (`lfx_openai`, `lfx_anthropic`, `lfx_google`, …) plus an aggregate
`lfx-bundles` package. The old import paths still exist as shims marked
`# lfx-bundles-shim`, which re-point at the installed distribution and raise a
`ModuleNotFoundError` naming `lfx-bundles` when it is absent. The shims are
**deleted at M4** (see *The M4 deadline* — it has no published date).

Measured on `1.12.0.dev10`, inside the tested image:

| | Count |
|---|---|
| `lfx/components/*` directories that are shims | **78** |
| `lfx/components/*` directories still core | **28** |
| `lfx-*` vendor distributions installed | **21** (incl. `lfx` itself) |
| `lfx-bundles` installed | **no** |
| Categories in `GET /api/v1/all` | **36** |
| Component types in `GET /api/v1/all` | **189** |

**The rule that matters, and it holds without exception on this image:** a category
appears in `GET /api/v1/all` **iff** it is core **or** its vendor distribution is
installed. All 20 vendor categories whose distribution is installed are present;
no shim without an installed distribution has a category.

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
  `probe-component-available.ts` and `probe-component-buildable.ts` both exist.

---

## Inventory: which of our specs depend on a vendor distribution

Two directions, because they fail differently and only one of them is visible today.

**(a) Specs that name a component living in a distribution the image DOES ship — 8 of 247.**
These pass today and are coupled to a packaging choice, not to a Langflow feature.

| Distribution(s) | Spec |
|---|---|
| `openai` | `api/flows/api-custom-component-creation.spec.ts` |
| `amazon` | `core-components/beta-components-toggle-regression.spec.ts` |
| `google` | `core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts` |
| `google` | `core-functionality/knowledge-ingestion-management/vector-store-index-query.spec.ts` |
| `anthropic`, `openai` | `core-functionality/llm-agents/model-provider-model-toggle.spec.ts` |
| `anthropic`, `google`, `ollama`, `openai` | `core-functionality/llm-agents/modelProviderModal.spec.ts` |
| `openai` | `core-functionality/observability-monitoring/traces-detail-llm-span-populated.spec.ts` |
| `openai` | `flow-functionality/generalBugs-shard-3.spec.ts` |

**(b) Specs gated on a family the image does NOT ship — 3.**
`groq-provider.spec.ts` and `mistral-provider.spec.ts` skip on every run (#1039).
`ollama-provider.spec.ts` carries the same gate but Ollama **returned** to the default
image, so its gate currently passes — it is insurance, not an active skip.

**The 8 in (a) is a floor, not the blast radius, and this is the important caveat.**
The method is a textual match on component display names and type keys, so it only
sees specs that *name* a component — and, by construction, only components the image
currently exposes. It cannot see:

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

Decide in this order. The first row that matches wins.

| Situation | Decision | Mechanism |
|---|---|---|
| The family's distribution is **not installed** in the image we test, and that is upstream's packaging choice (not a bug) | **Gate and skip, with an attributed reason.** Do not delete the spec, do not leave it failing. | `isProviderComponentAvailable()` before the first UI step; `test.skip()` naming the distribution and #1039 |
| Same, and the spec carries `@stable` | **Remove `@stable`** and demote the checklist bullet to `[-]`, stating in the bullet that the component is not on the tested image | A `@stable` spec that skips on every daily is a green that measures nothing (#1039/#570) |
| The family is installed but the component fails to **build** (missing `langchain-*`) | **Gate on buildability, not presence** | `probe-component-buildable.ts` (#900) — a registry hit does not prove it runs |
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
coverage for tidiness (#980). But it never reads as clean when it has no verdict — a
missing baseline, an unparseable one, and a failed request each say so explicitly
(#1012).

One detail worth keeping: `component_display_names` is a key of `GET /api/v1/all`
that is a **metadata map, not a category** (189 entries, one per component, keyed by
the lowercased type name). Folding it into the snapshot would list every component
twice and make reparenting undetectable.

---

## Hardcoded `lfx/components/...` paths and the M4 expiry

Measured across the whole repo (`*.ts`, `*.md`, `*.mjs`): **28 references, and none
of them points at a shim.** They resolve to six families, all core:

| Family | Refs | Core on `1.12.0.dev10` |
|---|---|---|
| `models_and_agents` | 7 | yes |
| `input_output` | 7 | yes |
| `processing` | 7 | yes |
| `flow_controls` | 4 | yes |
| `data_source` | 2 | yes |

So the M4 shim deletion breaks **zero** of our recorded paths today. #1040 assumed
otherwise ("anything of ours that reaches `lfx.components.*` directly breaks silently
at that point") — measured, it does not. **Re-measure when M4 gets a date**, since
core families keep moving: the command is in the *How to re-measure* section below.

The grep did find one defect, of a different kind. `docs/core-components/agent-component-regression.md`
recorded `src/lfx/src/lfx/components/agents/agent.py` — an `agents/` directory that
exists on **no** current ref; the component is at `models_and_agents/agent.py`.
Corrected in #1040.

That is the #1092 failure mode in a second place: a path that does not exist is
**silent**, because `git log --since -- <bad-path>` and a grep for it both return
nothing, which is indistinguishable from "nothing changed here".
`scripts/validate-spec-deps.ts` does not catch it — it checks that the
**External dependencies** section exists and is populated, never that its paths
resolve — and it is informational, not a gate. Validating every spec-doc dependency
path against a real ref is a worthwhile guard and a **separate** issue; it overlaps
`watch-upstream-areas.mjs --mode=check`, which already does this for the
`file-watcher` area table, and should extend that rather than duplicate it.

---

## The M4 deadline

**There is no published date, and this was searched for rather than assumed.** `M4`
appears only in the shim docstrings (`lfx/components/*/__init__.py`: "removed once
the deprecation window closes (M4)"). It is absent from:

- every `.md` on `origin/release-1.12.0`, including `BUNDLE_API.md`, the migration's
  own design document;
- any `\bM[0-9]\b` token in upstream markdown;
- upstream issues and PRs mentioning `lfx-bundles` with a deprecation date;
- upstream **milestones** — `langflow-ai/langflow` has none.

So the deadline cannot be turned into a date from the repository. Getting one
requires **asking the Langflow team**; that ask is the remaining open item on #1040
and is not something this suite can resolve on its own. Until then, treat M4 as "not
before the next minor" and rely on the drift detector rather than the calendar.

---

## How to re-measure

Everything above is reproducible against a running instance.

```bash
# shim vs core directories, inside the tested image
podman exec langflow-e2e-runner python -c '
import importlib.util, pathlib
root = pathlib.Path(importlib.util.find_spec("lfx").submodule_search_locations[0]) / "components"
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    init = d / "__init__.py"
    if not init.exists(): continue
    txt = init.read_text(errors="ignore")
    print("shim" if "lfx-bundles-shim" in txt or "lfx-compat-shim" in txt else "core", d.name)'

# installed lfx-* distributions
podman exec langflow-e2e-runner python -c '
import importlib.metadata as m
print(sorted({d.metadata["Name"] for d in m.distributions() if (d.metadata["Name"] or "").startswith("lfx")}))'

# the catalog, and the accepted baseline
npm run catalog:baseline           # writes tests/assets/catalog/component-catalog-baseline.json

# hardcoded component paths in this repo
grep -rnoE "lfx(/src/lfx)?/components/[a-zA-Z_]+" --include="*.ts" --include="*.md" --include="*.mjs" . | grep -v node_modules
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
