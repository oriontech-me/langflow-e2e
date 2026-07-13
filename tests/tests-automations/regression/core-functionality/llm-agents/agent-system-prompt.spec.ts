import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { APIRequestContext, Page, Response } from "@playwright/test";
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

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Distinctive stem for the sentinel code word. A model would never emit it on
// its own for an unrelated question (the negative-control test asserts exactly
// that), so its presence proves the Agent Instructions reached the model
// (UI → flow → backend → call).
const SENTINEL_BASE = "PINEAPPLE";

// The user message is unrelated to the sentinel — the model has no reason to
// produce the code word unless the system prompt instructed it.
const USER_MESSAGE = "What is the capital of France?";

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
  // Collect the POST /api/v1/flows → 201 responses synchronously as they arrive,
  // then resolve their bodies in `finally`. Awaiting the .json() here (instead of
  // a fire-and-forget .then()) guarantees every created id is recorded BEFORE the
  // test proceeds to afterEach — otherwise the last flow's id can land after
  // cleanup already ran, leaking that flow.
  const flowCreations: Response[] = [];
  const onResponse = (resp: Response) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      flowCreations.push(resp);
    }
  };
  page.on("response", onResponse);
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  } finally {
    page.off("response", onResponse);
    for (const resp of flowCreations) {
      const body = (await resp.json().catch(() => null)) as { id?: string } | null; // non-JSON / batch payloads
      if (body?.id) createdFlowIds.push(body.id);
    }
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

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Fill the Agent Instructions (system prompt) and make sure it is COMMITTED and
// PERSISTED before the build, so the run uses the prompt we set, not the
// template default.
async function setAgentInstructions(page: Page, prompt: string): Promise<void> {
  const promptField = page.getByTestId("textarea_str_system_prompt");
  await expect(promptField).toBeVisible({ timeout: 15000 });

  await promptField.click();
  await promptField.fill(prompt);
  await promptField.blur();
  // Drain ALL debounced autosave PATCHes. The previous single
  // `waitForResponse(PATCH)` could match a STALE PATCH still in flight from
  // load() (model selection), resolving BEFORE the instruction's own save landed
  // — so the build could run the template default (no instruction) and the model
  // answers the literal question without the sentinel (#635). Persistence is then
  // confirmed server-side by the caller (expectSentinelPersistedInFlows) — the
  // true "instruction reaches the provider" gate, which DOM state cannot prove.
  await waitForFlowSaveSettled(page);
}

// Server-side confirmation that `sentinel` actually reached the PERSISTED flow —
// the true "does the instruction reach the provider" gate (#635). Poll GET
// /api/v1/flows/ (the list carries each flow's full `data` graph) until the
// unique per-run sentinel appears. If it never persists, this fails as a
// SAVE/WIRING issue here; if it DOES persist but the reply omits it, that is
// unambiguously model-side non-adherence, not a dropped instruction.
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
      // Explicit, backing-off intervals: GET /api/v1/flows/ returns every flow's
      // full graph, so avoid hammering it with the default aggressive cadence.
      { timeout: 15000, intervals: [500, 1000, 2000] },
    )
    .toBe("persisted");
}

// Open the Playground, send a message, wait for the run to finish, return the
// latest chat message text.
async function askAndGetReply(page: Page, message: string): Promise<string> {
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
    timeout: 30000,
  });

  await page.getByTestId("input-chat-playground").last().fill(message);
  await page.getByTestId("button-send").last().click();

  await waitForAgentToFinish(page);

  const chatMessage = page.getByTestId("div-chat-message").last();
  await expect(chatMessage).toBeVisible({ timeout: 30000 });
  return chatMessage.innerText();
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each
// other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent System Prompt [${label}]`, () => {
    test(
      "Agent Instructions are respected in the model response",
      { tag: ["@stable", "@release", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Per-run sentinel: a passing assertion can only be caused by THIS run's
        // instruction reaching the model — never a cached/hardcoded/leaked value.
        const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sentinel = `${SENTINEL_BASE}-${uniq}`;
        const systemPrompt = `You are a test assistant. No matter what the user asks, you must always include the exact code word ${sentinel} verbatim somewhere in your reply.`;

        await loadAgent(page, options);

        await test.step("set the Agent Instructions and confirm they persist to the flow", async () => {
          await setAgentInstructions(page, systemPrompt);
          // Payload-level gate: prove the instruction reached the PERSISTED flow
          // (what the build/provider call reads) before running — so a run that
          // omits the sentinel is unambiguously model non-adherence, not a
          // dropped instruction (#635).
          await expectSentinelPersistedInFlows(request, sentinel);
        });

        await test.step("run an unrelated message and assert the instruction is honoured", async () => {
          const reply = await askAndGetReply(page, USER_MESSAGE);
          expect(reply.toUpperCase()).toContain(sentinel.toUpperCase());
        });
      },
    );

    test(
      "negative control — sentinel is absent without the instruction",
      { tag: ["@stable", "@release", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        // Guards the positive test against a false positive: with a neutral prompt
        // (no sentinel instruction), the model must NOT emit the sentinel stem for
        // the unrelated question — proving the code word is not something the model
        // produces spontaneously, so a match in the positive test is caused by the
        // instruction, not coincidence.
        await test.step("set a neutral instruction and wait for autosave", async () => {
          await setAgentInstructions(page, "You are a helpful assistant.");
        });

        await test.step("run the same message and assert the sentinel is absent", async () => {
          const reply = await askAndGetReply(page, USER_MESSAGE);
          expect(reply.toUpperCase()).not.toContain(SENTINEL_BASE);
        });
      },
    );
  });
}
