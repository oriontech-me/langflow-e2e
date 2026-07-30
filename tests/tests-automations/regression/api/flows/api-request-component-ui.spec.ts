import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";

// Id-scoped flow cleanup, via the shared tracker (#1108). This file had NONE: all
// four tests reach the canvas through `awaitBootstrapTest` + the `blank-flow`
// click, so every run leaked. Measured with the tracker disabled: one orphan per
// test, i.e. four per full run of this file, kept for good. Never a name-scoped or
// delete-all sweep — that deletes flows other parallel workers are driving (#553).
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
  flows.dispose();
});

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

    // `headers` is an ADVANCED field, so it is not on the node body — measured on
    // 1.12.0.dev9 via `GET /api/v1/all`: `template.headers.advanced === true`
    // while `url_input` and `method` are false. Scouted on the same build, the
    // node carries no header-related `data-testid` at all; the field lives in the
    // node inspector panel, which `parameters-button` opens (#1136).
    //
    // The previous version searched the node for a `/^headers$/i` label and, on
    // missing it, clicked a `/advanced/i` button — a control the nightly replaced
    // with this panel around dev46 — so it had been failing on every run of a
    // spec no lane happens to execute (`@release`, never `@stable`).
    await openAdvancedOptions(page);

    // Asserted by exact testid, never by a `/.*headers.*/` regex: the page also
    // renders `app-header` and `chat-header-more-menu`, so a substring match
    // would report success with the headers field absent — the false-positive
    // shape `CONTRIBUTING.md` warns about, and the reason this test could not
    // have failed honestly either way (#1136).
    await expect(page.getByTestId("inspector-param-headers")).toBeVisible({
      timeout: 15000,
    });

    // The field is a key-value table, and the panel exposes its editor plus the
    // add-to-node toggle every advanced input gets. Both prove the field is
    // genuinely wired, not just a label rendered by the panel.
    await expect(page.getByTestId("inspector-api-headers")).toBeVisible();
    await expect(page.getByTestId("inspector-add-headers")).toBeVisible();

    await closeAdvancedOptions(page);
  },
);
