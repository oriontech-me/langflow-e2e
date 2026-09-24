# Flow Functionality — ComposIO Tools places without an `api_key` error (PARKED)

**File:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-11.spec.ts`
**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev22`)

> **Parked, not pending.** The component is not shipped by the image this suite tests.
> The test is gated on component availability and skips with an attributed reason on
> every run — the treatment `docs/component-distribution-policy.md` prescribes for a
> distribution the tested image does not install, and the same one `groq-provider`,
> `mistral-provider` (#1039) and `core-functionality/llm-agents/composio.spec.ts`
> (#1916) carry. The park is owned by issue **#1912**; the triage rows are
> `docs/triage/inherited-spec-triage.md` (T2, `flow-functionality/generalBugs-shard-11.spec.ts`,
> both tests `0/3 green`).
>
> **This file used to hold a second test, *user should be able to use connect tools*,
> which was DELETED rather than parked.** See *The deleted sibling*.

---

## What this test validates *(required)*

The regression this spec was imported for: dragging the **ComposIO Tools** component
onto the canvas must not surface an `api_key` error before the user has configured
anything. The component is searched in the sidebar, dragged onto the canvas, the view
is zoomed out, and the canvas is asserted to contain no `api_key` text.

If this broke, the component would greet every user with a credential error on drop.

**As of `1.13.0.dev22` it validates none of that, and cannot.** See *Why it is parked*.

---

## Tags *(required)*

`@release` `@components` `@workspace`

`@stable` is **absent deliberately**: the component is not in the tested image, so a
tagged test would skip on every daily — a green that measures nothing (#1039/#570/#1010).
`QA-CHECKLIST.md` § 6.2 additionally records a team decision (2026-08-06) that the
ComposIO surface is out of scope and must not be promoted. Tracked by **#1912**.

---

## Step by step *(required)*

1. Bootstrap the app and create a blank flow
2. Search the sidebar for `composio`
3. Drag `composioComposio Tools` onto the canvas (`#react-flow-id`)
4. Fit the view and zoom out
5. Assert no `api_key` text is visible on the canvas

---

## Validation criterion *(required)*

- the ComposIO Tools node is on the canvas
- no element containing the text `api_key` is visible

---

## Why it is parked *(the measurement, `1.13.0.dev22`)*

**Two facts, each measured, and either is decisive.**

1. **The component is not in the catalog.** `GET /api/v1/all` on the running nightly
   returns **32 categories / 200 component types** (the 33rd top-level key is
   `component_display_names`, a metadata map and not a category) with **zero**
   `composio` entries across every `category/type` pair and every
   `component_display_names` key. The four raw substring hits in the response body are
   incidental: they are the `replacement = ["composio.ComposioGmailAPIComponent"]`
   attribute of Google's own legacy Gmail loader, pointing at a class the image does not
   ship. A sidebar search for `composio` renders *"No components found."*, so
   `waitForSelector('[data-testid="composioComposio Tools"]')` can never resolve — which
   is the recorded `page.waitForSelector: Timeout 3000ms exceeded`.

2. **The flavour of absence is `lfx-bundles-shim`, so it is packaging and not a
   rename.** `src/lfx/src/lfx/components/composio/__init__.py` is a shim whose header
   says so, and in the container `import lfx_bundles` raises
   `ModuleNotFoundError: No module named 'lfx_bundles'`; the image installs no
   `lfx-bundles`. This is exactly the case `docs/component-distribution-policy.md` is
   the standing answer for (#1039 / #1040).

`core-functionality/llm-agents/composio.spec.ts` carries the same absence from the other
side — it skips on its own gate rather than hard-failing — and its doc
(`docs/core-functionality/llm-agents/composio.md`) already anticipated this file.

**Why gate-and-skip rather than `test.fixme`.** The policy's decision table answers a
distribution the tested image does not install with *"Gate and skip, with an attributed
reason. Do not delete the spec, do not leave it failing"*, implemented as
`probeProviderComponent()` before the first UI step. That gate **self-heals** the day
the image installs `lfx-bundles`; a `test.fixme` is inert until a human edits it.

The probe answers three states since #1930, and only `absent` produces the packaging
sentence above. A wedged or erroring backend is `undecided`: the spec still skips, but
says the probe could not decide and carries the underlying error (#1012).

**This spec was never `@stable`**, so its park is owned by an open issue rather than a
declaration in `scripts/lib/stable-orphan-exemptions.json`: #1746's reconciler reports a
declaration whose test never carried the tag as **expired**. #1912 names this file in
its body, which keeps `check-stable-ownership.ts` reporting it as `owned`.

---

## The deleted sibling — *user should be able to use connect tools*

That test was removed in the same change, under the T2 design's **DELETE** outcome, and
the evidence is recorded here because the triage table cannot hold it.

**It was never a ComposIO test.** #1912's body attributes both of this file's tests to
ComposIO's absence; the second one never mentions ComposIO. It searched `search api`,
waited for `[data-testid="searchapiSearchApi"]` at a 1000 ms timeout, dragged in a
`Tool Calling Agent`, enabled tool mode and asserted `.react-flow__edge-interaction`
reached a count of 2.

**Its real blocker was the SearchApi half, and it is not packaging either.** Measured on
`1.13.0.dev22`, `SearchAPI` **is** in the catalog — `tools::SearchAPI`, display name
`Search API`, served from the core module `lfx.components.tools.search_api.SearchAPIComponent`,
not from the `searchapi` shim. But **all ten components of the `tools` category are
`legacy: true`**, and legacy components are not offered in the sidebar: searching
`search api` and `searchapi` both render *"No components found."*. The other half of the
test is fine — `langchain_utilitiesTool Calling Agent` still resolves exactly as written,
under the LangChain bundle.

**The replacement, named as design §3 requires:**

| Deleted test | Replacing `@stable` test |
|---|---|
| *user should be able to use connect tools* | `core-components/tool-mode.spec.ts` → *User should be able to use components as tool* |

The replacement asserts the same subject and the same failure condition, and is strictly
stronger: it enables tool mode on a component (`tool-mode-button`), connects
`handle-urlcomponent-shownode-toolset-right` to `handle-agent-shownode-tools-left`,
asserts an edge was created, and then also asserts the toolset's output contract
(`tool_name`, `tool_description`, `tool_tags`) — which the deleted test never did. It
also drives the core `URL` component instead of a legacy one the sidebar hides, so it
cannot fail the same way.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/composio/__init__.py` — the `lfx-bundles-shim` that
  re-points `lfx.components.composio` at the `lfx-bundles` distribution; if the image
  ever installs that distribution, this spec becomes runnable
- `src/lfx/src/lfx/components/tools/search_api.py` — the core `SearchAPIComponent`
  whose `legacy: true` flag is why the deleted sibling could not reach it from the
  sidebar
- `src/backend/base/langflow/api/v1/endpoints.py` — serves `GET /api/v1/all`, the
  catalog whose contents decide whether the sidebar can offer either component

---

## What this test does not cover *(optional)*

- configuring or running the ComposIO component — only that placing it raises no
  premature credential error
- any other ComposIO tool

---

## Preconditions *(optional)*

- An image that installs `lfx-bundles` (the OSS nightly does not)

---

## When to review this test *(optional)*

- `docs/component-distribution-policy.md` changes, or the nightly starts installing
  `lfx-bundles`
- the `tools` category stops being `legacy`, which would make the deleted sibling
  runnable again — though not worth restoring, since its replacement is stronger
- **#1912** is closed
