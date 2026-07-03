import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Consumption side of global variables: binding a Credential-typed variable to a
// component's secret field (OpenAI `api_key`, a SecretStrInput) via the field's
// Globe dropdown, and confirming the binding persists across a full page reload.
// CRUD/secrecy-in-list guarantees live in `global-variables-crud.spec.ts`; this
// spec is strictly about wiring a variable into a component and its persistence.

const API_KEY_ANCHOR = "anchor-popover-anchor-input-api_key";
const API_KEY_INPUT = "popover-anchor-input-api_key";

/**
 * Blank flow + OpenAI component on the canvas with its `api_key` field visible.
 */
async function addOpenAiComponent(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("openai");
  await page.waitForSelector('[data-testid="openaiOpenAI"]', { timeout: 30000 });
  await page
    .getByTestId("openaiOpenAI")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-openai").last().click();
    });

  // The OpenAI node renders expanded, so its primary `api_key` field is on the canvas.
  await expect(page.getByTestId(API_KEY_ANCHOR)).toBeVisible({ timeout: 15000 });
}

/**
 * Opens the `api_key` field's global-variable dropdown, handling both render
 * states. Empty/editable: click the visible `icon-Globe`. Auto-bound (a matching
 * Credential variable already exists): the field shows a badge and the trigger
 * button's icon fails to render (zero-size but click-functional), so we assert it
 * attached and fire a geometry-independent `dispatchEvent("click")`. See the spec
 * doc's "Indirect mechanism justified" note.
 */
async function openApiKeyVariableDropdown(page: Page): Promise<void> {
  const globe = page
    .getByTestId(API_KEY_INPUT)
    .locator("xpath=following::*[@data-testid='icon-Globe'][1]");

  if ((await globe.count()) > 0) {
    await expect(globe).toBeVisible({ timeout: 10000 });
    await globe.click();
    return;
  }

  // Scoped structurally off the anchor testid; distinct from the badge's own
  // "remove" (X) icon, which unbinds instead of opening the dropdown.
  const boundTrigger = page
    .getByTestId(API_KEY_ANCHOR)
    .locator("xpath=/parent::div/following-sibling::*[1]//button");

  await expect(boundTrigger).toBeAttached({ timeout: 10000 });
  await boundTrigger.dispatchEvent("click");
}

/**
 * Creates a Credential global variable from the open `api_key` dropdown and binds
 * it to the field. Returns once the field shows the variable name as its value.
 */
async function createAndBindCredentialVariable(
  page: Page,
  varName: string,
  sentinelValue: string,
): Promise<void> {
  await openApiKeyVariableDropdown(page);

  // "Add New Variable" can render outside the viewport when the dropdown overflows,
  // so trigger it via a DOM click (mirrors global-variables-crud.spec.ts).
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("button, span")).find(
      (e) => e.textContent?.trim() === "Add New Variable",
    ) as HTMLElement | undefined;
    if (el) el.click();
    else throw new Error("Add New Variable button not found in DOM");
  });

  await page.getByPlaceholder("Enter a name for the variable...").fill(varName);
  // Switch to Credential BEFORE saving — otherwise a Generic variable is created.
  await page.getByTestId("credential-tab").click();
  await page
    .getByPlaceholder("Enter a value for the variable...")
    .fill(sentinelValue);
  await page.getByText("Save Variable", { exact: true }).click();

  const boundValue = page
    .getByTestId(API_KEY_ANCHOR)
    .getByText(varName, { exact: true });
  const optionRow = page.getByTestId(`option-${varName}`);

  // After creation the variable is either left selectable in the still-open
  // dropdown or auto-bound to the referencing field. Wait for whichever occurs,
  // then bind explicitly only when it isn't bound yet.
  await expect(boundValue.or(optionRow)).toBeVisible({ timeout: 10000 });
  if ((await optionRow.count()) > 0) {
    await optionRow.click();
  }
  await expect(boundValue).toBeVisible({ timeout: 10000 });
}

/**
 * Best-effort deletion of a global variable by name via the REST API.
 */
async function deleteVariableByName(
  request: import("@playwright/test").APIRequestContext,
  varName: string,
): Promise<void> {
  const authToken = await getAuthToken(request);
  const listRes = await request.get("/api/v1/variables/", {
    headers: { Authorization: authToken },
  });
  if (!listRes.ok()) return;
  const variables = (await listRes.json()) as Array<{ id: string; name: string }>;
  const match = variables.find((v) => v.name === varName);
  if (match) {
    await request.delete(`/api/v1/variables/${match.id}`, {
      headers: { Authorization: authToken },
    });
  }
}

test(
  "bind a Credential global variable to a component secret field",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page, request }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const varName = `gv-api-key-${stamp}`;
    const sentinelValue = `SECRET-SENTINEL-${stamp}`;

    try {
      await test.step("Add an OpenAI component with an api_key secret field", async () => {
        await addOpenAiComponent(page);
      });

      await test.step("Create a Credential variable and bind it to the api_key field", async () => {
        await createAndBindCredentialVariable(page, varName, sentinelValue);
      });

      await test.step("Field shows the variable name and never leaks the secret value", async () => {
        // The field displays the variable NAME as its bound value.
        await expect(
          page.getByTestId(API_KEY_ANCHOR).getByText(varName, { exact: true }),
        ).toBeVisible({ timeout: 10000 });

        // The secret value is never rendered as visible text anywhere on the page.
        // Substring match (no `exact`) also catches a leak embedded in a longer string.
        await expect(page.getByText(sentinelValue)).toHaveCount(0, {
          timeout: 5000,
        });
      });
    } finally {
      await deleteVariableByName(request, varName);
    }
  },
);

test(
  "component secret-field global-variable binding persists across reload",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page, request }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const varName = `gv-api-key-${stamp}`;
    const sentinelValue = `SECRET-SENTINEL-${stamp}`;

    try {
      await test.step("Add an OpenAI component and bind a Credential variable to api_key", async () => {
        await addOpenAiComponent(page);
        await createAndBindCredentialVariable(page, varName, sentinelValue);
      });

      await test.step("Reload the page and confirm the binding survived", async () => {
        // Let the flow autosave the binding, then reload from scratch.
        await page.waitForTimeout(2000);
        await page.reload();

        // The rehydrated node still shows the same variable as its bound value —
        // auto-bind never overrides an explicit binding saved in the flow.
        await expect(page.getByTestId(API_KEY_ANCHOR)).toBeVisible({
          timeout: 30000,
        });
        await expect(
          page.getByTestId(API_KEY_ANCHOR).getByText(varName, { exact: true }),
        ).toBeVisible({ timeout: 15000 });
      });
    } finally {
      await deleteVariableByName(request, varName);
    }
  },
);
