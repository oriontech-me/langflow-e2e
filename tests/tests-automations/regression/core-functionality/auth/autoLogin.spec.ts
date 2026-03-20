import { test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe(
  "Auto_login tests",
  { tag: ["@release", "@api", "@database", "@mainpage", "@auth"] },

  () => {
    test(
      "auto_login sign in",
      { tag: ["@release", "@api", "@database", "@auth"] },
      async ({ page }) => {
        await awaitBootstrapTest(page, {
          skipModal: true,
        });
        await page.getByTestId("new-project-btn").click();
      },
    );

    test(
      "auto_login block_admin",
      { tag: ["@release", "@api", "@database", "@auth"] },
      async ({ page }) => {
        await awaitBootstrapTest(page, {
          skipModal: true,
        });
        await page.getByTestId("new-project-btn").click();
        await page.waitForSelector('[data-testid="modal-title"]', {
          timeout: 5000,
        });

        await page.goto("/login");
        await page.getByTestId("new-project-btn").click();
        await page.waitForSelector('[data-testid="modal-title"]', {
          timeout: 5000,
        });
        await page.goto("/admin");
        await page.getByTestId("new-project-btn").click();
        await page.waitForSelector('[data-testid="modal-title"]', {
          timeout: 5000,
        });

        await page.goto("/admin/login");
        await page.getByTestId("new-project-btn").click();
        await page.waitForSelector('[data-testid="modal-title"]', {
          timeout: 5000,
        });
      },
    );
  },
);
