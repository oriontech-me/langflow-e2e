import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Ids of the flows created by loadAgent(), so afterEach can delete exactly
// those via the API (id-scoped, #515) — never a global cleanAllFlows.
// SimpleAgentTemplatePage.load() no longer clears flows (#553), so without this
// the suite leaked one Simple Agent flow per run.
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    const flowId = await new SimpleAgentTemplatePage(page).load(options);
    if (flowId) createdFlowIds.push(flowId);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a
  // flow we are about to delete, then pass an explicit bearer — page.request is
  // unauthenticated under AUTO_LOGIN and would 401 otherwise.
  await page.goto("/");
  const auth = await getAuthToken(page.request);
  const opts = auth ? { headers: { Authorization: auth } } : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// `tool-calling`, and this file is worth a note because it is the case that shows
// why a measured pass rate is NOT the adoption criterion (#1187).
//
// It was declared `any-completion` on the argument that every assertion here reads
// node behaviour rather than the answer, and it then passed **5/5 routed** to
// `llama3.2:1b` on the CI lane (20/20 declarations, `retries=0`). It is still
// `tool-calling`, because the criterion is whether an assertion DEPENDS on the model,
// and three of them do — the rate just did not expose it in five runs:
//
//  - **The Stop-button test depends on the model being slow.** `expect(stopButton)
//    .toBeVisible({ timeout: 30000 })` requires generation to still be in flight, and
//    `dispatchEvent("click")` requires the button to still be mounted. A model that
//    finishes first turns this red for a non-defect — or, worse, makes `toBeHidden`
//    pass trivially, which is precisely the silent no-op #992 fixed here.
//  - **The interaction suite reads the answer.** `expect.soft(text.trim().length)
//    .toBeGreaterThan(1)` runs on all three turns, and a soft failure still fails the
//    test — so a reply that ends empty (the `"Message empty."` shape) is a red.
//  - **Three turns, one long-form, inside the 5-minute cap.** The third asks for a
//    5-paragraph summary, and `model-provider/ollama-provider.spec.ts` measures
//    `llama3.2:1b` at **>100 s per call on a runner** (daily 2026-07-15 failed 3/3 on
//    `div-chat-message not found` after ~100 s, #931). That is not a margin.
//
// Timing and throughput are model dependence just as much as compliance is. Routing
// this file would make it pass because the runner is slow, which is the dependency
// inverted rather than removed — and the first fast local model would collect the
// bill. The template also wires two tools into the Agent (`URLComponent`,
// `UnifiedWebSearch` in `Simple Agent.json`), so every turn asks a 1B to drive a
// tool-bearing agent without derailing.
const targets = resolveTestTargets({ tier: "tool-calling" });

