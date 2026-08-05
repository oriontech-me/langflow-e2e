import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

/**
 * Global Variables CRUD via the dedicated Settings page
 * (`/settings/global-variables`).
 *
 * dev49 note — why the Settings page, not a component's Globe picker: the old
 * flow created variables through an OpenAI node's `input_value` global-variable
 * picker. On dev49 that picker AUTO-APPLIES the created variable to
 * `input_value`, which (a) renders the name in two places (the field anchor and
 * a `disabled-option-<name>`), breaking exact-text asserts, and (b) makes a
 * Credential variable 400 —
 * "Cannot use a Credential-typed global variable in 'input_value'" — so the
 * Credential secrecy test could not run at all. The Settings page is the
 * canonical CRUD surface: a single-render data table, no node binding, no 400,
 * and stable testids (`api-key-button-store`, `save-variable-btn`,
 * `delete-row-button`).
 *
 * Teardown is by API id (captured from the create POST), never a UI trash
 * click: a UI teardown that fails under load leaks the variable, and a leaked
 * Credential variable poisons later tests — the real driver of the recurring
 * #810 flake.
 */

const createdVariableIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdVariableIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdVariableIds.splice(0)) {
    await request
      .delete(`/api/v1/variables/${id}`, { headers: { Authorization: bearer } })
      .catch(() => {});
  }
});

// Open the Settings → Global Variables page. Wait for the always-present
// "Add New" button — the data table (`treegrid`) does NOT render on an empty
// variable list, so it is not a reliable readiness gate.
async function openGlobalVariablesSettings(page: Page): Promise<void> {
  await page.goto("/settings/global-variables");
  await expect(page.getByTestId("api-key-button-store")).toBeVisible({
    timeout: 30000,
  });
}

interface NewVariable {
  name: string;
  type: "generic" | "credential";
  value: string;
}

// Create a variable through the "Add New" dialog and block until the create
// round-trip lands (`POST /api/v1/variables/`) — deterministic under load,
// unlike a fixed wait. The created id is tracked for API teardown.
async function createVariable(page: Page, v: NewVariable): Promise<void> {
  await page.getByTestId("api-key-button-store").click(); // "Add New"
  // Select the type tab BEFORE filling, so the value lands on the right field.
  await page.getByTestId(`${v.type}-tab`).click();
  await page.getByPlaceholder("Enter a name for the variable...").fill(v.name);
  await page
    .getByPlaceholder("Enter a value for the variable...")
    .fill(v.value);

  const saved = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/variables/") &&
      resp.request().method() === "POST",
    { timeout: 30000 },
  );
  await page.getByTestId("save-variable-btn").click();
  const resp = await saved;
  await resp
    .json()
    .then((body: { id?: string }) => {
      if (body?.id) createdVariableIds.push(body.id);
    })
    .catch(() => {});
}

// The data table row for a given variable name.
function variableRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

// The variable name as rendered in the data table (single render on the
// Settings page — no node-binding duplicate).
function variableInTable(page: Page, name: string) {
  return page.getByRole("treegrid").getByText(name, { exact: true });
}

test(
  "create a Generic type global variable",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `test-generic-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "generic",
      value: "generic-value-123",
    });

    // The variable must appear in the data table after creation.
    await expect(variableInTable(page, varName)).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "delete a global variable removes it from the list",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `delete-me-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "generic",
      value: "to-be-deleted",
    });
    await expect(variableInTable(page, varName)).toBeVisible({
      timeout: 15000,
    });

    // Delete is a bulk action: select the row, then click "Delete selected
    // items" (which is disabled until a row is selected).
    await variableRow(page, varName).locator(".ag-selection-checkbox").click();
    const deleteButton = page.getByTestId("delete-row-button");
    await expect(deleteButton).toBeEnabled({ timeout: 5000 });
    await deleteButton.click();

    // The variable must no longer be in the table.
    await expect(variableInTable(page, varName)).toHaveCount(0, {
      timeout: 15000,
    });
  },
);

test.fixme(
  "Credential variable value is hidden from the variable list",
  // Quarantined at triage (#1296): recurrent flake 3x (2026-07-15, 2026-07-17,
  // 2026-08-05) — the variable the test just created never appears in the grid,
  // so the sanity assertion fails before the secret-leak assertion is reached.
  // Restore (`test` + `@stable`) in #1303.
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `credential-${Date.now()}`;
    // Distinctive sentinel — if this string surfaces anywhere as visible text
    // after save, the Credential value leaked into the DOM.
    const sentinelValue = `SECRET-SENTINEL-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "credential",
      value: sentinelValue,
    });

    // Sanity: the variable name IS in the table.
    await expect(variableInTable(page, varName)).toBeVisible({
      timeout: 15000,
    });

    // Critical: the Credential value must NOT appear as visible text anywhere
    // on the page — not standalone, and not embedded inside a toast, label, or
    // preview. `getByText` without `exact` does substring matching, so a leak
    // like `"Saved: SECRET-SENTINEL-..."` also fails. The table renders the
    // Credential value masked as `*****`; input `value` attributes don't count
    // as visible text — only rendered text does, which is the guarantee here.
    await expect(page.getByText(sentinelValue)).toHaveCount(0, {
      timeout: 5000,
    });
  },
);
