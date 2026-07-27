import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { renameFlow } from "../../../helpers/flows/rename-flow";
import { openNewFlowTemplatesModal } from "../../../helpers/flows/open-new-flow-templates-modal";

// Quarantined for #966 — recurrent flake (2026-07-16 / 07-27): neither the
// welcome overlay nor the templates modal surfaces after the "New Flow" entry
// point, so the reconciliation poll in openNewFlowTemplatesModal times out.
test.fixme(
  "user should be able to use Run Flow without any issues",
  { tag: ["@release", "@workspace", "@api", "@regression"] },
  async ({ page, request }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    await awaitBootstrapTest(page);

    // Track the IDs of the 2 flows we create so cleanup can target ONLY
    // those via the API, not example/starter flows or flows belonging to
    // sibling specs running in parallel.
    const createdFlowIds: string[] = [];

    // Unique name for the sub-flow we build so the Run Flow "Flow Name" dropdown
    // can pick it deterministically by name instead of by position (issue #340).
    // The worker index + a random suffix keep it collision-free across parallel
    // workers/projects sharing one Langflow instance, where a bare millisecond
    // timestamp could repeat and make the dropdown locator match >1 option.
    const targetFlowName = `Run Flow Target ${test.info().workerIndex}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const captureFlowIdFromUrl = async () => {
      // `waitForURL` enforces the URL matches, so the subsequent match() is
      // guaranteed — no need for a runtime null check.
      await page.waitForURL(/\/flow\/[0-9a-f-]+/i, { timeout: 15000 });
      const id = page.url().match(/\/flow\/([0-9a-f-]+)/i)![1];
      createdFlowIds.push(id);
    };

    try {
      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });

      await page.getByTestId("blank-flow").click();
      await captureFlowIdFromUrl();

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat output");
      await page.waitForSelector('[data-testid="input_outputChat Output"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input_outputChat Output")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-chat-output").click();
        });

      await zoomOut(page, 2);

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat input");
      await page.waitForSelector('[data-testid="input_outputChat Input"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input_outputChat Input")
        .dragTo(page.locator('//*[@id="react-flow-id"]'), {
          targetPosition: { x: 100, y: 100 },
        });

      await adjustScreenView(page);

      // Connect Chat Input → Chat Output directly. The intermediate Text Output
      // was dropped: Langflow flipped Text Input/Output to legacy and hides them
      // from the sidebar (see CONTRIBUTING "Do not build on legacy components"),
      // and this shorter pipeline still echoes the input, so the assertion below
      // is unchanged.
      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      // Rename the built flow to a unique name so the Run Flow dropdown below can
      // select it deterministically by name (issue #340).
      await renameFlow(page, { flowName: targetFlowName });

      await page.getByTestId("icon-ChevronLeft").click();

      await openNewFlowTemplatesModal(page);

      await page.getByTestId("blank-flow").click();
      await captureFlowIdFromUrl();

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("run flow");
      await page.waitForSelector('[data-testid="flow_controlsRun Flow"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("flow_controlsRun Flow")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-run-flow").click();
        });

      await page
        .getByTestId("value-dropdown-dropdown_str_flow_name_selected")
        .click();

      await page.getByTestId("refresh-dropdown-list-flow_name_selected").click();

      await page.waitForSelector("text=Loading", { timeout: 30000 });
      await page.waitForSelector("text=Select an option", { timeout: 30000 });

      await page
        .getByTestId("value-dropdown-dropdown_str_flow_name_selected")
        .click();

      await page
        .getByTestId(/^dropdown-option-\d+-container$/)
        .filter({ hasText: targetFlowName })
        .click();

      await page.getByTestId(/^textarea_str_chatinput.*/).click();
      await page
        .getByTestId(/^textarea_str_chatinput.*/)
        .fill("THIS IS A TEST FOR RUN FLOW COMPONENT");

      await page.getByTestId("button_run_run flow").click();
      await page.waitForSelector("text=built successfully", {
        timeout: 30000,
      });

      // Wait for and click the output inspection button using partial match
      await page.waitForSelector('[data-testid^="output-inspection-"]', {
        timeout: 30000,
      });

      await page.locator('[data-testid^="output-inspection-"]').first().click();

      const value = page.getByPlaceholder("Empty");

      await expect(value).toHaveValue("THIS IS A TEST FOR RUN FLOW COMPONENT");
    } finally {
      // API-based cleanup scoped to the IDs we captured during creation.
      // Parallelism-safe: the previous implementation listed all flows and
      // sliced the top 2 positionally, which could (a) delete example or
      // starter flows that the listing returns before user flows, or
      // (b) under `fullyParallel`, delete flows another worker just
      // created. Iterating the captured IDs eliminates both classes of
      // collateral damage. It also sidesteps the brittle object-form
      // fallback (`body?.items` vs the actual `body.flows` shape used in
      // `helpers/flows/clean-all-flows.ts`) since we no longer need to
      // list at all.
      try {
        const headers = { Authorization: await getAuthToken(request) };
        for (const id of createdFlowIds) {
          try {
            await deleteFlow(request, id, { headers });
          } catch {
            // Best-effort per-flow — do not mask the original test failure.
          }
        }
      } catch {
        // Cleanup is best-effort — do not mask the original test failure.
      }
    }
  },
);
