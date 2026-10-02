import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// The voice button lives on the PUBLIC playground (`/playground/:id`), which still
// mounts the older IOModal chat input; the editor playground renders the new chat
// input, which has an `audio-button` and no voice button. Measured on
// 1.13.0.dev29 — see docs/ui-ux/voice-assistant.md (#1915).

let flowId: string | null = null;

test.afterEach(async ({ page, request }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (flowId) {
    const auth = await getAuthToken(request);
    await deleteFlow(request, flowId, auth ? { headers: { Authorization: auth } } : undefined);
  }
  flowId = null;
});

/**
 * Opens a fresh public playground with `voice_mode_available` overridden, and
 * fails unless the config mock fired. The real config is fetched and
 * merged, never replaced: the nightly reports `false` because it does not ship
 * `webrtcvad`, so this is a test of the frontend gate.
 */
async function openPublicPlayground(
  page: Page,
  voiceModeAvailable: boolean,
  beforeNavigate?: () => Promise<void>,
): Promise<void> {
  const request = page.request;
  flowId = await createFlowFromStarter(request, "Basic Prompting", `voice-assistant-${Date.now()}`);
  const auth = await getAuthToken(request);
  const publish = await request.patch(`/api/v1/flows/${flowId}`, {
    headers: auth ? { Authorization: auth } : undefined,
    data: { access_type: "PUBLIC" },
  });
  expect(publish.ok(), `PATCH access_type=PUBLIC answered ${publish.status()}`).toBe(true);

  let fired = 0;
  await page.route("**/api/v1/config", async (route) => {
    fired++;
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), voice_mode_available: voiceModeAvailable },
    });
  });

  await beforeNavigate?.();
  await page.goto(`/playground/${flowId}/`);
  await expect(page.getByTestId("input-wrapper")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("button-send").last()).toBeVisible();
  expect(fired, "the config mock never fired, so the flag under test was not applied").toBeGreaterThan(0);
}

// A RegExp rather than a predicate, so the browser filters it and only the variables
// list round-trips to the test; the query string carries the flow scope.
const VARIABLES_URL = /\/api\/v1\/variables\/?(?:\?|$)/;

/** Any read of the variables list, scoped or not. */
function isVariablesList(url: string, method: string): boolean {
  return method === "GET" && /^\/api\/v1\/variables\/?$/.test(new URL(url).pathname);
}

/** The request that decides `hasOpenAIAPIKey`: the list scoped to this test's flow. */
function isScopedVariablesList(url: string, method: string): boolean {
  return (
    flowId !== null &&
    isVariablesList(url, method) &&
    new URL(url).searchParams.get("flow_id") === flowId
  );
}

// Fields beyond `name` are read only on paths the tests never take (editing or
// deleting the key); nothing is persisted.
const SYNTHETIC_OPENAI_KEY = {
  id: "00000000-0000-4000-8000-000000002150",
  name: "OPENAI_API_KEY",
  type: "Credential",
  value: null,
  default_fields: [],
};

/**
 * Pins whether the voice assistant sees a stored OpenAI key, whatever the lane holds.
 * `hasOpenAIAPIKey` is "a global variable named OPENAI_API_KEY exists", and a lane
 * gets one from the collect-models pre-flight or from Langflow importing its own
 * environment (#2149). The real list is fetched and that entry dropped, or a
 * synthetic one added (#2150); nothing is persisted, so the shared variable the
 * provider specs depend on is never touched. A body that is not a list (an error) is
 * passed through so its real status stays visible.
 *
 * Every list is rewritten, but only the flow-scoped one is counted, and only once it
 * was served rewritten: the page also loads an unscoped list before the click, which
 * would satisfy the count on its own.
 */
async function routeStoredOpenAIKey(page: Page, stored: boolean): Promise<() => number> {
  let scoped = 0;
  await page.route(VARIABLES_URL, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();
    const response = await route.fetch();
    const variables: unknown = await response.json().catch(() => null);
    if (!Array.isArray(variables)) return route.fulfill({ response });
    const others = variables.filter((variable: { name?: string }) => variable.name !== "OPENAI_API_KEY");
    await route.fulfill({
      response,
      json: stored ? [...others, SYNTHETIC_OPENAI_KEY] : others,
    });
    // Counted only once a rewritten list was served: an error body passes through
    // untouched, and on a key-holding lane it would leave test 1 in the no-key
    // state without the filter ever acting.
    if (isScopedVariablesList(request.url(), request.method())) scoped++;
  });
  return () => scoped;
}

