import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent Markdown output (QA-CHECKLIST §6.5, "Agent returns output in correctly
 * rendered Markdown").
 *
 * The Agent is prompted to reply using Markdown syntax (H2 heading, a bulleted
 * list, a bold word and a fenced code block). The Playground chat renderer
 * (react-markdown + remarkGfm, inside `.markdown.prose`) must turn that syntax
 * into HTML tags. The distinctive observable is the pairing:
 *   - the rendered bubble CONTAINS the tags (h1|h2|h3, li, strong, code), AND
 *   - the visible text does NOT contain the raw tokens (`**`, `## `).
 * A plain-text/broken renderer would echo `**bold**` / `## Heading` literally and
 * fail the pairing — that is the false-positive guard.
 *
 * `@stable` is intentionally withheld (promotion gated — issue #826; #773 flaky
 * cluster). Parameterized per active provider, resolving a generic chat model.
 * Grounding: the `.markdown.prose` container and `<code>` rendering are confirmed
 * live by the @stable `playground/playground-output-data.spec.ts`.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// A Markdown-only prompt exercising the four most reliably-produced constructs:
// a level-2 heading, a three-item bulleted list, a bold run, and a fenced code
// block. "Only" + "no other text" keeps stray prose (and stray asterisks) out of
// the reply so the raw-token-absence guard is meaningful.
const PROMPT =
  "Respond in Markdown. Your whole answer MUST render as formatted Markdown, so " +
  "do NOT wrap the entire response in a code block. Include, in this order: a " +
  "level-2 heading written as `## Report`; then a bulleted list with the three " +
  "items `- alpha`, `- beta`, `- gamma`; then a separate paragraph containing the " +
  "word **important** in bold; then a single fenced code block whose only content " +
  "is print('hello'). Output nothing else.";

// Flows created by the template load are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and the
// app can fire more than one flows POST during template load (only one
// persists; deleting a transient id 404s harmlessly — deleteFlow treats 404 as
// done).
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
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Set the ChatInput node's "Input Text" on the canvas. The Playground chat input
// pre-fills from this node value, so setting it here makes the Playground prompt
// deterministic — typing into the Playground races an async re-injection of the
// template default ("Hello, how are you?"), which corrupts the value (mechanism
// documented in agent-multimodal-image-input.md).
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
  await waitForFlowSaveSettled(page);
}

async function openPlayground(page: Page): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  // Prefilled from the ChatInput node — deterministic, no typing race.
  await expect(chatInput).toHaveValue(PROMPT, { timeout: 15000 });
}

const targets = resolveTestTargets({ tier: "tool-calling", requires: "chat" });

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each
// other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Markdown Output [${label}]`, () => {
    test(
      "agent reply renders as correct Markdown in the Playground",
      { tag: ["@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("send a Markdown-only prompt and wait for the reply", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("assert the reply rendered Markdown to HTML tags", async () => {
          const response = page.locator(".markdown.prose").last();
          await expect(response).toBeVisible({ timeout: 60000 });

          // Heading rendered — the '## Report' line became a heading tag.
          await expect(
            response.locator("h1, h2, h3").first(),
          ).toBeVisible({ timeout: 60000 });
          // Bulleted list rendered — at least two list items.
          await expect
            .poll(async () => response.locator("li").count(), { timeout: 60000 })
            .toBeGreaterThanOrEqual(2);
          // Bold run rendered.
          await expect(response.locator("strong").first()).toBeVisible();
          // Fenced code block rendered (react-markdown emits <code>).
          await expect(response.locator("code").first()).toBeVisible();
        });

        await test.step("assert the raw Markdown tokens were NOT shown literally", async () => {
          // The distinctive guard: a plain-text / broken renderer would echo the
          // source verbatim. Rendered output has no `**` bold markers and no
          // `## ` heading marker in its visible text.
          const response = page.locator(".markdown.prose").last();
          const text = (await response.textContent()) ?? "";
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toContain("**");
          expect(text).not.toContain("## ");
        });
      },
    );
  });
}
