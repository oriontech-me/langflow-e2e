import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createProjectViaApi } from "../../../helpers/flows/create-project-via-api";
import { deleteProject } from "../../../helpers/flows/delete-project";
import { dismissWelcomeOverlayAndWaitForModal } from "../../../helpers/flows/open-new-flow-templates-modal";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";
import { waitForPageEntry } from "../../../helpers/other/page-entry-barrier";

// Regression guard for upstream langflow-ai/langflow#3909 ("Button 'Start Here' not
// working"): an empty project's call to action must create a flow IN THAT PROJECT and
// open its canvas; picking Basic Prompting from there opens the template in the same
// project. See docs/flow-functionality/general-bugs-shard-3909.md.
//
// Sibling coverage, not repeated here: project CRUD in
// project-management/folder-crud.spec.ts; the template gallery and the graph a
// template instantiates in templates/templates-gallery.spec.ts and
// templates/templates-instantiate.spec.ts.

// Every flow the page creates (the call to action's placeholder and the template's
// flow) is captured from its POST /api/v1/flows 201 and deleted id-scoped; the
// project is deleted by id. The inherited version deleted nothing: 3 flows leaked per
// run on an empty project, plus its project whenever it passed (#1911).
let flows: FlowTracker | undefined;
let projectId: string | undefined;

test.beforeEach(async ({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit these bindings.
  const tracker = flows;
  flows = undefined;
  const project = projectId;
  projectId = undefined;
  // Leaves the editor, then deletes the captured ids; a failure is logged, never thrown.
  await tracker?.cleanup(request);
  tracker?.dispose();
  if (project) {
    await deleteProject(request, project, {
      headers: { Authorization: await getAuthToken(request) },
    }).catch((error: unknown) => {
      console.warn(
        `general-bugs-shard-3909: project cleanup failed — ${String(error).split("\n")[0]}`,
      );
    });
  }
});

// The name the template lands under. NOT pinned to the bare string on purpose, and
// this is a narrowing of the claim to what the product guarantees rather than a
// loosened assertion (#1955): picking a template renames the call to action's
// placeholder flow in place, and the FRONTEND uniquifies that name against the whole
// flow store minus the examples — not against the project — appending ` (N)` on a
// collision. So any user flow named `Basic Prompting` anywhere on the instance makes
// this one land as `Basic Prompting (1)`, and `awaitBootstrapTest` plus ~14 specs
// create exactly that name on the shared instance. The backend imposes no such rule:
// `POST /api/v1/flows/` accepts the duplicate unsuffixed (201). Measured on
// 1.13.0.dev19 AND on 1.13.0.dev16 — the build the daily's regression hypothesis
// blamed — where seeding one such flow turns a green run red 5/5.
const TEMPLATE_FLOW_NAME = /^Basic Prompting(?: \(\d+\))?$/;

/** Names of the flows `GET /api/v1/projects/{id}` lists for the project. */
async function projectFlowNames(
  request: APIRequestContext,
  id: string,
): Promise<string[] | string> {
  const res = await request.get(`/api/v1/projects/${id}`, {
    headers: { Authorization: await getAuthToken(request) },
  });
  if (!res.ok()) return `GET /api/v1/projects/{id} -> ${res.status()}`;
  const body = (await res.json()) as { flows?: Array<{ name?: string }> };
  return (body.flows ?? []).map((f) => String(f.name));
}

test(
  "user must be able to create a new flow clicking on New Flow button",
  { tag: ["@stable", "@release", "@regression", "@mainpage", "@ui-ux"] },
  async ({ page, request }) => {
    const emptyPageButton = page.getByTestId("new_project_btn_empty_page");

    await test.step("Create a project and open its empty page", async () => {
      // Over the API and opened by its route: on an instance with no flow at all the
      // home page renders no project sidebar, so `add-project-button` is not a
      // dependable entry (measured on 1.13.0.dev16). Sidebar creation is
      // folder-crud.spec.ts's subject.
      const project = await createProjectViaApi(
        request,
        { Authorization: await getAuthToken(request) },
        { namePrefix: "shard-3909" },
      );
      projectId = project.projectId;

      await page.goto(`/all/folder/${projectId}`);
      await waitForPageEntry(page, '[data-testid="mainpage_title"]', 30000);
      await expect(emptyPageButton).toBeVisible({ timeout: 15000 });
    });

    await test.step("The call to action creates a flow in that project and opens it", async () => {
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.replace(/\/$/, "") === "/api/v1/flows" &&
          response.status() === 201,
        { timeout: 30000 },
      );
      await emptyPageButton.click();
      // The frontend's attribution, read from the REQUEST: the body of this response
      // can stay undelivered once the SPA navigates away (see load-template-by-name).
      const sent = (await created).request().postDataJSON() as { folder_id?: string };
      expect(sent.folder_id, "the call to action created its flow for another project").toBe(
        projectId,
      );
      await expect(page).toHaveURL(/\/flow\//, { timeout: 30000 });

      // Server truth: the project now holds the flow.
      await expect
        .poll(() => projectFlowNames(request, projectId!), {
          timeout: 15000,
          message: "the project should list the flow its call to action created",
        })
        .toHaveLength(1);
    });

    await test.step("Pick Basic Prompting from the template gallery", async () => {
      await dismissWelcomeOverlayAndWaitForModal(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting", exact: true }).click();
    });

    await test.step("The template opens on the canvas with its four components", async () => {
      for (const node of ["chat input", "prompt template", "language model", "chat output"]) {
        await expect(page.getByTestId(`button_run_${node}`)).toBeVisible({
          timeout: 30000,
        });
      }
    });

    await test.step("The template flow lives in the new project", async () => {
      // Exactly one flow, named after the template: the project is created by this
      // test, so nothing else can put a flow in it, and this pins BOTH that the
      // template landed here and that the placeholder did not survive alongside it.
      // Stricter than the `toContain` it replaced, which allowed any number of flows
      // and was satisfied by a same-named leftover (#1955).
      await expect
        .poll(() => projectFlowNames(request, projectId!), {
          timeout: 15000,
          message:
            "the project should hold exactly the flow the template opened — the ` (N)` " +
            "the client appends when another flow already holds the name is tolerated",
        })
        .toEqual([expect.stringMatching(TEMPLATE_FLOW_NAME)]);
    });
  },
);
