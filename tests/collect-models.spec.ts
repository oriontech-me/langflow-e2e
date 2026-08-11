import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { expect, test } from "./fixtures/fixtures";
import {
  collectAll,
  isCollectorStallReason,
  resolveRequiredProviders,
} from "./helpers/provider-setup/collect-models";
import type { ProviderRecord } from "./helpers/provider-setup/collect-models";
import { keyedProviderNames, providerConfigMap, type Provider } from "./helpers/provider-setup";
import { isBuildAxisReason } from "./helpers/provider-setup/probe-component-buildable";

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
    // This pre-flight owns its own clock (#1385).
    //
    // `playwright.config.ts` sets 5 minutes, and that number is the default for a
    // PRODUCT spec — nothing about it was ever derived from what this sweep
    // costs. #1370 nonetheless sized the sweep's shared post-Save budget from it
    // (210 s = 300 s minus a ~90 s reserve), which made the suite-wide default
    // the binding constraint on how many providers get configured: against an
    // anthropic credential write measured at 105–180 s+ on CI, 30 s was left for
    // google, google's Save-idle wait spent it before a Save was ever clicked,
    // and 5 of the run's 6 skips on 2026-08-10 followed from that on 3 of 4
    // shards.
    //
    // 12 minutes is the sweep's worst measured shape (~450 s of post-Save waits,
    // see SWEEP_SAVE_BUDGET_MS) plus the ~90 s of build axis, navigation, toggle
    // sweeps, key probes and file writes, with room over. It costs nothing on a
    // healthy run — the whole sweep measures ~55 s on CI and ~24 s locally — and
    // it is still far below the lanes' own `timeout-minutes` (90 on the daily),
    // so a wedged pre-flight is bounded here rather than by the job.
    test.setTimeout(12 * 60 * 1000);

    await page.goto("/");
    await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

    await collectAll(page);

    await test.step("providers.json has exactly one valid record per known KEYED provider", async () => {
      expect(fs.existsSync(PROVIDERS_PATH), `${PROVIDERS_PATH} was written`).toBe(true);
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      // Keyed providers only (#1187). This sweep is the KEY axis: it saves an API key
      // per provider through the Settings UI and probes it with a real call, so a
      // keyless provider (Ollama, configured by a base URL) is out of scope by
      // design, not missing. Comparing against the whole map would fail this
      // pre-flight on every lane the moment a keyless entry existed — and this spec
      // gates the daily, the PR run and every manual dispatch.
      const known = [...keyedProviderNames].sort();
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

    await test.step("this Langflow build can instantiate every provider's component", async () => {
      // The BUILD axis (#900), asserted independently of the key axis below.
      //
      // Why this is not redundant with the env-keyed check that follows: that one
      // skips every provider whose env key is unset. A component that cannot be
      // built is a broken IMAGE, and that verdict does not depend on whether
      // anyone configured a key — so without this step, running without (say)
      // ANTHROPIC_API_KEY would let an unbuildable Anthropic component pass in
      // silence. That is the same silent-skip class the whole issue removes.
      //
      // It is also never downgraded: a packaging gap is a broken environment, not
      // a transient billing/quota outage, so it must fail loud every time.
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      const unbuildable = providers.filter((p) => isBuildAxisReason(p.error));
      expect(
        unbuildable.map((p) => p.provider),
        `provider component(s) this Langflow build cannot instantiate — the image is ` +
          `missing a distribution or a langchain-* package, and every spec parametrized ` +
          `on them would fail downstream as a generic node-build timeout: ` +
          unbuildable.map((p) => `${p.provider} — ${p.error}`).join(" | "),
      ).toEqual([]);
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
        // A provider the COLLECTOR never configured is not a key/account/config
        // verdict at all — its key was never probed (#1370). It gets its own
        // step below, which is what decides whether it is fatal on THIS lane.
        if (isCollectorStallReason(p.error)) continue;
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

    await test.step("a provider the COLLECTOR never configured fails the lanes that need it", async () => {
      // Separate from the step above because it is a different verdict about a
      // different layer (#1370). A stalled save hands
      // `validateProviderWithFallback` zero candidates, so the provider is
      // recorded `inactive` having never been probed — and under the old
      // classification that landed in `hardFailures` and failed the spec as a
      // "real key/account/config problem", for a provider whose build axis had
      // reported OK and whose key was never touched.
      //
      // Why it is scoped rather than always fatal: `pr-validation.yml` pins its
      // own run to ONE provider (`select-pr-model-target.mjs --provider openai`,
      // #1169), so a stalled anthropic there changes no spec that lane will
      // execute — and yet it exited this pre-flight non-zero, which on that lane
      // is a hard gate, so the PR got no E2E coverage of its own diff at all.
      // Unset (the daily, manual.yml, every local run) still requires every
      // env-keyed provider, so #570's guarantee is unchanged where it bites.
      const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8")) as ProviderRecord[];
      const keyed = providers
        .filter((p) => {
          const envKeys = providerConfigMap[p.provider as Provider]?.envKeys ?? [];
          return envKeys.some((k: string) => !!process.env[k]);
        })
        .map((p) => p.provider);

      const { required, unrecognised } = resolveRequiredProviders(
        process.env.COLLECT_REQUIRED_PROVIDERS,
        keyed,
      );
      // A typo in a workflow must not quietly require nothing — that is how a
      // gate disappears for good (#1012).
      expect(
        unrecognised,
        `COLLECT_REQUIRED_PROVIDERS names provider(s) this run has no key for — either a typo or an ` +
          `unset secret. Providers with a key this run: ${keyed.join(", ") || "<none>"}`,
      ).toEqual([]);

      const stalled = providers.filter((p) => isCollectorStallReason(p.error));
      // Reported whether or not it is fatal here: an unconfigured provider still
      // makes every spec parametrized on it skip, wherever this models.json is
      // consumed (#570/#1012).
      for (const p of stalled) {
        console.warn(
          `⚠️  provider "${p.provider}" was never configured by the collector — its parametrized specs ` +
            `will SKIP wherever this models.json is used: ${p.error}`,
        );
      }

      const fatal = stalled.filter((p) => required.includes(p.provider));
      expect(
        fatal.map((p) => p.provider),
        `provider(s) this lane cannot run without were never configured by the collector — this is NOT a ` +
          `key or account problem, the key was never probed: ` +
          fatal.map((p) => `${p.provider} — ${p.error}`).join(" | "),
      ).toEqual([]);
    });
  },
);
