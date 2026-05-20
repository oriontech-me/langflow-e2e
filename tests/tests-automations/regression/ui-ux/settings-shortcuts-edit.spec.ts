import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.describe("Settings — Edit Shortcut", () => {
  test.afterEach(async ({ page }) => {
    // Cleanup: restore default shortcuts so subsequent tests start clean.
    // Implemented in Task 5.
  });

  test(
    "editing the Duplicate shortcut persists and triggers the action on canvas",
    { tag: ["@release", "@regression", "@settings", "@ui-ux"] },
    async ({ page }) => {
      await test.step("load home", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
      });

      // Remaining steps implemented in Tasks 2–4.
    },
  );
});
