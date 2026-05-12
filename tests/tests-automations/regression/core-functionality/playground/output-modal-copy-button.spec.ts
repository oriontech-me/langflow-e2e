import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe("Output Modal — Copy Button", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate to home before deleting to stop background browser requests
      // for the current flow; without this, pending polling GETs complete
      // after the DELETE and trigger spurious 404 fixture errors.
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "copy button copies Text Input output and toggles Check icon",
    { tag: ["@stable", "@release", "@workspace", "@playground"] },
    async ({ page }) => {
      await test.step("create blank flow and capture flow id", async () => {
        await awaitBootstrapTest(page);

        const flowCreationPromise = page.waitForResponse(
          (resp) =>
            resp.url().includes("/api/v1/flows") &&
            resp.request().method() === "POST" &&
            resp.status() === 201,
          { timeout: 15000 },
        );

        await page.getByTestId("blank-flow").click();

        const creationResponse = await flowCreationPromise;
        const flowData = await creationResponse.json();
        // Capture id before asserting format so afterEach can still clean up
        // if the regex assertion fails on an unexpected id shape.
        createdFlowId = flowData.id ?? null;
        expect(flowData.id, "flow creation response missing id").toMatch(
          /^[0-9a-f-]{36}$/,
        );
      });

      await test.step("add Text Input and fill its value", async () => {
        await page.getByTestId("sidebar-search-input").fill("text input");
        await page
          .getByTestId("input_outputText Input")
          .hover()
          .then(async () => {
            await page.getByTestId("add-component-button-text-input").click();
          });

        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 10000,
        });

        await page
          .getByTestId("textarea_str_input_value")
          .fill("Test content to copy");
      });

      await test.step("run component and open output modal", async () => {
        await page.getByTestId("button_run_text input").click();
        await expect(page.getByText("built successfully").last()).toBeVisible({
          timeout: 30000,
        });

        await page
          .locator('[data-testid^="output-inspection-"]')
          .first()
          .click();
        await expect(page.getByText("Component Output").first()).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("click copy and verify Check → Copy icon transition", async () => {
        const copyButton = page.getByTestId("copy-output-button");
        await expect(copyButton).toBeVisible();
        await copyButton.click();

        await expect(page.getByText("Copied to clipboard")).toBeVisible({
          timeout: 5000,
        });
        await expect(
          copyButton.locator('[data-testid="icon-Check"]'),
        ).toBeVisible();

        // Icon reverts to Copy after the success state expires (~2s in UI).
        // Web-first assertion polls until the Copy icon reappears.
        await expect(
          copyButton.locator('[data-testid="icon-Copy"]'),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );
});
