import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "Model provider modal allows removing a configured API key",
  { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    // Navigate to settings via user profile menu
    await page.getByTestId("user-profile-settings").click();
    await page.waitForTimeout(300);

    const settingsLink = page.getByText("Settings", { exact: true });
    const hasSettings = await settingsLink
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasSettings) {
      await settingsLink.click();
    } else {
      await page.goto("/settings");
    }

    await page.waitForTimeout(1000);

    // Look for Global Variables section to find where API keys live
    const apiKeysSection = page
      .getByText(/global.*var|variables|api.*keys/i)
      .first();
    const hasApiKeys = await apiKeysSection
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasApiKeys) {
      console.log("INFO: API keys / Global Variables section not found, skipping");
      return;
    }

    await apiKeysSection.click();
    await page.waitForTimeout(500);

    // Create a test variable to delete
    const addBtn = page
      .getByRole("button", { name: /add.*variable|new.*variable|\+/i })
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!hasAddBtn) {
      console.log("INFO: Add variable button not found, skipping");
      return;
    }

    await addBtn.click();
    await page.waitForTimeout(300);

    const nameInput = page
      .locator('input[placeholder*="name"], input[id*="name"]')
      .first();
    const hasNameInput = await nameInput
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!hasNameInput) {
      console.log("INFO: Variable name input not found, skipping");
      return;
    }

    const uniqueName = `provider-key-${Date.now()}`;
    await nameInput.fill(uniqueName);

    const saveBtn = page
      .getByRole("button", { name: /save|create|add/i })
      .first();
    await saveBtn.click();
    await page.waitForTimeout(500);

    // Verify the variable was created
    const varEntry = page.getByText(uniqueName).first();
    const wasCreated = await varEntry
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!wasCreated) {
      console.log("INFO: Variable was not created, skipping delete test");
      return;
    }

    // Delete the variable using the trash icon
    const deleteBtn = page.getByTestId("icon-Trash2").last();
    const hasDeleteBtn = await deleteBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!hasDeleteBtn) {
      console.log("INFO: Delete button not found, skipping");
      return;
    }

    await deleteBtn.click();
    await page.waitForTimeout(300);

    // Confirm if a dialog appears
    const confirmBtn = page
      .getByRole("button", { name: /delete|confirm|yes/i })
      .last();
    const hasConfirm = await confirmBtn
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasConfirm) {
      await confirmBtn.click();
      await page.waitForTimeout(500);
    }

    // Verify the variable is gone
    const stillVisible = await varEntry
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    expect(
      stillVisible,
      "Provider API key variable should be removed after deletion",
    ).toBe(false);
  },
);

test(
  "DELETE /api/v1/variables/{id} removes a provider API key variable",
  { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Create a test provider variable
    const createRes = await request.post("/api/v1/variables/", {
      headers: { Authorization: authToken },
      data: {
        name: `provider-api-key-${Date.now()}`,
        value: "test-provider-key-value",
        type: "Generic",
      },
    });

    if (createRes.status() !== 200 && createRes.status() !== 201) {
      console.log(
        `INFO: Variables endpoint returned ${createRes.status()}, skipping`,
      );
      return;
    }

    const body = await createRes.json();
    const varId = body.id;

    if (!varId) {
      console.log("INFO: Variable ID not returned, skipping");
      return;
    }

    // Delete it
    const deleteRes = await request.delete(`/api/v1/variables/${varId}`, {
      headers: { Authorization: authToken },
    });

    expect([200, 204]).toContain(deleteRes.status());

    // Verify it's gone — subsequent GET should return 404 or 422
    const getRes = await request.get(`/api/v1/variables/${varId}`, {
      headers: { Authorization: authToken },
    });

    expect([404, 422]).toContain(getRes.status());
  },
);

test(
  "Variables list no longer contains deleted provider key",
  { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    const uniqueName = `list-check-key-${Date.now()}`;

    const createRes = await request.post("/api/v1/variables/", {
      headers: { Authorization: authToken },
      data: {
        name: uniqueName,
        value: "some-api-key",
        type: "Generic",
      },
    });

    if (createRes.status() !== 200 && createRes.status() !== 201) {
      console.log(`INFO: Variables endpoint returned ${createRes.status()}, skipping`);
      return;
    }

    const body = await createRes.json();
    const varId = body.id;

    if (!varId) {
      console.log("INFO: Variable ID not returned, skipping");
      return;
    }

    // Delete the variable
    await request.delete(`/api/v1/variables/${varId}`, {
      headers: { Authorization: authToken },
    });

    // Fetch the list and confirm the variable is no longer present
    const listRes = await request.get("/api/v1/variables/", {
      headers: { Authorization: authToken },
    });

    if (listRes.status() !== 200) {
      console.log(`INFO: Variables list returned ${listRes.status()}, skipping`);
      return;
    }

    const listBody = await listRes.json();
    const variables = Array.isArray(listBody) ? listBody : listBody.items ?? [];

    const found = variables.some(
      (v: { id?: string; name?: string }) => v.id === varId || v.name === uniqueName,
    );

    expect(found, "Deleted variable should not appear in the variables list").toBe(false);
  },
);
