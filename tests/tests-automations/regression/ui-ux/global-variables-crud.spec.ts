import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "create a Generic type global variable",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    // Use large viewport so the global variables modal is fully visible
    await page.setViewportSize({ width: 1920, height: 1080 });
    await awaitBootstrapTest(page);
    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("openai");
    await page.waitForSelector('[data-testid="openaiOpenAI"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("openaiOpenAI")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-openai").last().click();
      });

    await page.waitForTimeout(1000);
    await page.getByText("OpenAI", { exact: true }).last().click();
    await page.getByTestId("icon-Globe").nth(0).click();
    await page.waitForTimeout(500);

    const varName = `test-generic-${Date.now()}`;

    try {
      // Use JS click because the button may render outside the browser viewport
      // (global variables modal can exceed viewport height on smaller screens)
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("button, span")).find(
          (e) => e.textContent?.trim() === "Add New Variable",
        ) as HTMLElement | undefined;
        if (el) el.click();
        else throw new Error("Add New Variable button not found in DOM");
      });
      await page.waitForTimeout(300);
      await page.waitForTimeout(500);

      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);

      // "Generic" type must be available
      await expect(
        page.getByText("Generic", { exact: true }).first(),
      ).toBeVisible({ timeout: 5000 });

      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill("generic-value-123");

      await page.getByText("Save Variable", { exact: true }).click();
      await page.waitForTimeout(500);

      // Variable must appear in the list
      await expect(page.getByText(varName, { exact: true })).toBeVisible({
        timeout: 5000,
      });
    } finally {
      // Cleanup: delete the variable even if assertions above fail
      const varRow = page.getByText(varName, { exact: true });
      if (await varRow.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.getByTestId("icon-Trash2").last().click();
        await page.waitForTimeout(300);
        await page.getByText("Delete", { exact: true }).last().click();
        await page.waitForTimeout(300);
      }
    }
  },
);

test(
  "delete a global variable removes it from the list",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await awaitBootstrapTest(page);
    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("openai");
    await page.waitForSelector('[data-testid="openaiOpenAI"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("openaiOpenAI")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-openai").last().click();
      });

    await page.waitForTimeout(1000);
    await page.getByText("OpenAI", { exact: true }).last().click();
    await page.getByTestId("icon-Globe").nth(0).click();
    await page.waitForTimeout(500);

    const varName = `delete-me-${Date.now()}`;
    let varCreated = false;

    try {
      // Use JS click because the button may render outside the browser viewport
      // (global variables modal can exceed viewport height on smaller screens)
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("button, span")).find(
          (e) => e.textContent?.trim() === "Add New Variable",
        ) as HTMLElement | undefined;
        if (el) el.click();
        else throw new Error("Add New Variable button not found in DOM");
      });
      await page.waitForTimeout(300);
      await page.waitForTimeout(500);

      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);
      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill("to-be-deleted");
      await page.getByText("Save Variable", { exact: true }).click();
      await page.waitForTimeout(500);

      await expect(page.getByText(varName, { exact: true })).toBeVisible({
        timeout: 5000,
      });
      varCreated = true;

      // Delete it — Trash2 icon + confirm Delete
      await page.getByTestId("icon-Trash2").last().click();
      await page.waitForTimeout(300);
      await page.getByText("Delete", { exact: true }).last().click();
      await page.waitForTimeout(600);

      // Variable must no longer be in the list
      await expect(page.getByText(varName, { exact: true })).toHaveCount(0, {
        timeout: 5000,
      });
      varCreated = false;
    } finally {
      // Cleanup if deletion test failed and variable was left behind
      if (varCreated) {
        const varRow = page.getByText(varName, { exact: true });
        if (await varRow.isVisible({ timeout: 2000 }).catch(() => false)) {
          await page.getByTestId("icon-Trash2").last().click();
          await page.waitForTimeout(300);
          await page.getByText("Delete", { exact: true }).last().click();
        }
      }
    }
  },
);

test(
  "Credential variable value is hidden from the variable list",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await awaitBootstrapTest(page);
    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("openai");
    await page.waitForSelector('[data-testid="openaiOpenAI"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("openaiOpenAI")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-openai").last().click();
      });

    await page.waitForTimeout(1000);
    await page.getByText("OpenAI", { exact: true }).last().click();
    await page.getByTestId("icon-Globe").nth(0).click();
    await page.waitForTimeout(500);

    const varName = `credential-${Date.now()}`;
    // Distinctive sentinel — if this string surfaces anywhere as visible text
    // after save, the Credential value leaked into the DOM.
    const sentinelValue = `SECRET-SENTINEL-${Date.now()}`;
    let varCreated = false;

    try {
      // Use JS click because the button may render outside the browser viewport
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("button, span")).find(
          (e) => e.textContent?.trim() === "Add New Variable",
        ) as HTMLElement | undefined;
        if (el) el.click();
        else throw new Error("Add New Variable button not found in DOM");
      });
      await page.waitForTimeout(500);

      // Credential is the default type in the modal — no need to switch tabs
      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);
      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill(sentinelValue);

      await page.getByText("Save Variable", { exact: true }).click();
      await page.waitForTimeout(500);

      // Sanity: variable name is in the list
      await expect(page.getByText(varName, { exact: true })).toBeVisible({
        timeout: 5000,
      });
      varCreated = true;

      // Critical: the Credential value must NOT appear as visible text anywhere
      // on the page. getByText scans rendered text, not input value attributes,
      // so a masked <input type="password" value="…"> is fine — what we forbid
      // is the value being echoed back into the list, a toast, or any preview.
      await expect(
        page.getByText(sentinelValue, { exact: true }),
      ).toHaveCount(0, { timeout: 5000 });
    } finally {
      if (varCreated) {
        const varRow = page.getByText(varName, { exact: true });
        if (await varRow.isVisible({ timeout: 2000 }).catch(() => false)) {
          await page.getByTestId("icon-Trash2").last().click();
          await page.waitForTimeout(300);
          await page.getByText("Delete", { exact: true }).last().click();
        }
      }
    }
  },
);
