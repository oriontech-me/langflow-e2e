# Spec: The Loop feeds every item through its body and `done` aggregates the updated items

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/loop-component.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

The **Loop** component iterates over a table one row at a time: each row leaves on the
`item` output, goes through the loop **body**, and the body's result comes back into the
Loop through the `item` **feedback** input. When the rows run out, `done` emits the
aggregated table — and what it aggregates must be the **body's results**, not the rows
that went in.

The body here is **Data Operations** (`Operations`) on JSON input with the
**Append or Update** operation, which adds `tag = modified_value` to each item — the
non-legacy successor of the "Update Data" step this inherited test was written around.
A **Parser** renders `done` one row per line as `{text}={tag}`, and the flow ends in a
Chat Output. With the two rows `alpha` and `beta`, the run must produce exactly:

```
alpha=modified_value
beta=modified_value
```

That one string pins four things at once: both items were processed (two lines), each
was processed once (one tag per line), the aggregate is the body's output (the tag is
there) and each result is paired with its own item, in order.

---

## Tags

`@stable` `@release` `@workspace` `@components` `@ui-ux`

`@ui-ux` is the functional area: the run is started from the canvas and its result read
through the canvas's output inspector — the same choice
`flow-functionality/graph-execution-canvas.spec.ts` made. No `@agents`: the file lives
under `llm-agents/` for history but calls no model.

---

## Step by step

1. Create over the API a flow built from the live `GET /api/v1/all` catalog
   (`build-catalog-flow`), and open it with `openFlowById`:
   - **Create List** with `texts = ["alpha", "beta"]`, its `dataframe` output selected;
   - **Loop**;
   - **Data Operations** configured for JSON input, operation **Append or Update**,
     `append_update_data = {"tag": "modified_value"}`, JSON output;
   - **Parser** with `pattern = "{text}={tag}"`;
   - **Chat Output**.

   Edges: `Create List.dataframe → Loop.data`, `Loop.item → Data Operations.data`,
   `Data Operations → Loop.item` (the feedback), `Loop.done → Parser.input_data`,
   `Parser.parsed_text → Chat Output.input_value`. The flow id is deleted id-scoped in
   `afterEach`, after leaving the editor with `unmountEditorForCleanup`.
2. Assert the canvas shows the five edges.
3. Click `button_run_chat output`; wait for `node_duration_chat output` and
   `node_duration_loop`.
4. Open the Chat Output's output inspector (`output-inspection-output message-chatoutput`)
   and read the dialog's `textarea`.

---

## Validation criterion

| Claim | Observable |
|---|---|
| The whole graph reached the canvas | 5 `.react-flow__edge` |
| The loop ran to completion | `node_duration_loop` and `node_duration_chat output` visible |
| `done` aggregates the body's result for every item, once, in order | the Chat Output value is exactly `alpha=modified_value\nbeta=modified_value` |

The test fails if the Loop stops routing items through its body or back through the
feedback input (measured: without the feedback edge the output is **empty**), if `done`
aggregates the original rows instead of the body's results, or if an item is dropped,
duplicated or reordered.

---

## External dependencies

- `src/lfx/src/lfx/components/flow_controls/loop.py` — the Loop: `item` / `done` and the
  feedback input
- `src/lfx/src/lfx/components/processing/operations.py` — Data Operations: the `JSON`
  input type, **Append or Update**, and the JSON output it switches to
  (`update_outputs`). The test seeds that configuration into the template instead of
  clicking it, so a rename of `input_type`, `operation`, `append_update_data` or
  `data_output` fails the build naming the field
- `src/lfx/src/lfx/components/processing/parser.py` — the `{text}={tag}` rendering
- `src/lfx/src/lfx/components/processing/create_list.py` — the input rows. **Legacy** on
  1.13 (hidden from the sidebar, still in the catalog); it is also the source the
  `@stable` exit-condition test uses
- `src/lfx/src/lfx/components/input_output/chat_output.py`
- `tests/helpers/flows/build-catalog-flow.ts` — builds the five nodes and their edges,
  including the Loop's feedback edge and Create List's selected output

---

## What this test does not cover

- The Loop's handles, its standalone-run failure and the exit condition on N = 3 and
  N = 1 — `core-components/loop-component-regression.spec.ts`.
- Configuring Data Operations through its UI (input type tab, operation list, key/value
  editor). The configuration is seeded; the Loop is the subject.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key, no network egress.
- On the PR lane this path is in `ALWAYS_LLM_AREAS` (`scripts/provider-dependent-specs.mjs`),
  so selecting it forces the `Collect models` sweep even though it calls no model — the
  same trade-off #1907 recorded for `chatInputOutputUser-shard-1`.

---

## Notes

- **Wave 9 T2 triage, issue #1911 — outcome PROMOTE.** Row in
  `docs/triage/inherited-spec-triage.md`: T2,
  `core-functionality/llm-agents/loop-component.spec.ts`, 0/3 green.
- **Why it failed (drift, not product).** Measured on `1.13.0.dev16`: it died at the
  handle `handle-dataoperations-shownode-data-left` (20 s). The component the test was
  written for (`DataOperations`) is now **legacy** and displayed as *JSON Operations*,
  while its replacement `Operations` took over the *Data Operations* display name — so the
  sidebar search found the new component under the old name, and its handles
  (`handle-operations-…`) no longer matched.
- **Why DELETE was not available.** `loop-component-regression.spec.ts`'s exit-condition
  test counts the rows `done` emits through a Type Convert body. A Loop that aggregated the
  **original** rows would still produce N rows and pass it; this test's exact output would
  not.
- Hardening for the promotion: (a) the inherited file built the flow through sidebar drags
  and handle clicks, reached through `awaitBootstrapTest`, and deleted nothing — **3 flows
  leaked per run** on an empty project; the flow is now built over the API and deleted by
  id; (b) its rows came from the URL component fetching two **Wikipedia** pages — public
  internet egress — and now come from Create List; (c) a Read File block labelled "for
  testing the wrong loop message" built a component standalone, asserted nothing about any
  message and deleted it — dropped; (d) the assertion was `toContain("modified_value")`
  plus a count of 2, which a duplicated item paired with a dropped one would pass; it is
  now exact equality.
- The Create List → Loop edge needs Create List's `selected_output` set to `dataframe`:
  measured, without it the canvas selects the `list` output on load and **drops** the edge
  from `dataframe` in its first autosave.
