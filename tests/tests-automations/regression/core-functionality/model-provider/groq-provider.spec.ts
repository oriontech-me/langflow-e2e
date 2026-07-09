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

/**
 * Groq provider path (QA-CHECKLIST §7.6 "Configure and execute flow with
 * Groq") as a single component-centric journey, mirroring the §7.6 sibling
 * ollama-provider.spec.ts:
 *
 *   A blank flow (Chat Input → Groq → Chat Output) is configured with the
 *   Groq API key ON THE COMPONENT, a model is selected from the component's
 *   live-refreshed catalog, and a Playground run returns a non-empty reply —
 *   a real cloud inference, impossible without a valid key.
 *
 * Why no Settings → Model Providers test (premise change, found live): the
 * 1.11 nightly's Settings page does NOT list Groq ("No providers match your
 * search") even though GET /api/v1/models/providers includes it — the
 * component's api_key field is the configure surface. The UI/API divergence
 * is flagged on the PR as a product observation.
 *
 * False-positive guards: a probe against the Groq API turns a missing or
 * invalid key into an explicit skip; the custom_component/update 200 waiter
 * is armed around THIS key fill (a rejected key cannot satisfy it causally);
 * the model assert requires the exact GROQ_TEST_MODEL text; the reply assert
 * requires a genuine authenticated inference.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_TEST_MODEL = process.env.GROQ_TEST_MODEL ?? "llama-3.1-8b-instant";
const GROQ_API_BASE = "https://api.groq.com/openai/v1";

interface GroqProbe {
  reachable: boolean;
  reason: string;
}

// One probe per test: GET /models straight against the Groq API. Missing or
// invalid keys and a catalog without the test model surface as an explicit
// skip, never a silent green or a mid-test failure (zero-credit lesson from
// the Anthropic sibling, #503).
async function probeGroq(request: APIRequestContext): Promise<GroqProbe> {
  if (!GROQ_API_KEY) {
    return { reachable: false, reason: "GROQ_API_KEY not set in the environment" };
  }
  try {
    const res = await request.get(`${GROQ_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      timeout: 10000,
    });
    if (res.status() !== 200) {
      return {
        reachable: false,
        reason: `Groq API answered ${res.status()} for the configured key`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    if (!models.includes(GROQ_TEST_MODEL)) {
      return {
        reachable: false,
        reason: `model "${GROQ_TEST_MODEL}" not in the live Groq catalog (override via GROQ_TEST_MODEL)`,
      };
    }
    return { reachable: true, reason: "" };
  } catch {
    return { reachable: false, reason: "Groq API not reachable from the test host" };
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

test.describe("Groq Provider", () => {
  test(
    "the Groq component configures the API key and executes the flow",
    { tag: ["@stable", "@components", "@model-provider", "@playground"] },
    async ({ page, request }) => {
      const probe = await probeGroq(request);
      test.skip(!probe.reachable, probe.reason);

      // Per-run sentinel: logged (soft) — model obedience is not the contract.
      const token = `GROQ-${Date.now()}`;
      let flowId = "";

      try {
        await test.step("create a blank flow with Chat Input → Groq → Chat Output", async () => {
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

          await page.getByTestId("sidebar-search-input").fill("groq");
          await page.waitForSelector('[data-testid="groqGroq"]', { timeout: 30000 });
          await page.getByTestId("groqGroq").hover();
          await page.getByTestId("add-component-button-groq").click();

          await adjustScreenView(page);
          await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 10000 });

          // Connect by clicking source handle then target handle
          // (setup-playground pattern; testids live-scouted).
          await page.getByTestId("handle-chatinput-noshownode-chat message-source").click();
          await page.getByTestId("handle-groqmodel-shownode-input-left").click();
          await page.getByTestId("handle-groqmodel-shownode-model response-right").click();
          await page.getByTestId("handle-chatoutput-noshownode-inputs-target").click();
          await expect(page.locator(".react-flow__edge")).toHaveCount(2, { timeout: 8000 });
        });

        await test.step("configure the API key on the Groq node — the catalog refreshes live", async () => {
          const keyInput = page.getByTestId("popover-anchor-input-api_key");
          await expect(keyInput).toBeVisible({ timeout: 15000 });
          // api_key is real_time_refresh: the fill/blur triggers a
          // custom_component/update round-trip that re-fetches the model
          // catalog LIVE from the Groq API — wait for it to resolve 2xx
          // before trusting the dropdown (a rejected key cannot satisfy
          // this causally).
          const updatePromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/custom_component/update") &&
              r.request().method() === "POST" &&
              r.status() === 200,
            { timeout: 30000 },
          );
          await keyInput.fill(GROQ_API_KEY);
          await keyInput.blur();
          await updatePromise;
        });

        await test.step("select the test model in the component dropdown", async () => {
          await page.getByTestId("dropdown_str_model_name").click();
          const option = page
            .locator('[data-testid$="-option"]')
            .filter({ hasText: GROQ_TEST_MODEL })
            .first();
          await expect(option).toBeVisible({ timeout: 15000 });
          await option.click();
          await expect(page.getByTestId("value-dropdown-dropdown_str_model_name")).toContainText(
            GROQ_TEST_MODEL,
            { timeout: 10000 },
          );
          // Playground builds the PERSISTED flow — the selection must be saved.
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
          // Hard: the Groq cloud inference executed with the configured key.
          expect(reply.length).toBeGreaterThan(0);
          // Soft (family pattern): log whether the sentinel round-tripped.
          console.log(
            reply.includes(token)
              ? `sentinel echoed: input reached the Groq model (${token})`
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
