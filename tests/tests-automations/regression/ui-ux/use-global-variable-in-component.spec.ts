import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";

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
  await page.waitForSelector('[data-testid="openaiOpenAI"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("openaiOpenAI")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-openai").last().click();
    });

  // The OpenAI node renders expanded, so its primary `api_key` field is on the canvas.
  await expect(page.getByTestId(API_KEY_ANCHOR)).toBeVisible({
    timeout: 15000,
  });
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
  // Selects the Credential tab explicitly. Measured on 1.13.0.dev8 (#1788's
  // force-fail audit): removing this click does NOT produce a Generic variable —
  // opening "Add New Variable" from a `SecretStrInput`'s own dropdown already
  // creates a Credential, so the click is belt-and-braces, not the thing that
  // decides the type. The comment here used to claim the opposite.
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
  //
  // `.first()` is load-bearing, and its absence was a latent strict-mode defect
  // rather than a style choice: the two states are not exclusive. On
  // 1.13.0.dev8 creating the variable from this field auto-binds it AND leaves
  // the dropdown open listing it, so `boundValue.or(optionRow)` resolves to TWO
  // elements and `toBeVisible` fails with `strict mode violation` — measured
  // 2/2 red locally on a spec the T1 triage table recorded 3/3 green, because
  // CI happened to poll while only the option row had rendered. Waiting for
  // "whichever of the two" is what this line means; it must not also assert
  // that only one of them exists.
  await expect(boundValue.or(optionRow).first()).toBeVisible({
    timeout: 10000,
  });
  // Bind only when the field does NOT already show the variable: clicking the
  // option row of an already-bound variable is a second toggle on the same
  // value, which is how a passing bind would be undone.
  if ((await boundValue.count()) === 0 && (await optionRow.count()) > 0) {
    await optionRow.click();
  }
  await expect(boundValue).toBeVisible({ timeout: 10000 });
}

/**
 * Asserts the variable the test just created is actually a **Credential**.
 *
 * Added by #1788's force-fail audit, which is the only reason it exists: skipping
 * the `credential-tab` click — so a **Generic** variable is created instead — left
 * the test GREEN. The dropdown offers Generic variables to this field too, and the
 * binding assertion reads the variable NAME, which is identical either way, so the
 * word "Credential" in the test title was not verified by anything. A regression
 * that made the credential tab write the wrong type would have gone unnoticed.
 *
 * Read over the API rather than off the UI: the type is not rendered anywhere on the
 * canvas once the variable is bound.
 */
async function expectCredentialVariable(
  request: import("@playwright/test").APIRequestContext,
  varName: string,
): Promise<void> {
  const authToken = await getAuthToken(request);
  const listRes = await request.get("/api/v1/variables/", {
    headers: { Authorization: authToken },
  });
  expect(listRes.ok()).toBeTruthy();
  const variables = (await listRes.json()) as Array<{
    name: string;
    type?: string;
  }>;
  const match = variables.find((v) => v.name === varName);
  expect(match, `global variable ${varName} must exist`).toBeTruthy();
  expect(match?.type).toBe("Credential");
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
  const variables = (await listRes.json()) as Array<{
    id: string;
    name: string;
  }>;
  const match = variables.find((v) => v.name === varName);
  if (match) {
    await request.delete(`/api/v1/variables/${match.id}`, {
      headers: { Authorization: authToken },
    });
  }
}

// Both tests reach the canvas through `awaitBootstrapTest`, which creates `New Flow`
// and `Basic Prompting` whenever the default project is empty, and then open a blank
// flow of their own. None of those ids was ever seen by this file, so the `finally`
// blocks below — which delete the global VARIABLE, correctly — left the flows behind:
// measured 4 per run against a purged instance (#1788). `trackCreatedFlows` captures
// every `POST /api/v1/flows/` → 201 the page performs and deletes exactly those ids.
test.describe("Global variable bound to a component secret field", () => {
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
    flows.dispose();
  });

  test(
    "bind a Credential global variable to a component secret field",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
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

        await test.step("The variable created from the field is a Credential", async () => {
          await expectCredentialVariable(request, varName);
        });

        await test.step("Field shows the variable name and never leaks the secret value", async () => {
          // The field displays the variable NAME as its bound value.
          await expect(
            page
              .getByTestId(API_KEY_ANCHOR)
              .getByText(varName, { exact: true }),
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
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
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
            page
              .getByTestId(API_KEY_ANCHOR)
              .getByText(varName, { exact: true }),
          ).toBeVisible({ timeout: 15000 });
        });
      } finally {
        await deleteVariableByName(request, varName);
      }
    },
  );
});
