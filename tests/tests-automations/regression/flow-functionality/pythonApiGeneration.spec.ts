import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can copy a valid Python requests snippet from the API access modal",
  { tag: ["@release", "@workspace", "@stable"] },
  async ({ page }) => {
    await test.step("Open the Basic Prompting template", async () => {
      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
    });

    await test.step("Open the API access modal on the Python tab", async () => {
      await page.getByTestId("publish-button").click();
      await page.getByTestId("api-access-item").click();
      await page.getByTestId("api_tab_python").click();
    });

    await test.step("Copy the generated snippet to the clipboard", async () => {
      await page.getByTestId("icon-Copy").last().click();
    });

    const clipboardContent = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );

    await test.step("Validate the Python snippet structure", async () => {
      expect(clipboardContent).toMatch(/^import requests/);
      expect(clipboardContent).toContain("import uuid");
      expect(clipboardContent).toContain("api_key = 'YOUR_API_KEY_HERE'");
      expect(clipboardContent).toMatch(
        /url = "[^"]*\/api\/v1\/run\/[0-9a-f-]{36}"/,
      );
      expect(clipboardContent).toContain('"input_value": "Hello"');
      expect(clipboardContent).toContain('"output_type": "chat"');
      expect(clipboardContent).toContain('"input_type": "chat"');
      expect(clipboardContent).toContain(
        'payload["session_id"] = str(uuid.uuid4())',
      );
      expect(clipboardContent).toContain('headers = {"x-api-key": api_key}');
      expect(clipboardContent).toContain(
        'requests.request("POST", url, json=payload, headers=headers)',
      );
    });
  },
);