/**
 * Clicks the voice button and waits for the variables list, then asserts the
 * assistant and its settings popover are open and polls until the flow-scoped list
 * has been served rewritten — so any assertion after this sees the pinned state's
 * data on the wire, whichever variables response the wait itself resolved on. The popover opens itself while no key is known, which is always the
 * case at the click because the scoped list has not landed yet.
 */
async function openVoiceAssistant(page: Page, scopedFired: () => number): Promise<void> {
  // The wait takes any variables read after the click, not only the scoped one and
  // not through VARIABLES_URL, so a route that stops matching — or a list that stops
  // carrying `flow_id` — still reaches the named assertion below instead of timing
  // out here. The unscoped page-load read has already happened by the click.
  await Promise.all([
    page.waitForResponse((response) => isVariablesList(response.url(), response.request().method())),
    page.getByTestId("voice-button").click(),
  ]);
  await expect(page.getByTestId("voice-assistant-container")).toBeVisible();
  await expect(page.getByTestId("voice-assistant-settings-modal-header")).toBeVisible();
  await expect
    .poll(scopedFired, {
      message: "the variables mock never served the flow-scoped list, so a key stored on this instance decides the popover's state",
    })
    .toBeGreaterThan(0);
}

test(
  "should able to see and interact with voice assistant",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    let scopedFired = () => 0;

    await test.step("open the public playground with voice mode available and no OpenAI key stored", async () => {
      await openPublicPlayground(page, true, async () => {
        scopedFired = await routeStoredOpenAIKey(page, false);
      });
    });

    await test.step("the voice button opens the assistant with its settings popover", async () => {
      // The key field also renders while the variables list is still in flight, so
      // a key that was not hidden would pass the assertion below in that window.
      // Waiting for the list narrows it from a network round trip to one render.
      await openVoiceAssistant(page, scopedFired);
      await expect(page.getByTestId("popover-anchor-openai-api-key")).toBeVisible();
    });

    await test.step("dismissing the popover and closing the assistant restores the chat input", async () => {
      // Escape, not the popover's Cancel: Cancel only leaves key-editing mode and
      // the popover stays open while no key is stored (audio-settings-dialog.tsx).
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("voice-assistant-settings-modal-header")).toBeHidden();

      await page.getByTestId("voice-assistant-close-button").click();
      await expect(page.getByTestId("voice-assistant-container")).toBeHidden();
      await expect(page.getByTestId("input-wrapper")).toBeVisible();
    });
  },
);

test(
  "user should not be able to see voice button if voice mode is not available",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    await test.step("open the public playground with voice mode unavailable", async () => {
      await openPublicPlayground(page, false);
    });

    await test.step("no voice button is rendered once the chat input has loaded", async () => {
      await expect(page.getByTestId("voice-button")).toHaveCount(0);
    });
  },
);

test(
  "user should be able to see voice button if voice mode is available",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    await test.step("open the public playground with voice mode available", async () => {
      await openPublicPlayground(page, true);
    });

    await test.step("the voice button is rendered", async () => {
      await expect(page.getByTestId("voice-button")).toBeVisible();
    });
  },
);

test(
  "should show the voice settings when an OpenAI key is stored",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    let scopedFired = () => 0;

    await test.step("open the public playground with voice mode available and an OpenAI key stored", async () => {
      await openPublicPlayground(page, true, async () => {
        scopedFired = await routeStoredOpenAIKey(page, true);
      });
    });

    await test.step("the settings popover offers the voice settings instead of asking for the key", async () => {
      await openVoiceAssistant(page, scopedFired);
      // Both render only once a list reporting a key has landed, so unlike test 1's
      // key field they cannot pass in the window before it.
      await expect(page.getByTestId("voice-assistant-settings-modal-microphone-select")).toBeVisible();
      await expect(page.getByRole("menu").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect(page.getByTestId("popover-anchor-openai-api-key")).toHaveCount(0);
      // The popover is left open: closing it with a key stored starts audio
      // initialisation, which opens the voice websocket this image cannot serve.
      // (Rendering it already requests microphone access: MicrophoneSelect calls
      // getUserMedia on mount. A scout measured the resulting console error a few
      // seconds later; the test ends before it.)
    });
  },
);
