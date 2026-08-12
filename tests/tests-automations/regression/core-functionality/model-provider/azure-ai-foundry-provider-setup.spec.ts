import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { createFlowFromStarter } from "../../../../helpers/flows/create-flow-from-starter";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";

/**
 * Azure AI Foundry in the unified provider setup (QA-CHECKLIST §7.8, Langflow
 * 1.11.0 — upstream #13912 / #14023). Spec doc:
 * docs/core-functionality/model-provider/azure-ai-foundry-provider-setup.md
 *
 * Foundry is the first provider on the Settings → Model Providers surface whose
 * model identities are OPERATOR-DEFINED: the seed catalog (gpt-4o, gpt-4o-mini,
 * gpt-4.1, o3-mini, Mistral-Large-3) is a suggestion list, and inference
 * addresses the PORTAL DEPLOYMENT NAME the operator typed. It is also the first
 * one configured by TWO variables (api key + endpoint).
 *
 * Tests 1-4 hold that surface with no Azure account at all — the deployment-name
 * mechanism is credential-independent by design (the backend validator returns
 * early when the provider's variables are absent, api/v1/models.py ::
 * update_enabled_models), which is what keeps §7.8 covered on every lane.
 * Tests 5-6 exercise the operator's real path and probe-gate themselves out
 * with an explicit reason when the endpoint/key/deployment are not configured.
 *
 * False-positive guards that shape the asserts (all measured on 1.12.0.dev14):
 * - the Foundry hint and its "Search or add a deployment name…" placeholder are
 *   asserted for Foundry AND asserted ABSENT for OpenRouter, so a page-wide
 *   regression cannot pass;
 * - `POST /api/v1/models/validate-provider` answers HTTP **200** with
 *   `{"valid": false, "error": …}` for a credential it rejected, so every
 *   validation assert reads the BODY (same trap as ollama-provider.spec.ts' M1);
 * - test 2 proves `add-custom-*-deployment-button` is ABSENT while unconfigured,
 *   so test 5's "the control appeared" is a real state change;
 * - test 4 enables a name present in NO catalog, so only the free-text
 *   mechanism can satisfy it.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const PROVIDER_NAME = "Azure AI Foundry";
const PROVIDER_ITEM = `provider-item-${PROVIDER_NAME}`;
const KEY_VAR = "AZURE_AI_FOUNDRY_API_KEY";
const ENDPOINT_VAR = "AZURE_AI_FOUNDRY_ENDPOINT";
const KEY_INPUT = `provider-variable-input-${KEY_VAR}`;
const ENDPOINT_INPUT = `provider-variable-input-${ENDPOINT_VAR}`;

// Seed catalog shipped by lfx/base/models/azure_ai_foundry_constants.py.
// Asserted as a FLOOR (>= 3 present), never exactly: a catalog addition is not
// a regression (#993's count rule).
const SEED_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "Mistral-Large-3"];
const SEED_FLOOR = 3;

// FIXED, not per-run: disabling a model does not erase its identity, it moves it
// into the internal `__disabled_models__` variable, which GET /api/v1/variables/
// filters out (names wrapped in `__`), so there is no id to DELETE. A fixed name
// bounds that residue to ONE inert entry naming a deployment that does not
// exist, instead of one per run.
const E2E_DEPLOYMENT = "e2e-azure-foundry-deployment";

const FOUNDRY_KEY = process.env.AZURE_AI_FOUNDRY_API_KEY ?? "";
const FOUNDRY_ENDPOINT = (process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? "").replace(/\/+$/, "");
const FOUNDRY_DEPLOYMENT = process.env.AZURE_AI_FOUNDRY_TEST_DEPLOYMENT ?? "";

interface FoundryProbe {
  usable: boolean;
  reason: string;
}

/**
 * Probes the real Foundry resource from the TEST host, before opening a browser,
 * so an unusable account is an explicit skip and never a mid-test mystery.
 *
 * Note what it can NOT check: `<endpoint>/models` is the resource's CATALOG, not
 * its deployment list (`request_azure_ai_foundry_model_entries` /
 * "Foundry /models is a catalog, not deployments" in lfx/base/models/model_utils.py),
 * so the configured deployment's existence cannot be pre-verified — the
 * inference in test 6 is what proves it.
 */
