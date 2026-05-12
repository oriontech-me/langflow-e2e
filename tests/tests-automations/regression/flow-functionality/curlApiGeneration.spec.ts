import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can copy a valid macOS/Linux curl command from the API access modal",
  { tag: ["@release", "@workspace", "@stable"] },
  async ({ page }) => {
    await test.step("Open the Basic Prompting template", async () => {
      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
    });

    await test.step("Open the API access modal on the cURL tab", async () => {
      await page.getByTestId("publish-button").click();
      await page.getByTestId("api-access-item").click();
      await page.getByTestId("api_tab_curl").click();
    });

    await test.step("Force the macOS/Linux platform variant", async () => {
      await page.getByRole("tab", { name: "macOS/Linux" }).click();
    });

    await test.step("Copy the generated command to the clipboard", async () => {
      await page.getByTestId("icon-Copy").last().click();
    });

    const clipboardContent = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );

    await test.step("Validate the curl command structure", async () => {
      expect(clipboardContent).toMatch(/^curl --request POST/);
      expect(clipboardContent).toMatch(
        /--url '[^']*\/api\/v1\/run\/[0-9a-f-]{36}\?stream=false'/,
      );
      expect(clipboardContent).toContain(
        "--header 'Content-Type: application/json'",
      );
      expect(clipboardContent).toContain("x-api-key: YOUR_API_KEY_HERE");
      expect(clipboardContent).toContain("--data");
      expect(clipboardContent).toContain('"input_value": "Hello"');
      expect(clipboardContent).toContain('"session_id"');
      expect(clipboardContent).toContain('"output_type": "chat"');
    });
  },
);
