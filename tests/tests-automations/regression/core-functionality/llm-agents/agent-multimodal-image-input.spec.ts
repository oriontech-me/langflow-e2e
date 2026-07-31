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
 * Agent multimodal image input (QA-CHECKLIST §6.5, "Image passed via input
 * handle is processed correctly").
 *
 *   Test 1 — an image attached to the chat input flows through the
 *            ChatInput.message → Agent.input handle to a vision-capable model,
 *            and the agent's response describes the image content.
 *   Test 2 — negative control: the same prompt with NO image must not produce
 *            the image-specific keyword, proving Test 1's match is caused by the
 *            processed image (not the prompt or chance).
 *
 * Parameterized per active provider, resolving a vision-capable chat model
 * (skips a provider with none). Mechanism scouted on 1.11.0.dev33: the ChatInput
 * node has no canvas file field — the only image-attach path is the chat input
 * widget (`input-wrapper` file input), which feeds the confirmed input handle.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const IMAGE_PATH = "tests/assets/media/chain.png";
const IMAGE_ALT = "chain.png";
const PROMPT = "what is this image? describe it";
// chain.png is a chain/links graphic. The predicate must only match words that
// require having SEEN it — measured replies: "two vertical metal chains", "a
// stylized vector illustration of two chains".
//
// `link` was in this set and made the test unfalsifiable (#964): with NO image
// attached the model answers "please upload an image or provide a link to one",
// which matched — so the test passed while proving nothing about the image ever
// reaching the model (verified by force-failure: 1 passed with the image
// detached). Word-bounded `chain(s)` only.
const DESCRIBES_IMAGE = /\bchains?\b|\binkscape\b/i;
const IMAGE_SPECIFIC = /chain/i;
// The two ways this test's real failure looks — the model says it got no image,
// or that it cannot do images at all (the recurrent #964 signature on the
// retired `gemini-2.5-flash`). Asserted separately so the failure names itself
// instead of surfacing as "pattern not found".
const NO_IMAGE_REACHED_MODEL =
  /(cannot|can not|can't|unable to|not able to)[\s\S]{0,40}(interpret|describe|process|analy[sz]e|see|view)|did not (provide|attach|include)|no image (was )?(provided|attached|included)|please (upload|provide|attach|share)/i;

// Flows created by the template load are tracked here and deleted BY ID in
// afterEach. `SimpleAgentTemplatePage.load()` does NO cleanup (post-#553
// contract: never a global cleanAllFlows, which races parallel workers), so
// without this every run left one "Simple Agent" behind (#964). The app can fire
// more than one flows POST per load — only one persists, and deleting a transient
// id 404s harmlessly (deleteFlow treats 404 as done).
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

// The agent's rendered reply, anchored to the AI chat bubble.
//
// `.markdown.prose` alone is NOT the reply (#964): the canvas renders 6 of them
// on this template — the Simple Agent sticky note is one — so `.last()` silently
// matched the sticky note whenever no reply rendered, and a hard build failure
// ("Error calling model 'gemini-2.5-flash' (Not Found): 404") was reported as a
// content mismatch against the template's help text. Anchoring on the AI bubble
// (`chat-message-AI-<text>`, the 1.12 container) makes a missing reply fail as a
// missing reply.
async function agentReply(page: Page) {
  const bubble = page.locator('[data-testid^="chat-message-AI-"]').last();
  await expect(
    bubble,
    "no AI chat message rendered — the agent produced no reply (check the flow build error)",
  ).toBeVisible({ timeout: 60000 });
  return bubble.locator(".markdown.prose").last();
}

// Set the ChatInput node's "Input Text" on the canvas. The Playground chat input
// pre-fills from this node value, so setting it here makes the Playground prompt
// deterministic — typing into the Playground races an async re-injection of the
// template default ("Hello, how are you?"), which corrupts the value.
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
  // Playground builds/reads the persisted flow — the new value must be saved.
  await waitForFlowSaveSettled(page);
}

// Open the Playground and (optionally) attach an image through the chat input
// widget (`input-wrapper` file input) — the only UI path to attach an image; it
// feeds the ChatInput → Agent input handle. The prompt is prefilled from the
// ChatInput node value set via setChatInputText().
async function openPlayground(page: Page, attachImage: boolean): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  // Prefilled from the ChatInput node — deterministic, no typing race.
  await expect(chatInput).toHaveValue(PROMPT, { timeout: 15000 });

  if (attachImage) {
    await page
      .locator('[data-testid="input-wrapper"] input[type="file"]')
      .setInputFiles(IMAGE_PATH);
    // Attachment renders as an <img alt="chain.png"> preview, not literal text.
    await expect(page.locator(`img[alt="${IMAGE_ALT}"]`).first()).toBeVisible({
      timeout: 30000,
    });
  }
}

const targets = resolveTestTargets({ tier: "tool-calling", requires: "vision" });

// Serial: each provider block loads the Simple Agent template and runs it, and
// the Playground work is heavy enough that concurrent provider blocks starve the
// single backend. (It does NOT protect against flow wiping — load() deletes
// nothing; teardown is the id-scoped afterEach above.)
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Multimodal Image Input [${label}]`, () => {
    test(
      "image via input handle is described by the agent",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("attach the image and send it through the input handle", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page, /* attachImage */ true);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("assert the vision model described the image content", async () => {
          // The image reached the model via ChatInput → Agent.input: the reply
          // describes the actual image (chain/links), not a generic answer.
          const response = await agentReply(page);
          await expect(response).toContainText(DESCRIBES_IMAGE, { timeout: 60000 });
          const text = (await response.textContent()) ?? "";
          // The image reached the model at all — this is the #964 signature.
          expect(
            text,
            "the agent replied that it received no image / cannot process images — the attached image did not reach the model",
          ).not.toMatch(NO_IMAGE_REACHED_MODEL);
          // Secondary guard against a one-word answer.
          expect(text.length).toBeGreaterThan(50);
        });
      },
    );

    test(
      "negative control — no image, no image-specific description",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("run the same prompt with NO image attached", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page, /* attachImage */ false);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("assert the response does not describe a chain", async () => {
          // With no image the model cannot describe the chain — so the keyword
          // only appears in Test 1 because the image was actually processed.
          const response = await agentReply(page);
          await expect(response).toBeVisible({ timeout: 60000 });
          const text = (await response.textContent()) ?? "";
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toMatch(IMAGE_SPECIFIC);
        });
      },
    );
  });
}
