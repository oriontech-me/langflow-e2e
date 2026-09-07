import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForAttributedSelector } from "../../../../helpers/other/page-entry-barrier";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import { setupGoogle } from "../../../../helpers/provider-setup/setup-google";
import { resolveGeminiModel } from "../../../../helpers/provider-setup/resolve-gemini-model";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { hideInspectorPanel } from "../../../../helpers/ui/hide-inspector-panel";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Language Model component execution and provider management (QA-CHECKLIST
// §7.5 "Language Model component — configuration"). Hardened for @stable
// (issue #505):
// - the multi-provider tests use Google instead of Anthropic — same contract
//   (a second provider answers; a switch persists), and the suite holds a
//   funded GOOGLE_API_KEY (no Anthropic credits available; Save/validation
//   requires a real funded key). They skip when the provider is unusable — the
//   daily-stable workflow needs the GOOGLE_API_KEY secret for them to run
//   in CI (flagged on the PR).
//
// Every test here drives a REAL completion, so each gates on provider HEALTH
// (`providerSkipGate`), not on the mere presence of the env key (#1029). A key
// that exists but is drained used to pass the old gate and block the backend
// past gunicorn's 300s timeout, killing the shard's Langflow worker — the
// Google tests below did exactly that on run 30374528125.
// - the "Manage Model Providers" test lost its if-wrapping: every step is a
//   hard assertion against live-scouted testids.

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

test.describe("Language Model Component Regression", () => {
  // Each test opens the Basic Prompting template, which creates a flow. The
  // canvas URL carries a TRANSIENT id on 1.11 (deleting it 404s), so capture
  // the real id from the page's own POST /api/v1/flows/ response and delete
  // just that flow afterwards (targeted — never cleanAllFlows, which would
  // nuke parallel workers' flows).
  const createdFlowIds: string[] = [];

  const openBasicPrompting = async (page: any) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("side_nav_options_all-templates").click();
    const flowCreated = page
      .waitForResponse(
        (r: any) =>
          r.url().includes("/api/v1/flows/") &&
          r.request().method() === "POST" &&
          r.status() < 300,
        { timeout: 30000 },
      )
      .then(async (r: any) => (await r.json()).id as string)
      .catch(() => undefined);
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
    const flowId = await flowCreated;
    if (flowId) createdFlowIds.push(flowId);

    // The canvas-mount barrier (#1469). `waitForURL` only proves the route
    // changed — the canvas fetches and renders AFTER it, so returning here left
    // every test to trip over whichever canvas observable it happened to wait on
    // first, with no attribution. On the 2026-08-17 daily (run 32011412906,
    // shard 2) that cost this file's `@release` dialog test its `@stable`: its
    // three attempts died on `.react-flow__node` filtered on Language Model,
    // then twice on `canvas_controls_dropdown`, while shard 2's own
    // backend-liveness lost 12% / 35% / 58% of its probes in contiguous 45-66s
    // stretches. Both shapes are reproducible on demand by failing the canvas's
    // backend GETs (measured on 1.12.0.dev30), so they say "the backend was
    // gone", not "the canvas regressed" — but `page.waitForSelector: Timeout`
    // cannot say which, and it is deliberately NOT an exempting infra signature.
    //
    // So wait here, once, through the attributed barrier (#1262/#1265): on
    // timeout it probes `GET /api/v1/version` and reports whether Langflow
    // answered, which is what makes this class of collateral classifiable.
    // Budgets are exactly the ones the dialog test already spent (30s + 15s) —
    // nothing is inflated, and on a healthy instance both resolve in under a
    // second (64-824ms and 353-826ms over 5 runs of 5 on 1.12.0.dev30).
    await waitForAttributedSelector(
      page,
      '[data-testid="canvas_controls_dropdown"]',
      30000,
      { surface: "flow-canvas" },
    );
    await waitForAttributedSelector(page, ".react-flow__node", 15000, {
      surface: "flow-canvas-nodes",
    });
  };

  test.afterEach(async ({ request }) => {
    // page.request carries only browser cookies — the flows API wants the
    // Bearer token, so authenticate explicitly (a silent 401 here leaks flows).
    if (createdFlowIds.length === 0) return;
    const bearer = await getAuthToken(request);
    while (createdFlowIds.length > 0) {
      const id = createdFlowIds.pop();
      if (!id) continue;
      await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
    }
  });

  test(
    "language model must respond with OpenAI provider",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      const gate = providerSkipGate("openai");
      test.skip(gate.skip, gate.reason);

      await openBasicPrompting(page);

      await initialGPTsetup(page);
      // The model selection autosaves with a debounce — running before the
      // save settles builds the template's DEFAULT model (observed live:
      // gpt-5.5-pro instead of the selected one).
      await waitForFlowSaveSettled(page);

      // Pre-run widget gate (#606, same class as #596/#491): a
      // custom_component/update racing the selection can silently revert the
      // node to the workspace-default model. If the selection dropped,
      // re-apply it; bounded — three drops in a row is a real failure.
      const modelWidget = page.locator('[data-testid="model_model"]').first();
      for (let attempt = 0; attempt < 3; attempt++) {
        const shown = await modelWidget.innerText().catch(() => "");
        if (/gpt/i.test(shown)) break;
        console.log(
          `model selection dropped to "${shown.trim()}" — re-applying (attempt ${attempt + 1}/3, see #606)`,
        );
        await initialGPTsetup(page, {
          skipAdjustScreenView: true,
          skipUpdateOldComponents: true,
        });
        await waitForFlowSaveSettled(page);
      }
      await expect(modelWidget).toContainText(/gpt/i, { timeout: 10000 });

      await page.getByTestId("button_run_chat output").click();
      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page.getByRole("button", { name: "Playground", exact: true }).click();
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page.getByTestId("input-chat-playground").last().fill("What is 2+2?");
      await page.getByTestId("button-send").last().click();

      const stopBtn = page.getByRole("button", { name: "Stop" });
      if (await stopBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtn).toBeHidden({ timeout: 120000 });
      }
      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      await expect(page.getByTestId("div-chat-message").last()).toContainText(/4/, {
        timeout: 15000,
      });
    },
  );

  // `@stable` restored (#1504). It was auto-removed by the 2026-08-14 daily
  // (`f6f4c39`, run 31786538844) on `MODEL_NOT_AVAILABLE: "gemini-flash-latest"
  // not found in dropdown` — the sr-only "N of M" counter 1.12.0.dev26 added to
  // each picker option, which defeated every anchored matcher (#1459 / #1461).
  // `setupGoogle` has resolved options by IDENTITY through `model-option.ts`
  // since `8cab90f`, and this spec carries no option matcher of its own, so the
  // shared fix covers it by construction. Re-validated on nightly 1.13.0.dev5:
  // 4/4 clean at `--retries=0`, and the force-fail call log reads
  // `unexpected value "gemini-flash-latest"` — the very model that could not be
  // resolved on 08-14 now lands in the widget.
  test(
    "language model must respond with Google provider",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      const gate = providerSkipGate("google");
      test.skip(gate.skip, gate.reason);

      await openBasicPrompting(page);

      // Pin a deterministic Gemini flash model instead of "first gemini in
      // the dropdown" — the dropdown order follows the catalog and the node's
      // default follows the first configured provider (#596).
      const geminiModel = resolveGeminiModel();
      try {
        await setupGoogle(page, geminiModel);
      } catch (e: any) {
        if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
        throw e;
      }
      // Same autosave-debounce guard as the OpenAI test above.
      await waitForFlowSaveSettled(page);

      // Pre-run widget gate (#596, same class as #491): a custom_component/
      // update racing the selection can silently revert the node to the
      // workspace-default model (an unrelated provider — the build then fails
      // and "built successfully" never fires). If the selection dropped,
      // re-apply it; the race becomes a re-select instead of a wrong-model
      // build. Bounded — three drops in a row is a real failure.
      const modelWidget = page.locator('[data-testid="model_model"]').first();
      for (let attempt = 0; attempt < 3; attempt++) {
        const shown = await modelWidget.innerText().catch(() => "");
        if (/gemini/i.test(shown)) break;
        console.log(
          `model selection dropped to "${shown.trim()}" — re-applying (attempt ${attempt + 1}/3, see #596)`,
        );
        await setupGoogle(page, geminiModel);
        await waitForFlowSaveSettled(page);
      }
      await expect(modelWidget).toContainText(/gemini/i, { timeout: 10000 });

      await page.getByTestId("button_run_chat output").click();
      // Build completion is observed on the Chat Output node's persistent
      // `node_duration_` badge, NOT the "built successfully" toast (#750). The
      // toast auto-dismisses after ~2s (FlowBuildingComponent), so a 30s wait
      // that only fires once the whole Gemini build finishes has to catch a
      // 2s window at an unknown time — under CI saturation the build tips past
      // 30s and the toast is missed, producing the recurrent flake. The
      // per-node duration badge renders on build success and stays, so it is a
      // deterministic completion signal; the 60s budget matches this file's
      // playground wait and the repo's node_duration convention (this is not
      // masking latency — the widget gate above already guarantees the correct
      // Gemini model built; the build genuinely completes, it is only slow).
      await expect(page.getByTestId("node_duration_chat output")).toBeVisible({
        timeout: 60000,
      });

      await page.getByRole("button", { name: "Playground", exact: true }).click();
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page.getByTestId("input-chat-playground").last().fill("Say hello.");
      await page.getByTestId("button-send").last().click();

      const stopBtn = page.getByRole("button", { name: "Stop" });
      if (await stopBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtn).toBeHidden({ timeout: 120000 });
      }
      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      const responseText = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();
      expect(responseText.trim().length).toBeGreaterThan(1);
    },
  );

  test(
    "language model provider switch from OpenAI to Google must persist",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      // Both providers are driven here, so a dead key on EITHER one wedges the
      // test — gate on both.
      const gate = providerSkipGate("openai", "google");
      test.skip(gate.skip, gate.reason);

      await openBasicPrompting(page);

      await initialGPTsetup(page);
      await setupGoogle(page);
      await waitForFlowSaveSettled(page);

      // The Basic Prompting flow has a single Language Model node, so the
      // page-level model_model trigger is unambiguous (the node-scoped nested
      // locator detaches after setupGoogle re-renders the node).
      await expect(
        page.locator('[data-testid="model_model"]').first(),
      ).toContainText(/gemini/i, { timeout: 15000 });
    },
  );

  test(
    "model provider dialog opens from the Language Model node",
    {
      tag: [
        "@stable",
        "@release",
        "@components",
        "@workspace",
        "@model-provider",
      ],
    },
    async ({ page }) => {
      // openBasicPrompting now holds the canvas-mount barrier itself, so the
      // canvas_controls_dropdown wait that used to open this test is gone —
      // it was the same wait, one caller up (#1469).
      await openBasicPrompting(page);

      // Resolve the node by the title testid the COMPONENT carries, never by
      // text (#1469). `.filter({ hasText: "Language Model" })` matched TWO
      // nodes: the template's README sticky note reads "Large Language Model
      // (LLM)", and it precedes the component in DOM order — so `.first()`
      // selected the note and this test never touched the node it is named
      // after. It still passed, because the `model_model` locator below is
      // page-level; a false negative that no green run could reveal. The count
      // assert pins the disambiguation: if a future template adds a second node
      // carrying this title, the test says so instead of silently picking one.
      const languageModelNode = page.locator(
        '.react-flow__node:has([data-testid="title-Language Model"])',
      );
      await expect(languageModelNode).toHaveCount(1, { timeout: 15000 });
      await expect(languageModelNode).toBeVisible({ timeout: 15000 });
      await languageModelNode.click();

      // The selected node's Inspector Panel overlaps the dropdown on 1.11.x —
      // close it so the click is not intercepted (setup-google convention).
      await hideInspectorPanel(page);

      const modelDropdown = page.locator('[data-testid="model_model"]').first();
      await expect(modelDropdown).toBeVisible({ timeout: 10000 });
      await modelDropdown.click();

      await page.getByTestId("manage-model-providers").click();

      await expect(page.getByTestId("provider-item-OpenAI")).toBeVisible({
        timeout: 10000,
      });

      await page.keyboard.press("Escape");
    },
  );
});
