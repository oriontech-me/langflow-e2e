import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test(
  "user should be able to select flows with different methods and perform bulk actions",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page, request }) => {
    // Track the IDs of the 3 flows we create so cleanup can delete ONLY those
    // via the API, not sibling specs' flows. Under `fullyParallel`, a positional
    // bulk-delete on the shared listing would otherwise be able to hit a flow
    // created by another worker (guarded against below).
    const createdFlowIds: string[] = [];
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const createdNames = [1, 2, 3].map((n) => `bulk-actions-${suffix}-${n}`);

    try {
      // Create the 3 flows directly via the REST API instead of clicking through
      // the templates modal three times. The UI path (open modal → pick template
      // → navigate editor↔home, ×3) was heavy and load-sensitive; both recurring
      // daily failures (#723: modal never opened / home-return waitForSelector
      // timeout) lived entirely in that scaffolding, never in the bulk-action
      // assertions under test. `createFlow` retries the transient concurrent
      // 500 (#588); empty `data` is enough — the test only selects/downloads/
      // deletes the cards, it never runs the flows.
      //
      // Seed via the API BEFORE bootstrapping the browser: this leaves the
      // instance non-empty, so `awaitBootstrapTest`'s empty-page seeding branch
      // (`addFlowToTestOnEmptyLangflow`, which itself drives the flaky templates
      // modal via `dismissWelcomeOverlayAndWaitForModal`) is never taken. Getting
      // the token uses `request` and is independent of the browser session.
      const headers = { Authorization: await getAuthToken(request) };
      for (const name of createdNames) {
        const id = await createFlow(
          request,
          { name, description: "", data: { nodes: [], edges: [] }, is_component: false },
          { headers },
        );
        createdFlowIds.push(id);
      }

      // Bootstrap onto the home listing. `skipModal` skips opening the templates
      // modal, and because the 3 flows above already exist the empty-page
      // seeding branch is skipped too — so no part of the historically flaky
      // modal path (#723) is exercised. The 3 flows sort to the top by recency
      // (verified live — API-created empty flows select via shift/ctrl click
      // exactly like template-created ones).
      await awaitBootstrapTest(page, { skipModal: true });
      await expect(page.getByTestId("list-card").first()).toBeVisible({ timeout: 30000 });

      // Safety + determinism guard: the top 3 cards must be exactly the flows we
      // created. Selection below is positional (shift/ctrl-click by card index)
      // and bulk-delete is destructive, so if a sibling worker's flow interleaved
      // at the top of the recency-sorted listing under `fullyParallel`, fail fast
      // here rather than risk deleting someone else's flow.
      // Poll rather than read once: on load-degraded dailies the recency-sorted
      // listing has not yet floated the 3 freshly-created flows to the top when a
      // single snapshot is taken, so a one-shot `evaluateAll → toEqual` flaked
      // with a deep-equality mismatch (#790). Polling retries until the listing
      // settles; it still fails fast if a sibling worker's flow genuinely sits in
      // the top 3.
      await expect
        .poll(
          async () =>
            (
              await page
                .locator("[data-testid='flow-name-div'] span")
                .evaluateAll((els) =>
                  els.slice(0, 3).map((e) => e.textContent?.trim() ?? ""),
                )
            )
              .slice()
              .sort(),
          { timeout: 30000 },
        )
        .toEqual([...createdNames].sort());

      // Test shift selection
      await page.keyboard.down("Shift");
      await page.getByTestId("list-card").first().click();
      await page.getByTestId("list-card").nth(2).click();
      await page.keyboard.up("Shift");

      // Verify all 3 flows are selected (shift-click range)
      const firstCheckbox = page.getByTestId(/^checkbox-/).first();
      const secondCheckbox = page.getByTestId(/^checkbox-/).nth(1);
      const thirdCheckbox = page.getByTestId(/^checkbox-/).nth(2);
      await expect(firstCheckbox).toBeChecked();
      await expect(secondCheckbox).toBeChecked();
      await expect(thirdCheckbox).toBeChecked();
      // Test bulk download
      await page.getByTestId("download-bulk-btn").last().click();
      await expect(page.getByText(/.*downloaded successfully/)).toBeVisible({
        timeout: 10000,
      });

      // Deselect all
      await page.keyboard.down("Shift");
      await page.getByTestId("list-card").first().click();
      await page.keyboard.up("Shift");

      // Verify all 3 flows are deselected
      await expect(firstCheckbox).not.toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).not.toBeChecked();

      // Test Ctrl/Cmd selection — clicks 1 and 3 only, so the 2nd should
      // remain unchecked (this is what proves Ctrl-click is per-item, not
      // range-based).
      await page.keyboard.down("ControlOrMeta");
      await page.getByTestId("list-card").first().click();
      await page.getByTestId("list-card").nth(2).click();
      await page.keyboard.up("ControlOrMeta");

      // Verify 1st and 3rd selected, 2nd skipped
      await expect(firstCheckbox).toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).toBeChecked();

      // Capture flow names from the list cards for the post-bulk-delete
      // hidden/visible assertions. Assert each span has non-empty text
      // BEFORE reading textContent — if the span hasn't rendered yet, the
      // captured name would be "" and `getByText("", { exact: true })` would
      // pass vacuously, letting a real regression slip through.
      const firstNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .first()
        .locator("span");
      const secondNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .nth(1)
        .locator("span");
      const thirdNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .nth(2)
        .locator("span");
      await expect(firstNameLoc).toHaveText(/.+/);
      await expect(secondNameLoc).toHaveText(/.+/);
      await expect(thirdNameLoc).toHaveText(/.+/);
      const firstFlowName = (await firstNameLoc.textContent())!.trim();
      const secondFlowName = (await secondNameLoc.textContent())!.trim();
      const thirdFlowName = (await thirdNameLoc.textContent())!.trim();

      // Test bulk delete
      await page.getByTestId("delete-bulk-btn").first().click();
      await expect(page.getByText("This can't be undone.")).toBeVisible({ timeout: 5000 });
      await page.getByText("Delete").last().click();

      // Verify deletion success message
      await expect(page.getByText("Flows deleted successfully")).toBeVisible({
        timeout: 10000,
      });

      // Verify flows are deleted
      await expect(
        page.getByText(firstFlowName, { exact: true }),
      ).toBeHidden();
      await expect(page.getByText(secondFlowName, { exact: true })).toBeVisible();
      await expect(
        page.getByText(thirdFlowName, { exact: true }),
      ).toBeHidden();
    } finally {
      // API-based cleanup scoped to the IDs we captured during creation.
      // Parallelism-safe: a previous UI-driven cleanup did a Shift-click
      // first→last bulk-delete on the entire listing, which would nuke any
      // flow concurrently created by sibling specs under `fullyParallel`.
      // Iterating known IDs avoids that whole class of cross-worker damage.
      // 404s on IDs already deleted by the test (the 2 bulk-deleted flows
      // when the test reaches its happy path) are expected and ignored.
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
