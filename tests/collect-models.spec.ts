import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { expect, test } from "./fixtures/fixtures";
import { collectAll } from "./helpers/provider-setup/collect-models";
import type { ProviderRecord } from "./helpers/provider-setup/collect-models";
import { providerConfigMap, type Provider } from "./helpers/provider-setup";

/**
 * Utility spec that populates the provider data files every LLM spec depends
 * on (QA-CHECKLIST §7.1: key validation via real call, model collection via
 * the Settings UI, Save/Replace configuration) — promoted to @stable by #501.
 *
 * The collectAll helper stays TOLERANT by contract (a provider whose key is
 * missing or fails its probe is recorded "inactive", never thrown). The
 * asserts below are the force-failability hardening the promotion required:
 * before them, a fully broken Model Providers UI still produced a green run
 * with empty JSONs (the #505 class of blind spot).
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

const DATA_DIR = path.resolve(__dirname, "helpers/provider-setup/data");
const PROVIDERS_PATH = path.join(DATA_DIR, "providers.json");
const MODELS_PATH = path.join(DATA_DIR, "models.json");

interface ModelRecord {
  provider: string;
  model: string;
}

test(
  "collect providers status and models from UI",
  { tag: ["@stable", "@model-provider", "@settings"] },
  async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

    await collectAll(page);

    await test.step("providers.json has exactly one valid record per known provider", async () => {
      expect(fs.existsSync(PROVIDERS_PATH), `${PROVIDERS_PATH} was written`).toBe(true);
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      const known = Object.keys(providerConfigMap).sort();
      expect(providers.map((p) => p.provider).sort()).toEqual(known);
      for (const p of providers) {
        expect(["active", "inactive"], `status of ${p.provider}`).toContain(p.status);
        expect(p.checkedAt, `checkedAt of ${p.provider}`).toBeTruthy();
      }
    });

    await test.step("every ACTIVE provider contributed at least one model", async () => {
      expect(fs.existsSync(MODELS_PATH), `${MODELS_PATH} was written`).toBe(true);
      const models = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8")) as ModelRecord[];
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      for (const p of providers.filter((r) => r.status === "active")) {
        // An active key with an empty model collection means the Settings UI
        // collection silently broke — the exact failure the old "never
        // throws" contract hid.
        expect(
          models.filter((m) => m.provider === p.provider).length,
          `models collected for active provider "${p.provider}"`,
        ).toBeGreaterThan(0);
      }
    });

    await test.step("an env-keyed provider that probed inactive carries the probe error", async () => {
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      for (const p of providers.filter((r) => r.status === "inactive")) {
        const envKeys = providerConfigMap[p.provider as Provider]?.envKeys ?? [];
        const hasEnvKey = envKeys.some((k: string) => !!process.env[k]);
        if (hasEnvKey) {
          // Legitimate inactive (e.g. an account without access to the probe
          // model) — but the REASON must be recorded, never silently dropped.
          expect(p.error, `probe error recorded for env-keyed inactive provider "${p.provider}"`).toBeTruthy();
        }
      }
    });
  },
);
