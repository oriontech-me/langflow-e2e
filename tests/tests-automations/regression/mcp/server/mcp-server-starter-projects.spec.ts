import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { cleanOldFolders } from "../../../../helpers/filesystem/clean-old-folders";
import { createProjectThroughSidebar } from "../../../../helpers/flows/create-project-through-sidebar";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { openProjectOptions } from "../../../../helpers/ui/project-sidebar";

/** The name test 1 renames its first project to. */
const RENAMED_PROJECT = "renamed_project";

/**
 * Address an MCP server row on the Settings → MCP Servers page **by name**.
 *
 * Row order is not part of the §14.1 contract and must not be asserted (#1123):
 * with `agentic_experience` enabled by default upstream, Langflow injects an
 * internal `langflow-agentic` server that is created before the starter
 * project's, and the page renders `GET /api/v2/mcp/servers` (ordered by
 * `created_at`) with no sort — so index 0 is not the starter project.
 *
 * Filtering the `mcp_server_name_<index>` rows keeps the assertion scoped to the
 * server list, so matching text elsewhere on the page cannot satisfy it.
 */
const mcpServerRow = (page: Page, name: string) =>
  page
    .getByTestId(/^mcp_server_name_\d+$/)
    .filter({ hasText: new RegExp(`^${name}$`) });

/**
 * Delete any leftover `renamed_project` before the test renames a project to it.
 *
 * `cleanOldFolders` only removes folders named "New Project*", so an attempt
 * that dies between the rename (step 4) and the delete (step 5) leaves
 * `renamed_project` on the shared superuser account. The next attempt then hits
 * `UNIQUE constraint failed: folder.user_id, folder.name` on its own rename —
 * a 500 that makes the retry fail for a reason the first attempt did not have,
 * so the retries stop being independent evidence. Observed on PR #1135's CI run
 * (3/3 attempts red, two of them on the leftover rather than the original
 * defect).
 *
 * API rather than the sidebar: this is teardown of the *previous* run, so it
 * must not depend on the UI state the test is about to assert on. `deleteProject`
 * treats 404 as the desired end state and retries the #965 contention 500.
 */
const removeLeftoverRenamedProject = async (page: Page) => {
  const response = await page.request.get("/api/v1/projects/");
  if (!response.ok()) return;

  // The /api/v1/projects/ response shape varies (sometimes a bare array,
  // sometimes `{ folders: [...] }`); mcp-server.spec.ts normalizes the same way.
  const raw = await response.json();
  const projects: Array<{ id: string; name: string }> = Array.isArray(raw)
    ? raw
    : (raw.folders ?? []);

  for (const project of projects.filter((p) => p.name === RENAMED_PROJECT)) {
    await deleteProject(page.request, project.id);
  }
};

// Ids of what a test created, deleted id-scoped in afterEach (#1376) — never a
// global sweep, which wipes what other workers are building (#515).
//
// Measured on `1.12.0.dev20` over three consecutive runs of this file, counting
// `GET /api/v1/flows/?get_all=true` and `GET /api/v1/projects/` around each:
//
//   flows     34 -> 35 -> 36 -> 37     (+1 every run, unbounded)
//   projects   1 ->  2 ->  2 ->  2     (+1, then flat)
//
// The two halves fail differently, and the second is the one worth naming. Test
// 2 opens the Basic Prompting template, which creates a flow nothing deletes —
// that leak is monotonic and visible. Test 1 creates TWO projects and only ever
// deletes the one it renames, and that leak reads as zero from run 2 onwards
// only because `cleanOldFolders` at the top of test 1 sweeps the PREVIOUS run's
// leftover. It is not absent, it is absorbed — and #1363 is the incident where
// that absorption stopped working: with the sweep silently deleting nothing,
// `New Project (N)` accumulated inside a single test's own retries.
//
// So the cleanup below is not redundant with `cleanOldFolders`. That helper
// guards against OTHER runs' leftovers; this one stops the file from producing
// them.
const createdProjectIds = new Set<string>();