async function probeFoundry(request: APIRequestContext): Promise<FoundryProbe> {
  const missing = [
    FOUNDRY_KEY ? "" : "AZURE_AI_FOUNDRY_API_KEY",
    FOUNDRY_ENDPOINT ? "" : "AZURE_AI_FOUNDRY_ENDPOINT",
    FOUNDRY_DEPLOYMENT ? "" : "AZURE_AI_FOUNDRY_TEST_DEPLOYMENT",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { usable: false, reason: `not set in the environment: ${missing.join(", ")}` };
  }
  try {
    const res = await request.get(`${FOUNDRY_ENDPOINT}/models`, {
      headers: { "api-key": FOUNDRY_KEY },
      timeout: 15000,
    });
    if (res.status() !== 200) {
      return {
        usable: false,
        reason: `GET ${FOUNDRY_ENDPOINT}/models answered ${res.status()}`,
      };
    }
    const payload = await res.json().catch(() => null);
    if (!payload || !Array.isArray((payload as { data?: unknown }).data)) {
      return {
        usable: false,
        reason: `unexpected /models payload (no "data" list) from ${FOUNDRY_ENDPOINT}`,
      };
    }
    return { usable: true, reason: "" };
  } catch (e) {
    return { usable: false, reason: `Foundry endpoint unreachable: ${(e as Error).message}` };
  }
}

