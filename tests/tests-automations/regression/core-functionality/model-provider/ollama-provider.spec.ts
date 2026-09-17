import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import {
  addComponentFromSidebar,
  dragComponentFromSidebar,
} from "../../../../helpers/flows/add-component-from-sidebar";
import { isProviderComponentAvailable } from "../../../../helpers/provider-setup/probe-component-available";
import {
  readOllamaCapabilities,
  resolveComponentTestModel,
} from "../../../../helpers/provider-setup/ollama-capabilities";
import {
  ollamaBaseUrl,
  ollamaBaseUrlFromLangflow,
  ollamaTestModel,
} from "../../../../helpers/provider-setup/ollama-endpoint";
import {
  assertNodeConfigHeld,
  waitForNodeConfigSettled,
} from "../../../../helpers/flows/node-config-guard";
import { armProviderSave } from "../../../../helpers/provider-setup/provider-panel-save";

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
 * commands). When Langflow runs in Docker, LANGFLOW_SSRF_ALLOWED_HOSTS must
 * cover the private address its container reaches Ollama on —
 * host.docker.internal resolves to one, and the nightly's SSRF protection
 * otherwise refuses it (validate-provider reports `valid: false`, the
 * component's model-list fetch answers 400). scripts/start-langflow-docker.sh
 * and every CI lane already allow-list the RFC-1918 ranges
 * (172.16.0.0/12,10.0.0.0/8,192.168.0.0/16), which cover it; the bare hostname
 * is accepted too (both measured on 1.13.0.dev12 — see the spec doc). Without
 * a reachable instance both tests skip with an explicit reason — the same
 * missing-dependency contract the keyed providers use for absent env keys.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Reachability probe from the TEST host.
const OLLAMA_BASE_URL = ollamaBaseUrl();
// The URL typed INTO Langflow — how the (dockerized) Langflow reaches the
// instance; host.docker.internal resolves to the host from the container.
const OLLAMA_BASE_URL_FROM_LANGFLOW = ollamaBaseUrlFromLangflow();
// The model to exercise. Left UNSET on purpose when the lane pins none: the model
// is baked into the CI image by build-ollama-image.yml (docker/ollama-e2e/Dockerfile,
// `ARG OLLAMA_E2E_MODEL`), so the instance — not this file — is the source of
// truth. A hardcoded fallback used to live here, and it lied: with the env var
// unset, or the baked model changed, the probe reported "model not pulled" and
// the test SKIPPED silently on the very surface it exists to guard. Unset now
// means "the first completion tag this instance serves" (#1850); the workflows
// still pin it explicitly.
const OLLAMA_TEST_MODEL = ollamaTestModel();

interface OllamaProbe {
  // Both tests' precondition: a reachable instance serving a model the Ollama
  // component can list.
  usable: boolean;
  model: string;
  reason: string;
}

// One probe per test: `/api/tags` plus every tag's `/api/show`, from the test host,
// then `resolveComponentTestModel` (#1850). The capabilities are what matter: the
// component lists only completion tags, and `/api/tags` puts an embedding tag first
// as readily as a chat model — which is how test 2 used to wait for a dropdown
// option that could not exist. An unreachable instance, or one serving nothing the
// component would list, is an explicit skip naming why, never a silent green.
async function probeOllama(request: APIRequestContext): Promise<OllamaProbe> {
  const oracle = await readOllamaCapabilities(request, OLLAMA_BASE_URL);
  if (!oracle.reachable) {
    return {
      usable: false,
      model: "",
      reason: `${oracle.reason} — see the spec doc's provisioning commands`,
    };
  }
  const resolution = resolveComponentTestModel(oracle.classes, OLLAMA_TEST_MODEL);
  if ("skipReason" in resolution) {
    return { usable: false, model: "", reason: resolution.skipReason };
  }
  return { usable: true, model: resolution.model, reason: "" };
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
  // Both tests enter through `awaitBootstrapTest`, which creates `New Flow` and
  // `Basic Prompting` whenever the default project is empty, and no test here deleted
  // them — test 2's own `finally` covers only its blank flow. Measured on a purged
  // 1.13.0.dev12 instance: the first run left exactly those two behind. The tracker
  // captures every `POST /api/v1/flows/` → 201 the page performs and deletes exactly
  // those ids; test 2's blank flow is deleted twice, and `deleteFlow` treats the
  // second DELETE's 404 as done.
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
    flows.dispose();
  });

  test(
    "Ollama base URL is configured via Settings → Model Providers",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const probe = await probeOllama(request);
      test.skip(!probe.usable, probe.reason);

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
        const save = armProviderSave(page, { subject: "base URL", timeout: 60000 });

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        // The verdict FIRST, on its body (#1849). validate-provider answers HTTP
        // 200 with `{ valid: false, error: … }` for a URL it could not reach
        // (measured on 1.12.0.dev9 with the SSRF allowlist absent), and the panel
        // then issues no variables write at all — so reading the two together
        // settled only when the write waiter timed out, 64.6 s later on
        // 1.13.0.dev12, with the refusal's reason discarded (#931's symptom,
        // reached by a different route).
        await save.validated();
        // variables 2xx = the URL is persisted.
        const persistResp = await save.persisted();
        expect(persistResp.ok()).toBe(true);
      });
    },
  );

  test(
    "the Ollama component lists the local model live and executes the flow",
    {
      // `test.fixme` lifted (#1302). The quarantine (#1296) read the failure as
      // "no `div-chat-message` within the 180s budget"; the artifacts refute
      // that budget reading three ways — the retry did the same step in 5.5s on
      // the same runner, green dailies do it in 5.4-6.5s on a COLD container,
      // and `div-chat-message` counts the user's own bubble, so 0 elements for
      // 183 polls means the typed message never rendered. The failing DOM shows
      // the Ollama node reverted to its defaults (Model Name empty, base URL
      // back to localhost), which is why no run could start. Guarded above and
      // below by `helpers/flows/node-config-guard.ts`.
      //
      // `@stable` restored (#1302) on 40 `manual.yml` dispatches at
      // `-f retries=0` against nightly 1.13.0.dev5, none of which reproduced
      // the revert: 20 on `main` (19 green; the one red was the sidebar-reset
      // class, fixed below and unrelated to this mechanism) and 20 on the
      // hardened branch, 20/20 green with both tests executing — the playground
      // step measuring 3 390-5 418 ms, median 4 358, against the 180 s budget.
      // Read that as bounded rather than conclusive: this lane runs the file
      // ALONE at one worker, while the daily runs it beside a full shard, so
      // the contention the race needs is weaker here than where it fired. What
      // makes restoration the right call anyway is that a persistent revert now
      // fails in ~1 s naming both fields, not as a 180 s timeout three layers
      // downstream, and the daily's own auto-removal is the backstop.
      tag: [
        "@stable",
        "@regression",
        "@model-provider",
        "@components",
        "@playground",
      ],
    },
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
      test.skip(!probe.usable, probe.reason);

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

          // All three adds go through the repaired helpers rather than a bare
          // fill + waitForSelector (#1304/#1518/#1335). Measured while gating
          // this test's `@stable` restoration: 1 of 15 consecutive `manual.yml`
          // dispatches on 1.13.0.dev5 died here at 30 s waiting for
          // `input_outputChat Output` to be visible, and the failure snapshot
          // shows why it is not a slow sidebar — the search box was EMPTY and
          // the category list back to its collapsed default, so the typed term
          // was wiped by the sidebar's own mount and the entry never rendered.
          // A second identical fill repairs that; a longer timeout cannot,
          // because nothing is in flight to wait for.
          await addComponentFromSidebar(
            page,
            "chat output",
            "add-component-button-chat-output",
          );
          await zoomOut(page, 2);

          // Dragged, not clicked, deliberately: dragging a component out of the
          // sidebar is a gesture Langflow ships and the drop surface is swallowed
          // independently of the click one (#1335).
          await dragComponentFromSidebar(
            page,
            "chat input",
            "input_outputChat Input",
          );

          await addComponentFromSidebar(page, "ollama", "add-component-button-ollama");

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

        const selectModel = async () => {
          await page.getByTestId("dropdown_str_model_name").click();
          const option = page
            .locator('[data-testid$="-option"]')
            .filter({ hasText: probe.model })
            .first();
          // THE connectivity assert: passing requires the component to have
          // enumerated the real local instance (the static catalog does not
          // contain the pulled model's tag). `probe.model` is a tag the instance
          // actually serves, so this cannot drift from the CI image — and, short of
          // a pin whose capabilities the test host could not read, one it reports
          // as a completion model: never a tag the component filters out on
          // purpose, which is what made this red misread as connectivity (#1850).
          await expect(
            option,
            `the Ollama component's live model list does not offer "${probe.model}" after ` +
              `pointing it at ${OLLAMA_BASE_URL_FROM_LANGFLOW}`,
          ).toBeVisible({ timeout: 15000 });
          await option.click();
        };

        await test.step("the LIVE model dropdown lists the locally pulled model — select it", async () => {
          await selectModel();
          await expect(page.getByTestId("value-dropdown-dropdown_str_model_name")).toContainText(
            probe.model,
            { timeout: 10000 },
          );
          // Not just `waitForFlowSaveSettled` (#1302): that barrier drains the
          // PATCHes in flight and, at the derived window, the one the selection
          // just scheduled (#1902) — and says nothing about whether the selection
          // survived one that landed. This re-reads the widget after the quiet
          // window and re-applies once if the value is gone.
          await waitForNodeConfigSettled(page, {
            valueTestId: "value-dropdown-dropdown_str_model_name",
            expected: probe.model,
            reapply: selectModel,
          });
        });

        await test.step("execute the flow through the Playground", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          const chatInput = page.getByTestId("input-chat-playground").last();
          await expect(chatInput).toBeVisible({ timeout: 30000 });
          await chatInput.fill(`Repeat this token exactly and nothing else: ${token}`);

          // Immediately before the send, never earlier (#1302): the revert was
          // observed with the Playground already OPEN and the canvas node behind
          // it, and the run ships the in-memory graph — so this is the last
          // moment at which what will execute can still be read. Without it the
          // spec spends its whole 180 s budget on a `div-chat-message` that a
          // node missing its required Model Name can never produce.
          await assertNodeConfigHeld(page, {
            valueTestId: "value-dropdown-dropdown_str_model_name",
            expected: probe.model,
            field: "Model Name",
            companion: {
              valueTestId: "popover-anchor-input-base_url",
              expected: OLLAMA_BASE_URL_FROM_LANGFLOW,
              field: "Ollama API URL",
            },
          });

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
