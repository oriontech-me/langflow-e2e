# LLM Agents — YouTube Transcripts component (PARKED)

**File:** `tests/tests-automations/regression/core-functionality/llm-agents/youtube-transcripts.spec.ts`
**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev22`)

> **Parked, not pending.** The component is not shipped by the image this suite tests.
> The test is gated on component availability and skips with an attributed reason on
> every run — the treatment `docs/component-distribution-policy.md` prescribes for a
> distribution the tested image does not install, and the same one `groq-provider`,
> `mistral-provider` (#1039) and `composio` (#1916) carry. The park is owned by issue
> **#1912**; the triage row is `docs/triage/inherited-spec-triage.md` (T2,
> `core-functionality/llm-agents/youtube-transcripts.spec.ts`, `0/3 green`).

---

## What this test validates *(required)*

The YouTube Transcripts component's happy path on the canvas: the component is added
from the sidebar, a video URL is typed into its `url` field, the component is run, and
its transcript output is inspected and asserted non-trivial.

If this broke, users could not pull a video transcript into a flow.

**As of `1.13.0.dev22` it validates none of that, and cannot.** See *Why it is parked*.

---

## Tags *(required)*

`@release` `@components` `@agents`

`@stable` is **absent deliberately**: the component is not in the tested image, so a
tagged test would skip on every daily — a green that measures nothing (#1039/#570/#1010).
Tracked by **#1912**.

---

## Step by step *(required)*

1. Bootstrap the app and create a blank flow
2. Search the sidebar for `youtube` and add the `youtubeYouTube Transcripts` component
3. Clear outdated components
4. Fill `textarea_str_url` with a YouTube video URL
5. Run the component (`button_run_youtube transcripts`) and wait for
   *built successfully*
6. Open `output-inspection-transcript-youtube-transcripts`, wait for *Component Output*
7. Assert the first grid cell holds a value longer than 10 characters

---

## Validation criterion *(required)*

- the component runs to *built successfully*
- the transcript output's first cell holds more than 10 characters

---

## Why it is parked *(the measurement, `1.13.0.dev22`)*

**Two facts, each measured, and either is decisive.**

1. **The component is not in the catalog.** `GET /api/v1/all` on the running nightly
   returns **32 categories / 200 component types** (the 33rd top-level key is
   `component_display_names`, a metadata map and not a category) and a case-insensitive
   search for `youtube` over every `category/type` pair and every
   `component_display_names` key returns **0 hits**. A sidebar search for `youtube`
   renders *"No components found."*, so `getByTestId("youtubeYouTube Transcripts")` can
   never resolve — which is the old spec's `locator.hover: Timeout 20000ms exceeded`.

2. **The flavour of absence is `lfx-bundles-shim`, so it is packaging and not a
   rename.** `src/lfx/src/lfx/components/youtube/__init__.py` is a shim whose header says
   so, and in the container `import lfx_bundles` raises
   `ModuleNotFoundError: No module named 'lfx_bundles'`. The image installs 16 `lfx_*`
   distributions — `lfx`, `lfx_amazon`, `lfx_anthropic`, `lfx_azure`, `lfx_cohere`,
   `lfx_datastax`, `lfx_docling`, `lfx_google`, `lfx_ibm`, `lfx_microsoft`,
   `lfx_ollama`, `lfx_openai`, `lfx_openai_compatible`, `lfx_oracle`, `lfx_slack`,
   `lfx_toolguard`, `lfx_vllm` — and **no `lfx-bundles`**. This is exactly the case
   `docs/component-distribution-policy.md` is the standing answer for (#1039 / #1040).

**Why gate-and-skip rather than the `test.skip` it carried.** The spec was imported as a
bare `test.skip(...)` declaration — inert, unattributed, and indistinguishable from a
test somebody meant to come back to. The policy's decision table answers a distribution
the tested image does not install with *"Gate and skip, with an attributed reason. Do
not delete the spec, do not leave it failing"*, implemented as
`probeProviderComponent()` before the first UI step. That gate **self-heals**: the day
the image installs `lfx-bundles` it opens and the spec runs. The bare modifier never
would.

The probe answers three states since #1930, and only `absent` produces the packaging
sentence above. A wedged or erroring backend — or any `200` whose body is not a readable
catalog — is `undecided`: the spec still skips, but the reason says the probe could not
decide and carries the underlying error, because an unknown must not be recorded as a
verdict (#1012).

**This spec was never `@stable`**, so its park is owned by an open issue rather than a
declaration in `scripts/lib/stable-orphan-exemptions.json`: #1746's reconciler reports a
declaration whose test never carried the tag as **expired** rather than honouring it.
#1912 names this file in its body, which keeps `check-stable-ownership.ts` reporting it
as `owned`.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/youtube/__init__.py` — the `lfx-bundles-shim` that
  re-points `lfx.components.youtube` at the `lfx-bundles` distribution; if the image ever
  installs that distribution, this spec becomes runnable
- `src/backend/base/langflow/api/v1/endpoints.py` — serves `GET /api/v1/all`, the catalog
  whose contents decide whether the sidebar can offer the component at all

---

## What this test does not cover *(optional)*

- any YouTube component other than Transcripts
- transcript language selection, or a video with transcripts disabled

---

## Preconditions *(optional)*

- An image that installs `lfx-bundles` (the OSS nightly does not)
- Outbound network access to YouTube from the Langflow instance

---

## When to review this test *(optional)*

- `docs/component-distribution-policy.md` changes, or the nightly starts installing
  `lfx-bundles`
- **#1912** is closed
