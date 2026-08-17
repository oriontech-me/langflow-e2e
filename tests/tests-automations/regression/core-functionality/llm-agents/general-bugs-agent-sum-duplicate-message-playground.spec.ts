import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// A current, non-dated Claude model from the collected catalog. Pinning one is
// what makes the template load a GUARDED one: SimpleAgentTemplatePage blocks
// until the Agent's persisted binding carries this model, and it warns that a
// load with no pin observes no transition at all (#751/#1274). Without that
// barrier the Playground opens while the node still holds its mount-time state,
// and the run reaches the backend with no model bound (#1465).
function resolveClaudeModel(): string | undefined {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) return undefined;
  const models = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Array<{
    provider: string;
    model: string;
  }>;
  const claude = models
    .filter((m) => m.provider === "anthropic")
    .map((m) => m.model);
  return claude.find((m) => !/\d{8}/.test(m)) ?? claude[0];
}

// Id of the flow the template load created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// workers are building mid-run (#515). This spec created one flow per run and
// deleted none until #1465.
let createdFlowId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdFlowId) return;
  const bearer = await getAuthToken(request);
  await deleteFlow(request, createdFlowId, { headers: { Authorization: bearer } });
  createdFlowId = undefined;
});

test(
  "user must not experience message duplication in mathematical expressions with agent component",
  { tag: ["@release", "@components", "@workspace"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }

    // Real completions run below, so gate on provider HEALTH, not on the env var
    // alone — a drained key would block the backend past gunicorn's 300s timeout
    // and kill the shard's Langflow worker (#1029).
    const gate = providerSkipGate("anthropic");
    test.skip(gate.skip, gate.reason);

    // Loaded through the Page Object, not by clicking the template and calling a
    // provider helper directly: the POM performs the same setup AND then blocks
    // until the Agent's PERSISTED binding carries the requested provider+model.
    // The hand-rolled version this replaced opened the Playground as soon as the
    // helper returned, so the run left with no model bound and the backend
    // answered `ComponentBuildError: … No model selected.` — which surfaced 30 s
    // later as the completion gate below timing out (#1465).
    await new SimpleAgentTemplatePage(page).load({
      provider: "anthropic",
      model: resolveClaudeModel(),
    });

    createdFlowId = page.url().split("/flow/")[1]?.split(/[/?#]/)[0];

    await page.getByTestId("playground-btn-flow-io").click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // Test simple math expression
    await page.getByTestId("input-chat-playground").last().fill("2+2");

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").last().click();

    // The chat message testid embeds the message text
    // (`chat-message-<sender>-<text>`), so the duplication signature is readable
    // straight off the DOM without expanding anything. That matters: until 1.12
    // this spec expanded the message's execution header (`header-icon` →
    // `icon-Check`) and read the tool's JSON payload from `chat-code-tab`, and on
    // 1.12.0.dev26 BOTH count 0 — the same change that removed the expandable
    // tool accordion (#827). Reading the payload off the run stream instead was
    // rejected: for `2+2` the Agent answers directly, so a tool-anchored assert
    // would depend on the model choosing to call one (#1187).
    // Wait for the FINISHED run, not for the bubble: `div-chat-message` mounts
    // empty while the answer streams, so gating on it read a spinner as a reply.
    // The assistant's testid embeds the text, so it only exists once there IS
    // text, and the token-usage row is written when the run completes.
    const assistantMessage = page.getByTestId(/^chat-message-AI-/);
    await expect(assistantMessage).toBeVisible({ timeout: 120000 });
    await expect(page.getByTestId("chat-message-token-usage")).toBeVisible({
      timeout: 30000,
    });

    // The typed input reached the run exactly once. A duplicated input renders
    // the user's own message as "2+22+2" (or "22+2"), so this fails on the very
    // bug the spec exists for.
    await expect(page.getByTestId("chat-message-User-2+2")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("chat-message-User-2+22+2")).toHaveCount(0);
    await expect(page.getByTestId("chat-message-User-22+2")).toHaveCount(0);

    // And the answer is the arithmetic of the CLEAN expression. 26 is what
    // "2+22+2" evaluates to — asserted by name so a duplicated run cannot pass by
    // producing a plausible-looking number.
    const answer = (await assistantMessage.innerText()).trim();
    expect(answer).toContain("4");
    expect(answer).not.toContain("26");
  },
);
