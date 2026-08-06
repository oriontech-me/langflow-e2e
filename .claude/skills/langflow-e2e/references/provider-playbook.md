# Provider-spec playbook

Six merged provider specs (§7.2–§7.6: openai, anthropic, google, ollama,
groq, mistral) established that "add provider coverage" has **three distinct
shapes** — and that the issue body cannot tell you which one applies. Run the
**surface triage** first; it costs ~5 minutes and prevents a spec-doc rewrite
(#499 paid one).

## Step 0 — surface triage (BEFORE authoring the spec doc)

1. **Settings UI:** open `/settings/model-providers` live and SEARCH for the
   provider (the list renders a subset — scrolling isn't enough). Found ⇒
   keyed-Settings shape. "No providers match your search" ⇒ not configurable
   there, regardless of what the API says.
2. **Backend list:** `GET /api/v1/models/providers`. The UI and this list
   diverge (1.11: API lists Groq + Azure OpenAI, the Settings page renders
   neither; Mistral is absent from both). A divergence goes on the PR as a
   product observation — never assume either side alone.
3. **Component source in the container.** Do **not** hardcode a path — there are two
   post-migration layouts and one of them is not installed. Ask Python where the
   module actually is:

   ```bash
   docker exec langflow-e2e-runner python -c '
   import importlib, pathlib
   for mod in ("lfx_<provider>.components.<provider>", "lfx_bundles.<provider>", "lfx.components.<provider>"):
       try:
           m = importlib.import_module(mod)
       except ModuleNotFoundError as e:
           print("absent:", mod, "-", e); continue
       print("found:", mod, "->", pathlib.Path(m.__file__).parent)
       break'
   ```

   A **graduated** vendor lives at `lfx_<vendor>/components/<vendor>/<file>.py`; one
   still inside the aggregate lives at `lfx_bundles/<vendor>/<vendor>.py` — and
   `lfx-bundles` is **not installed** on the tested image, so for those vendors there
   is no source in the container to read at all (read it from the upstream clone
   instead). The `lfx.components.<vendor>` spelling is the shim, removed at M4, which
   has **no published date** — see `docs/component-distribution-policy.md`. Measured
   on `origin/release-1.12.0`: 79 of the 106 `lfx/components/*` directories are
   shims.
   Read three things: is `api_key` `real_time_refresh`? Is the `model_name`
   dropdown **live-fetched or a static hardcoded list**? What is the field's
   **default value** (a default like Mistral's `codestral-latest` means the
   exact-name selection assert has real bite)?

## The three shapes

| Shape | Examples | Test 1 (configure) | Execution proof |
|---|---|---|---|
| **Keyed-Settings** | OpenAI §7.2, Anthropic §7.3, Google §7.4 | Settings → `provider-item-<Name>` → `provider-variable-input-<VAR>` → Save with waiters armed BEFORE the click: `POST validate-provider` 2xx **and** `POST\|PATCH /variables` 2xx (causal — pre-existing state can't pass) | Agent path: `SimpleAgentTemplatePage.load({provider, model})`, model from `models.json` by family regex (prefer undated names), sentinel run |
| **Component-only** | Groq #499, Mistral #500 | Fill `popover-anchor-input-api_key` on the node. If `real_time_refresh` (Groq): await the `custom_component/update` 200 it fires — causal key proof. If static (Mistral): no request to await — the authenticated inference IS the proof | Blank flow Chat Input → \<node\> → Chat Output, exact-name model select, non-empty Playground reply |
| **Local-service** | Ollama #498 | Settings URL variable (reset it via API first — Save is disabled on unchanged values) + SSRF allowlist on the container | Component flow; live dropdown listing the locally pulled tag is the connectivity assert |

All three share: probe-gated skips, per-run sentinel (logged, not asserted),
id-scoped flow cleanup, `.env.example` block, `--workers=1` serial. See
`authoring-conventions.md` for each of those patterns.

## Family-sibling rule (first-mover cost)

If a sibling spec of the same shape exists, **start from its skeleton and
source-dive the component for deviations** — do not rediscover. #500 shipped
in ~12 min this way (vs ~40 min for first-mover #499): the static-dropdown
and no-refresh deviations were found in the component source before writing
a line of the spec. The deviations, not the skeleton, are where the new
spec's asserts live.

## Live-catalog observables — when the dropdown proves something

- Dropdown contents prove connectivity ONLY if they contain something the
  static fallback cannot: Ollama's locally-pulled tag (static catalog never
  has it) ✔; Groq's live list overlaps static on the test model ✘ (the
  update-200 wait + inference carry the proof); Mistral has no live fetch at
  all ✘.
- Check `lfx/base/models/<provider>_constants.py` for the static list before
  claiming a dropdown assert is a connectivity proof.

## Model choice

- Prefer the cheapest/fastest current model (`llama-3.1-8b-instant`,
  `mistral-small-latest`, haiku-family) — env-overridable via
  `<PROVIDER>_TEST_MODEL`.
- The probe verifies the model is in the live catalog; for static-dropdown
  components it must ALSO be in the hardcoded options (the selection step
  enforces that inherently).
- Multi-model bullets ("switch between X, Y, Z"): resolve each family by
  regex from `models.json`, execute after ONE switch, select-only for the
  expensive tier (Opus) — mechanism proven once is proven (#503 Test 3).
