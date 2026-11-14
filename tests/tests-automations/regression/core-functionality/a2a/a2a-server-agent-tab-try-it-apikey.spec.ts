import { expect } from "@playwright/test";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import type { PageWithErrorHooks } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";

// Spec doc: docs/core-functionality/a2a/a2a-server-agent-tab-try-it-apikey.md
//
// Since 1.14.0.dev23 (#16186 + #16151) every project created under AUTO_LOGIN is
// "apikey", the default one included, so the restricted Try it panel is the one a
// user reaches first. That panel adds an `agent-test-apikey` field. The HTTP half of
// the gate is asserted in a2a-server-auth-apikey.spec.ts; what only the UI can show
// is whether the panel puts the typed key on the wire as `x-api-key`, and what it
// renders when the key is missing or wrong.
//
// Each test creates its OWN project with an EXPLICIT auth_type "apikey" rather than
// relying on the default project: the default is apikey only on dev23+ builds, and
// it is shared with every spec running in parallel.

// Syntactically plausible and certainly unknown, so the call reaches the key lookup
// and fails there (same value as a2a-server-auth-apikey.spec.ts).
const UNKNOWN_API_KEY = "sk-e2e-definitely-not-a-real-key-000000000000";

function newSentinel(): string {
  return `a2a-try-it-key-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Number of times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface RestrictedAgent {
  flowId: string;
  cleanup: () => Promise<void>;
}

/**
 * A Chat Input -> Chat Output passthrough flow in a project of its own whose
 * auth_type is "apikey". Cleanup deletes the flow, then the project (which also
 * sweeps the key Langflow mints for an auth_settings project); both halves always
 * run and the first failure is rethrown.
 */
async function createRestrictedAgentFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<RestrictedAgent> {
  const project = await createProjectViaApi(request, headers, {
    namePrefix: "a2a-tryit-key",
    description: "Restricted (auth_type apikey) project for the A2A Try it spec",
    authSettings: { auth_type: "apikey" },
  });

  let flow: Awaited<ReturnType<typeof createRunnableChatFlowViaApi>>;
  try {
    flow = await createRunnableChatFlowViaApi(request, headers, { folderId: project.projectId });
  } catch (e) {
    // No handle reaches the caller when this throws, so nothing else would delete
    // the project made for the flow.
    await project.deleteProject().catch((err) => console.warn(`⚠️ project cleanup failed: ${err}`));
    throw e;
  }

  return {
    flowId: flow.flowId,
    cleanup: async () => {
      let firstError: unknown;
      try {
        await flow.deleteFlow();
      } catch (e) {
        firstError = e;
      }
      // After the flow, never before: a project still holding flows is a
      // different delete path.
      try {
        await project.deleteProject();
      } catch (e) {
        firstError ??= e;
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

/** Publishes the flow through the Agent tab and lands on the restricted panel. */
async function publishAndOpenRestrictedPanel(page: Page, flowId: string): Promise<void> {
  await openFlowById(page, flowId);

  await test.step("publish through the UI to reach the panel", async () => {
    await page.getByTestId("sidebar-nav-agent").click();
    await page.getByTestId("agent-publish-switch").click();

    // The status chip flips optimistically; the PATCH is what proves the agent is
    // published before anything is sent to it.
    const saved = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/v1/flows/${flowId}` &&
        res.status() === 200,
    );
    await page.getByTestId("agent-save").click();
    await saved;

    await expect(page.getByTestId("agent-status")).toHaveText("Live");
  });

  await test.step("the panel is the restricted one: it asks for an API key", async () => {
    // The field exists only for an agent whose project requires a key — asserting it
    // is what proves this spec is not silently running the public panel.
    await expect(page.getByTestId("agent-test-apikey")).toBeVisible();
  });
}

/**
 * Clicks Send and returns the panel's message/send response.
 *
 * Both promises are awaited together: a `waitForResponse` left dangling when the
 * click fails rejects unhandled, which tears the context down under the teardown
 * and leaks what the test created (measured while force-failing this spec).
 */
async function sendAndCaptureJsonRpc(page: Page, flowId: string): Promise<Response> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === `/api/v1/a2a/${flowId}/jsonrpc`,
    ),
    page.getByTestId("agent-test-send").click(),
  ]);
  return res;
}

