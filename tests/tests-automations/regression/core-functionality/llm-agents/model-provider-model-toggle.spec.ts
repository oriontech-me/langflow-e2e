import * as dotenv from "dotenv";
import path from "path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Resolve the provider to drive the test. The behavior under test (per-model
// enable/disable toggles in Settings → Model Providers) is provider-agnostic,
// so a single env-configured provider is enough. Priority: MODEL_TEST_PROVIDER
// (when its env keys are set) > first provider in providerConfigMap with env
// keys configured.
const envProvider = process.env.MODEL_TEST_PROVIDER as Provider | undefined;
const provider: Provider | undefined =
  envProvider && hasProviderEnvKeys(envProvider)
    ? envProvider
    : (Object.keys(providerConfigMap) as Provider[]).find(hasProviderEnvKeys);

const skipReason = provider
  ? undefined
  : `No provider has its env keys configured (need one of: ${Object.keys(
      providerConfigMap,
    )
      .map((p) => missingProviderEnvKeys(p as Provider).join("/"))
      .join(" | ")})`;

// The `provider-item-...` testid carries the provider's display name
// ("OpenAI", "Anthropic", …), which is the single source of truth in
// provider-config.ts.
const providerItemTestId = provider
  ? providerConfigMap[provider].providerTestId
  : "";

const ENABLED_MODELS_ENDPOINT = "/api/v1/models/enabled_models";

// SimpleAgentTemplatePage.load() does NO cleanup (post-#553 contract) and the
// canvas URL id is transient on 1.11 — track every flow the load actually
// creates (POST /api/v1/flows → 201) and delete those ids in afterEach (#605
// pattern; this file previously leaked 2 flows per run).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
  }
});

// Load the Simple Agent template with the configured provider. This configures
// the provider's API key globally and enables all of its models — the known
// baseline both tests start from. MODEL_NOT_AVAILABLE (a model present in
// models.json but absent from the picker) is turned into a skip.
async function loadAgentWithProvider(page: Page): Promise<void> {
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
  try {
    await new SimpleAgentTemplatePage(page).load({ provider });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// Navigate to Settings → Model Providers and expand the configured provider so
// its model toggles render. Clicking the provider item toggles its selection,
// so this assumes the panel was freshly navigated (nothing selected yet).
async function openProviderModelList(page: Page): Promise<void> {
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 10000 },
  );
  const providerItem = page.getByTestId(providerItemTestId);
  await providerItem.waitFor({ state: "visible", timeout: 10000 });
  await providerItem.click();
  await page
    .getByTestId("model-provider-selection")
    .waitFor({ state: "visible", timeout: 10000 });
  await page
    .getByTestId("llm-models-section")
    .waitFor({ state: "visible", timeout: 10000 });
}

// Filter the model list down to a single model via the search field so its
// toggle is always rendered and on-screen (long provider lists otherwise push
// rows below the scroll fold). Returns the toggle locator.
async function toggleForModel(page: Page, modelName: string): Promise<Locator> {
  const search = page.getByTestId("model-search-input");
  await search.fill(modelName);
  const toggle = page.getByTestId(`llm-toggle-${modelName}`);
  await toggle.waitFor({ state: "visible", timeout: 10000 });
  return toggle;
}

// Flip a toggle and wait for the optimistic UI change plus the debounced POST
// that persists it (useModelToggleQueue debounces the write by 1000ms).
async function setToggle(
  page: Page,
  toggle: Locator,
  enabled: boolean,
): Promise<void> {
  const current = (await toggle.getAttribute("aria-checked")) === "true";
  if (current === enabled) return;
  const save = page.waitForResponse(
    (resp) =>
      resp.url().includes(ENABLED_MODELS_ENDPOINT) &&
      resp.request().method() === "POST",
    { timeout: 15000 },
  );
  await toggle.click();
  // Optimistic update — the switch reflects the new state immediately.
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await save;
}

// Named template loads collide under parallelism — this file is serial and
// the folder is run with --workers=1 (agent-family convention).
test.describe.configure({ mode: "serial" });

