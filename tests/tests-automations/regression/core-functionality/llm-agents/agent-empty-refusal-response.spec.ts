import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";

/**
 * Agent robustness on a degenerate model output (QA-CHECKLIST §6.5,
 * "Empty response or model refusal — component does not crash").
 *
 *   Test 1 — a refusal-forcing instruction: the model refuses with a per-run
 *            marker; the component finishes with no backend/flow error.
 *   Test 2 — an empty-forcing instruction: the run completes without crashing;
 *            whether the reply is actually empty is logged, not asserted (model
 *            obedience varies — a soft assertion would still fail the test).
 *
 * The crash guard is the fixture: importing `test` from fixtures.ts adds backend
 * 4xx/5xx and flow-error monitoring, so a component crash on the degenerate
 * output fails the test automatically. A green run therefore proves the §6.5
 * "does not crash" contract. Mirrors agent-system-prompt.spec.ts.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// The user message is unrelated to the instruction — a plain question the agent
// would normally answer, so a refusal / empty reply can only come from the
// instruction we set.
const USER_MESSAGE = "What is the capital of France?";

// Id-scoped cleanup for every flow this spec's page creates (#1108's shared
// tracker, never a delete-all sweep — #553). This spec had NO cleanup at all: the
// flow it ran the agent on was left behind, which cost twice. It leaked an orphan
// `Simple Agent` per test on the shared instance, and — because token attribution
// lives on the delete path (#1197) — its tokens reached the platform with no spec
// to claim them. Measured on the 2026-08-06 daily (#1346): traces `1027dfd2` and
// `6676e05d`, 936 + 918 tokens on `claude-haiku-4-5`, in the run's `unattributed`
// bucket. The `attrib_cost` records this spec DID produce came from
// `loadTemplateByName`'s own cleanup of the surplus flows it creates — those never
// ran, so they carried no traces and the attribution read came back empty.
//
// The tracker rather than the returned id: `load()` can throw AFTER creating the
// flow (the #751/#1072 credential-settle guard throws exactly there), and an id
// captured from the creation POST survives that.
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

// Attribution is derived from the running test by `cleanup` itself (#1197 §1.1) —
// no explicit `attribution` option is needed, and the whole sidecar stays inert
// unless the lane sets TOKENS_ATTRIB.
test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
});

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Fill the Agent Instructions (system prompt) and make sure the debounced
// autosave has settled before the build, so the run uses the prompt we set, not
// the template default.
async function setAgentInstructions(page: Page, prompt: string): Promise<void> {
  const promptField = page.getByTestId("textarea_str_system_prompt");
  await expect(promptField).toBeVisible({ timeout: 15000 });

  await promptField.click();
  await promptField.fill(prompt);
  await promptField.blur();
  // Drain ALL debounced autosave PATCHes instead of racing a single
  // `waitForResponse(PATCH && ok(), 15s)` (#608). The old waiter flaked three
  // ways on the google run: (a) the autosave debounce could exceed 15s under
  // load; (b) a stale PATCH still in flight from load() (model selection) could
  // resolve it BEFORE the instruction's own save landed; (c) a transient
  // non-ok PATCH never matched `resp.ok()`, so it waited out the full timeout.
  // `waitForFlowSaveSettled` waits for a quiet period after the last flow-save
  // PATCH (any status), which is robust to all three. Matches the hardened
  // `agent-system-prompt.spec.ts` helper (#635).
  await waitForFlowSaveSettled(page);
}

// Open the Playground, send a message, wait for the run to finish, return the
// latest chat message bubble locator + its text.
async function askAndGetReplyBubble(page: Page, message: string) {
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
    timeout: 30000,
  });

  await page.getByTestId("input-chat-playground").last().fill(message);
  await page.getByTestId("button-send").last().click();

  await waitForAgentToFinish(page);

  const bubble = page.getByTestId("div-chat-message").last();
  await expect(bubble).toBeVisible({ timeout: 30000 });
  return { bubble, text: (await bubble.innerText()).trim() };
}

// Assert the per-run marker on the PERSISTED reply (monitor API), NOT the live
// playground bubble (#757). The bubble renders the "Message empty." placeholder
// (EMPTY_OUTPUT_SEND_MESSAGE) while the model is still streaming, and
// `waitForAgentToFinish` can return before the final text lands — so reading the
// live bubble races the stream and intermittently sees the placeholder instead
// of the refusal (the #634 class). The marker is globally unique per run, so a
// Machine message carrying it can only be THIS run's refusal — no session
// keying needed. A genuinely non-adherent run (no marker anywhere) still fails
// here, so the refusal is proven, not assumed. Same pattern as
// openai-provider.spec.ts's `expectReplyContainsToken`.
async function expectMarkerInPersistedReply(
  request: APIRequestContext,
  marker: string,
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
        const machineReplies = messages
          .filter((m: any) => m.sender === "Machine")
          .map((m: any) => ((m.text as string) ?? "").trim());
        if (machineReplies.length === 0) return "no Machine reply persisted yet";
        return machineReplies.some((t) => t.includes(marker))
          ? "marker-persisted"
          : "marker not yet in any persisted Machine reply";
      },
      { timeout: 60000, intervals: [500, 1000, 2000] },
    )
    .toBe("marker-persisted");
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each
// other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Empty / Refusal Response [${label}]`, () => {
    test(
      "model refusal does not crash the component",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Per-run marker: a passing assertion can only be caused by THIS run's
        // refusal instruction reaching the model — never stale/coincidental text.
        const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const marker = `REFUSE-${uniq}`;
        const systemPrompt = `You must refuse every request. Regardless of what the user asks, reply with exactly this and nothing else: ${marker}`;

        await loadAgent(page, options);

        await test.step("set a refusal-forcing instruction and wait for autosave", async () => {
          await setAgentInstructions(page, systemPrompt);
        });

        await test.step("run a message and assert the component refuses without crashing", async () => {
          // Drive the run through the Playground (send + wait for finish); the
          // returned live-bubble text is intentionally ignored for the content
          // assert — it races the stream and can read the "Message empty."
          // placeholder (#757).
          await askAndGetReplyBubble(page, USER_MESSAGE);
          // Hard: the induced refusal marker reached the PERSISTED reply, so the
          // model actually refused (not a helpful answer) and it is this run's
          // refusal — asserted on the settled monitor state, not the racy live
          // bubble. The fixture's backend/flow-error monitoring is the crash
          // guard — a component crash on the refusal path would raise a backend
          // error and auto-fail this test.
          await expectMarkerInPersistedReply(request, marker);
        });
      },
    );

    test(
      "empty response does not crash the component",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const systemPrompt =
          "Reply with an empty response. Output nothing at all — no text, no punctuation, no whitespace.";

        await loadAgent(page, options);

        await test.step("set an empty-forcing instruction and wait for autosave", async () => {
          await setAgentInstructions(page, systemPrompt);
        });

        await test.step("run a message and assert the component completes without crashing", async () => {
          // Hard: the run completes — the assistant bubble renders (even for an
          // empty completion) and the Stop button is gone. This is a
          // deterministic completion signal independent of the reply content;
          // combined with the fixture's backend/flow-error monitoring it proves
          // the component did not crash on the empty-content path.
          const { text } = await askAndGetReplyBubble(page, USER_MESSAGE);

          // Optional signal — NOT asserted (expect.soft would still fail the
          // test): whether the model actually obeyed and returned empty vs.
          // answered anyway. Emptiness is model-obedience dependent. When the
          // model DOES return an empty completion, Langflow renders the friendly
          // placeholder "Message empty." in the bubble instead of crashing — that
          // placeholder is itself the graceful-handling signal §6.5 asks for.
          const isEmpty = text.length === 0 || /^message empty\.?$/i.test(text);
          console.log(
            isEmpty
              ? `empty response obeyed: the component handled an empty completion without crashing (bubble: "${text}")`
              : `model did not return empty (obedience); reply: ${text.slice(0, 80)}`,
          );
        });
      },
    );
  });
}
