import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createCatalogFlow,
  fetchComponentCatalog,
  type CatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";

// The Loop feeds every item through its body and `done` aggregates the BODY'S
// results: Create List (alpha, beta) -> Loop <-> Data Operations (JSON, Append or
// Update tag=modified_value) -> Parser "{text}={tag}" -> Chat Output must produce
// exactly "alpha=modified_value\nbeta=modified_value". No model, no network.
// See docs/core-functionality/llm-agents/loop-component.md.
//
// Sibling coverage, not repeated here: the Loop's handles, its standalone-run error
// and the N=3 / N=1 exit condition in core-components/loop-component-regression.spec.ts.

const SOURCE_ID = "CreateList-items";
const LOOP_ID = "LoopComponent-items";
const BODY_ID = "Operations-body";
const PARSER_ID = "ParserComponent-rows";
const CHAT_ID = "ChatOutput-loopResult";

const EXPECTED_OUTPUT = "alpha=modified_value\nbeta=modified_value";

/**
 * Seeds Data Operations with the configuration its UI produces for JSON input and the
 * "Append or Update" operation (operations.py `update_build_config` /
 * `update_outputs`): the JSON input shown, the text input hidden, the key/value editor
 * shown with `entries`, and the JSON output (`data_output`) in place of the default
 * Message one. A renamed field fails here, naming it.
 */
function appendOrUpdate(entries: Record<string, string>) {
  return (component: CatalogComponent): void => {
    const t = component.template;
    for (const name of ["input_type", "operation", "data", "text_input", "append_update_data"]) {
      if (!t[name]) {
        throw new Error(
          `Data Operations has no field "${name}" — the seeded JSON / Append or Update ` +
            "configuration no longer matches the component",
        );
      }
    }
    const operation = { name: "Append or Update", icon: "circle-plus" };
    t.input_type.value = "JSON";
    t.operation.options = [operation];
    t.operation.value = [operation];
    t.text_input.show = false;
    t.text_input.required = false;
    t.data.show = true;
    t.data.required = true;
    t.append_update_data.show = true;
    t.append_update_data.value = entries;
    const [base] = component.outputs;
    component.outputs = [
      {
        ...base,
        name: "data_output",
        display_name: "JSON",
        method: "as_data",
        types: ["JSON"],
        selected: "JSON",
      },
    ];
  };
}

// The one flow this file creates, deleted id-scoped in afterEach. The inherited
// version built it through the sidebar after `awaitBootstrapTest` and deleted
// nothing: 3 flows leaked per run on an empty project (#1911).
let createdFlow: { id: string; bearer: string } | undefined;

test.afterEach(async ({ page, request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit this binding.
  const flow = createdFlow;
  createdFlow = undefined;
  if (!flow) return;
  // Leave the editor first: an editor mounted over a deleted flow keeps polling
  // `GET /flows/{id}/events` and 404s into the backend-error log (#1288).
  await unmountEditorForCleanup(page);
  await deleteFlow(request, flow.id, {
    headers: { Authorization: flow.bearer },
  }).catch((error: unknown) => {
    console.warn(`loop-component: flow cleanup failed — ${String(error).split("\n")[0]}`);
  });
});

test(
  "should process loop with update data correctly",
  { tag: ["@stable", "@release", "@workspace", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    await test.step("Open the loop flow built from the live catalog", async () => {
      const bearer = await getAuthToken(request);
      const headers = { Authorization: bearer };
      const catalog = await fetchComponentCatalog(request, headers);
      const id = await createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            {
              id: SOURCE_ID,
              type: "CreateList",
              values: { texts: ["alpha", "beta"] },
              // Without it the canvas shows `list` and drops the `dataframe` edge.
              selectedOutput: "dataframe",
            },
            { id: LOOP_ID, type: "LoopComponent" },
            {
              id: BODY_ID,
              type: "Operations",
              configure: appendOrUpdate({ tag: "modified_value" }),
            },
            { id: PARSER_ID, type: "ParserComponent", values: { pattern: "{text}={tag}" } },
            { id: CHAT_ID, type: "ChatOutput" },
          ],
          edges: [
            { source: SOURCE_ID, output: "dataframe", target: LOOP_ID, field: "data" },
            { source: LOOP_ID, output: "item", target: BODY_ID, field: "data" },
            // The feedback edge: the body's result goes back into the Loop's `item`.
            { source: BODY_ID, output: "data_output", target: LOOP_ID, loopOutput: "item" },
            { source: LOOP_ID, output: "done", target: PARSER_ID, field: "input_data" },
            { source: PARSER_ID, output: "parsed_text", target: CHAT_ID, field: "input_value" },
          ],
        },
        {
          name: `Loop Update Data ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          headers,
        },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
      // All five edges survived the canvas load (a dropped one is removed silently).
      await expect(page.locator(".react-flow__edge")).toHaveCount(5, {
        timeout: 15000,
      });
    });

    await test.step("Run the flow from the Chat Output", async () => {
      await page.getByTestId("button_run_chat output").click();
      await expect(page.getByTestId("node_duration_loop")).toBeVisible({
        timeout: 60000,
      });
      await expect(page.getByTestId("node_duration_chat output")).toBeVisible({
        timeout: 60000,
      });
    });

    await test.step("done aggregated the updated items, once each and in order", async () => {
      await page.getByTestId("output-inspection-output message-chatoutput").click();
      // `<nodeId>-<output>-output-modal` marks the dialog's header title, not its root
      // (outputModal/index.tsx), so the dialog is the one that contains it.
      const dialog = page
        .getByRole("dialog")
        .filter({ has: page.getByTestId(`${CHAT_ID}-message-output-modal`) });
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByTestId("textarea")).toHaveValue(EXPECTED_OUTPUT);
    });
  },
);
