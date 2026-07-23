import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { isProviderComponentAvailable } from "../../../../helpers/provider-setup/probe-component-available";

/**
 * Mistral provider path (QA-CHECKLIST §7.6 "Configure and execute flow with
 * Mistral") as a single component-centric journey, mirroring the §7.6
 * siblings ollama-provider.spec.ts and groq-provider.spec.ts:
 *
 *   A blank flow (Chat Input → MistralAI → Chat Output) is configured with
 *   the Mistral API key ON THE COMPONENT, a model is selected, and a
 *   Playground run returns a non-empty reply — a real cloud inference,
 *   impossible without a valid key.
 *
 * Why component-centric: like Groq (#499), Mistral has no Settings → Model
 * Providers surface on 1.11 — GET /api/v1/models/providers does not list it
 * at all. Unlike Groq, the component's model_name dropdown is a STATIC list
 * (no real_time_refresh on api_key), so there is no live-catalog request to
 * await — the authenticated execution carries the key-works proof, and the
 * fixture's flow-error monitor fails the test on an auth error.
 *
 * False-positive guards: a probe against the Mistral API turns a missing or
 * invalid key into an explicit skip; the model assert requires the exact
 * MISTRAL_TEST_MODEL text (the component defaults to codestral-latest — a
 * skipped selection fails); the reply assert requires a genuine inference.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_TEST_MODEL = process.env.MISTRAL_TEST_MODEL ?? "mistral-small-latest";
const MISTRAL_API_BASE = "https://api.mistral.ai/v1";

interface MistralProbe {
  reachable: boolean;
  reason: string;
}

// One probe per test: GET /models straight against the Mistral API. Missing
// or invalid keys and a catalog without the test model surface as an explicit
// skip, never a silent green or a mid-test failure (zero-credit lesson from
// the Anthropic sibling, #503).
async function probeMistral(request: APIRequestContext): Promise<MistralProbe> {
  if (!MISTRAL_API_KEY) {
    return { reachable: false, reason: "MISTRAL_API_KEY not set in the environment" };
  }
  try {
    const res = await request.get(`${MISTRAL_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` },
      timeout: 10000,
    });
    if (res.status() !== 200) {
      return {
        reachable: false,
        reason: `Mistral API answered ${res.status()} for the configured key`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    if (!models.includes(MISTRAL_TEST_MODEL)) {
      return {
        reachable: false,
        reason: `model "${MISTRAL_TEST_MODEL}" not in the live Mistral catalog (override via MISTRAL_TEST_MODEL)`,
      };
    }
    return { reachable: true, reason: "" };
  } catch {
    return { reachable: false, reason: "Mistral API not reachable from the test host" };
  }
}

async function waitForRunToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

test.describe.configure({ mode: "serial" });

test.describe("Mistral Provider", () => {
  test(
    "the MistralAI component configures the API key and executes the flow",
    { tag: ["@stable", "@components", "@model-provider", "@playground"] },
    async ({ page, request }) => {
      // Build-side pre-flight (#907 / LE-1987): when the nightly ships without
      // `langchain-mistralai`, Langflow hides the MistralAI component entirely,
      // so the sidebar `waitForSelector('[data-testid="mistralMistralAI"]')`
      // would hard-fail after 30s. Skip explicitly instead — the component
      // genuinely is not in this build. Runs BEFORE the cloud-API probe: no
      // point checking the key when the component cannot be placed at all.
      const componentAvailable = await isProviderComponentAvailable(
        request,
        "mistral",
      );
      test.skip(
        !componentAvailable,
        "MistralAI component not available in this Langflow build — langchain-mistralai missing (#907, LE-1987)",
      );

      const probe = await probeMistral(request);
      test.skip(!probe.reachable, probe.reason);

      // Per-run sentinel: logged (soft) — model obedience is not the contract.
      const token = `MISTRAL-${Date.now()}`;
      let flowId = "";

      try {
        await test.step("create a blank flow with Chat Input → MistralAI → Chat Output", async () => {
          await awaitBootstrapTest(page);
          await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
          const flowCreation = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/flows") &&
              r.request().method() === "POST" &&
              r.status() === 201,
            { timeout: 15000 },
          );
          await page.getByTestId("blank-flow").click();
          flowId = ((await (await flowCreation).json()) as { id: string }).id;

          await expect(page.getByTestId("sidebar-search-input")).toBeVisible({ timeout: 30000 });

          await page.getByTestId("sidebar-search-input").fill("chat output");
          await page.waitForSelector('[data-testid="input_outputChat Output"]', { timeout: 30000 });
          await page.getByTestId("input_outputChat Output").hover();
          await page.getByTestId("add-component-button-chat-output").click();
          await zoomOut(page, 2);

          await page.getByTestId("sidebar-search-input").fill("chat input");
          await page.waitForSelector('[data-testid="input_outputChat Input"]', { timeout: 30000 });
          await page
            .getByTestId("input_outputChat Input")
            .dragTo(page.locator('//*[@id="react-flow-id"]'), {
              targetPosition: { x: 100, y: 100 },
            });

          await page.getByTestId("sidebar-search-input").fill("mistral");
          await page.waitForSelector('[data-testid="mistralMistralAI"]', { timeout: 30000 });
          await page.getByTestId("mistralMistralAI").hover();
          await page.getByTestId("add-component-button-mistralai").click();

          await adjustScreenView(page);
          await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 10000 });

          // Connect by clicking source handle then target handle
          // (setup-playground pattern; testids live-scouted).
          await page.getByTestId("handle-chatinput-noshownode-chat message-source").click();
          await page.getByTestId("handle-mistralaimodelcomponent-shownode-input-left").click();
          await page.getByTestId("handle-mistralaimodelcomponent-shownode-model response-right").click();
          await page.getByTestId("handle-chatoutput-noshownode-inputs-target").click();
          await expect(page.locator(".react-flow__edge")).toHaveCount(2, { timeout: 8000 });
        });

        await test.step("configure the API key on the MistralAI node", async () => {
          const keyInput = page.getByTestId("popover-anchor-input-api_key");
          await expect(keyInput).toBeVisible({ timeout: 15000 });
          // No real_time_refresh on this field (unlike Groq) — the model
          // dropdown is a static list; the authenticated execution below is
          // what proves the key works.
          await keyInput.fill(MISTRAL_API_KEY);
          await keyInput.blur();
        });

        await test.step("select the test model in the component dropdown", async () => {
          await page.getByTestId("dropdown_str_model_name").click();
          const option = page
            .locator('[data-testid$="-option"]')
            .filter({ hasText: MISTRAL_TEST_MODEL })
            .first();
          await expect(option).toBeVisible({ timeout: 15000 });
          await option.click();
          // Exact-name assert: the component defaults to codestral-latest, so
          // a silently skipped selection cannot pass.
          await expect(page.getByTestId("value-dropdown-dropdown_str_model_name")).toContainText(
            MISTRAL_TEST_MODEL,
            { timeout: 10000 },
          );
          // Playground builds the PERSISTED flow — key + selection must be saved.
          await waitForFlowSaveSettled(page);
        });

        await test.step("execute the flow through the Playground", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          const chatInput = page.getByTestId("input-chat-playground").last();
          await expect(chatInput).toBeVisible({ timeout: 30000 });
          await chatInput.fill(`Repeat this token exactly and nothing else: ${token}`);
          await page.getByTestId("button-send").last().click();
          await waitForRunToFinish(page);

          const aiMessage = page.getByTestId("div-chat-message").last();
          await expect(aiMessage).toBeVisible({ timeout: 60000 });
          const reply = (await aiMessage.innerText()).trim();
          // Hard: the Mistral cloud inference executed with the configured key.
          expect(reply.length).toBeGreaterThan(0);
          // Soft (family pattern): log whether the sentinel round-tripped.
          console.log(
            reply.includes(token)
              ? `sentinel echoed: input reached the Mistral model (${token})`
              : `sentinel not echoed (model obedience); reply: ${reply.slice(0, 80)}`,
          );
        });
      } finally {
        if (flowId) {
          const bearer = await getAuthToken(request);
          await deleteFlow(request, flowId, { headers: { Authorization: bearer } }).catch(() => {});
        }
      }
    },
  );
});
