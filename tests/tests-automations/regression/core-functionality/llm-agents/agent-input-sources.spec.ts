import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

/**
 * Validates that the Agent component accepts its `input_value` from either of
 * its two canonical sources, and that each independently drives the response:
 *   - the ChatInput handle (`ChatInput → Agent(input)`), fed via the Playground;
 *   - the Agent's own inline `Input` field, with no upstream connection.
 *
 * Each test round-trips a fresh per-run sentinel so a pass can't be coincidental.
 *
 * Sibling coverage — NOT duplicated here:
 *   - agent-component-regression.spec.ts: streaming, reasoning steps, duration,
 *     multiple consecutive messages, stop button.
 *   - agent-system-prompt.spec.ts: system prompt influence on the response.
 * This spec owns only the "which input source reached the agent" contract (§6.5).
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

interface ModelRecord {
  provider: string;
  model: string;
}

interface TestTarget {
  label: string;
  options: LoadSimpleAgentOptions;
  skipReason?: string;
}

function getProviderSkipReasons(): Map<string, string> {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/providers.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("providers.json not found — run collect-models.spec.ts first. Skipping provider pre-validation.");
    return new Map();
  }
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  const reasons = new Map<string, string>();
  for (const r of records) {
    if (r.status === "inactive") {
      reasons.set(r.provider, `Provider "${r.provider}" inactive — ${r.error}`);
    }
  }
  return reasons;
}

function getModelsFromJson(): ModelRecord[] {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("models.json not found — run collect-models.spec.ts first.");
    return [];
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const skipReasons = getProviderSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);

    if (!record) {
      console.warn(
        `MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred. ` +
        `Run collect-models.spec.ts first, or set MODEL_TEST_PROVIDER.`,
      );
      return [{ label: `model:${model}`, options: { model } }];
    }

    const provider = record.provider as Provider;
    return [{
      label: `${provider} / ${model}`,
      options: { provider, model },
      skipReason: skipReasons.get(provider),
    }];
  }

  const allModels = getModelsFromJson();

  if (allModels.length === 0) {
    const fallbackProvider = Object.keys(providerConfigMap)[0] as Provider;
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [{
      label: `provider:${fallbackProvider} (fallback)`,
      options: { provider: fallbackProvider },
      skipReason: skipReasons.get(fallbackProvider),
    }];
  }

  let models = allModels;

  if (process.env.MODEL_TEST_PROVIDER) {
    models = models.filter((m) => m.provider === process.env.MODEL_TEST_PROVIDER);
  } else if (process.env.ALL_MODELS !== "true") {
    const seen = new Set<string>();
    models = models.filter((m) => {
      if (seen.has(m.provider)) return false;
      seen.add(m.provider);
      return true;
    });
  }

  return models.map((m) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

// Track every flow the template load creates (POST /api/v1/flows → 201) so
// afterEach can delete exactly those ids. SimpleAgentTemplatePage.load() does NO
// cleanup (post-#553 contract), so without this each run leaks a "Simple Agent"
// flow into the instance.
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
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
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    const res = await request.delete(`/api/v1/flows/${id}`, {
      headers: { Authorization: bearer },
    });
    // 404 = transient flow the app already discarded — expected noise.
    if (!res.ok() && res.status() !== 404) {
      console.warn(`flow cleanup: DELETE ${id} -> ${res.status()}`);
    }
  }
});

// Server-side confirmation that `sentinel` actually reached the PERSISTED flow —
// the true "does the input reach the provider" gate (#635). DOM state and PATCH
// quiescence don't prove persistence; the build (and thus the provider call)
// reads the persisted flow. Poll GET /api/v1/flows/ (the list carries each
// flow's full `data` graph) until the unique per-run sentinel appears in it.
// If it never persists, this fails as a SAVE/WIRING issue — unambiguously
// distinct from the model later ignoring an input that WAS persisted.
async function expectSentinelPersistedInFlows(
  request: APIRequestContext,
  sentinel: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/flows/", {
          headers: { Authorization: bearer },
        });
        if (!res.ok()) return `GET flows -> ${res.status()}`;
        const flows = await res.json();
        return JSON.stringify(flows).includes(sentinel)
          ? "persisted"
          : "sentinel not yet persisted in any flow";
      },
      { timeout: 15000 },
    )
    .toBe("persisted");
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Input Sources [${label}]`, () => {

    test(
      "input via ChatInput handle drives the agent response",
      { tag: ["@stable", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Per-run sentinel: a match on this exact token can't be coincidental.
        const token = `HANDLE-${Date.now()}`;

        // The Simple Agent template ships ChatInput → Agent(input) → ChatOutput.
        await loadAgent(page, options);

        await test.step("send the sentinel through the Playground (ChatInput handle)", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 30000 });
          await page
            .getByTestId("input-chat-playground")
            .last()
            .fill(`Repeat this token exactly and nothing else: ${token}`);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("agent response echoes the token routed through the handle", async () => {
          const aiMessage = page.getByTestId("div-chat-message").last();
          await expect(aiMessage).toBeVisible({ timeout: 30000 });
          const text = await aiMessage.innerText();
          expect(text).toContain(token);
        });
      },
    );

    test(
      "input via the Agent's direct field drives the agent response",
      { tag: ["@stable", "@components", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const token = `FIELD-${Date.now()}`;

        await loadAgent(page, options);

        await test.step("delete ChatInput so the Agent's own field is the only input source", async () => {
          const edges = page.locator(".react-flow__edge");
          const edgesBefore = await edges.count();

          const chatInputNode = page.locator('[data-testid^="rf__node-ChatInput"]');
          await expect(chatInputNode).toHaveCount(1);
          await chatInputNode.click();
          await page.keyboard.press("Backspace");

          await expect(chatInputNode).toHaveCount(0, { timeout: 10000 });
          // The single ChatInput → Agent edge is gone with the node.
          await expect(edges).toHaveCount(edgesBefore - 1, { timeout: 10000 });
        });

        await test.step("type the sentinel directly into the Agent's Input field", async () => {
          const inputField = page.getByTestId("popover-anchor-input-input_value");
          await expect(inputField).toBeVisible({ timeout: 15000 });
          const fieldValue = `Repeat this token exactly and nothing else: ${token}`;
          await inputField.click();
          await inputField.fill(fieldValue);
          // COMMIT the value: `fill` alone can leave the change uncommitted (the
          // node applies it on blur/change); without an explicit blur the value
          // can miss the autosave PATCH, so the build runs with an EMPTY
          // input_value and the agent replies generically ("I don't see any prior
          // conversation history…") — the #635 flaky symptom. Every other
          // field-set in this suite blurs; this one didn't.
          await inputField.blur();
          // button_run_agent builds the PERSISTED flow, so drain the debounced
          // autosave PATCHes (model selection from load(), the ChatInput deletion,
          // and this field value) first.
          await waitForFlowSaveSettled(page);
          // Then CONFIRM server-side that the field value actually reached the
          // persisted flow — the payload-level proof the input reaches the run
          // (#635). If it didn't persist, this fails as a save/wiring problem
          // here, rather than surfacing later as a misleading generic reply that
          // looks like model non-adherence.
          await expectSentinelPersistedInFlows(request, token);
        });

        await test.step("run the Agent node from the canvas", async () => {
          await page.getByTestId("button_run_agent").click();
          // Anchor completion on the persistent node badge, not the transient toast.
          await expect(page.getByTestId("node_duration_agent")).toBeVisible({ timeout: 120000 });
        });

        await test.step("agent output echoes the token typed into the field", async () => {
          await expect(page.getByTestId("output-inspection-response-agent")).toBeAttached({ timeout: 10000 });
          await page.getByTestId("output-inspection-response-agent").click();
          // [role="dialog"] is ambiguous — the onboarding tooltip also carries it.
          const dialog = page.locator(
            '[role="dialog"]:not([data-testid="assistant-onboarding-tooltip"])',
          );
          await expect(dialog).toBeVisible({ timeout: 10000 });
          const text = (await dialog.evaluate((el: HTMLElement) => el.textContent ?? "")) ?? "";
          expect(text).toContain(token);
        });
      },
    );
  });
}
