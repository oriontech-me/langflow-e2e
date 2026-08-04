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
 *  2. **The model list is the live instance, not a static catalog** — and it is
 *     enumerated at READ time, not at save time. `fetch_live_ollama_models()` hits
 *     `GET /api/tags` on every options build, and a provider counts as configured
 *     purely because its base-URL variable exists (`skip_validation=True` in
 *     `unified_models/credentials.py`). The first **five** live tags come back
 *     `default=True` (`MIN_DEFAULT_MODELS`), which is why a single pulled model is
 *     selectable with nothing else configured.
 *
 *     Corrected in #1187: this block used to say saving the URL "auto-enables what
 *     the instance serves", read off the observation that
 *     `enabled_models.Ollama` held both tags after a save. It does — but that is the
 *     live default flag being reported, not state the save wrote, and reading it the
 *     other way makes an empty dropdown look like proof the save failed. So the
 *     keyed helpers' "enable every model toggle" loop still has nothing to do here,
 *     for a different reason: the tags are already default-enabled on read.
 *
 * That live enumeration is also why this helper cannot invent a model name: a target
 * must arrive pinned (`OLLAMA_TEST_MODEL`), and a name the instance does not serve
 * must surface as `MODEL_NOT_AVAILABLE` — the #570 trap is a weak-model failure that
 * reads as a product regression, and a silently substituted model is how you get one.
 *
 * ## Two error prefixes, and the split is the contract
 *
 * `MODEL_NOT_AVAILABLE` is turned into a `test.skip` by every caller, so it is
 * reserved for the one fault that is genuinely about the model: the instance answered
 * and does not serve this tag. Everything that means *the lane is wired wrong* throws
 * `OLLAMA_PROVIDER_UNREACHABLE` and FAILS instead — Langflow rejecting the base URL
 * (Step 4), and an empty model list on an instance configured by an earlier run
 * (Step 6, which Step 4 cannot see because it short-circuits on an already-configured
 * provider). Collapsing the two would give the lane that asked for a keyless model a
 * silent skip when its local instance is down, which is #976's "24 specs skipped
 * silently" reproduced on the mechanism built to prevent it.
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

  // Resolves true when a concurrent worker won the base-URL write (see the listener
  // below). Read ONLY by Step 6's empty-dropdown branch, which otherwise attributes
  // the empty list to an unreachable instance. Defaults to a settled `false` so the
  // already-configured path — where no save is attempted at all — needs no special
  // case.
  let duplicateWritePromise: Promise<boolean> = Promise.resolve(false);

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

    // Armed alongside it: the base URL is persisted as a `Global` variable, and a
    // CONCURRENT save loses that write with `400 {"detail":"Variable name already
    // exists"}` while `validate-provider` still answers `valid: true` — the URL is
    // reachable, it is the second writer that is redundant. The loser's dropdown then
    // comes up empty, and without reading this the helper blames the instance for a
    // race (#1187). `globalSetup` pre-configures the provider precisely so this window
    // closes; capturing it here keeps the attribution right if it ever reopens (two
    // shards starting in the same instant, a failed pre-configuration, or
    // `model-provider/ollama-provider.spec.ts`, which DELETES this variable mid-run on
    // purpose so it can exercise a real first-time configure).
    //
    // It is NEVER awaited on the healthy path, and that is the whole reason it is
    // shaped this way. On a first-time configure no 400 arrives, so this promise can
    // only settle by timing out — awaiting it inline would add that timeout to every
    // successful configure, once per routed spec. So the window stays wide (a slow
    // runner can put the save round-trip seconds out) and the value is read only in
    // the empty-dropdown branch, where several seconds have already passed and the
    // answer is waiting. `.catch()` keeps the unawaited rejection handled; it is safe
    // here in a way it would not be for a verdict promise (see CLAUDE.md on the v1
    // flow-error read) because this one only ever picks the wording of a failure that
    // happens either way.
    // The un-awaited `waitForResponse` is the point of this block, not an oversight —
    // see above. `.catch()` below keeps the rejection handled, and the value is awaited
    // in Step 6's empty-dropdown branch.
    // eslint-disable-next-line playwright/missing-playwright-await
    duplicateWritePromise = page
      .waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/v1/variables/" &&
          r.request().method() === "POST" &&
          r.status() === 400,
        { timeout: 30000 },
      )
      .then(async (r) => /already exists/i.test(await r.text().catch(() => "")))
      .catch(() => false);

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

  let isAvailable = await option.isVisible({ timeout: 10000 }).catch(() => false);
  let offered = isAvailable
    ? []
    : await page
        .locator('[data-testid^="Ollama-"][data-testid$="-option"]')
        .allTextContents()
        .catch(() => [] as string[]);

  // One re-read before deciding, and ONLY when the list came back empty. The
  // dropdown's options are fetched, so "no options yet" and "no options at all"
  // render identically, and the verdict below is severe enough (a FAILURE, naming an
  // unreachable instance) to be worth one close-and-reopen. A list that is non-empty
  // but lacks the tag is a real answer and is not retried — the instance told us what
  // it serves.
  if (!isAvailable && offered.length === 0) {
    await page.keyboard.press("Escape");
    // `hideInspectorPanel` for the same reason Step 2 needs it: a selected node
    // re-opens the right-side Inspector Panel over this control on 1.11+. Without it
    // the re-click can die on an interception at `actionTimeout`, which throws neither
    // attributed prefix and loses exactly the attribution this branch exists to give.
    await hideInspectorPanel(page);
    await page.getByTestId("model_model").click().catch(() => {});
    isAvailable = await option.isVisible({ timeout: 15000 }).catch(() => false);
    offered = isAvailable
      ? []
      : await page
          .locator('[data-testid^="Ollama-"][data-testid$="-option"]')
          .allTextContents()
          .catch(() => [] as string[]);
  }

  if (!isAvailable) {
    await page.keyboard.press("Escape");

    // NOTHING offered is a different fault from THIS TAG not offered, and only one
    // of them may skip.
    //
    // The `validate-provider` guard in Step 4 covers a URL saved on THIS run. It
    // cannot cover the other path: an instance where Ollama was configured earlier
    // short-circuits that step (`alreadyConfigured`), so a provider that has since
    // become unreachable — the container stopped, the address changed — reaches
    // here with an empty list and no verdict read anywhere. Reported as
    // MODEL_NOT_AVAILABLE it becomes a `test.skip`, which is exactly the silent
    // coverage loss #976 recorded and the reason Step 4 throws instead of skipping.
    //
    // An empty Ollama list has ONE benign reading, and it is not the instance's
    // fault: a concurrent worker won the base-URL write, so THIS page's create was
    // rejected and its options cache was never invalidated (the frontend refetches
    // only after its own create succeeds). The backend is fine — enumeration is live
    // per read and the winner's variable satisfies it — which is why the fix is to
    // configure once up front rather than to make this page retry. That is what
    // `duplicateWritePromise` records, and it changes only the message — the failure
    // stands either way, because a lane that asked for a local model must not lose
    // coverage quietly (#976) and because the run is misconfigured in both cases.
    // Getting the attribution right is the point: the original text sends a
    // dispatcher to check SSRF and pulled models on an instance that was serving
    // both correctly, which cost this issue a full measurement round.
    //
    // Otherwise: zero options means Langflow enumerated nothing — unreachable, or
    // reachable and serving no model. Both are lane misconfigurations. A non-empty
    // list that lacks the requested tag is the genuine "this instance does not serve
    // it" case and keeps skipping.
    if (offered.length === 0 && (await duplicateWritePromise)) {
      throw new Error(
        `OLLAMA_PROVIDER_UNREACHABLE: the base-URL write for this run was REJECTED as ` +
          `a duplicate (POST /api/v1/variables/ → 400 "Variable name already exists"), ` +
          `so Langflow never enumerated the instance for it and the model dropdown is ` +
          `empty. The instance itself is almost certainly fine — another worker ` +
          `configured the provider concurrently. This is the race \`globalSetup\`'s ` +
          `routed pre-configuration exists to close, so check its warning above: it ` +
          `runs before any worker and makes every spec take the already-configured ` +
          `path (#1187).`,
      );
    }
    if (offered.length === 0) {
      throw new Error(
        `OLLAMA_PROVIDER_UNREACHABLE: the Agent's model dropdown offers NO Ollama ` +
          `model at all. Langflow enumerates the live instance when the provider is ` +
          `saved, so an empty list means it reached nothing — the instance is down or ` +
          `at a different address than the one Langflow holds, or it serves no model. ` +
          `Check that Langflow (not this test process) can reach ` +
          `OLLAMA_BASE_URL_FROM_LANGFLOW, that LANGFLOW_SSRF_ALLOWED_HOSTS covers it, ` +
          `and that the instance has the model pulled. Reported as a FAILURE, not a ` +
          `skip: a lane that asked for a local model must not lose that coverage ` +
          `quietly when the wiring is wrong (#1187).`,
      );
    }

    throw new Error(
      `MODEL_NOT_AVAILABLE: "${modelTestId ?? "(any Ollama model)"}" is not offered by ` +
        `the Agent's model dropdown. Ollama's list is the LIVE instance, so this means ` +
        `the instance does not serve it (offered: ${offered.join(", ")}) — ` +
        `pull it, or point OLLAMA_TEST_MODEL at one it has.`,
    );
  }
  await option.click();
}
