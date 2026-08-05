import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";
import { separateOverlappingNodes } from "../../../helpers/ui/separate-overlapping-nodes";
import { zoomOut } from "../../../helpers/ui/zoom-out";

// §3.10 Data Operations (1.11.0) — the component that unified JSON Operations,
// Table Operations and Text Operations into one node (upstream #13743/#14025;
// `lfx/components/processing/operations.py`, class OperationsComponent,
// name="Operations"). The three originals stayed in the sidebar as `legacy`
// with `replacement = ["processing.Operations"]`.
//
// The contract under test: the Input Type tab (Text/JSON/Table) filters the
// operation picker, swaps the main input and the advertised output — and the
// SELECTED OPERATION can override that output type (Word Count on a Text input
// emits JSON; Text to DataFrame emits a Table). Each operation must then return
// the value its own semantics define.
//
// No provider key, no models.json, no --workers=1: every operation is pure
// Python (string ops, dict ops, pandas). See
// docs/core-components/data-operations-component.md.

// The sentinel repeats `data` and `ops` ON PURPOSE, so `unique_words` (4) and
// `word_count` (6) differ — a regression returning the same list for both would
// pass against a sentinel with all-distinct words.
const WORD_COUNT_TEXT = "data ops probe abc123 data ops";
const CASE_TEXT = "data ops probe abc123";

// Pipe-separated table for `Text to DataFrame` (default separator `|`,
// has_header default true). `score` is converted to numeric by
// `_convert_numeric_columns`, so `> 15` keeps beta and gamma — deliberately NOT
// the first N rows, so a head-like regression cannot look like a pass.
const TABLE_TEXT = ["name|score", "alpha|10", "beta|30", "gamma|20"].join("\n");

// Ids of the flows each test creates via the REST API — deleted id-scoped in
// afterEach (#490/#681/#515). Never cleanAllFlows / name-scoped / diff-based:
// those wipe flows other parallel workers are actively driving (#553).
const createdFlowIds: string[] = [];

