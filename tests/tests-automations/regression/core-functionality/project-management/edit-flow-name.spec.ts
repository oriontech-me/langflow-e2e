import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { renameFlow } from "../../../../helpers/flows/rename-flow";

// Every flow this test creates (bootstrap + the Basic Prompting template) is
// tracked by id and deleted in afterEach — id-scoped, never a name or wipe
// sweep, which would kill flows other parallel workers are driving (#553).
// The app can fire more than one flows POST per creation; only one persists and
// deleting a transient id 404s harmlessly (deleteFlow treats 404 as done).
const createdFlowIds: string[] = [];

test.afterEach(async ({ page }) => {
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(page.request, id);
  }
});

test(
  "user should be able to edit flow name and see it reflected in the main page listing",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
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
          .catch(() => {}); // non-JSON / batch payloads
      }
    });

    await awaitBootstrapTest(page);

    await page.getByRole("heading", { name: "Basic Prompting" }).click();

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

      // Re-open the flow by clicking its name in the listing — required so the next
      // iteration starts inside the editor with renameFlow() targeting the flow header.
      // The /flows a11y refactor (Langflow #13891) makes the card content
      // pointer-events-none; open the flow via the card's overlay button.
      await page
        .getByTestId("list-card")
        .filter({
          has: page.getByTestId("flow-name-div").filter({ hasText: targetName }),
        })
        .getByTestId("list-card-open-button")
        .first()
        .click();
    }
  },
);
