import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { providerSkipReasons } from "../../../../helpers/provider-setup/provider-health";

/**
 * Agent current-date tool toggle (QA-CHECKLIST §6.5 "Toggle
 * add_current_date_tool works (enables/disables date tool)").
 *
 * Causal pair — only the toggle differs between the two tests:
 *   ON (template default): a date question persists a `get_current_date`
 *   tool_use block whose OUTPUT contains today's UTC date (backend-generated
 *   string — model prose is never the observable).
 *   OFF (flipped in the controls dialog, aria-checked write proven): zero
 *   `get_current_date` tool_use blocks in the run's session — the tool is
 *   not in the toolkit, so its absence is deterministic.
 *
 * Trap disarmed: the template's DEFAULT system prompt contains the
 * `{current_date}` placeholder, substituted with the real date at run time —
 * with the toggle OFF the model would still "know" the date via the prompt.
 * Both tests set a custom prompt WITHOUT the placeholder (spec doc, Trap
 * note). Naming the date tool in the instructions is deliberate: this
 * bullet's contract is tool AVAILABILITY, not free selection (that is
 * agent-multi-tool-selection.spec.ts).
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const DATE_TOOL = "get_current_date";
const SYSTEM_PROMPT =
  "If a date/time tool is available you MUST use it to answer date questions - " +
  "never answer date questions from memory. " +
  "If no such tool is available, reply that you cannot verify the date.";

// Today's UTC date, with yesterday accepted to survive a midnight flip
// between the tool call and the assert (spec doc, Step by step).
function acceptedUtcDates(): string[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [today, yesterday];
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
  const skipReasons = providerSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);
    if (!record) {
      console.warn(`MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred.`);
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

// Flows created by each test are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and
// SimpleAgentTemplatePage.load() discards the id, so it is re-captured from
// the template-instantiation POST response in parallel with the load.
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  // Collect EVERY flow id this page creates (POST /api/v1/flows 201): the
  // app can fire more than one flows POST during template load, and only
  // one of them is the flow that persists — deleting all collected ids is
  // still id-scoped (only THIS test's creations), and a 404 on an already-
  // gone transient id is harmless.
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
    // deleteFlow throws on real failures and treats 404 as done — a
    // transient id the app already discarded is the desired end state.
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Set the Agent Instructions (system prompt) on the node.
async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
}

// Set the task on the ChatInput node (the Playground prompt pre-fills from it;
// typing into the Playground races an async default re-injection).
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
}

// Flip add_current_date_tool OFF in the Agent controls dialog. Asserting the
// pre-flip default makes this a proven WRITE — a changed template default
// fails loudly instead of silently inverting the test's meaning (pattern
// from agent-config-persistence.spec.ts).
async function setCurrentDateToggleOff(page: Page): Promise<void> {
  // dev49: add_current_date_tool is an advanced field — expose it on the node
  // body via the inspector (replaces the old Controls dialog / edit-button-modal),
  // then flip its toggle on the body.
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-add_current_date_tool").click();
  await closeAdvancedOptions(page);
  const toggle = page.getByTestId("toggle_bool_add_current_date_tool");
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Open the Playground with the pre-seeded task and send it.
async function openPlaygroundAndSend(page: Page, task: string): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(task, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

// Collect the tool_use blocks of every AI message in the nonce-keyed
// session. Returns null while the session's AI reply is not persisted yet
// (poll-friendly); after that, the block list (possibly empty).
async function getSessionToolBlocks(
  request: APIRequestContext,
  bearer: string,
  nonce: string,
): Promise<{ name: string; output: unknown }[] | null> {
  const res = await request.get("/api/v1/monitor/messages", {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) return null;
  const messages = await res.json();
  if (!Array.isArray(messages)) return null;

  const userMsg = messages.find(
    (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
  );
  if (!userMsg) return null;

  const aiMsgs = messages.filter(
    (m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id,
  );
  if (aiMsgs.length === 0) return null;

  return aiMsgs.flatMap((m: any) =>
    ((m.content_blocks ?? []) as any[])
      .flatMap((b: any) => b.contents ?? [])
      .filter((c: any) => c.type === "tool_use")
      .map((c: any) => ({ name: c.name as string, output: c.output })),
  );
}

// ON assert: a get_current_date block exists and its backend-generated
// output contains today's UTC date — model prose is never the observable.
async function expectDateToolReturnedToday(
  request: APIRequestContext,
  nonce: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const blocks = await getSessionToolBlocks(request, bearer, nonce);
        if (blocks === null) return "session messages not persisted yet";
        const dateBlocks = blocks.filter((b) => b.name === DATE_TOOL);
        if (dateBlocks.length === 0) {
          return `no ${DATE_TOOL} tool_use block; called: ${JSON.stringify(blocks.map((b) => b.name))}`;
        }
        const accepted = acceptedUtcDates();
        return dateBlocks.some((b) => {
          const out = JSON.stringify(b.output ?? "");
          return accepted.some((d) => out.includes(d));
        })
          ? "date-tool-returned-today"
          : `${DATE_TOOL} output has no accepted UTC date ${JSON.stringify(accepted)}: ${JSON.stringify(dateBlocks[0].output).slice(0, 120)}`;
      },
      { timeout: 30000 },
    )
    .toBe("date-tool-returned-today");
}

// OFF assert: the session's AI reply is persisted and carries ZERO
// get_current_date blocks — the toggle removed the tool from the toolkit.
async function expectNoDateToolBlocks(
  request: APIRequestContext,
  nonce: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const blocks = await getSessionToolBlocks(request, bearer, nonce);
        if (blocks === null) return "session messages not persisted yet";
        const dateBlocks = blocks.filter((b) => b.name === DATE_TOOL);
        return dateBlocks.length === 0
          ? "no-date-tool-blocks"
          : `unexpected ${DATE_TOOL} block(s): ${dateBlocks.length}`;
      },
      { timeout: 30000 },
    )
    .toBe("no-date-tool-blocks");
}

const targets = getTestTargets();

// Serial mode + --workers=1 keeps the shared instance state deterministic
// (area rule for agent specs). Cleanup is id-scoped in afterEach — nothing
// here wipes flows, so parallel neighbors are never victims.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Current Date Tool [${label}]`, () => {
    test(
      "toggle ON (default): agent's date tool returns today's date",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `What is the current date? (${nonce})`;

        await loadAgent(page, options);

        await test.step("set a prompt WITHOUT {current_date}, seed the date question", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("date tool called and its output contains today's UTC date", async () => {
          await expectDateToolReturnedToday(request, nonce);
        });
      },
    );

    test(
      "toggle OFF: the date tool is removed from the agent's toolkit",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `What is the current date? (${nonce})`;

        await loadAgent(page, options);

        await test.step("set a prompt WITHOUT {current_date}, flip add_current_date_tool OFF (proven write)", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setCurrentDateToggleOff(page);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("run completed with a final, non-empty reply", async () => {
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          await expect(bubble).not.toHaveText("", { timeout: 30000 });
        });

        await test.step("zero get_current_date tool_use blocks persisted for this run", async () => {
          await expectNoDateToolBlocks(request, nonce);
        });
      },
    );
  });
}
