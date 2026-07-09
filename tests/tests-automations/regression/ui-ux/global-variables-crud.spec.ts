import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Each test creates a blank flow it never deleted — 3 leaked flows per run,
// feeding the instance-state degradation behind the #599 flake. Track the ids
// the page actually creates (POST /api/v1/flows → 201; the canvas URL id is
// transient on 1.11) and delete them in afterEach.
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
  }
});

// Shared setup: blank flow → OpenAI component → Global Variables modal.
// The sidebar-search-input and icon-Globe clicks come right after heavy page
// transitions (canvas mount; node panel render). Under CI load those exceed
// the 20s implicit action timeout — the recurring #599 flake — so each click
// is gated on visibility with the file's standard 30s transition timeout.
// Behavior asserts are untouched.
async function openGlobalVariablesModal(page: Page): Promise<void> {
  // Use large viewport so the global variables modal is fully visible
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  const searchInput = page.getByTestId("sidebar-search-input");
  await expect(searchInput).toBeVisible({ timeout: 30000 }); // readiness gate (#599)
  await searchInput.click();
  await searchInput.fill("openai");
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
  const globeIcon = page.getByTestId("icon-Globe").first();
  await expect(globeIcon).toBeVisible({ timeout: 30000 }); // readiness gate (#599)
  await globeIcon.click();
  await page.waitForTimeout(500);
}

test(
  "create a Generic type global variable",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesModal(page);

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
    await openGlobalVariablesModal(page);

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
    await openGlobalVariablesModal(page);

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

      // The modal opens on the Generic tab by default — switch to Credential
      // BEFORE saving, otherwise this test would be creating (and asserting
      // against) a Generic variable, not a Credential one.
      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);
      await page.getByTestId("credential-tab").click();
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
      // on the page — not as a standalone match, and not embedded inside a
      // toast, label, preview, or any other longer message. getByText without
      // `exact: true` does substring matching, so a leak like
      // `"Saved: SECRET-SENTINEL-..."` also fails the assertion. Input value
      // attributes (`<input type="password" value="…">`) don't count as
      // visible text — only rendered text does, which is the guarantee under
      // test.
      await expect(page.getByText(sentinelValue)).toHaveCount(0, {
        timeout: 5000,
      });
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
