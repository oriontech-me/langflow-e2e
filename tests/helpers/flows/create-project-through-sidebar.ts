import { expect, type Page } from "@playwright/test";

export type CreatedProject = { id: string; name: string };

/**
 * Creates a project (folder) through the home sidebar's `add-project-button`
 * and returns what the backend actually created — **id and name**.
 *
 * Why the name has to come from the API (#1023): the button always asks for a
 * folder called "New Project", and Langflow de-duplicates that server-side into
 * `New Project (N)` whenever the name is taken. Callers used to reach for the
 * fresh entry with `page.getByText("New Project").last()`, which stops being
 * the folder they just created the moment a second entry with that prefix
 * exists — a leftover from an earlier run, or a sibling worker creating its own
 * folder under `fullyParallel`.
 *
 * Measured on `1.12.0.dev9`: `folder-deletion-integrity.spec.ts` is 3 passed in
 * 18.4 s on a clean instance and **2 failed in 55.0 s** with 8 leftover
 * "New Project" folders seeded — both failures on `input-project` never
 * appearing after the double-click.
 *
 * The returned id is what teardown deletes (`deleteProject`), so a folder
 * created here can never be orphaned by a UI delete that silently 500s (#965).
 */
export async function createProjectThroughSidebar(
  page: Page,
): Promise<CreatedProject> {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.replace(/\/$/, "") ===
        "/api/v1/projects" &&
      response.request().method() === "POST" &&
      response.status() === 201,
    { timeout: 30000 },
  );

  await page.getByTestId("add-project-button").click();

  const project = (await (await created).json()) as CreatedProject;
  await expect(page.getByTestId(`sidebar-nav-${project.name}`)).toBeVisible({
    timeout: 15000,
  });
  return { id: project.id, name: project.name };
}

/**
 * Renames a project through the sidebar's inline input, addressing it by its
 * `sidebar-nav-<name>` testid rather than by a substring text match — the same
 * ambiguity described above, on the rename side. Double-clicking the testid
 * opens `input-project` (confirmed live on `1.12.0.dev9`).
 */
export async function renameProjectThroughSidebar(
  page: Page,
  currentName: string,
  newName: string,
): Promise<void> {
  await page.getByTestId(`sidebar-nav-${currentName}`).dblclick();
  await page.getByTestId("input-project").fill(newName);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`sidebar-nav-${newName}`)).toBeVisible({
    timeout: 15000,
  });
}
