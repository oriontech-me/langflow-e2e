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

    await test.step("every env-keyed provider is ACTIVE (transient billing/quota outages warn, don't fail)", async () => {
      // The #570 guarantee: a provider whose key is configured but that ends
      // "inactive" silently test.skip()s every spec parametrized on it (16
      // OpenAI-variant agent tests on 2026-07-08) — and a skip never trips
      // the daily-failure gate. With the candidate fallback in collectAll,
      // inactive-with-key means ALL probed candidates failed: a real
      // key/account/provider problem that must fail this spec (and the CI
      // "Collect models" step) loudly instead of eroding coverage quietly.
      //
      // EXCEPTION (#952 follow-up / Approach B): a *transient billing/quota*
      // outage (Anthropic "credit balance is too low", OpenAI
      // "insufficient_quota", Google RESOURCE_EXHAUSTED, 402/429) is an ops
      // state, not a code/config defect. Failing on it reddens every LLM PR —
      // even ones that don't depend on the drained provider — until someone
      // tops up the account (the recurring #915/#910/#911 class). So a
      // billing/quota inactive is downgraded to a loud WARNING while at least
      // one provider is still active; genuine key rot (401 invalid key, 403 no
      // model access, etc.) still fails LOUD, and a total wipeout (zero active
      // providers) still fails.
      //
      // `spend(ing) cap` is listed EXPLICITLY (#1011). Google's spend-cap error
      // — "Your project has exceeded its monthly spending cap. Please go to AI
      // Studio at ... to manage your project spend cap. Learn more at
      // https://ai.google.dev/gemini-api/docs/billing#project-spend-caps." —
      // matched this pattern on 2026-07-28 only via the word `billing` inside a
      // DOCUMENTATION URL. That is an accident: reword the message or drop the
      // link and an exhausted spend cap silently becomes a hard key/config
      // failure, which is exactly the false alarm Approach B exists to prevent.
      const BILLING_OR_QUOTA =
        /credit balance is too low|insufficient[_ ]?quota|exceeded your current quota|\bquota\b|resource[_ ]?exhausted|billing|spend(?:ing)?[ _-]?cap|payment required|\b402\b|\b429\b/i;

      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      const activeCount = providers.filter((p) => p.status === "active").length;

      const hardFailures: ProviderRecord[] = [];
      for (const p of providers) {
        const envKeys = providerConfigMap[p.provider as Provider]?.envKeys ?? [];
        const hasEnvKey = envKeys.some((k: string) => !!process.env[k]);
        if (!hasEnvKey || p.status === "active") continue;
        if (BILLING_OR_QUOTA.test(p.error ?? "")) {
          console.warn(
            `⚠️  provider "${p.provider}" inactive for a TRANSIENT billing/quota reason — ` +
              `its parametrized specs will skip this run (gate not failed): ${p.error}`,
          );
        } else {
          hardFailures.push(p);
        }
      }

      // Genuine key/config failures still erode coverage silently → fail loud.
      expect(
        hardFailures.map((p) => p.provider),
        `env-keyed provider(s) inactive for a NON-billing reason (real key/account/config problem): ` +
          hardFailures.map((p) => `${p.provider} — ${p.error}`).join(" | "),
      ).toEqual([]);

      // A total wipeout (every configured key failed, even if all "just" billing)
      // means the collection produced nothing usable — still a hard failure.
      expect(
        activeCount,
        "no provider probed active — every configured key failed; collection is unusable",
      ).toBeGreaterThan(0);
    });
  },
);
