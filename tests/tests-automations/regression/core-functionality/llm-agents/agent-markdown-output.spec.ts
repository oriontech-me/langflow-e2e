import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
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
 *   - every construct the REPLY ACTUALLY CARRIES renders as its tag
 *     (h1|h2|h3, li, strong, code), AND
 *   - the visible text does NOT contain the raw tokens (`**`, `## `).
 * A plain-text/broken renderer would echo `**bold**` / `## Heading` literally and
 * fail the pairing — that is the false-positive guard.
 *
 * **The expectation is derived from the reply, not from the prompt (#1790).**
 * Until then the four constructs were all required as tags, which made the
 * assertion depend on the model obeying every clause of the prompt — the
 * dependence #1187 rules out. It failed exactly that way on run 34980302630:
 * `claude-haiku-4-5` produced heading, list and code and skipped bold, and the
 * test went red on `strong` with nothing wrong in the product. The constructs are
 * now read out of the run's own persisted reply
 * (`GET /api/v1/monitor/messages?flow_id=…&sender=Machine`), so a model that
 * skips bold is not a failure while a renderer that drops a bold the model DID
 * write still is — twice over, through the missing tag and through the raw `**`
 * left in the visible text.
 *
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

/**
 * The constructs this spec knows how to check, each with how it appears in the
 * Markdown SOURCE and what the renderer must emit for it. `inSource` reads the
 * reply the run persisted, so only what the model actually wrote is asserted.
 */
const CONSTRUCTS: Array<{
  name: string;
  inSource: (raw: string) => boolean;
  selector: string;
  min: number;
}> = [
  {
    name: "heading",
    inSource: (raw) => /^#{1,3} \S/m.test(raw),
    selector: "h1, h2, h3",
    min: 1,
  },
  {
    name: "bulleted list",
    inSource: (raw) => (raw.match(/^[-*] \S/gm) ?? []).length >= 2,
    selector: "li",
    min: 2,
  },
  {
    name: "bold run",
    inSource: (raw) => /\*\*[^*\n]+\*\*/.test(raw),
    selector: "strong",
    min: 1,
  },
  {
    name: "fenced code block",
    inSource: (raw) => /```/.test(raw),
    selector: "code",
    min: 1,
  },
];

// Flows created by the template load are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and the
// app can fire more than one flows POST during template load (only one
// persists; deleting a transient id 404s harmlessly — deleteFlow treats 404 as
// done).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<string> {
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
    // The POM returns the template flow's id — the handle the monitor read below
    // filters on. The accumulator above stays: it also catches the entry point's
    // own `New Flow`, which the id alone would leak.
    return await new SimpleAgentTemplatePage(page).load(options);
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

/**
 * The reply as the run stored it, i.e. the Markdown SOURCE behind the rendered
 * bubble. Polled rather than read once: the `Machine` row appears BEFORE its text
 * does — measured at 1 Hz on 1.13.0.dev12, two consecutive samples carried
 * `text: ""` while the bubble already showed the answer, and the third carried
 * the 114-character reply. `content_blocks` stayed empty on that run, so `text`
 * is the field to read.
 */
async function readPersistedReply(
  request: APIRequestContext,
  flowId: string,
): Promise<string> {
  const bearer = await getAuthToken(request);
  let reply = "";
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
          params: { flow_id: flowId, sender: "Machine" },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";
        const withText = messages.filter(
          (m: { text?: unknown }) => typeof m.text === "string" && m.text.trim() !== "",
        );
        if (withText.length === 0) return "no Machine message with text persisted yet";
        reply = (withText[withText.length - 1] as { text: string }).text;
        return "reply-persisted";
      },
      { timeout: 60000 },
    )
    .toBe("reply-persisted");
  return reply;
}

/** Waits until the bubble renders `selector` at least `min` times. */
async function expectRendered(
  bubble: Locator,
  construct: { name: string; selector: string; min: number },
): Promise<void> {
  await expect
    .poll(async () => bubble.locator(construct.selector).count(), {
      timeout: 30000,
      message:
        `the persisted reply carries a ${construct.name}, so the Playground must render ` +
        `it as \`${construct.selector}\` (at least ${construct.min}). The model wrote the ` +
        `construct — a missing tag here is the renderer, not the model`,
    })
    .toBeGreaterThanOrEqual(construct.min);
}

const targets = resolveTestTargets({ tier: "tool-calling", requires: "chat" });

// Each provider block is serial on its own, NOT the whole file. A file-level
// `mode: "serial"` skips every later block once one fails, which is how run
// 34980302630 lost the `[google]` observation after `[anthropic]` went red
// (#1790) — the collateral-skip class #1690 owns for the five files it lists.
// `--workers=1` (agent-family rule) is what keeps two blocks from loading named
// templates at the same time; nothing here needs cross-block ordering, since the
// POM stopped wiping flows in #553 and cleanup is id-scoped in afterEach.
for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe.serial(`Agent Markdown Output [${label}]`, () => {
    test(
      "agent reply renders as correct Markdown in the Playground",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const flowId = await loadAgent(page, options);
        let reply = "";

        await test.step("send a Markdown-only prompt and wait for the reply", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("read the reply as the run persisted it", async () => {
          reply = await readPersistedReply(request, flowId);
        });

        await test.step("assert every construct the reply carries rendered as HTML", async () => {
          const response = page.locator(".markdown.prose").last();
          await expect(response).toBeVisible({ timeout: 60000 });

          const present = CONSTRUCTS.filter((c) => c.inSource(reply));
          expect(
            present.length,
            "the persisted reply carries no Markdown at all, so nothing can exercise the " +
              `renderer — the model ignored the prompt. Reply: ${JSON.stringify(reply.slice(0, 200))}`,
          ).toBeGreaterThan(0);

          for (const construct of present) {
            await expectRendered(response, construct);
          }
        });

        await test.step("assert the raw Markdown tokens were NOT shown literally", async () => {
          // The distinctive guard: a plain-text / broken renderer would echo the
          // source verbatim. Rendered output has no `**` bold markers and no
          // `## ` heading marker in its visible text. This half is independent of
          // what the model chose to write: it fails on whatever construct IS there.
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