test.describe("Model Provider Model Toggle", () => {
  test(
    "model toggle changes immediately and persists across reopen",
    {
      tag: ["@stable", "@regression", "@components", "@model-provider"],
    },
    async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");

      await test.step("configure provider and enable all its models", async () => {
        await loadAgentWithProvider(page);
      });

      let modelName = "";
      let toggle: Locator;

      await test.step("open Model Providers and pick an enabled model", async () => {
        await openProviderModelList(page);
        const firstToggle = page
          .locator('[data-testid^="llm-toggle-"]:visible')
          .first();
        await firstToggle.waitFor({ state: "visible", timeout: 10000 });
        const testId = await firstToggle.getAttribute("data-testid");
        modelName = (testId ?? "").replace("llm-toggle-", "");
        expect(modelName.length).toBeGreaterThan(0);
        toggle = await toggleForModel(page, modelName);
        await expect(toggle).toHaveAttribute("aria-checked", "true");
      });

      await test.step("disable the model — change is immediate and persisted", async () => {
        await setToggle(page, toggle, false);
      });

      await test.step("reopen Model Providers — disabled state persisted", async () => {
        await page.goto("/");
        await openProviderModelList(page);
        const reopened = await toggleForModel(page, modelName);
        await expect(reopened).toHaveAttribute("aria-checked", "false");

        // Restore the baseline so the model stays enabled for other specs.
        await setToggle(page, reopened, true);
        await expect(reopened).toHaveAttribute("aria-checked", "true");
      });
    },
  );

  test(
    "disabling a model removes it from a component model dropdown",
    {
      tag: ["@stable", "@regression", "@components", "@agents", "@model-provider"],
    },
    async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");

      const modelTrigger = page.getByTestId("model_model");
      const modelValue = page.getByTestId("value-dropdown-model_model");
      const optionLocator = '[data-testid$="-option"]';

      let flowUrl = "";
      let targetModel = "";
      let dropdownModels: string[] = [];
      let dropdownSelected = "";

      await test.step("load Agent with configured provider and capture model options", async () => {
        await loadAgentWithProvider(page);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        flowUrl = page.url();

        const selectedModel = (await modelValue.innerText()).trim();
        await modelTrigger.click();
        const options = page.locator(optionLocator);
        await options.first().waitFor({ state: "visible", timeout: 10000 });
        // Derive model names from the `${name}-option` testid rather than the
        // option's innerText — deprecated options also render a "Deprecated"
        // badge, so innerText would yield a malformed name. This mirrors how
        // Test 1 reads the model name from the toggle's testid.
        const names = (
          await options.evaluateAll((els) =>
            els.map(
              (el) =>
                el.getAttribute("data-testid")?.replace(/-option$/, "") ?? "",
            ),
          )
        ).filter((n) => n.length > 0);
        dropdownModels = names;
        dropdownSelected = selectedModel;
        await page.keyboard.press("Escape");
      });

      await test.step("disable the target model in Settings → Model Providers", async () => {
        await openProviderModelList(page);
        // The component dropdown mixes models from EVERY configured provider
        // (#597: with Google configured by sibling specs it listed
        // gemini-3.5-flash first while this test's provider was OpenAI, and
        // the toggle lookup below never resolves). Pick the target from the
        // intersection of the dropdown options and THIS provider's own model
        // list — the attached llm-toggle-* testids Settings just rendered —
        // and never the currently selected model (disabling the active
        // selection would entangle the test with selection-reset logic).
        await page
          .locator('[data-testid^="llm-toggle-"]')
          .first()
          .waitFor({ state: "attached", timeout: 10000 });
        const providerModels = new Set(
          (
            await page
              .locator('[data-testid^="llm-toggle-"]')
              .evaluateAll((els) =>
                els.map(
                  (el) =>
                    el.getAttribute("data-testid")?.replace(/^llm-toggle-/, "") ??
                    "",
                ),
              )
          ).filter((n) => n.length > 0),
        );
        targetModel =
          dropdownModels.find(
            (n) => providerModels.has(n) && n !== dropdownSelected,
          ) ?? "";
        test.skip(
          targetModel.length === 0,
          "No non-selected dropdown option belongs to the test's provider — cannot test removal.",
        );
        const toggle = await toggleForModel(page, targetModel);
        await setToggle(page, toggle, false);
      });

      await test.step("target model no longer appears in the component dropdown", async () => {
        await page.goto(flowUrl);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        await modelTrigger.click();
        await page
          .locator(optionLocator)
          .first()
          .waitFor({ state: "visible", timeout: 10000 });
        await expect(
          page.locator(optionLocator, {
            hasText: new RegExp(`^${escapeRegExp(targetModel)}$`),
          }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
      });

      await test.step("re-enabling the model brings it back to the dropdown", async () => {
        await openProviderModelList(page);
        const toggle = await toggleForModel(page, targetModel);
        await setToggle(page, toggle, true);

        await page.goto(flowUrl);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        await modelTrigger.click();
        await expect(
          page.locator(optionLocator, {
            hasText: new RegExp(`^${escapeRegExp(targetModel)}$`),
          }),
        ).toHaveCount(1, { timeout: 10000 });
        await page.keyboard.press("Escape");
      });
    },
  );
});

// Escape a model name for safe use inside an anchored RegExp (model ids can
// contain regex metacharacters such as "." in "gpt-4.1").
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
