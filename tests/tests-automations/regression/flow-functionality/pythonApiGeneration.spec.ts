import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { selectApiVersion } from "../../../helpers/ui/select-api-version";
import {
  type FlowTracker,
  trackCreatedFlows,
} from "../../../helpers/flows/track-created-flows";

// Every flow this page creates — the bootstrap's and the template's — is tracked
// from before the bootstrap and deleted id-scoped after the test (repo convention,
// #490/#681). Until #2415 this spec deleted none of the flows it created.
let flows: FlowTracker | undefined;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  const tracker = flows;
  flows = undefined;
  // `strict`: a failed delete fails the teardown so a leak surfaces (#545).
  await tracker?.cleanup(request, { strict: true });
});

test(
  "user can copy a valid Python requests snippet from the API access modal",
  { tag: ["@release", "@workspace", "@stable"] },
  async ({ page }) => {
    await test.step("Open the Basic Prompting template", async () => {
      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
    });

    await test.step("Open the API access modal on the v1 Python tab", async () => {
      await page.getByTestId("publish-button").click();
      await page.getByTestId("api-access-item").click();
      // v1 explicitly: the modal opens on v2 on the 1.14 line since #13508, and this
      // spec asserts the v1 /run snippet (#2415).
      await selectApiVersion(page, "v1");
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