// Before the first document load — the only point at which the assistant
// onboarding tooltip can be suppressed (#1220). The two-node tests click the
// canvas-controls bar (zoomOut, adjustScreenView), which the tooltip covers.
test.beforeEach(async ({ page }) => {
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ page, request }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the editor before deleting: a mounted editor keeps polling
  // `GET /flows/{id}/events` and 404s once the flow is gone, which the fixture
  // logs as `🚨 Backend Error` (#1023/#1103/#1288).
  await unmountEditorForCleanup(page);
  const bearer = await getAuthToken(request);
  for (const id of ids) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Create a blank flow through the REST API (parallel-safe unique name), open it
// and add one Data Operations node. Returns the flow id. Mirrors
// `parameters-panel-field-types.spec.ts` — going through the API means the id is
// known without sniffing the creation response, and the canvas URL id is
// transient on this Langflow version.
async function openFlowWithDataOperations(
  page: Page,
  request: APIRequestContext,
  bearer: string,
): Promise<string> {
  const flowId = await createFlow(
    request,
    {
      name: `Data Ops ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      data: { nodes: [], edges: [] },
      is_component: false,
    },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });
  await addDataOperationsNode(page);
  return flowId;
}

async function addDataOperationsNode(page: Page): Promise<void> {
  const before = await page.locator(".react-flow__node").count();
  await addComponentFromSidebar(
    page,
    "data operations",
    "add-component-button-data-operations",
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1, {
    timeout: 15000,
  });
}

// Both nodes in the chained tests are of type `Operations`, so every testid on
// them is identical. They are addressed by an identity-carrying child instead of
// by DOM order: only a Text-mode node renders `textarea_str_text_input`, and only
// a JSON/Table-mode node renders the matching typed input handle. Each locator is
// asserted to resolve to exactly one node before use, so a mis-selection fails
// naming the cause instead of silently configuring the wrong node.
function nodeContaining(page: Page, childTestId: string): Locator {
  return page
    .locator(".react-flow__node")
    .filter({ has: page.getByTestId(childTestId) });
}

async function expectSingleNode(node: Locator, what: string): Promise<Locator> {
  await expect(node, `${what} should resolve to exactly one node`).toHaveCount(
    1,
    { timeout: 15000 },
  );
  return node;
}

// The operation picker is a SortableListInput with limit=1: the "Select
// Operation" button is replaced by a chip once an operation is chosen. Every
// test picks its operation once, so no chip removal is needed here. Switching the
// Input Type clears the selection by itself (update_build_config sets
// `operation.value = []`), which is what lets the chained tests re-open it.
async function pickOperation(
  page: Page,
  node: Locator,
  optionTestId: string,
): Promise<void> {
  await node
    .getByTestId("button_open_list_selection_sortablelist_sortablelist_operation")
    .click();
  await page.getByTestId(optionTestId).click();
  await expect(page.getByTestId(optionTestId)).toHaveCount(0, {
    timeout: 15000,
  });
}

// Assert the picker offers the operations of `input_type` and no longer offers
// the others — `update_build_config` swapping
// `build_config["operation"]["options"]` to OPERATIONS_BY_TYPE[input_type],
// observed from the UI. Leaves the picker OPEN on the wanted option so the
// caller can click it.
async function expectPickerFilteredTo(
  page: Page,
  node: Locator,
  presentTestId: string,
): Promise<void> {
  await node
    .getByTestId("button_open_list_selection_sortablelist_sortablelist_operation")
    .click();
  await expect(page.getByTestId(presentTestId)).toBeVisible({ timeout: 15000 });
  // `Case Conversion` belongs to the Text tab only: still being offered would
  // mean the picker was never re-filtered for the selected type.
  await expect(page.getByTestId("list_item_case_conversion")).toHaveCount(0);
}

async function selectDropdownOption(
  page: Page,
  node: Locator,
  dropdownTestId: string,
  optionName: string,
): Promise<void> {
  await node.getByTestId(dropdownTestId).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await expect(node.getByTestId(dropdownTestId)).toHaveText(optionName, {
    timeout: 15000,
  });
}

// Run one node and wait for its build badge — `node_duration_*` renders only on
// a successful build and is the repo's canonical completion signal (#506/#507).
//
// The click is dispatched at the event level: on the two-node canvas the lower
// node's controls sit under `main_canvas_controls` (and, right after a build,
// under the "built successfully" toast), which intercepts hit-tested clicks.
// Same fix, and same safeguard, as `selectOperator` in
// `if-else-component-regression.spec.ts`: the assertion below fails loudly if
// the dispatch was a no-op.
async function runNode(node: Locator): Promise<void> {
  await node.getByTestId("button_run_data operations").dispatchEvent("click");
  await expect(node.getByTestId("node_duration_data operations")).toBeVisible({
    timeout: 60000,
  });
}

// Open a node's output inspector and return the modal. The testid carries the
// output's DISPLAY NAME (`output-inspection-<title>-<type>`), so requesting
// `output-inspection-json-operations` is itself an assertion that the node
// advertises a JSON output.
async function openOutputInspector(
  page: Page,
  node: Locator,
  outputTestId: string,
): Promise<Locator> {
  // Dispatched for the same reason as in `runNode`, and guarded the same way:
  // the modal becoming visible is what proves the dispatch landed.
  await node.getByTestId(outputTestId).dispatchEvent("click");
  const modal = page.locator('[role="dialog"]').last();
  await expect(modal).toBeVisible({ timeout: 15000 });
  return modal;
}

async function closeOutputInspector(page: Page): Promise<void> {
  await page.getByTestId("btn-close-modal").click();
}

// The node-level Text field is an `<input type="text">` and strips newlines —
// a multi-line value has to go through the text-area modal.
async function fillMultilineText(
  page: Page,
  node: Locator,
  value: string,
): Promise<void> {
  await node
    .getByTestId("button_open_text_area_modal_textarea_str_text_input")
    .click();
  const modal = page.locator('[role="dialog"]').last();
  await modal.getByTestId("text-area-modal").fill(value);
  await modal.getByTestId("genericModalBtnSave").click();
  await expect(modal).toBeHidden({ timeout: 15000 });
}

// Add the second Data Operations node and spread the two apart. Two sidebar `+`
// clicks land the nodes ~10px apart, and a stacked node intercepts pointer
// events aimed at a handle underneath it — which can silently produce a
// different connection than intended (#939).
//
// Order matters, and the obvious one is wrong: `adjustScreenView` starts with
// `fit_view`, which on two STACKED nodes zooms IN to fill the canvas with them,
// undoing the zoom-out and leaving each node ~415 px tall — taller than
// `separateOverlappingNodes`' default 220 px step, so the separation poll can
// never converge (measured: both chained tests failed there on the first run).
// So: zoom out first, separate with a step wider than the zoomed-out node, and
// only then fit both nodes back into view.
async function addSecondNodeAndSeparate(page: Page): Promise<void> {
  await addDataOperationsNode(page);
  await zoomOut(page, 3);
  await separateOverlappingNodes(page, 300);
  await adjustScreenView(page);
}

test(
  "Data Operations Text mode returns the Case Conversion result as a Message",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with one Data Operations node", async () => {
      await openFlowWithDataOperations(page, request, bearer);
      await expect(page.getByTestId("title-Data Operations")).toBeVisible({
        timeout: 15000,
      });
    });

    const node = page.locator(".react-flow__node").first();

    await test.step("Configure Text / Case Conversion → uppercase", async () => {
      // Input Type stays on its default `Text` tab.
      await node.getByTestId("textarea_str_text_input").fill(CASE_TEXT);
      await pickOperation(page, node, "list_item_case_conversion");
      await selectDropdownOption(
        page,
        node,
        "value-dropdown-dropdown_str_case_type",
        "uppercase",
      );
    });

    await test.step("Run and assert the Message output is the uppercased text", async () => {
      await runNode(node);
      const modal = await openOutputInspector(
        page,
        node,
        "output-inspection-message-operations",
      );
      // `as_message` → Message(text=text.upper()); the inspector renders a
      // Message output in a textarea.
      await expect(modal.locator("textarea").first()).toHaveValue(
        CASE_TEXT.toUpperCase(),
        { timeout: 15000 },
      );
      await closeOutputInspector(page);
    });
  },
);

test(
  "Data Operations Word Count switches the Text-mode output to JSON and counts the text",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with one Data Operations node", async () => {
      await openFlowWithDataOperations(page, request, bearer);
      await expect(page.getByTestId("title-Data Operations")).toBeVisible({
        timeout: 15000,
      });
    });

    const node = page.locator(".react-flow__node").first();

    await test.step("Configure Text / Word Count", async () => {
      await node.getByTestId("textarea_str_text_input").fill(WORD_COUNT_TEXT);
      await pickOperation(page, node, "list_item_word_count");
    });

    await test.step("The advertised output flips from Message to JSON", async () => {
      // The distinctive consequence of the merge: the OPERATION, not only the
      // Input Type, decides the output. Word Count is routed to `as_data` while
      // the tab is still `Text`.
      await expect(
        node.getByTestId("output-inspection-json-operations"),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        node.getByTestId("output-inspection-message-operations"),
      ).toHaveCount(0);
    });

    await test.step("Run and assert the counted values", async () => {
      await runNode(node);
      const modal = await openOutputInspector(
        page,
        node,
        "output-inspection-json-operations",
      );
      // `_word_count`: len(split()) / len(set(split())) / len(text).
      // "data ops probe abc123 data ops" → 6 words, 4 unique, 30 characters.
      await expect(modal).toContainText('"word_count": 6', { timeout: 15000 });
      await expect(modal).toContainText('"unique_words": 4');
      await expect(modal).toContainText('"character_count": 30');
      await closeOutputInspector(page);
    });
  },
);

test(
  "Data Operations JSON mode selects a single key from an upstream JSON output",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with two Data Operations nodes", async () => {
      await openFlowWithDataOperations(page, request, bearer);
      await addSecondNodeAndSeparate(page);
    });

    // Before the downstream node is switched to JSON, both nodes are in Text
    // mode, so order is the only way to tell them apart — the second node added
    // is the last one in the DOM.
    const downstream = page.locator(".react-flow__node").last();
    const upstream = page.locator(".react-flow__node").first();

    await test.step("Upstream node produces a JSON payload via Word Count", async () => {
      await upstream.getByTestId("textarea_str_text_input").fill(WORD_COUNT_TEXT);
      await pickOperation(page, upstream, "list_item_word_count");
      await expect(
        upstream.getByTestId("output-inspection-json-operations"),
      ).toBeVisible({ timeout: 15000 });
    });

    await test.step("Downstream node switches to JSON and the picker is re-filtered", async () => {
      await downstream.getByTestId("tab_1_json").click();
      // Only a JSON-mode node renders this handle — from here on both nodes are
      // addressed by identity, never by position.
      await expect(
        downstream.getByTestId("handle-operations-shownode-json-left"),
      ).toBeVisible({ timeout: 15000 });
      await expectPickerFilteredTo(page, downstream, "list_item_select_keys");
      await page.getByTestId("list_item_select_keys").click();
      await downstream
        .getByTestId("inputlist_str_select_keys_input_0")
        .fill("word_count");
    });

    const jsonConsumer = await expectSingleNode(
      nodeContaining(page, "handle-operations-shownode-json-left"),
      "the JSON-mode node",
    );
    const jsonProducer = await expectSingleNode(
      nodeContaining(page, "textarea_str_text_input"),
      "the Text-mode node",
    );

    await test.step("Wire the JSON output into the JSON input", async () => {
      await jsonProducer
        .getByTestId("handle-operations-shownode-json-right")
        .click();
      await jsonConsumer
        .getByTestId("handle-operations-shownode-json-left")
        .click();
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 15000,
      });
    });

    await test.step("Run and assert only the requested key survives", async () => {
      await runNode(jsonConsumer);
      const modal = await openOutputInspector(
        page,
        jsonConsumer,
        "output-inspection-json-operations",
      );
      // `select_keys` keeps only the requested key; the upstream payload also
      // carried unique_words / character_count / line_count. The negative half
      // is what separates "Select Keys ran" from "the payload passed through".
      await expect(modal).toContainText('"word_count": 6', { timeout: 15000 });
      await expect(modal).not.toContainText("unique_words");
      await closeOutputInspector(page);
    });
  },
);

test(
  "Data Operations Table mode filters the rows of an upstream Table output",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with two Data Operations nodes", async () => {
      await openFlowWithDataOperations(page, request, bearer);
      await addSecondNodeAndSeparate(page);
    });

    const downstream = page.locator(".react-flow__node").last();
    const upstream = page.locator(".react-flow__node").first();

    await test.step("Upstream node produces a Table via Text to DataFrame", async () => {
      await fillMultilineText(page, upstream, TABLE_TEXT);
      await pickOperation(page, upstream, "list_item_text_to_dataframe");
      // Text to DataFrame is the second operation that overrides the Text tab's
      // default output — here to a Table.
      await expect(
        upstream.getByTestId("output-inspection-table-operations"),
      ).toBeVisible({ timeout: 15000 });
    });

    await test.step("Downstream node switches to Table and the picker is re-filtered", async () => {
      await downstream.getByTestId("tab_2_table").click();
      await expect(
        downstream.getByTestId("handle-operations-shownode-table-left"),
      ).toBeVisible({ timeout: 15000 });
      await expectPickerFilteredTo(page, downstream, "list_item_filter");
      await page.getByTestId("list_item_filter").click();
    });

    const tableConsumer = await expectSingleNode(
      nodeContaining(page, "handle-operations-shownode-table-left"),
      "the Table-mode node",
    );
    const tableProducer = await expectSingleNode(
      nodeContaining(page, "textarea_str_text_input"),
      "the Text-mode node",
    );

    await test.step("Configure Filter: score greater than 15", async () => {
      await tableConsumer
        .getByTestId("popover-anchor-input-column_name")
        .fill("score");
      await tableConsumer
        .getByTestId("popover-anchor-input-filter_value")
        .fill("15");
      await selectDropdownOption(
        page,
        tableConsumer,
        "value-dropdown-dropdown_str_filter_operator",
        "greater than",
      );
    });

    await test.step("Wire the Table output into the Table input", async () => {
      await tableProducer
        .getByTestId("handle-operations-shownode-table-right")
        .click();
      await tableConsumer
        .getByTestId("handle-operations-shownode-table-left")
        .click();
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 15000,
      });
    });

    await test.step("Run and assert only the matching rows survive", async () => {
      await runNode(tableConsumer);
      const modal = await openOutputInspector(
        page,
        tableConsumer,
        "output-inspection-table-operations",
      );
      // `filter_rows_by_value` with `greater than` compares numerically after
      // `_convert_numeric_columns`: 10, 30, 20 > 15 keeps beta and gamma, in the
      // original row order. alpha must be gone.
      await expect
        .poll(
          async () => modal.getByRole("gridcell").allInnerTexts(),
          { timeout: 20000 },
        )
        .toEqual(["beta", "30", "gamma", "20"]);
      await closeOutputInspector(page);
    });
  },
);
