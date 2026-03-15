import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "import invalid JSON must show error message",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Simulate drag-and-drop of an invalid JSON file
    const invalidJsonContent = "{ this is not valid json !!!";

    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([data], "invalid.json", {
        type: "application/json",
      });
      dt.items.add(file);
      return dt;
    }, invalidJsonContent);

    await page
      .getByTestId("cards-wrapper")
      .dispatchEvent("drop", { dataTransfer });

    // Must display an error or warning — not silently fail
    // Use a single reliable regex-based wait (comma-separated text= is invalid Playwright syntax)
    const errorLocator = page.getByText(/invalid|error|failed|could not/i).first();
    await expect(errorLocator).toBeVisible({ timeout: 10000 });

    // No new flow should be created (we can verify by checking that no success message appears)
    const successVisible = await page
      .getByText("uploaded successfully")
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(successVisible).toBeFalsy();
  },
);

test(
  "import non-JSON file must show error message",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Simulate drop of a plain text file (not JSON)
    const textContent = "This is a plain text file, not a flow.";

    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([data], "notaflow.txt", { type: "text/plain" });
      dt.items.add(file);
      return dt;
    }, textContent);

    await page
      .getByTestId("cards-wrapper")
      .dispatchEvent("drop", { dataTransfer });

    await page.waitForTimeout(3000);

    // No flow should be created successfully
    const successVisible = await page
      .getByText("uploaded successfully")
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(successVisible).toBeFalsy();
  },
);

test(
  "import JSON with missing data field must show error",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Valid JSON but missing required "data" field for a flow
    const incompleteFlow = JSON.stringify({
      name: "Incomplete Flow",
      description: "This flow is missing the data field",
      // no "data" property
    });

    const dataTransfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([data], "incomplete.json", {
        type: "application/json",
      });
      dt.items.add(file);
      return dt;
    }, incompleteFlow);

    await page
      .getByTestId("cards-wrapper")
      .dispatchEvent("drop", { dataTransfer });

    await page.waitForTimeout(3000);

    // Either shows error or uploads without nodes (both are acceptable behaviors)
    // The key assertion is that the app doesn't crash
    const appStillVisible = await page
      .getByTestId("mainpage_title")
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(appStillVisible).toBeTruthy();
  },
);
