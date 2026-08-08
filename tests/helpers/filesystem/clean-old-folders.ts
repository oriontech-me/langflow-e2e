import type { Page } from "@playwright/test";
import { deleteProject } from "../flows/delete-project";

/**
 * Deletes every leftover `New Project*` folder on the account.
 *
 * This is teardown of the PREVIOUS run, not a step of the test that calls it —
 * so it goes through the REST API and must not depend on the UI state the test
 * is about to assert on. The sibling `removeLeftoverRenamedProject` in
 * `mcp-server-starter-projects.spec.ts` already makes that argument; this helper
 * was the last cleanup still driving the sidebar.
 *
 * It was doing so through the kebab's **name-derived** testid
 * (`more-options-button_<slug>`), which upstream renamed to the project id in
 * `23f91d8587` — so from `1.12.0.dev20` on it deleted nothing and merely timed
 * out on a click. That is the second defect riding on #1363: the daily's retries
 * show `New Project` → `New Project (5)` accumulating across six attempts of the
 * same test, because nothing was clearing them between attempts.
 *
 * `deleteProject` retries the `500` the endpoint answers under contention (#965)
 * and treats `404` as the desired end state. A folder that survives every retry
 * is reported and skipped: cleanup must never fail the test whose assertions
 * have not run yet, but it must not be silent either (#1012).
 */
export const cleanOldFolders = async (page: Page) => {
  const response = await page.request.get("/api/v1/projects/");
  if (!response.ok()) {
    console.warn(
      `⚠️ cleanOldFolders could not list projects: ${response.status()}`,
    );
    return;
  }

  // The /api/v1/projects/ response shape varies (sometimes a bare array,
  // sometimes `{ folders: [...] }`) — normalized the same way the MCP specs do.
  const raw = await response.json();
  const projects: Array<{ id: string; name: string }> = Array.isArray(raw)
    ? raw
    : (raw.folders ?? []);

  for (const project of projects.filter((p) =>
    p.name?.startsWith("New Project"),
  )) {
    await deleteProject(page.request, project.id).catch((error) => {
      console.warn(
        `⚠️ Leftover project left behind (${project.id} "${project.name}"): ${error}`,
      );
    });
  }
};