async function listVariables(
  request: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  const bearer = await getAuthToken(request);
  const res = await request.get("/api/v1/variables/", {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Array<{ id: string; name: string }>;
  return body;
}

async function foundryVariables(
  request: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  return (await listVariables(request)).filter((v) => v.name === KEY_VAR || v.name === ENDPOINT_VAR);
}

/**
 * Deletes the Foundry credential pair, tolerating a write that is still in
 * flight.
 *
 * A single list-then-delete pass is not enough: the UI's Save issues two
 * separate variables writes, so a cleanup that ran between them left the second
 * one behind — measured while authoring, and the leftover then made the NEXT
 * run's unconfigured-state tests skip instead of run (a silent coverage loss,
 * which is the worse half of the failure). Bounded, and the caller still asserts
 * the end state.
 */
async function purgeFoundryCredentials(request: APIRequestContext): Promise<void> {
  const bearer = await getAuthToken(request);
  for (let pass = 0; pass < 3; pass++) {
    const stored = await foundryVariables(request);
    if (stored.length === 0 && pass > 0) return;
    for (const variable of stored) {
      await request
        .delete(`/api/v1/variables/${variable.id}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    }
  }
}

interface EnabledModelsWrite {
  enabled_models: string[];
  disabled_models: string[];
  /** Present only on a rejection — `Validation failed for <provider>: …`. */
  detail?: string;
}

/**
 * Model-level enablement (POST /api/v1/models/enabled_models). Returns the
 * write's own response body, whose `enabled_models` carries the TYPED identity
 * `<provider>::<type>::<name>` — the assert surface for the deployment-name
 * contract.
 */
async function setDeploymentEnabled(
  request: APIRequestContext,
  deployment: string,
  enabled: boolean,
): Promise<{ status: number; body: EnabledModelsWrite }> {
  const bearer = await getAuthToken(request);
  const res = await request.post("/api/v1/models/enabled_models", {
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    data: [{ provider: PROVIDER_NAME, model_id: deployment, enabled, model_type: "llm" }],
  });
  const body = (await res.json().catch(() => ({
    enabled_models: [],
    disabled_models: [],
  }))) as EnabledModelsWrite;
  // A bare "expected 200, received 400" is an unattributed red: the backend puts
  // the reason in `detail` (`Validation failed for Azure AI Foundry: …`, which is
  // how a transient Azure hiccup on the live /models probe surfaces here).
  if (res.status() !== 200) {
    console.log(
      `POST /api/v1/models/enabled_models -> ${res.status()} ${JSON.stringify(body.detail ?? body)}`,
    );
  }
  return { status: res.status(), body };
}

/**
 * The Foundry model identities `GET /api/v1/models/enabled_models` KNOWS about,
 * as names — the seed catalog plus every free-text deployment the user enabled.
 *
 * Reading the map's KEYS, not its booleans, is deliberate and was measured on
 * 1.12.0.dev14: the value answers "enabled AND usable", so a deployment enabled
 * while the provider carries no credentials is reported `false` (every seed entry
 * is `false` there too). The KEY is what registration writes and erases —
 * enabling adds it to both `enabled_models["Azure AI Foundry"]` and
 * `enabled_models_by_type["Azure AI Foundry"].llm`, disabling removes it from
 * both — so key presence is causal in both directions, which is exactly the
 * "Langflow accepted this deployment name" contract §7.8 is about. The `true`
 * value belongs to the configured-provider path (test 5, which reads the UI
 * toggle's own state).
 */
async function registeredFoundryDeployments(request: APIRequestContext): Promise<string[]> {
  const bearer = await getAuthToken(request);
  const res = await request.get("/api/v1/models/enabled_models", {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    enabled_models?: Record<string, Record<string, boolean>>;
    enabled_models_by_type?: Record<string, Record<string, Record<string, boolean>>>;
  };
  const names = new Set<string>([
    ...Object.keys(body.enabled_models?.[PROVIDER_NAME] ?? {}),
    ...Object.keys(body.enabled_models_by_type?.[PROVIDER_NAME]?.llm ?? {}),
  ]);
  return [...names];
}

/** Settings → Model Providers → <provider>, with the detail panel open. */
async function openProviderPanel(page: Page, providerItemTestId: string): Promise<void> {
  await new SettingsPage(page).navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 15000 },
  );
  await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 15000 });
  await page.getByTestId(providerItemTestId).click();
  await expect(page.getByTestId("model-provider-selection")).toBeVisible({ timeout: 15000 });
}

// Serial + --workers=1: every test drives the same account-wide Settings state
// (provider credentials, enabled models), so parallel execution would have them
// read each other's writes.
test.describe.configure({ mode: "serial" });

test.describe("Azure AI Foundry — unified provider setup", () => {
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    if (createdFlowIds.length === 0) return;
    // page.request carries only browser cookies — the flows API wants the Bearer
    // token, so authenticate explicitly (a silent 401 here leaks flows).
    const bearer = await getAuthToken(request);
    // No `.catch()` here on purpose: deleteFlow throws on a failed deletion, and
    // swallowing that is how a leak goes silent (the very buildup the helper was
    // written for). A cleanup that cannot delete must fail the test.
    for (const id of createdFlowIds.splice(0)) {
      await deleteFlow(request, id, { headers: { Authorization: bearer } });
    }
  });

  test(
    "Azure AI Foundry is offered with a two-variable form and a Foundry-only deployment surface",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("the provider is searchable in Settings → Model Providers", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 15000 });

        // Search, not scroll: the list renders a subset, and searching is how the
        // page is used (provider-playbook step 0).
        await page.getByTestId("provider-search-input").fill("azure");
        const items = page.locator('[data-testid^="provider-item-"]');
        await expect(items).toHaveCount(1, { timeout: 15000 });
        await expect(page.getByTestId(PROVIDER_ITEM)).toBeVisible();

        await page.getByTestId("provider-search-input").fill("");
        await expect(items.first()).toBeVisible({ timeout: 15000 });
      });

      await test.step("its detail panel opens", async () => {
        await page.getByTestId(PROVIDER_ITEM).click();
        await expect(page.getByTestId("model-provider-selection")).toBeVisible({
          timeout: 15000,
        });
        // The two-variable form itself is asserted in the next test: a CONFIGURED
        // provider replaces the raw inputs with a masked value plus Replace, so
        // that assert belongs behind the unconfigured-state gate — this test runs
        // on every lane regardless of what the instance has stored.
      });

      await test.step("the panel states the deployment-name rule and offers to add one", async () => {
        const hint = page.getByTestId("custom-deployment-hint");
        await expect(hint).toBeVisible({ timeout: 15000 });
        await expect(hint).toContainText("deployment names");
        await expect(hint).toContainText("not catalog model IDs");
        await expect(page.getByTestId("model-search-input")).toHaveAttribute(
          "placeholder",
          /Search or add a deployment name/,
        );
      });

      await test.step("the seed catalog renders as suggestions", async () => {
        const section = page.getByTestId("llm-models-section");
        await expect(section).toBeVisible({ timeout: 15000 });
        await expect(section).toContainText("gpt-4o");
        const sectionText = (await section.innerText()) ?? "";
        const present = SEED_MODELS.filter((m) => sectionText.includes(m));
        expect(
          present.length,
          `seed catalog entries rendered: ${JSON.stringify(present)}`,
        ).toBeGreaterThanOrEqual(SEED_FLOOR);
      });

      await test.step("the deployment surface is Foundry-specific, not page-wide", async () => {
        // Differential control: OpenRouter is a plain keyed provider on the same
        // page. Without this, a regression that showed the hint for EVERY
        // provider would still pass the asserts above.
        await page.getByTestId("provider-item-OpenRouter").click();
        await expect(page.getByTestId("provider-variable-input-OPENROUTER_API_KEY")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("custom-deployment-hint")).toHaveCount(0);
        await expect(page.getByTestId("model-search-input")).toHaveAttribute(
          "placeholder",
          /Search models/,
        );
      });
    },
  );

  test(
    "an unconfigured Azure AI Foundry panel is read-only: no enable toggle, no add-deployment control",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const stored = await foundryVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — the unconfigured-state assertions do not apply`,
      );

      await awaitBootstrapTest(page, { skipModal: true });
      await openProviderPanel(page, PROVIDER_ITEM);

      await test.step("the form requires BOTH an API key and an endpoint", async () => {
        // Foundry is the first provider on this page needing two variables. Both
        // raw inputs exist only while unconfigured (a configured provider shows a
        // masked value + Replace), which is why this lives here and not in the
        // always-on surface test.
        await expect(page.getByTestId(KEY_INPUT)).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId(ENDPOINT_INPUT)).toBeVisible();
        // Save stays disabled while the required pair is empty — the two-variable
        // contract asserted through the control the operator actually uses.
        await expect(page.getByRole("button", { name: /^Save$/ }).first()).toBeDisabled();
      });

      await test.step("the seed models render with tags but nothing to switch", async () => {
        await expect(page.getByTestId("llm-tag-tool-gpt-4o")).toBeVisible({ timeout: 15000 });
        await expect(page.locator('[data-testid^="llm-toggle-"]')).toHaveCount(0);
        await expect(page.locator('[data-testid^="embeddings-toggle-"]')).toHaveCount(0);
      });

      await test.step("typing a deployment name offers no add control while unconfigured", async () => {
        await page.getByTestId("model-search-input").fill("e2e-unconfigured-probe");
        // The empty state proves the search ran; the absent buttons are the
        // contract (the control is gated on is_enabled || is_configured).
        await expect(page.getByTestId("model-search-empty")).toBeVisible({ timeout: 15000 });
        await expect(page.locator('[data-testid*="add-custom"]')).toHaveCount(0);
      });
    },
  );

  test(
    "credentials that do not validate are rejected and nothing is persisted",
    { tag: ["@stable", "@api", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const stored = await foundryVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — saving bogus credentials would overwrite a real one`,
      );

      await awaitBootstrapTest(page, { skipModal: true });
      await openProviderPanel(page, PROVIDER_ITEM);

      // A Foundry-shaped host that cannot resolve: the backend takes the Foundry
      // branch and fails at the live GET <endpoint>/models (measured ~4.7 s,
      // NameResolutionError). Unique per run so no DNS cache can answer it.
      const bogusEndpoint = `https://e2e-invalid-${Date.now()}.services.ai.azure.com/openai/v1`;

      await test.step("save a garbage key and an unreachable endpoint", async () => {
        await page.getByTestId(KEY_INPUT).fill("e2e-bogus-azure-foundry-key");
        await page.getByTestId(ENDPOINT_INPUT).fill(bogusEndpoint);

        const validatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/models/validate-provider") &&
            r.request().method() === "POST",
          { timeout: 60000 },
        );
        await page.getByRole("button", { name: /^Save$/ }).first().click();
        const validateResp = await validatePromise;

        // HTTP 200 is NOT the verdict here — the endpoint answers 200 with
        // valid:false for a rejected credential, so the body is the assert.
        expect(validateResp.status()).toBe(200);
        const body = (await validateResp.json()) as { valid?: boolean; error?: string };
        expect(body.valid).toBe(false);
        // The error names the provider: proof the backend ran the Foundry
        // validation branch rather than a generic reject.
        expect(body.error ?? "").toContain(PROVIDER_NAME);
      });

      await test.step("no credential is stored and the provider stays unconfigured", async () => {
        expect(await foundryVariables(request)).toEqual([]);
        await expect(page.locator('[data-testid^="llm-toggle-"]')).toHaveCount(0);
      });
    },
  );

  test(
    "a portal deployment name absent from every catalog is accepted and rendered",
    { tag: ["@stable", "@api", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const identity = `${PROVIDER_NAME}::llm::${E2E_DEPLOYMENT}`;

      // Pre-clean: a leftover enable from an earlier run must not pre-satisfy the
      // asserts below. Registration is causal in both directions, so the absence
      // here is a real starting point, not an assumption.
      await setDeploymentEnabled(request, E2E_DEPLOYMENT, false);
      expect(await registeredFoundryDeployments(request)).not.toContain(E2E_DEPLOYMENT);

      try {
        await test.step("enabling the deployment stores it under the typed identity", async () => {
          const { status, body } = await setDeploymentEnabled(request, E2E_DEPLOYMENT, true);
          expect(status).toBe(200);
          // The deployment name survives verbatim under the typed identity, with
          // no catalog membership and no credentials configured.
          expect(body.enabled_models).toContain(identity);
          // …and the read side now knows the identity (see the helper's note on
          // why this reads keys, not the enabled flag).
          expect(await registeredFoundryDeployments(request)).toContain(E2E_DEPLOYMENT);
        });

        await test.step("the provider panel renders it alongside the seed catalog", async () => {
          await awaitBootstrapTest(page, { skipModal: true });
          await openProviderPanel(page, PROVIDER_ITEM);
          const section = page.getByTestId("llm-models-section");
          await expect(section).toBeVisible({ timeout: 15000 });
          await expect(section).toContainText(E2E_DEPLOYMENT);
          // Alongside, not instead of: the free-text enable is MERGED into the
          // catalog list for this provider.
          await expect(section).toContainText("gpt-4o");
        });
      } finally {
        const { body } = await setDeploymentEnabled(request, E2E_DEPLOYMENT, false);
        expect(body.enabled_models).not.toContain(identity);
        expect(await registeredFoundryDeployments(request)).not.toContain(E2E_DEPLOYMENT);
      }
    },
  );

  // Quarantined at triage (daily run 31581590030): recurrent flake, and the same
  // cause as #1424 — the second `POST /api/v1/variables/` of the pair is answered
  // 400 while validate-provider succeeds, so only AZURE_AI_FOUNDRY_ENDPOINT is
  // stored and the poll below times out on a pair that will never complete. The
  // 30 s poll is not the problem: the write was refused, not delayed. Same
  // signature on the 2026-08-10 and 08-12 dailies, with the 400 recorded in both
  // runs' logs. Lifting the quarantine (remove test.fixme + restore @stable) is a
  // deliverable of #1424.
  test.fixme(
    "real credentials configure the provider and enable a portal deployment through the UI",
    { tag: ["@model-provider", "@settings"] },
    async ({ page, request }) => {
      const probe = await probeFoundry(request);
      test.skip(!probe.usable, `Azure AI Foundry not usable: ${probe.reason}`);
      // This test CONFIGURES the provider and deletes the credential afterwards,
      // so it must own what it deletes: on an instance where an operator already
      // stored one, it would both race that state and destroy it. Same gate as the
      // unconfigured-state tests, for a stronger reason.
      const stored5 = await foundryVariables(request);
      test.skip(
        stored5.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored5
          .map((v) => v.name)
          .join(", ")}) — this test would overwrite and then delete a credential it does not own`,
      );

      try {
        await awaitBootstrapTest(page, { skipModal: true });
        await openProviderPanel(page, PROVIDER_ITEM);

        await test.step("save the endpoint and key — assert the save requests succeed", async () => {
          await page.getByTestId(KEY_INPUT).fill(FOUNDRY_KEY);
          await page.getByTestId(ENDPOINT_INPUT).fill(FOUNDRY_ENDPOINT);

          // Armed BEFORE the click so the pass is caused by THIS save, never by a
          // pre-existing configured state.
          const validatePromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/models/validate-provider") &&
              r.request().method() === "POST",
            { timeout: 60000 },
          );
          // Create (POST /variables/) on a fresh instance, update (PATCH
          // /variables/{id}) when a value already exists — the frontend branches
          // on existence (#636), so match both.
          const persistPromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/variables/") &&
              (r.request().method() === "POST" || r.request().method() === "PATCH"),
            { timeout: 60000 },
          );

          await page.getByRole("button", { name: /^Save$|^Replace$/ }).first().click();

          const [validateResp, persistResp] = await Promise.all([
            validatePromise,
            persistPromise,
          ]);
          expect(validateResp.status()).toBe(200);
          const validateBody = (await validateResp.json()) as { valid?: boolean; error?: string };
          expect(
            validateBody.valid,
            `validate-provider rejected the credentials: ${validateBody.error ?? "(no error)"}`,
          ).toBe(true);
          expect(persistResp.ok()).toBe(true);
        });

        await test.step("the provider is now configured: both variables stored, toggles render", async () => {
          // A two-variable provider means Save issues TWO separate variables
          // writes, and the waiter above resolves on the FIRST one. Asserting the
          // stored state right after it is a race the test loses ~1 run in 3
          // (measured while authoring: only AZURE_AI_FOUNDRY_ENDPOINT present, and
          // in an earlier run no toggle rendered within 30 s — same cause, the
          // provider was still half-configured). So poll for the PAIR: that is the
          // backend fact "this provider is configured", independent of how many
          // requests the frontend chose to make.
          await expect
            .poll(async () => (await foundryVariables(request)).map((v) => v.name).sort(), {
              timeout: 30000,
            })
            .toEqual([KEY_VAR, ENDPOINT_VAR].sort());

          // Only then is the panel expected to reflect `is_configured` — the enable
          // toggles the unconfigured panel (test 2) does not render at all.
          await expect(page.locator('[data-testid^="llm-toggle-"]').first()).toBeVisible({
            timeout: 30000,
          });
        });

        await test.step("the add-deployment control appears and enables the portal deployment", async () => {
          await page.getByTestId("model-search-input").fill(FOUNDRY_DEPLOYMENT);
          // The exact control test 2 proved absent while unconfigured. Both
          // testids exist upstream: the all-types panel renders
          // `add-custom-llm-deployment-button`, a type-filtered one
          // `add-custom-deployment-button`.
          const addButton = page.locator(
            '[data-testid="add-custom-llm-deployment-button"], [data-testid="add-custom-deployment-button"]',
          );
          await expect(addButton.first()).toBeVisible({ timeout: 15000 });

          // Armed BEFORE the click, and asserted on the BODY: the row and its
          // toggle render optimistically, so the UI alone cannot tell an accepted
          // deployment from a write that never landed. Measured while authoring:
          // reloading right after the click cancelled the in-flight POST and the
          // deployment was absent afterwards, with the panel still showing it.
          const enablePromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/models/enabled_models") &&
              r.request().method() === "POST",
            { timeout: 30000 },
          );
          await addButton.first().click();
          const enableResp = await enablePromise;
          expect(enableResp.ok()).toBe(true);
          const enableBody = (await enableResp.json()) as EnabledModelsWrite;
          expect(enableBody.enabled_models).toContain(
            `${PROVIDER_NAME}::llm::${FOUNDRY_DEPLOYMENT}`,
          );

          await expect(page.getByTestId("llm-models-section")).toContainText(
            FOUNDRY_DEPLOYMENT,
            { timeout: 15000 },
          );
          // With the provider configured, the row carries a real toggle and the
          // add put it in the ON state — the half test 4 cannot reach, since an
          // unconfigured provider renders no toggle at all.
          await expect(page.getByTestId(`llm-toggle-${FOUNDRY_DEPLOYMENT}`)).toHaveAttribute(
            "data-state",
            "checked",
            { timeout: 15000 },
          );
        });

        await test.step("the enabled deployment persists across a reload", async () => {
          await page.reload();
          await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 30000 });
          expect(await registeredFoundryDeployments(request)).toContain(FOUNDRY_DEPLOYMENT);
        });
      } finally {
        // Restore the pre-test account state: deployment disabled, credentials
        // removed by id (these two ARE listed by GET /api/v1/variables/).
        await setDeploymentEnabled(request, FOUNDRY_DEPLOYMENT, false);
        await purgeFoundryCredentials(request);
        expect(await foundryVariables(request)).toEqual([]);
      }
    },
  );

  test(
    "the configured deployment answers a real inference through the Language Model component",
    { tag: ["@stable", "@model-provider", "@components", "@playground"] },
    async ({ page, request }) => {
      const probe = await probeFoundry(request);
      test.skip(!probe.usable, `Azure AI Foundry not usable: ${probe.reason}`);

      // Same ownership gate as test 5: this test stores the credential pair and
      // deletes it in its own teardown.
      const stored6 = await foundryVariables(request);
      test.skip(
        stored6.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored6
          .map((v) => v.name)
          .join(", ")}) — this test would overwrite and then delete a credential it does not own`,
      );

      // Per-run sentinel: a match proves THIS execution produced the output.
      const token = `AZFOUNDRY-${Date.now()}`;

      try {
        await test.step("configure the provider and enable the deployment (setup, via API)", async () => {
          const bearer = await getAuthToken(request);
          // Idempotent: a variable left behind by an interrupted run would make
          // the create below a 4xx, so clear the pair first.
          await purgeFoundryCredentials(request);
          // Order matters: the backend validates on write and returns early while
          // only one of the two variables exists, so the endpoint (written last)
          // is the write that gets validated against the live resource.
          for (const [name, value] of [
            [KEY_VAR, FOUNDRY_KEY],
            [ENDPOINT_VAR, FOUNDRY_ENDPOINT],
          ] as const) {
            const res = await request.post("/api/v1/variables/", {
              headers: { Authorization: bearer, "Content-Type": "application/json" },
              data: { name, value, type: "Credential", default_fields: [] },
            });
            expect(res.ok(), `storing ${name} answered ${res.status()}`).toBe(true);
          }
          const { status } = await setDeploymentEnabled(request, FOUNDRY_DEPLOYMENT, true);
          expect(status).toBe(200);
        });

        await awaitBootstrapTest(page, { skipModal: true });

        await test.step("open Basic Prompting and point its Language Model at the deployment", async () => {
          // Basic Prompting ships Chat Input → Language Model → Chat Output
          // WIRED. Adding the three components to a blank canvas instead leaves
          // them unconnected, and the run then persists the user turn with NO
          // reply — measured while authoring, and indistinguishable from a
          // provider failure.
          //
          // Copied over the API rather than clicked in the templates modal: that
          // path creates a blank `New Flow` placeholder first (#1005) whose id the
          // helper can only clean when it manages to read the discarded response
          // body — a leak observed here as a stray `New Flow` + `Basic Prompting`
          // surviving one run in two. An id-addressed copy leaks nothing and is
          // isolated per worker (#684).
          const flowId = await createFlowFromStarter(
            page.request,
            "Basic Prompting",
            `azure-ai-foundry ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          );
          createdFlowIds.push(flowId);
          await openFlowById(page, flowId);

          await expect(page.getByTestId("title-Language Model")).toBeVisible({ timeout: 30000 });
          await page.getByTestId("model_model").first().click();
          // Options are keyed `<provider>-<model>-option` (scouted live on
          // 1.12.0.dev15) — the provider prefix matters here: a Foundry
          // deployment can share its name with an OpenAI catalog id.
          await page
            .getByTestId(`${PROVIDER_NAME}-${FOUNDRY_DEPLOYMENT}-option`)
            .first()
            .click();
          // The selection autosaves with a debounce; the Playground builds the
          // PERSISTED flow.
          await waitForFlowSaveSettled(page);
        });

        await test.step("the node shows the DEPLOYMENT name, not a catalog id", async () => {
          await expect(page.getByTestId("value-dropdown-model_model")).toContainText(
            FOUNDRY_DEPLOYMENT,
            { timeout: 15000 },
          );
        });

        await test.step("the playground gets a real answer from the deployment", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
            timeout: 30000,
          });
          await page
            .getByTestId("input-chat-playground")
            .last()
            .fill(`Repeat this token exactly and nothing else: ${token}`);
          await page.getByTestId("button-send").last().click();

          // Deterministic completion signal (never a "did Stop appear?" probe).
          await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 180000 });
          await expect(page.getByTestId("button-send").last()).toBeVisible({ timeout: 30000 });

          // Assert on the PERSISTED reply: the live bubble renders the empty
          // placeholder mid-stream (#634 race).
          const bearer = await getAuthToken(request);
          await expect
            .poll(
              async () => {
                const res = await request.get("/api/v1/monitor/messages", {
                  headers: { Authorization: bearer },
                });
                if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
                const messages = (await res.json()) as Array<{
                  sender?: string;
                  session_id?: string;
                  text?: string;
                }>;
                if (!Array.isArray(messages)) return "monitor payload not a list";
                const userMsg = messages.find(
                  (m) => m.sender !== "Machine" && (m.text ?? "").includes(token),
                );
                if (!userMsg) return "user message with token not persisted yet";
                const replies = messages
                  .filter((m) => m.sender === "Machine" && m.session_id === userMsg.session_id)
                  .map((m) => (m.text ?? "").trim());
                if (replies.length === 0) return "AI reply for the session not persisted yet";
                if (replies.every((t) => t === "")) return "AI reply persisted but still empty";
                return replies.some((t) => t.includes(token))
                  ? "reply-contains-token"
                  : `reply did not echo the token: ${JSON.stringify(
                      replies.map((t) => t.slice(0, 80)),
                    )}`;
              },
              { timeout: 90000 },
            )
            .toBe("reply-contains-token");
        });
      } finally {
        await setDeploymentEnabled(request, FOUNDRY_DEPLOYMENT, false);
        await purgeFoundryCredentials(request);
      }
    },
  );
});