// Flows go through the SHARED tracker (#1108), not a hand-rolled listener. The
// block that would be written here was copied into 51 spec files and drifted on
// four axes; two of them decide whether this file's leak is actually fixed.
// **One of the 51 settles its in-flight body reads** — the id lands a tick after
// the `201`, so a teardown that snapshots immediately drops it and the flow leaks
// anyway. And `cleanup` resolves the bearer itself and **never throws out of
// teardown**: `getAuthToken` throws once its retry budget is spent (a backend
// wedged at teardown, #1077), and a throw in an `afterEach` is a hook error that
// fails an otherwise-green test — the opposite of what cleanup is for. It also
// leaves the editor before deleting (#1288) and reports failures instead of
// swallowing them (#1012).
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ page, request }) => {
  await flows.cleanup(request);

  const projectIds = [...createdProjectIds];
  createdProjectIds.clear();
  if (projectIds.length === 0) return;

  // The tracker unmounts only when it has flows to delete, and test 1 has none
  // while still holding projects — so the navigation is done here too. Deleting a
  // project under a mounted home view makes it refetch a folder that is already
  // gone, which the fixture logs as `🚨 Backend Error` (#1023). Idempotent: when
  // the tracker already navigated, this is a second `about:blank`.
  await unmountEditorForCleanup(page);

  // Same contract as the tracker's own bearer, for the same reason (#1086/#1077):
  // caught so a wedged backend cannot turn teardown into a hook error, and NAMED
  // rather than degraded silently to an empty token — otherwise the 401s below
  // would read as the projects' fault.
  let options: { headers: Record<string, string> } | undefined;
  try {
    const bearer = await getAuthToken(request);
    options = bearer ? { headers: { Authorization: bearer } } : undefined;
  } catch (error) {
    console.warn(
      `⚠️  cleanup: no auth token — the project deletes below run on the browser ` +
        `session alone, so a 401 here is THAT and not the project (#1086/#1077): ${error}`,
    );
  }

  // `deleteProject` treats 404 — the project test 1 already deleted through the
  // UI — as the desired end state, and retries the 500 the endpoint answers
  // under contention (#965). Reported, never swallowed: a failed cleanup must not
  // fail the hook and mask the assertion that already ran, but it must not be
  // silent either (#1012).
  for (const id of projectIds) {
    await deleteProject(request, id, options).catch((error) => {
      console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
    });
  }
});

test(
  "user must be able to see starter projects for mcp servers",
  { tag: ["@stable", "@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    //starter mcp project

    await awaitBootstrapTest(page, {
      skipModal: true,
    });

    await cleanOldFolders(page);
    await removeLeftoverRenamedProject(page);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //add new folders

    // Created through the helper rather than two bare `add-project-button`
    // clicks, so the test holds the id AND the backend-assigned name of each
    // project. Both are needed to address the sidebar entry and its kebab: the
    // nightly keys those testids on the project id, 1.11.x on its name (#1363).
    const firstProject = await createProjectThroughSidebar(page);
    const secondProject = await createProjectThroughSidebar(page);
    // Both, not just the renamed one: the second is the project this file used
    // to leave behind on every run (#1376).
    createdProjectIds.add(firstProject.id);
    createdProjectIds.add(secondProject.id);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    // toHaveCount, not `expect(await ....count())`: the MCP-server row is
    // written by the backend as a side effect of the project write, so it can
    // lag the navigation. A bare .count() reads the DOM once and fails on that
    // lag; toHaveCount polls until the expectation timeout (#1135).
    await expect(page.getByText("lf-new_project", { exact: true })).toHaveCount(
      1,
    );
    await expect(
      page.getByText("lf-new_project_1", { exact: true }),
    ).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //rename a folder

    // Renamed through the kebab's own "Rename" entry (the double-click path is
    // covered by folder-crud.spec.ts), addressing the project this test created
    // instead of "whichever entry reads 'New Project' first" — a sibling worker
    // creating its own project mid-run could otherwise be the one renamed.
    await openProjectOptions(page, firstProject);
    await page.getByText("Rename", { exact: true }).last().click();
    await page.getByTestId("input-project").last().fill(RENAMED_PROJECT);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const renamedProject = { id: firstProject.id, name: RENAMED_PROJECT };

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await expect(
      page.getByText("lf-renamed_project", { exact: true }),
    ).toHaveCount(1);

    //delete a folder

    await page.getByTestId("icon-ChevronLeft").first().click();
    await openProjectOptions(page, renamedProject);
    await page.getByText("Delete", { exact: true }).last().click();
    await page.getByText("Delete", { exact: true }).last().click();
    await page.waitForTimeout(1000);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);
    await expect(
      page.getByText("lf-renamed_project", { exact: true }),
    ).toHaveCount(0);
  },
);

test(
  "user must not be able to add duplicate mcp servers from starter projects",
  { tag: ["@stable", "@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 100000,
    });

    await page.getByTestId("icon-ChevronLeft").first().click();

    await page.getByTestId("mcp-btn").click();
    await page.getByText("JSON").last().click();
    await page.getByTestId("icon-copy").click();

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await page.getByTestId("add-mcp-server-button-page").click();
    await page.getByTestId("json-input").click();
    await page.keyboard.press(`ControlOrMeta+V`);
    await page.getByTestId("add-mcp-server-button").click();

    // Wait for error message to appear
    await expect(page.getByText("Server already exists.")).toBeVisible({
      timeout: 10000,
    });

    const numberOfErrors = await page
      .getByText("Server already exists.")
      .count();
    expect(numberOfErrors).toBe(1);
  },
);
