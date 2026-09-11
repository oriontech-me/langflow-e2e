import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { clearApiKeyBadges } from "../../../helpers/ui/clear-api-key-badges";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach — the legacy spec built a
// flow via the blank-flow UI and leaked it every run (#490/#681 pattern; the
// response ids are authoritative and worker-safe).
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
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
        .catch(() => {});
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

test(
  "should copy code from playground modal",
  {
    tag: ["@stable", "@release", "@playground"],
  },
  async ({ page }) => {
    trackCreatedFlows(page);

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // A real playground send runs below, so gate on provider HEALTH rather than on
    // the mere presence of the env var: a key that exists but is drained blocks
    // the backend past gunicorn's 300s timeout and kills the shard's Langflow
    // worker (#1029). After the .env load, so a key that lives only in .env is
    // visible to the gate on a local run.
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });

    await page.getByTestId("blank-flow").click();
    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");

    await page
      .getByTestId("input_outputChat Output")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 400, y: 100 },
      });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");

    await page
      .getByTestId("input_outputChat Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 100 },
      });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("openai");

    await page
      .getByTestId("openaiOpenAI")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 200 },
      });

    await initialGPTsetup(page);
    await adjustScreenView(page);

    await page.getByText("OpenAI", { exact: true }).last().click();

    await expect(
      page.getByTestId("handle-chatinput-noshownode-chat message-source"),
    ).toBeVisible();

    await clearApiKeyBadges(page);

    await page
      .getByTestId("popover-anchor-input-api_key")
      .fill(process.env.OPENAI_API_KEY || "");

    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-openaimodelcomponent-shownode-input-left")
      .click();

    await page
      .getByTestId("handle-openaimodelcomponent-shownode-model response-right")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .last()
      .click();
    await adjustScreenView(page);

    await page.getByRole("button", { name: "Playground", exact: true }).click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });
    await page.getByTestId("input-chat-playground").click();
    await page
      .getByTestId("input-chat-playground")
      .fill(
        "Could you provide a Python example for a 'Hello, World!' program?",
      );

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.getByTestId("api_tab_python").isVisible({
      timeout: 100000,
    });

    await page.waitForSelector('[data-testid="copy-code-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("copy-code-button").first().click();

    const handle = await page.evaluateHandle(() =>
      navigator.clipboard.readText(),
    );
    const clipboardContent = await handle.jsonValue();
    expect(clipboardContent.length).toBeGreaterThan(0);
    expect(clipboardContent).toContain("Hello");
  },
);

// The quarantine's TODO guessed that "current Langflow behavior may not match what
// was originally expected". Measured on 1.13.0.dev9, the product is fine and the
// EXPECTATION was stale: `getByText("Langflow Chat")` targets the i18n value of
// `misc.chatTitle`, a key that occurs exactly ONCE in the whole frontend bundle —
// inside the translation dictionary, with zero call sites — so the string is never
// rendered and the assertion could not pass at any timeout (#1791; same shape as
// the dead `viewExchange` key). Both testids the test drives are live:
// `playground-btn-flow-io` is the Playground trigger 10+ specs already click, and
// `playground-btn-flow` is its disabled twin, rendered with
// `cursor-not-allowed text-muted-foreground` — which is exactly what the first
// assertion wants. The modal is therefore asserted by its own dialog role/name.
const PLAYGROUND_DIALOG = { role: "dialog" as const, name: "Playground" };

test(
  "playground button should be enabled or disabled",
  { tag: ["@stable", "@release", "@workspace", "@playground"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });

    await page.getByTestId("blank-flow").click();

    await expect(page.getByTestId("playground-btn-flow")).toBeDisabled();

    await expect(
      page.getByRole(PLAYGROUND_DIALOG.role, { name: PLAYGROUND_DIALOG.name }),
    ).toBeHidden();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");

    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .locator('//*[@id="input_outputChat Output"]')
      .dragTo(page.locator('//*[@id="react-flow-id"]'));

    await adjustScreenView(page);

    await page.getByTestId("playground-btn-flow-io").click();

    await expect(
      page.getByRole(PLAYGROUND_DIALOG.role, { name: PLAYGROUND_DIALOG.name }),
    ).toBeVisible({ timeout: 30000 });
  },
);
