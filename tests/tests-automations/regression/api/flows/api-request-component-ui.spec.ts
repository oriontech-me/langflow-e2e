import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

// Reusable helper: navigate to a blank flow and add the API Request component.
// Waits until the URL input in the inspector is ready.
async function addApiRequestComponent(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 10000,
  });
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("API Request");
  await page.waitForSelector('[data-testid="add-component-button-api-request"]', {
    timeout: 15000,
  });
  await page.getByTestId("add-component-button-api-request").click();
  // The inspector opens automatically; wait for the URL field as a ready signal
  await page.waitForSelector('[data-testid="popover-anchor-input-url_input"]', {
    timeout: 15000,
  });
}

test(
  "API Request component can be added to canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The node must be visible on the canvas
    await expect(
      page.locator('[data-testid^="rf__node"]').first(),
    ).toBeVisible({ timeout: 10000 });

    // The URL input in the inspector confirms the component was fully initialised
    await expect(
      page.getByTestId("popover-anchor-input-url_input"),
    ).toBeVisible();
  },
);

test(
  "API Request component URL field accepts input",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible();

    await urlInput.fill("https://httpbin.org/get");
    await expect(urlInput).toHaveValue("https://httpbin.org/get");
  },
);

test(
  "API Request component method dropdown shows GET by default and allows selecting POST",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The method dropdown is rendered as a custom Langflow dropdown
    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });

    // Default value must be GET
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText(/GET/i);

    // Open the dropdown and select POST
    await methodDropdown.click();
    await page.waitForSelector('[data-testid="POST-1-option"]', {
      timeout: 5000,
    });
    await page.getByTestId("POST-1-option").click();

    // The displayed value must have updated
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText(/POST/i);
  },
);

test(
  "API Request component has a headers field accessible in the inspector",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The headers field is rendered as a key-value table in the inspector.
    // Look for the label "Headers" which appears above the key-value input widget.
    const headersLabel = page.getByText(/^headers$/i).first();

    // If not immediately visible, try opening an "Advanced" section first
    const isHeadersVisible = await headersLabel
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!isHeadersVisible) {
      const advancedBtn = page
        .getByRole("button", { name: /advanced/i })
        .first();
      const advancedExists = await advancedBtn
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (advancedExists) {
        await advancedBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // The headers label (or an "Add" button for the headers table) must now be present
    const headersPresent =
      (await page.getByText(/^headers$/i).first().isVisible({ timeout: 5000 }).catch(() => false)) ||
      (await page.getByTestId(/.*headers.*/).first().isVisible({ timeout: 2000 }).catch(() => false));

    expect(
      headersPresent,
      "Headers field or section should be visible in the API Request component inspector",
    ).toBe(true);
  },
);
