import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import { providerConfigMap } from "./provider-config";
import { ollamaBaseUrlFromLangflow } from "./ollama-endpoint";

const OLLAMA = providerConfigMap.ollama;

/**
 * Point the Agent node at a model served by the LOCAL Ollama instance (#1187).
 *
 * Same contract as `setupOpenAI` / `setupAnthropic` / `setupGoogle` — reach the
 * provider panel from the Agent node, configure the provider, select `modelTestId`,
 * throw `MODEL_NOT_AVAILABLE` when it is not offered — so `providerSetupMap` can
 * dispatch to it unchanged. Two things differ, both because Ollama is a local
 * service rather than a keyed API:
 *
 *  1. **No key to fill.** The panel takes a base URL, and Langflow persists it as a
 *     `Global` variable rather than a `Credential`. The keyed helpers guard against
 *     re-saving a masked secret; here re-saving is merely redundant, so a configured
 *     provider is left alone for the same reason (a disabled Save button would hang
 *     the click).
 *  2. **The model list is the live instance, not a static catalog.** Saving the URL
 *     makes Langflow enumerate `GET /api/tags` and auto-enable exactly what that
 *     instance serves. Measured on 1.12.0.dev10: with one model pulled, saving left
 *     `enabled_models.Ollama = {"llama3.1:latest": true}`; after pulling a second,
 *     re-saving produced both, every toggle already `aria-checked="true"`. So the
 *     keyed helpers' "enable every model toggle" loop has nothing to do here — it is
 *     kept only as a repair path for a toggle someone turned off, never as the step
 *     that makes a model selectable.
 *
 * That live enumeration is also why this helper cannot invent a model name: a target
 * must arrive pinned (`OLLAMA_TEST_MODEL`), and a name the instance does not serve
 * must surface as `MODEL_NOT_AVAILABLE` — the #570 trap is a weak-model failure that
 * reads as a product regression, and a silently substituted model is how you get one.
 */
export async function setupOllama(page: Page, modelTestId?: string): Promise<void> {
  // Step 1: Find the entry point into the provider management panel.
  // "model_model" exists only when a provider is already configured; with none
  // configured the field renders a plain "Setup Provider" button (no data-testid).
  const modelDropdown = page.getByTestId("model_model");
  const setupProviderBtn = page.getByRole("button", { name: "Setup Provider" });

  const hasModelDropdown = (await modelDropdown.count()) > 0;
  const hasSetupButton = (await setupProviderBtn.count()) > 0;

  if (!hasModelDropdown && !hasSetupButton) {
    console.log("No Agent node found on canvas — skipping Ollama setup.");
    return;
  }

  // Step 2: Open the model provider management panel.
  if (hasModelDropdown) {
    // A selected node opens a right-side Inspector Panel that overlaps the model
    // dropdown on 1.11.x+ — close it so the click is not intercepted.
    await hideInspectorPanel(page);
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupProviderBtn.click();
  }

  // Step 3: Select the Ollama provider.
  await page.getByTestId(OLLAMA.providerTestId).click();

  // Step 4: Configure the base URL, unless this instance already has one.
  // A configured provider shows "Disconnect" next to "Replace", and its Save button
  // is disabled while the value is unchanged — so clicking it would retry-loop to a
  // timeout on every repeat run.
  const urlInput = page.getByTestId(OLLAMA.variableInputTestId);
  await urlInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  const alreadyConfigured = await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!alreadyConfigured && (await urlInput.count()) > 0) {
    const url = ollamaBaseUrlFromLangflow();
    await urlInput.fill(url);

    // Armed BEFORE the click: the save round-trips through
    // POST /api/v1/models/validate-provider, and that response is the only place the
    // real verdict appears. It answers **HTTP 200** with `{"valid": false, "error":
    // …}` for a URL Langflow cannot reach — so neither the status nor the UI says
    // "rejected", and without reading the body this helper walked on and died 100 s
    // later on `getByTestId("model_model")` never appearing, naming a dropdown
    // instead of the misconfiguration. Measured while building #1187 by pointing
    // Langflow at loopback (blocked by its SSRF layer from inside the container).
    const validatePromise = page
      .waitForResponse(
        (r) =>
          r.url().includes("/api/v1/models/validate-provider") &&
          r.request().method() === "POST",
        { timeout: 60000 },
      )
      .catch(() => null);

    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();

    const validateResp = await validatePromise;
    const verdict = validateResp
      ? ((await validateResp.json().catch(() => null)) as {
          valid?: boolean;
          error?: string | null;
        } | null)
      : null;
    if (verdict?.valid === false) {
      // Deliberately NOT `MODEL_NOT_AVAILABLE`: the specs turn that prefix into a
      // `test.skip`, and a lane that asked for a local model must not lose its
      // coverage quietly when the wiring is wrong. This is an actionable
      // misconfiguration of the lane, so it fails, attributed — the same reasoning
      // that made #976's "24 specs skipped silently" the failure it was.
      throw new Error(
        `OLLAMA_PROVIDER_UNREACHABLE: Langflow rejected the base URL "${url}" — ` +
          `${verdict.error ?? "no reason given"}. Langflow (not this test process) ` +
          `must be able to reach it: use the address the Langflow container resolves ` +
          `(OLLAMA_BASE_URL_FROM_LANGFLOW; http://ollama:11434 in CI, ` +
          `http://host.docker.internal:11434 for a dockerized local instance) and ` +
          `start Langflow with LANGFLOW_SSRF_ALLOWED_HOSTS covering it — its SSRF ` +
          `layer blocks loopback outright and private addresses unless allow-listed.`,
      );
    }

    // Wait for the configured state so the model list has been enumerated from the
    // live instance before Step 6 opens the dropdown.
    await page
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Step 5: Repair path only — saving the URL already enabled every served model.
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
  await toggles.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const toggleCount = await toggles.count();
  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute("aria-checked")) !== "true") {
      await toggle.click();
    }
  }

  // Step 6: Close the panel and select the model.
  await page.getByRole("button", { name: "Close" }).click();
  await hideInspectorPanel(page);
  await page.getByTestId("model_model").click();

  // The option testid is `${provider}-${model}-option` — e.g.
  // `Ollama-llama3.2:1b-option`. Matched by testid rather than by text because an
  // Ollama tag carries `:` and `.`, and the keyed helpers' `new RegExp(^model$)`
  // would treat those as regex syntax.
  const option = modelTestId
    ? page.getByTestId(`Ollama-${modelTestId}-option`)
    : page.locator('[data-testid^="Ollama-"][data-testid$="-option"]').first();

  const isAvailable = await option.isVisible({ timeout: 10000 }).catch(() => false);
  if (!isAvailable) {
    const offered = await page
      .locator('[data-testid^="Ollama-"][data-testid$="-option"]')
      .allTextContents()
      .catch(() => [] as string[]);
    await page.keyboard.press("Escape");
    throw new Error(
      `MODEL_NOT_AVAILABLE: "${modelTestId ?? "(any Ollama model)"}" is not offered by ` +
        `the Agent's model dropdown. Ollama's list is the LIVE instance, so this means ` +
        `the instance does not serve it (offered: ${offered.join(", ") || "nothing"}) — ` +
        `pull it, or point OLLAMA_TEST_MODEL at one it has.`,
    );
  }
  await option.click();
}