test.describe("A2A Server — Agent tab Try it panel on a restricted agent", () => {
  // Every resource a test creates registers its delete here, and afterEach runs
  // them newest-first. afterEach, not a `finally`: it runs while the page fixture
  // is still alive, a test timeout included. One failing delete does not skip the
  // others; the first failure is rethrown so a leak is reported, not swallowed.
  let teardown: Array<() => Promise<void>> = [];

  test.afterEach(async ({ page }) => {
    const steps = teardown.reverse();
    teardown = [];
    // Leave the editor first: an editor mounted over a deleted flow 404s its
    // events poll (#1288).
    await unmountEditorForCleanup(page);
    let firstError: unknown;
    for (const step of steps) {
      try {
        await step();
      } catch (e) {
        firstError ??= e;
      }
    }
    if (firstError !== undefined) throw firstError;
  });

  async function setUpRestrictedAgent(page: Page) {
    const headers = { Authorization: await getAuthToken(page.request) };
    await requireA2aEnabled(page.request, headers);
    const flow = await createRestrictedAgentFlow(page.request, headers);
    teardown.push(flow.cleanup);
    return { headers, flowId: flow.flowId };
  }

  test(
    "the Try it panel forwards the typed key and round-trips a sentinel on a restricted agent",
    { tag: ["@stable", "@workspace", "@ui-ux", "@a2a", "@auth"] },
    async ({ page }) => {
      const { headers, flowId } = await setUpRestrictedAgent(page);
      const apiKey = await createApiKey(page.request, headers, { namePrefix: "a2a-tryit-key" });
      teardown.push(() => deleteApiKey(page.request, apiKey.id, headers));
      const sentinel = newSentinel();

      await publishAndOpenRestrictedPanel(page, flowId);

      await test.step("send the sentinel with the owner's key", async () => {
        await page.getByTestId("agent-test-apikey").fill(apiKey.key);
        await page.getByTestId("agent-test-input").fill(sentinel);

        const res = await sendAndCaptureJsonRpc(page, flowId);
        // The load-bearing half of this test: the key typed in the panel is what
        // goes on the wire, under the header the card advertises.
        expect(res.request().headers()["x-api-key"]).toBe(apiKey.key);
        expect(res.status(), `owner-key send — ${await res.text().catch(() => "<no body>")}`).toBe(200);
      });

      await test.step("the transcript shows the turn reaching a terminal state", async () => {
        await expect(page.getByTestId("agent-transcript")).toContainText("completed");
      });

      await test.step("and the agent echoed the sentinel back", async () => {
        const transcript = await page.getByTestId("agent-transcript").innerText();
        // Two occurrences: one is what a panel rendering only the user's own turn
        // would produce.
        expect(occurrences(transcript, sentinel), `transcript was:\n${transcript}`).toBe(2);
        expect(transcript.indexOf("Agent")).toBeLessThan(transcript.lastIndexOf(sentinel));
      });

      await test.step("the panel counts the turn", async () => {
        await expect(page.getByText("1 turn", { exact: true })).toBeVisible();
      });
    },
  );

  test(
    "the Try it panel blocks a keyless send and renders the 401 for an unknown key",
    { tag: ["@stable", "@workspace", "@ui-ux", "@a2a", "@auth"] },
    async ({ page }) => {
      // The unknown-key 401 is provoked on purpose; keep it out of the backend-error
      // log so that log stays trustworthy (#1084).
      (page as PageWithErrorHooks).allowHttpErrors();

      const { flowId } = await setUpRestrictedAgent(page);
      const sentinel = newSentinel();

      await publishAndOpenRestrictedPanel(page, flowId);

      await test.step("with no key, Send stays disabled", async () => {
        await page.getByTestId("agent-test-input").fill(sentinel);
        await expect(page.getByTestId("agent-test-apikey")).toHaveValue("");
        // Measured on 1.14.0.dev26: the panel does not send and render the
        // `401 API key required` — it never sends at all.
        await expect(page.getByTestId("agent-test-send")).toBeDisabled();
      });

      await test.step("typing a key enables Send", async () => {
        // The control for the step above: the message is unchanged, so it is the
        // key — not the message — that was keeping Send disabled.
        await page.getByTestId("agent-test-apikey").fill(UNKNOWN_API_KEY);
        await expect(page.getByTestId("agent-test-send")).toBeEnabled();
      });

      await test.step("an unknown key is sent and rejected with 401 Invalid API key", async () => {
        const res = await sendAndCaptureJsonRpc(page, flowId);
        const raw = await res.text();
        expect(res.request().headers()["x-api-key"]).toBe(UNKNOWN_API_KEY);
        expect(res.status(), `unknown-key send — ${raw}`).toBe(401);
        expect(JSON.parse(raw).detail).toBe("Invalid API key");
      });

      await test.step("the transcript shows the failure instead of hanging", async () => {
        const transcriptLocator = page.getByTestId("agent-transcript");
        await expect(transcriptLocator).toContainText("failed");
        await expect(transcriptLocator).toContainText("Invalid API key");

        const transcript = await transcriptLocator.innerText();
        // Exactly once: the user turn, with no echoed reply.
        expect(occurrences(transcript, sentinel), `transcript was:\n${transcript}`).toBe(1);
        expect(transcript, `transcript was:\n${transcript}`).not.toContain("completed");
      });
    },
  );
});
