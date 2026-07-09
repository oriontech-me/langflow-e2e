import { test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { openNewFlowTemplatesModal } from "../../../../helpers/flows/open-new-flow-templates-modal";

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
        await openNewFlowTemplatesModal(page);
      },
    );

    test(
      "auto_login block_admin",
      { tag: ["@release", "@api", "@database", "@auth"] },
      async ({ page }) => {
        await awaitBootstrapTest(page, {
          skipModal: true,
        });
        await openNewFlowTemplatesModal(page);

        await page.goto("/login");
        await openNewFlowTemplatesModal(page);
        await page.goto("/admin");
        await openNewFlowTemplatesModal(page);

        await page.goto("/admin/login");
        await openNewFlowTemplatesModal(page);
      },
    );
  },
);
