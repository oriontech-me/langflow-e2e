import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { renameFlow } from "../../../../helpers/flows/rename-flow";
import { createFlowFromStarter } from "../../../../helpers/flows/create-flow-from-starter";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Id of the flow this file creates, so afterEach deletes exactly it — id-scoped,
// never a name or wipe sweep, which would kill flows other parallel workers are
// driving (#553). The shared `trackCreatedFlows` helper is deliberately NOT used
// here: it captures ids from page-level `POST /api/v1/flows` → 201 responses, and
// `createFlowFromStarter` creates through `page.request`, which emits no
// page-level response events at all — that tracker would collect nothing and leak
// the flow (the #1147 lesson).
const createdFlowIds: string[] = [];

/**
 * Open a flow addressed by id and wait until the editor is ready to be driven.
 *
 * `page.goto`, not a click on the home grid's `list-card-open-button`: the cards
 * other parallel workers leave behind overlap the target's absolute-inset open
 * button and intercept a hit-tested click, which lands without navigating
 * (#580/#588). A full document load also has no SPA hop left to race.
 *
 * The `menu_bar_display` gate is the write-permission barrier: upstream disables
 * that button while the effective-permissions query is in flight, and everything
 * the test does next mutates the flow (#1005).
 */
async function openFlowById(page: Page, flowId: string): Promise<void> {
  await page.goto(`/flow/${flowId}`);
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("menu_bar_display")).toBeEnabled({
    timeout: 30000,
  });
}

test.afterEach(async ({ page, request }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the canvas BEFORE deleting. The editor keeps refetching the flow it has
  // open, so deleting it out from under an open editor turns those refetches into
  // `404 GET /api/v1/flows/{id}` on the run's backend-error log — advisory noise
  // that makes the log less trustworthy for everyone reading it (#1084). This is
  // the same reason `trackCreatedFlows.cleanup` navigates first (#1108).
  // Playwright captures the failure screenshot before `afterEach` runs, so this
  // navigation cannot destroy the artefact of a failing test.
  await page.goto("/").catch(() => {});
  // Explicit bearer: under AUTO_LOGIN a bare request context is unauthenticated,
  // so an unheadered DELETE 401s and silently leaks the flow.
  const bearer = await getAuthToken(request);
  for (const id of ids) {
    await deleteFlow(request, id, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
  }
});

test(
  "user should be able to edit flow name and see it reflected in the main page listing",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    // Copy the Basic Prompting starter graph into a flow of this worker's own,
    // over the API. The templates-modal path this replaces ("New Flow" → welcome
    // overlay → Browse more → click the shared card) creates a blank placeholder
    // flow first and then navigates to a SECOND one, and nothing downstream waited
    // for that hop — so the rename helper would drive the placeholder, behind the
    // welcome overlay, mid-navigation (#1005). Keeping the real starter graph is
    // deliberate: it is what exposes the mount autosave the #995 clobber rides on.
    const flowId = await createFlowFromStarter(
      page.request,
      "Basic Prompting",
      `edit-flow-name ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    createdFlowIds.push(flowId);
    await openFlowById(page, flowId);

    const names = [
      Math.random().toString(36).substring(2, 15),
      Math.random().toString(36).substring(2, 15),
    ];

    for (const targetName of names) {
      await renameFlow(page, { flowName: targetName });

      const { flowName } = await renameFlow(page);
      expect(flowName).toBe(targetName);

      await page.getByTestId("icon-ChevronLeft").first().click();

      await expect(page.getByTestId("home-dropdown-menu").first()).toBeVisible({
        timeout: 30000,
      });

      // Auto-waits for the renamed flow to appear (home refetch + render).
      // Web-first assertion instead of a fixed 3s waitForSelector, which raced
      // the flow-list API refetch under parallel load (flaky, see issue #410).
      await expect(page.getByText(targetName)).toHaveCount(1, {
        timeout: 30000,
      });

      // Re-open the SAME flow so the next iteration starts inside the editor,
      // addressed by id rather than by a name-filtered card click (#1005).
      await openFlowById(page, flowId);
    }
  },
);
