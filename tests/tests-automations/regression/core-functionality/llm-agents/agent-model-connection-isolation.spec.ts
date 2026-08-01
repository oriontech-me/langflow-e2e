import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  keyedProviderNames,
  missingProviderEnvKeys,
  type Provider,
} from "../../../../helpers/provider-setup";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

interface ModelRecord {
  provider: string;
  model: string;
}

// Resolve a single { provider, model } to drive the test. The behavior under
// test (connection-mode isolation) is provider-agnostic, so one configured
// provider is enough — there is no value in looping every model. Priority:
// MODEL_TEST_ID > first model of MODEL_TEST_PROVIDER in models.json >
// first model of the first env-configured provider in models.json. The model
// is taken from models.json (populated by collect-models) so the spec follows
// the same source of truth as the rest of the folder, rather than relying on
// setup-openai's hardcoded default. MODEL_NOT_AVAILABLE is handled at load.
function resolveTarget(): LoadSimpleAgentOptions | undefined {
  let models: ModelRecord[] = [];
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (fs.existsSync(jsonPath)) {
    models = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
  }

  if (process.env.MODEL_TEST_ID) {
    const record = models.find((m) => m.model === process.env.MODEL_TEST_ID);
    const provider = (record?.provider ??
      process.env.MODEL_TEST_PROVIDER) as Provider | undefined;
    return { provider, model: process.env.MODEL_TEST_ID };
  }

  const envProvider = process.env.MODEL_TEST_PROVIDER as Provider | undefined;
  const provider =
    envProvider && hasProviderEnvKeys(envProvider)
      ? envProvider
      // Keyed providers only (#1187): `hasProviderEnvKeys` is true for Ollama as
      // soon as OLLAMA_BASE_URL is exported, and this spec resolves its model from
      // models.json — which a keyless provider is never in. Scoping keeps the
      // selection identical to what it was before a keyless entry existed.
      : keyedProviderNames.find(hasProviderEnvKeys);
  if (!provider) return undefined;

  const model = models.find((m) => m.provider === provider)?.model;
  return { provider, model };
}

const options = resolveTarget();
const provider = options?.provider;

// Build an accurate skip reason. Each case gets its own message so a skip is
// never mistaken for a different failure:
//   1. provider resolved but its env keys are missing — without this it would
//      hard-fail in SimpleAgentTemplatePage.load() ("Missing env vars for
//      provider"); this happens when MODEL_TEST_ID maps to a provider that has
//      no key configured, since resolveTarget() does not gate that branch on
//      hasProviderEnvKeys.
//   2. a MODEL_TEST_ID that maps to no provider (absent from models.json and
//      MODEL_TEST_PROVIDER unset) — more confusing than simply having no keys.
//   3. no provider has its env keys configured at all.
const skipReason = provider
  ? hasProviderEnvKeys(provider)
    ? undefined
    : `Provider "${provider}" is missing env vars: ${missingProviderEnvKeys(provider).join(", ")}`
  : process.env.MODEL_TEST_ID
    ? `MODEL_TEST_ID="${process.env.MODEL_TEST_ID}" could not be mapped to a provider — ` +
      `it is absent from models.json and MODEL_TEST_PROVIDER is unset.`
    : `No provider has its env keys configured (need one of: ${keyedProviderNames
        .map((p) => missingProviderEnvKeys(p).join("/"))
        .join(" | ")})`;

async function loadAgent(page: Page): Promise<void> {
  try {
    // `options` is guaranteed defined here — the test skips earlier when no
    // provider resolves. The `?? {}` only satisfies the type checker.
    await new SimpleAgentTemplatePage(page).load(options ?? {});
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// Serial mode only serializes the blocks within this file; isolation from
// sibling agent specs that also wipe flows relies on running with --workers=1
// (required by this folder's CLAUDE.md).
test.describe.configure({ mode: "serial" });

test.describe("Agent Model Connection Isolation", () => {
  test(
    "selecting 'Connect other models' clears the previously selected model",
    { tag: ["@stable", "@regression", "@components", "@agents", "@model-provider"] },
    async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");

      const modelTrigger = page.getByTestId("model_model");
      const modelValue = page.getByTestId("value-dropdown-model_model");

      await test.step("load Simple Agent with a configured provider and model", async () => {
        await loadAgent(page);
        // The provider setup helper selects a concrete model, so the picker
        // trigger must be present with a real model name as its value.
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
      });

      let initialModel = "";

      await test.step("capture the selected model as the precondition", async () => {
        initialModel = (await modelValue.innerText()).trim();
        expect(
          initialModel.length,
          "Agent should have a model selected before the test acts",
        ).toBeGreaterThan(0);
        expect(initialModel).not.toBe("Select a model");
      });

      await test.step("choose 'Connect other models' from the model picker", async () => {
        await modelTrigger.click();
        const connectOption = page.getByTestId("connect-other-models");
        const optionVisible = await connectOption
          .waitFor({ state: "visible", timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        test.skip(
          !optionVisible,
          "'Connect other models' option is not available — no compatible external LanguageModel type registered",
        );
        await connectOption.click();
      });

      await test.step("the previous model is dropped for connection mode (isolation)", async () => {
        // useModelConnectionLogic resets the model field value to [] and wipes
        // any provider-specific credential fields. The trigger then reflects
        // connection mode by displaying the "Connect other models" label
        // instead of the previously selected concrete model (`initialModel`) —
        // so the prior provider selection cannot leak into a backend run.
        await expect(modelValue).toHaveText("Connect other models", {
          timeout: 10000,
        });
      });
    },
  );
});
