# LLM Agents — ComposIO Gmail component (PARKED)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev15`)

> **Parked, not pending.** The test is gated on component availability and skips with an
> attributed reason on every run — the treatment `docs/component-distribution-policy.md`
> prescribes for a distribution the tested image does not install, and the same one
> `groq-provider` / `mistral-provider` carry (#1039). The
> component it drives is not shipped by the image this suite tests, and the surface
> is already recorded as out of scope for this QA team (`QA-CHECKLIST.md` § 6.2,
> decision dated 2026-08-06). The park is owned by issue **#1916**; the triage row is
> `docs/triage/inherited-spec-triage.md` (T2,
> `core-functionality/llm-agents/composio.spec.ts`), filed as #1913.

---

## What this test validates *(required)*

The ComposIO **Gmail** component's credential-and-action surface on the canvas: the
component is added from the sidebar, an API key is typed into its `api_key` field,
the component reports a connected OAUTH2 account, an action (`fetch_emails`) is
chosen from its action list, and running the component produces a DataFrame with more
than one cell.

If this broke, users could not connect a ComposIO tool provider to a flow.

**As of `1.13.0.dev15` it validates none of that, and cannot.** See *Why it is parked*.

---

## Tags *(required)*

`@release` `@workspace` `@api` `@components`

`@stable` is **absent deliberately**, for two independent reasons, either of which is
sufficient: the component is not in the tested image (#1040's packaging rule), and
`QA-CHECKLIST.md` § 6.2 records a team decision that this surface is out of scope and
the spec **must not be promoted**. Tracked by **#1916**.

---

## Step by step *(required)*

1. Bootstrap the app and create a blank flow
2. Search the sidebar for `gmail` and add the `composioGmail` component
3. Clear any pre-filled API-key badges
4. Fill `popover-anchor-input-api_key` with `COMPOSIO_API_KEY`
5. Wait for `button_connected_gmail` and for the text `OAUTH2`
6. Open the action list and pick `list_item_fetch_emails`
7. Run the component (`button_run_gmail`) and wait for *built successfully*
8. Open the output inspector and assert the DataFrame has more than one grid cell

---

## Validation criterion *(required)*

- the component reports a connected Gmail account (`button_connected_gmail` + `OAUTH2`)
- the chosen action runs to *built successfully*
- the output DataFrame contains more than one grid cell

---

## Why it is parked *(the measurement, `1.13.0.dev15`)*

**Three facts, each measured, and any one of them is decisive.**

1. **The component is not in the catalog.** `GET /api/v1/all` on the running nightly
   returns **29 categories / 183 component types** (the 30th top-level key is
   `component_display_names`, a metadata map and not a category — folding it in is what
   `CLAUDE.md` warns doubles the type count), and a case-insensitive search for
   `composio` over every `category/type` pair returns **0 hits**. The only Gmail
   components present are Google's own
   (`ext:google:GmailLoaderComponent@official`, `ext:google:GmailSendComponent@official`) —
   a different component with a different testid. `page.getByTestId("composioGmail")`
   can never resolve.

2. **The flavour of absence is `lfx-bundles-shim`, so it is packaging and not a
   rename.** `src/lfx/src/lfx/components/composio/__init__.py` is a shim whose header
   says so, and in the container `import lfx_bundles` raises
   `ModuleNotFoundError: No module named 'lfx_bundles'`. The installed distributions
   are `lfx`, `lfx-amazon`, `lfx-anthropic`, `lfx-azure`, `lfx-cohere`, `lfx-datastax`,
   `lfx-docling`, `lfx-google`, `lfx-ibm`, `lfx-ollama`, `lfx-openai`,
   `lfx-openai-compatible`, `lfx-oracle`, `lfx-toolguard`, `lfx-vllm` — no
   `lfx-bundles`. This is exactly the case `docs/component-distribution-policy.md`
   is the standing answer for (#1039 / #1040): component availability is a packaging
   decision per image, not a tracker item.

3. **The test's own credential gate can never open in CI either.** The body carries
   `test.skip(!process.env.COMPOSIO_API_KEY, …)`, and `COMPOSIO_API_KEY` is **not a
   repository secret** and appears in **no workflow**. That is why the #1784
   measurement reports `skipped in 3/3 run(s)` — the skip is a credential fact, not a
   product verdict — and it is also why this spec has never executed once in any
   lane since it was imported.

**Why gate-and-skip rather than `test.fixme`.** `docs/component-distribution-policy.md`'s
decision table answers "the family's distribution is not installed in the image we test,
and that is upstream's packaging choice" with *"Gate and skip, with an attributed reason.
Do not delete the spec, do not leave it failing"*, implemented as
`probeProviderComponent()` before the first UI step. That gate **self-heals**: the
day the image installs `lfx-bundles` it opens and the spec runs. A `test.fixme` is inert
until a human edits it, so it would trade a recovering gate for a silent one. The
availability probe runs **before** the credential gate, so the reported reason names the
packaging rather than a missing key.

The probe answers three states since #1930, and only `absent` produces the packaging
sentence above. A backend that is wedged, erroring or still building the registry is
`undecided`: the spec still skips, but the reason says the probe could not decide and
carries the underlying error — an unknown must not be recorded as a verdict (#1012),
least of all in the one sentence a lane-coverage reader parses.

`generalBugs-shard-11.spec.ts` carries the same absence from the other side (it
hard-fails waiting for the ComposIO sidebar entry) and is triaged in **#1912**.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/composio/__init__.py` — the `lfx-bundles-shim` that re-points `lfx.components.composio` at the `lfx-bundles` distribution; if the image ever installs that distribution, this spec becomes runnable
- `src/backend/base/langflow/api/v1/endpoints.py` — serves `GET /api/v1/all`, the catalog whose contents decide whether the sidebar can offer the component at all

---

## What this test does not cover *(optional)*

- any other ComposIO tool (only Gmail)
- the OAuth consent flow itself — the test asserts the connected state, never performs the grant

---

## Preconditions *(optional)*

- An image that installs `lfx-bundles` (the OSS nightly does not)
- `COMPOSIO_API_KEY` in the environment, with a ComposIO account holding a connected Gmail integration

---

## When to review this test *(optional)*

- `docs/component-distribution-policy.md` changes, or the nightly starts installing `lfx-bundles`
- the team revisits the § 6.2 out-of-scope decision
- **#1916** is closed
