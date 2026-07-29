import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user must be able to create a new flow clicking on New Flow button",
  { tag: ["@release", "@mainpage"] },
  async ({ page }) => {
    // Left on env-var presence (#1029 audit): this test only asserts that the
    // per-node run buttons RENDER (`button_run_chat output`, `button_run_language
    // model`, …) after creating a project and opening Basic Prompting. It never
    // clicks one, so no completion is driven and a dead key cannot produce the
    // hung request that wedges a shard.
    //
    // As in lock-flow.spec.ts, the gate reads as vestigial — nothing here consumes
    // OPENAI_API_KEY. Dropping it would make the test run where it currently
    // skips, a behaviour change left to whoever revisits this spec.
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    await awaitBootstrapTest(page);

    await page.getByText("Close").last().click();

    await page.getByTestId("add-project-button").click();

    await page.getByText("New Project").last().click();

    await page.waitForSelector("text=new flow", { timeout: 30000 });

    await expect(page.getByText("new flow")).toBeVisible({ timeout: 30000 });

    await expect(page.getByTestId("new_project_btn_empty_page")).toBeVisible({
      timeout: 5000,
    });

    await page.getByTestId("new_project_btn_empty_page").click();

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.waitForSelector("text=playground", { timeout: 30000 });
    await page.waitForSelector("text=share", { timeout: 30000 });

    await expect(page.getByTestId("button_run_chat output")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("button_run_language model")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("button_run_prompt template")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("button_run_chat input")).toBeVisible({
      timeout: 30000,
    });
  },
);
