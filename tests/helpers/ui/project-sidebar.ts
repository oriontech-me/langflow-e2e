import type { Locator, Page } from "@playwright/test";
import { convertTestName } from "../filesystem/convert-test-name";

/**
 * A project as the backend returns it — the only pair that addresses its home
 * sidebar entry on every Langflow line this suite runs against.
 */
export type ProjectRef = { id: string; name: string };

/**
 * Addressing a project in the home sidebar.
 *
 * Upstream changed the hook from the project's NAME to its ID in
 * `23f91d8587` ("fix(authz): support scoped project visibility", #14429), on
 * the `release-1.12.0` line the nightly is cut from:
 *
 *   sidebar-nav-${item.name}                 →  sidebar-nav-${item.id}
 *   more-options-button_${convertTestName(item.name)}
 *                                            →  more-options-button_${item.id}
 *
 * Measured live on `1.12.0.dev20`: the entry renders
 * `data-testid="sidebar-nav-<uuid>"` and the kebab
 * `data-testid="more-options-button_<uuid>" aria-label="Options for <name>"`.
 * The name is still the entry's text and the kebab's accessible name, so
 * nothing a user or a screen reader observes was lost — this is an internal
 * rename of an automation hook, not a product regression (#1363).
 *
 * **Both spellings are matched on purpose.** `main` still renders the
 * name-derived testid, and `manual.yml` dispatches the `@stable` set against
 * `1.11.x` release candidates before every sign-off — pinning the id alone
 * would trade seven tests red on the nightly for seven tests red on the lane
 * that signs releases off. The two selectors can never both match: an entry
 * carries exactly one testid, and a project's name is never another project's
 * uuid. **Delete the name branch when `1.11.x` leaves the support window** —
 * `projectSidebarEntrySelector` and `projectOptionsButtonSelector` are the only
 * two places that spell it.
 *
 * Scoped to `[data-testid="project-sidebar"]` (both elements live inside it,
 * confirmed live) so an unrelated `sidebar-nav-*` — the flow editor's own tab
 * strip uses that prefix too — can never satisfy a project assertion.
 */
const PROJECT_SIDEBAR = '[data-testid="project-sidebar"]';

/** Quotes a CSS attribute value, escaping `"` and `\` — project names are free text. */
function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** CSS matching the project's sidebar entry under either upstream spelling. */
export function projectSidebarEntrySelector(project: ProjectRef): string {
  return [
    `[data-testid=${quote(`sidebar-nav-${project.id}`)}]`,
    `[data-testid=${quote(`sidebar-nav-${project.name}`)}]`,
  ].join(", ");
}

/** CSS matching the project's kebab (options) button under either spelling. */
export function projectOptionsButtonSelector(project: ProjectRef): string {
  return [
    `[data-testid=${quote(`more-options-button_${project.id}`)}]`,
    `[data-testid=${quote(`more-options-button_${convertTestName(project.name)}`)}]`,
  ].join(", ");
}

/** The project's entry in the home sidebar. */
export function projectSidebarEntry(page: Page, project: ProjectRef): Locator {
  return page
    .locator(PROJECT_SIDEBAR)
    .locator(projectSidebarEntrySelector(project));
}

/** The project's kebab (options) button in the home sidebar. */
export function projectOptionsButton(page: Page, project: ProjectRef): Locator {
  return page
    .locator(PROJECT_SIDEBAR)
    .locator(projectOptionsButtonSelector(project));
}

/**
 * Opens the project's kebab menu, hovering the entry first — the icon inside
 * the trigger is `hidden` until the row is hovered or is the active path.
 */
export async function openProjectOptions(
  page: Page,
  project: ProjectRef,
): Promise<void> {
  await projectSidebarEntry(page, project).last().hover();
  await projectOptionsButton(page, project).last().click();
}
