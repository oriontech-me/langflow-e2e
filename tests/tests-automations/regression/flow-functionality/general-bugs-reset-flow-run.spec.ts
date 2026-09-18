import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createCatalogFlow,
  fetchComponentCatalog,
} from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";

// Re-running the same flow with If-Else routing the other way resets the previous
// run's branch state: the branch skipped last time builds now, the branch built last
// time is now the inactive one. Four runs alternate True / False / True / False, and
// after each one both halves of the state are asserted — presences AND absences,
// because a stale badge from the previous run would satisfy the presences alone.
// See docs/flow-functionality/general-bugs-reset-flow-run.md.
//
// Sibling coverage, not repeated here: each If-Else operator on a fresh flow, run
// once, in core-components/if-else-component-regression.spec.ts.

const ROUTER_ID = "ConditionalRouter-reset";
const TRUE_BRANCH = "true branch";
const FALSE_BRANCH = "false branch";
const MATCH_TEXT = "1";

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
    console.warn(
      `general-bugs-reset-flow-run: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

test(
  "user can run flow with If-Else component multiple times with different branches",
  { tag: ["@stable", "@release", "@regression", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const inputText = page.getByTestId("popover-anchor-input-input_text");

    await test.step("Open an If-Else flow with a Chat Output on each branch, built from the live catalog", async () => {
      const bearer = await getAuthToken(request);
      const headers = { Authorization: bearer };
      const catalog = await fetchComponentCatalog(request, headers);
      const id = await createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            { id: ROUTER_ID, type: "ConditionalRouter" },
            // Canvas testids derive from the display name: button_run_true branch, …
            { id: "ChatOutput-true", type: "ChatOutput", displayName: TRUE_BRANCH },
            { id: "ChatOutput-false", type: "ChatOutput", displayName: FALSE_BRANCH },
          ],
          edges: [
            { source: ROUTER_ID, output: "true_result", target: "ChatOutput-true", field: "input_value" },
            { source: ROUTER_ID, output: "false_result", target: "ChatOutput-false", field: "input_value" },
          ],
        },
        {
          name: `Reset Flow Run ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          headers,
        },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
      await expect(page.locator(".react-flow__edge")).toHaveCount(2, {
        timeout: 15000,
      });

      const matchText = page.getByTestId("popover-anchor-input-match_text");
      await matchText.fill(MATCH_TEXT);
      await expect(matchText).toHaveValue(MATCH_TEXT);
    });

    const runs: Array<{ label: string; input: string; routed: string; other: string }> = [
      { label: "Run 1 — matching input goes True", input: "1", routed: TRUE_BRANCH, other: FALSE_BRANCH },
      { label: "Run 2 — non-matching input goes False", input: "2", routed: FALSE_BRANCH, other: TRUE_BRANCH },
      { label: "Run 3 — matching input goes True again", input: "1", routed: TRUE_BRANCH, other: FALSE_BRANCH },
      { label: "Run 4 — non-matching input goes False again", input: "2", routed: FALSE_BRANCH, other: TRUE_BRANCH },
    ];

    for (const run of runs) {
      await test.step(run.label, async () => {
        await inputText.fill(run.input);
        await expect(inputText).toHaveValue(run.input);
        await page.getByTestId(`button_run_${run.routed}`).click();

        // Presences first: every one of them is a state the PREVIOUS run did not
        // leave behind, so they can only be satisfied by this run's result.
        await expect(page.getByTestId(`node_duration_${run.routed}`)).toHaveCount(1, {
          timeout: 30000,
        });
        await expect(
          page.getByTestId(`node_status_icon_${run.other}_inactive`),
        ).toHaveCount(1, { timeout: 30000 });

        // Then the absences, read after the run settled: nothing of the previous
        // run's status may survive on either branch.
        await expect(
          page.getByTestId(`node_status_icon_${run.routed}_inactive`),
        ).toHaveCount(0, { timeout: 10000 });
        await expect(page.getByTestId(`node_duration_${run.other}`)).toHaveCount(0, {
          timeout: 10000,
        });
      });
    }
  },
);
