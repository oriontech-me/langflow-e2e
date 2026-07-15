import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage, SimpleAgentTemplatePage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
} from "../../../../helpers/provider-setup";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { resolveGptModel } from "../../../../helpers/provider-setup/resolve-gpt-model";

/**
 * OpenAI provider happy path (QA-CHECKLIST §7.2) as a provider-centric journey:
 *   Test 1 — configure the OpenAI API key in Settings → Model Providers.
 *   Test 2 — the configured provider selects a GPT model in the Agent and
 *            executes a flow, round-tripping a per-run sentinel.
 *
 * Distinct from `agent-component-regression.spec.ts` (agent behaviors, which take
 * the provider config as a POM precondition) and from the settings-UI presence
 * specs (`model-provider-api-key`, `model-provider-modal-actions`). This spec
 * owns the "configure → select GPT → execute" contract.
 *
 * False-positive guards: Test 1 asserts the save *requests* succeed
 * (validate-provider + PATCH /variables, both 2xx) rather than a "Replace" button
 * that pre-exists when an earlier test already set the global key — so a no-op
 * save cannot pass. Test 2 asserts a GPT model is selected and echoes a per-run
 * sentinel, so the response can't be stale or from another provider.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const PROVIDER = "openai";

// SimpleAgentTemplatePage.load() does NO cleanup (post-#553 contract) and the
// canvas URL id is transient on 1.11 — track every flow the load actually
// creates (POST /api/v1/flows → 201) and delete those ids in afterEach (#605).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, model?: string): Promise<void> {
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
    await new SimpleAgentTemplatePage(page).load({ provider: PROVIDER, model });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  // page.request carries only browser cookies — the flows API wants the
  // Bearer token, so authenticate explicitly (a silent 401 here leaks flows).
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

// Assert the echoed sentinel on the PERSISTED reply (monitor API), NOT the live
// playground bubble. The bubble renders the empty placeholder ("Message empty.",
// the frontend's EMPTY_OUTPUT_SEND_MESSAGE) while the model is streaming, and
// `waitForAgentToFinish` can return before the final text lands — so reading the
// live bubble races the stream, the #634 flaky "Message empty." symptom (no
// backend 5xx; monitor state=complete — a streaming/empty-turn artifact, not a
// product error). The token is unique per run and appears in BOTH the user
// prompt and the expected reply, so it keys the session lookup and is the
// content assert. A genuinely empty final turn (rare, model-side, #634) fails
// here rather than passing on the placeholder.
async function expectReplyContainsToken(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const userMsg = messages.find(
          (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(token),
        );
        if (!userMsg) return "user message with token not persisted yet";

        const replies = messages
          .filter((m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id)
          .map((m: any) => ((m.text as string) ?? "").trim());
        if (replies.length === 0) return "AI reply for the session not persisted yet";
        if (replies.every((t) => t === ""))
          return "AI reply persisted but still empty (run not finished / empty final turn)";

        return replies.some((t) => t.includes(token))
          ? "reply-contains-token"
          : `reply did not echo the token: ${JSON.stringify(replies.map((t) => t.slice(0, 80)))}`;
      },
      { timeout: 60000 },
    )
    .toBe("reply-contains-token");
}

// Serial mode + --workers=1 keeps the shared instance state deterministic
// (agent-family convention — named template loads collide under parallelism).
test.describe.configure({ mode: "serial" });

test.describe("OpenAI Provider", () => {
  test(
    "OpenAI API key is configured via Settings → Model Providers",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page }) => {
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open Settings → Model Providers → OpenAI", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Model Providers",
          { timeout: 10000 },
        );
        await page.getByTestId("provider-item-OpenAI").click();
      });

      await test.step("enter the key and save — assert the save requests succeed", async () => {
        const keyInput = page.getByTestId("provider-variable-input-OPENAI_API_KEY");
        await expect(keyInput).toBeVisible({ timeout: 10000 });
        await keyInput.fill(process.env.OPENAI_API_KEY ?? "");

        // Arm both waiters BEFORE clicking so the pass is caused by THIS save,
        // not the "Replace" state a prior test's global key left behind.
        const validatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/models/validate-provider") &&
            r.request().method() === "POST",
          { timeout: 30000 },
        );
        // Persist is a CREATE (POST /variables/ 201) when the global key does
        // not yet exist and an UPDATE (PATCH /variables/{id} 200) when it does
        // — the frontend branches on existence (#636). Match BOTH: a fresh
        // instance, or a run where no earlier test configured the provider
        // first, takes the POST path, so a PATCH-only predicate waits forever
        // on a request that never fires — the confirmed flake (POST 201
        // observed live on a deleted-var repro; validate-provider itself
        // returns 200, so the backend is healthy — a test defect, not a
        // product hang).
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables/") &&
            (r.request().method() === "POST" || r.request().method() === "PATCH"),
          { timeout: 30000 },
        );

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        const [validateResp, persistResp] = await Promise.all([
          validatePromise,
          persistPromise,
        ]);
        // validate-provider 2xx = the key authenticates against OpenAI live;
        // POST/PATCH /variables 2xx = the key is persisted globally.
        expect(validateResp.ok()).toBe(true);
        expect(persistResp.ok()).toBe(true);
      });
    },
  );

  test(
    "configured OpenAI selects a GPT model in the Agent and executes the flow",
    { tag: ["@model-provider", "@agents", "@playground"] },
    async ({ page, request }) => {
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      // Per-run sentinel: a match proves THIS execution produced the output.
      const token = `OPENAI-${Date.now()}`;

      await loadAgent(page, resolveGptModel());

      await test.step("Agent has a GPT model selected", async () => {
        const modelValue = page.getByTestId("value-dropdown-model_model");
        await expect(modelValue).toBeVisible({ timeout: 15000 });
        await expect(modelValue).toContainText(/gpt/i, { timeout: 10000 });
      });

      await test.step("remove the Web Search + URL tools so execution is a plain completion", async () => {
        // The template's tool-orchestration on gpt-4o-mini transiently fails
        // (~1/5, backend ComponentBuildError) — incidental to §7.2. A tool-free
        // agent is a single deterministic LLM call. Tool execution is covered by
        // agent-component-regression.spec.ts.
        // Select via the node TITLE, not the body: URLComponent's body center is
        // an interactive element, so a body click doesn't select the node.
        const tools = [
          { title: "title-Web Search", node: "rf__node-UnifiedWebSearch" },
          { title: "title-URL", node: "rf__node-URLComponent" },
        ];
        for (const t of tools) {
          const node = page.locator(`[data-testid^="${t.node}"]`);
          if ((await node.count()) === 0) continue;
          await page.getByTestId(t.title).click();
          await page.keyboard.press("Delete");
          await expect(node).toHaveCount(0, { timeout: 10000 });
        }
        // Playground builds the PERSISTED flow — the deletion must be saved first.
        await waitForFlowSaveSettled(page);
      });

      await test.step("execute the flow and echo the sentinel", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 30000,
        });
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill(`Repeat this token exactly and nothing else: ${token}`);
        await page.getByTestId("button-send").last().click();
        await waitForAgentToFinish(page);

        const aiMessage = page.getByTestId("div-chat-message").last();
        await expect(aiMessage).toBeVisible({ timeout: 30000 });
        // Gate on the PERSISTED reply first — race-free completion signal; the
        // live bubble shows the empty placeholder mid-stream (#634 race).
        await expectReplyContainsToken(request, token);
        // The run is now complete, so the user-visible bubble must ALSO echo the
        // token. Re-asserting it here (after the gate, no stream race) keeps
        // end-to-end UI coverage: a bubble stuck on "Message empty." while the
        // reply persisted would be a real frontend bug and must still fail.
        // Use the retrying locator assertion (not innerText()) — even post-gate
        // the bubble can lag briefly from placeholder to final text.
        await expect(aiMessage).toContainText(token, { timeout: 15000 });
      });
    },
  );
});