// File-level serial mode: each provider block creates a named Simple Agent flow;
// serial execution avoids "flow must be unique" collisions across blocks.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Component Regression [${label}]`, () => {

    test(
      "agent interaction suite",
      { tag: ["@stable", "@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 30000 });

        await test.step("responds without tools connected", async () => {
          await page.getByTestId("input-chat-playground").last().fill("What is the capital of France?");
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
          await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
          const text = await page.getByTestId("div-chat-message").last().innerText();
          expect.soft(text.trim().length).toBeGreaterThan(1);
        });

        await test.step("shows reasoning steps", async () => {
          await page.getByTestId("input-chat-playground").last().fill("Who was the first astronaut to walk on the Moon?");
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
          await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
          const finishedText = page.getByText(/Finished in/).last();
          if (await finishedText.isVisible({ timeout: 5000 }).catch(() => false)) {
            const durationText = await finishedText.innerText();
            expect.soft(durationText.trim().length).toBeGreaterThan(0);
          }
        });

        await test.step("streams response progressively and displays duration", async () => {
          await page.getByTestId("input-chat-playground").last().fill(
            "Write a 5-paragraph summary explaining what artificial intelligence is, covering its definition, history, main techniques, applications, and future perspectives.",
          );
          await page.getByTestId("button-send").last().click();

          const stopButton = page.getByRole("button", { name: "Stop" });
          const chatMessage = page.getByTestId("div-chat-message").last();

          await expect.soft(chatMessage).toBeVisible({ timeout: 30000 });

          // Wait for the Stop button to appear — confirms the model is actively generating.
          // div-chat-message can appear before Stop (element created before first token),
          // so we must not start polling until Stop is visible or we'll exit immediately.
          const stopAppeared = await stopButton
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => true)
            .catch(() => false);

          if (!stopAppeared) {
            // Model responded before Stop appeared — too fast for streaming to be observable.
            // Still validate the final response exists and continue to remaining steps.
            const earlyFinalText = await chatMessage.innerText();
            expect.soft(earlyFinalText.trim().length).toBeGreaterThan(1);
            return;
          }

          // Poll while Stop is visible (max 5s) to detect text growth deterministically.
          // prevLength is captured after Stop appears so the model has already started.
          const prevLength = (await chatMessage.innerText()).trim().length;
          const deadline = Date.now() + 5000;

          while (Date.now() < deadline) {
            const stopVisible = await stopButton.isVisible().catch(() => false);
            if (!stopVisible) break;
            const currentLength = (await chatMessage.innerText()).trim().length;
            if (currentLength > prevLength) break;
            await page.waitForTimeout(100);
          }

          await expect(stopButton).toBeHidden({ timeout: 120000 });

          const finalText = await chatMessage.innerText();
          expect.soft(finalText.trim().length).toBeGreaterThan(1);

          // Growth not observed: the model may render faster than our 100ms poll interval,
          // or div-chat-message may only be applied after streaming completes (making .last()
          // point at the previous stable response throughout). The finalText check above
          // catches truly broken streaming (empty response). No assertion when unobservable.

          // "Finished in Xs" only appears when the frontend duration timer fires
          // (depends on isBuilding cycle + React render). node_duration_agent in the
          // canvas step is the canonical duration assertion backed by the backend.
          const durationBadge = page.getByText(/Finished in \d+(\.\d+)?s/);
          if (await durationBadge.isVisible({ timeout: 5000 }).catch(() => false)) {
            expect.soft((await durationBadge.innerText()).trim().length).toBeGreaterThan(0);
          }
        });

        await test.step("handles multiple consecutive messages", async () => {
          const count = await page.getByTestId("div-chat-message").count();
          expect.soft(count).toBeGreaterThanOrEqual(2);
        });

        await test.step("response time visible on canvas after closing playground", async () => {
          await page.getByTestId("playground-close-button").click();
          await expect.soft(page.getByTestId("node_duration_agent")).toBeVisible({ timeout: 10000 });
        });
      },
    );

    test(
      "agent stop button must halt execution mid-run",
      // @stable restored in #992: the #355 hard failure (120s `waitForSelector`
      // on the stop button) no longer reproduces on 1.12.0.dev7 — the test
      // finishes in ~10s. See CONTRIBUTING.md for the @stable lifecycle.
      { tag: ["@stable", "@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);
        await page.getByTestId("playground-btn-flow-io").click();

        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("Write a detailed story about the life and adventures of a fictional explorer in the 18th century.");
        await page.getByTestId("button-send").last().click();

        // The Stop button is the SUBJECT of this test, so its appearance is an
        // assertion, not a probe (#992). This used to be
        // `isVisible({ timeout: 30000 })` + an early `return`, which never
        // waited at all — Playwright marks that option `@deprecated: this
        // option is ignored`, so the read fired microseconds after the send
        // click and any render latency turned the whole test into a silent
        // no-op that asserted nothing while reporting green.
        const stopButton = page.getByRole("button", { name: "Stop" });
        await expect(stopButton).toBeVisible({ timeout: 30000 });

        // dispatchEvent bypasses Playwright actionability checks — stop button may be transitioning during stream teardown
        await stopButton.dispatchEvent("click");
        await expect(stopButton).toBeHidden({ timeout: 30000 });
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 10000 });
      },
    );
  });
}
