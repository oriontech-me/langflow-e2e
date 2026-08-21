import * as dotenv from "dotenv";
import { leaveFlowEditor } from "../../../helpers/flows/leave-flow-editor";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { renameFlow } from "../../../helpers/flows/rename-flow";
import { openNewFlowTemplatesModal } from "../../../helpers/flows/open-new-flow-templates-modal";

// `test.fixme` lifted in #966 — the spec runs again. The recurrent flake (dailies
// 2026-07-16 / 07-27) was the mid-test `openNewFlowTemplatesModal` call below: after
// the `icon-ChevronLeft` back-navigation the "New Flow" button becomes visible while
// the flows list is still loading, and a click landed in that window is a no-op, so
// neither the welcome overlay nor the templates modal was ever requested.
//
// That no-op is a PRODUCT defect, filed upstream as LE-2019 (evidence:
// docs/upstream-bugs/UPSTREAM-BUG-new-flow-dead-click.md). The shared helper gates
// on the flows list having rendered, which keeps the suite out of the broken window;
// the product fix itself landed upstream in langflow#14349 (*stop flow route request
// storm*), whose files are present on `release-1.12.0`, so `@stable` is restored here
// after re-validation on `1.12.0.dev23` (#966). See docs/flow-functionality/run-flow.md.
// Quarantined at triage (daily #1544): hard failure on all three attempts — the
// click on `refresh-dropdown-list-flow_name_selected` is refused by two overlays
// taking the pointer events, `main_canvas_controls` and an
// `assistant-onboarding-tooltip` popper this repository references nowhere. It
// ran on shard 1, which the in-run liveness recorder measured at zero outages,
// so the day's mass-failure verdict does not cover it. Lifting the quarantine
// (remove test.fixme + restore @stable) is a deliverable of #1548.
test.fixme(
  "user should be able to use Run Flow without any issues",
  { tag: ["@release", "@workspace", "@api", "@regression"] },
  async ({ page, request }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // Track the IDs of every flow THIS page creates so cleanup can target ONLY
    // those via the API, never example/starter flows or flows belonging to
    // sibling specs running in parallel.
    //
    // Collected from the `POST /api/v1/flows` 201 responses, NOT from the canvas
    // URL: the URL id is transient and 404s on delete (#505/#681), which is why
    // this spec was leaking both flows it creates — a `Run Flow Target …` (2
    // nodes) and the Run Flow canvas (1 node) survived every run. The listener is
    // installed before the first navigation so the bootstrap's own creates are
    // captured too; deleting a transient id is harmless (`deleteFlow` treats 404
    // as done).
    const createdFlowIds: string[] = [];
    page.on("response", (resp) => {
      if (
        resp.url().includes("/api/v1/flows") &&
        resp.request().method() === "POST" &&
        resp.status() === 201
      ) {
        resp
          .json()
          .then((body: { id?: string }) => {
            if (body?.id) createdFlowIds.push(body.id);
          })
          .catch(() => {
            /* a non-JSON 201 carries no id to clean up */
          });
      }
    });

    await awaitBootstrapTest(page);

    // Unique name for the sub-flow we build so the Run Flow "Flow Name" dropdown
    // can pick it deterministically by name instead of by position (issue #340).
    // The worker index + a random suffix keep it collision-free across parallel
    // workers/projects sharing one Langflow instance, where a bare millisecond
    // timestamp could repeat and make the dropdown locator match >1 option.
    const targetFlowName = `Run Flow Target ${test.info().workerIndex}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    // Gate on the editor route without reading an id off it: the id capture now
    // rides the create responses above (the URL id is transient).
    const waitForCanvasRoute = async () => {
      await page.waitForURL(/\/flow\/[0-9a-f-]+/i, { timeout: 15000 });
    };

    try {
      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });

      await page.getByTestId("blank-flow").click();
      await waitForCanvasRoute();

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

      // Back to the listing through the helper: the bare chevron click can land
      // behind `SaveChangesModal` and spin indefinitely (#1153), and this call
      // site had nothing waiting on the navigation at all — so a blocked exit
      // surfaced downstream inside `openNewFlowTemplatesModal`, i.e. wearing
      // LE-2019's signature on a run where LE-2019 was not what happened.
      //
      // NO `escapeDeadlock` here, deliberately. The recovery is a full page
      // load, and everything the rest of this test asserts lives in the flow
      // built on the canvas above; discarding it would trade a clean, attributed
      // failure at the exit for an inscrutable one ~90 s later at the Run Flow
      // dropdown. The helper throws with the reason instead.
      await leaveFlowEditor(page);

      await openNewFlowTemplatesModal(page);

      await page.getByTestId("blank-flow").click();
      await waitForCanvasRoute();

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
