import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { isProviderComponentAvailable } from "../../../../helpers/provider-setup/probe-component-available";

/**
 * Ollama provider path (QA-CHECKLIST §7.6 "Configure and execute flow with
 * Ollama (local model)") as a provider-centric journey, mirroring
 * openai-provider / google-provider for the one provider that is a LOCAL
 * SERVICE instead of a keyed cloud API:
 *
 *   Test 1 — configure the Ollama base URL in Settings → Model Providers;
 *            assert the save REQUESTS succeed (validate-provider + variables
 *            persistence, both 2xx) so a no-op save cannot pass.
 *   Test 2 — a canvas flow (Chat Input → Ollama → Chat Output) pointed at
 *            the local instance lists the locally pulled model in the
 *            component's LIVE model dropdown (deterministic connectivity
 *            proof — Langflow's static Ollama catalog is independent of the
 *            instance), selects it, and a Playground run returns a
 *            non-empty reply. The per-run sentinel is logged, not asserted
 *            (small local models don't reliably echo — family pattern).
 *
 * Requires a local Ollama instance (see the spec doc for the provisioning
 * commands). When Langflow runs in Docker, its container must be started
 * with LANGFLOW_SSRF_ALLOWED_HOSTS=host.docker.internal — the nightly's
 * SSRF protection otherwise rejects the private address with a 400
 * (discovered live; documented in the spec doc). Without a reachable
 * instance both tests skip with an explicit reason — the same
 * missing-dependency contract the keyed providers use for absent env keys.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Reachability probe from the TEST host.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
// The URL typed INTO Langflow — how the (dockerized) Langflow reaches the
// instance; host.docker.internal resolves to the host from the container.
const OLLAMA_BASE_URL_FROM_LANGFLOW =
  process.env.OLLAMA_BASE_URL_FROM_LANGFLOW ?? "http://host.docker.internal:11434";
// The model to exercise. Left EMPTY on purpose when unset: the model is baked
// into the CI image by build-ollama-image.yml (docker/ollama-e2e/Dockerfile,
// `ARG OLLAMA_E2E_MODEL`), so the instance — not this file — is the source of
// truth. A hardcoded fallback used to live here, and it lied: with the env var
// unset, or the baked model changed, the probe reported "model not pulled" and
// the test SKIPPED silently on the very surface it exists to guard. Unset now
// means "whatever this instance serves"; the workflows still pin it explicitly.
const OLLAMA_TEST_MODEL = process.env.OLLAMA_TEST_MODEL ?? "";

interface OllamaProbe {
  reachable: boolean;
  // The resolved model: the pinned one when set, else the instance's first.
  model: string;
  models: string[];
  reason: string;
}

// One probe per worker: GET /api/tags from the test host. Unreachable or
// model-less instances surface as an explicit skip, never a silent green.
async function probeOllama(request: APIRequestContext): Promise<OllamaProbe> {
  try {
    const res = await request.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 5000 });
    if (res.status() !== 200) {
      return {
        reachable: false,
        model: "",
        models: [],
        reason: `local Ollama at ${OLLAMA_BASE_URL} answered ${res.status()}`,
      };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    // Pinned (every CI workflow does): the exact model must be there, so a
    // drifted image is a loud skip reason instead of a silent substitution.
    if (OLLAMA_TEST_MODEL) {
      if (!models.includes(OLLAMA_TEST_MODEL)) {
        return {
          reachable: false,
          model: "",
          models,
          reason: `model "${OLLAMA_TEST_MODEL}" not pulled on the local Ollama (has: ${models.join(", ") || "none"})`,
        };
      }
      return { reachable: true, model: OLLAMA_TEST_MODEL, models, reason: "" };
    }
    // Unpinned: follow the instance. Only a model-less instance skips.
    if (models.length === 0) {
      return {
        reachable: false,
        model: "",
        models,
        reason: `local Ollama at ${OLLAMA_BASE_URL} serves no model — pull one (e.g. \`ollama pull llama3.2:1b\`) or set OLLAMA_TEST_MODEL`,
      };
    }
    return { reachable: true, model: models[0], models, reason: "" };
  } catch {
    return {
      reachable: false,
      model: "",
      models: [],
      reason: `local Ollama not reachable at ${OLLAMA_BASE_URL} — see the spec doc's provisioning commands`,
    };
  }
}

// Delete a previously persisted OLLAMA_BASE_URL variable so the test always
// exercises a REAL first-time configure: with the saved value pre-filled the
// Save button stays disabled (no change to save) and the request-level
// asserts could never fire on a re-run.
async function resetOllamaProviderVariable(request: APIRequestContext): Promise<void> {
  const bearer = await getAuthToken(request);
  const headers = { Authorization: bearer };
  const res = await request.get("/api/v1/variables/", { headers });
  if (res.status() !== 200) return;
  const variables = (await res.json()) as Array<{ id: string; name: string }>;
  for (const v of variables) {
    if (v.name === "OLLAMA_BASE_URL") {
      await request.delete(`/api/v1/variables/${v.id}`, { headers }).catch(() => {});
    }
  }
}

// Waits until the playground turn has FULLY completed, on the model-agnostic
// signal used across the playground specs: the bot bubble mounted, then the
// generating indicator cleared (`button-stop` hidden, `button-send` back).
//
// The previous version probed the Stop button with `isVisible({ timeout:
// 10000 })` and, when it did not show up in time, skipped the wait entirely —
// falling straight into the caller's 60s wait for the reply. On a CI runner,
// where `llama3.2:1b` inference on shared CPU is an order of magnitude slower
// than locally, that is precisely how the run was declared finished before it
// had produced anything: daily 2026-07-15 failed 3/3 on
// `div-chat-message not found` after ~100s (#931).
async function waitForRunToFinish(page: Page): Promise<void> {
  // The bubble mounts when the turn BEGINS, so this also rules out the
  // "checked completion before generation started" race (#354).
  await expect(page.getByTestId("div-chat-message")).toHaveCount(1, { timeout: 180000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 240000 });
  await expect(page.getByTestId("button-send").last()).toBeVisible({ timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Ollama Provider", () => {
  test(
    "Ollama base URL is configured via Settings → Model Providers",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const probe = await probeOllama(request);
      test.skip(!probe.reachable, probe.reason);

      await resetOllamaProviderVariable(request);
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open Settings → Model Providers → Ollama", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Model Providers",
          { timeout: 10000 },
        );
        await page.getByTestId("provider-item-Ollama").click();
      });

      await test.step("enter the base URL and save — assert the save requests succeed", async () => {
        const urlInput = page.getByTestId("provider-variable-input-OLLAMA_BASE_URL");
        await expect(urlInput).toBeVisible({ timeout: 10000 });
        await urlInput.fill(OLLAMA_BASE_URL_FROM_LANGFLOW);

        // Arm both waiters BEFORE clicking so the pass is caused by THIS
        // save, not a state a prior configuration left behind (family
        // pattern from openai/google-provider).
        const validatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/models/validate-provider") &&
            r.request().method() === "POST",
          { timeout: 60000 },
        );
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables") &&
            ["POST", "PATCH"].includes(r.request().method()),
          { timeout: 60000 },
        );

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        const [validateResp, persistResp] = await Promise.all([
          validatePromise,
          persistPromise,
        ]);
        // validate-provider 2xx = the endpoint answered; variables 2xx = the
        // URL is persisted.
        expect(validateResp.ok()).toBe(true);
        expect(persistResp.ok()).toBe(true);

        // The BODY is what proves Langflow reached the live instance: the
        // endpoint answers HTTP 200 with `{ valid: false, error: … }` for a URL
        // it could not reach (measured on 1.12.0.dev9 with the SSRF allowlist
        // absent), so the status alone is a weak assert. Without this the
        // failure surfaces only as the persistence waiter timing out at 60s,
        // naming nothing (#931).
        const validateBody = (await validateResp.json()) as {
          valid?: boolean;
          error?: string | null;
        };
        expect(
          validateBody.valid,
          `validate-provider rejected the base URL: ${validateBody.error ?? "no reason given"}`,
        ).toBe(true);
      });
    },
  );

  test(
    "the Ollama component lists the local model live and executes the flow",
    { tag: ["@regression", "@model-provider", "@components", "@playground"] },
    async ({ page, request }) => {
      // Local CPU inference on a shared CI runner is far slower than on a dev
      // box (~13s locally vs. >100s in the daily), and the waits below are
      // sized for it — the default 5-min budget would cut them short.
      test.setTimeout(8 * 60 * 1000);

      // Build-side pre-flight (#931). 1.12 moved the Ollama components into the
      // separate `lfx-ollama` distribution (`lfx.components.ollama` is now a
      // shim, removed at M4 — see #1040). When that distribution is missing from
      // the image the component vanishes from the registry and the sidebar wait
      // below dies after 30s naming nothing; this is what broke the daily on
      // 2026-07-23/24. Unlike Groq/Mistral — absent by design, hence a skip
      // (#1039) — `lfx-ollama` SHIPS in the stock nightly, so its absence is a
      // packaging regression that must stay visible: fail, attributed, in ~1s.
      const componentAvailable = await isProviderComponentAvailable(request, "ollama");
      expect(
        componentAvailable,
        "Ollama component not exposed by this Langflow build — the `lfx-ollama` distribution that ships it is not installed (#931)",
      ).toBe(true);

      const probe = await probeOllama(request);
      test.skip(!probe.reachable, probe.reason);

      // Per-run sentinel: logged (soft) — model obedience is not the contract.
      const token = `OLLAMA-${Date.now()}`;
      let flowId = "";

      try {
        await test.step("create a blank flow with Chat Input → Ollama → Chat Output", async () => {
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

          await page.getByTestId("sidebar-search-input").fill("ollama");
          await page.waitForSelector('[data-testid="ollamaOllama"]', { timeout: 30000 });
          await page.getByTestId("ollamaOllama").hover();
          await page.getByTestId("add-component-button-ollama").click();

          await adjustScreenView(page);
          await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 10000 });

          // Connect by clicking source handle then target handle
          // (setup-playground pattern).
          await page.getByTestId("handle-chatinput-noshownode-chat message-source").click();
          await page.getByTestId("handle-chatollamacomponent-shownode-input-left").click();
          await page.getByTestId("handle-chatollamacomponent-shownode-text-right").click();
          await page.getByTestId("handle-chatoutput-noshownode-inputs-target").click();
          await expect(page.locator(".react-flow__edge")).toHaveCount(2, { timeout: 8000 });
        });

        await test.step("point the Ollama node at the local instance", async () => {
          const baseUrl = page.getByTestId("popover-anchor-input-base_url");
          await expect(baseUrl).toBeVisible({ timeout: 15000 });
          // The blur triggers a custom_component/update round-trip that
          // re-fetches the model list from the NEW url — wait for it to
          // resolve 2xx before trusting the dropdown (an SSRF-blocked or
          // unreachable URL answers 400 here).
          const updatePromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/v1/custom_component/update") &&
              r.request().method() === "POST" &&
              r.status() === 200,
            { timeout: 30000 },
          );
          await baseUrl.fill(OLLAMA_BASE_URL_FROM_LANGFLOW);
          await baseUrl.blur();
          await updatePromise;
        });

        await test.step("the LIVE model dropdown lists the locally pulled model — select it", async () => {
          await page.getByTestId("dropdown_str_model_name").click();
          const option = page
            .locator('[data-testid$="-option"]')
            .filter({ hasText: probe.model })
            .first();
          // THE connectivity assert: passing requires the component to have
          // enumerated the real local instance (the static catalog does not
          // contain the pulled model's tag). `probe.model` is the model the
          // instance actually serves, so this cannot drift from the CI image.
          await expect(option).toBeVisible({ timeout: 15000 });
          await option.click();
          await expect(page.getByTestId("value-dropdown-dropdown_str_model_name")).toContainText(
            probe.model,
            { timeout: 10000 },
          );
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
          // Hard: the selected local model executed and returned output.
          expect(reply.length).toBeGreaterThan(0);
          // Soft (family pattern): log whether the sentinel round-tripped.
          console.log(
            reply.includes(token)
              ? `sentinel echoed: input reached the local model (${token})`
              : `sentinel not echoed (small-model obedience); reply: ${reply.slice(0, 80)}`,
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
