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

  await page.goto(`/playground/${flowId}/`);
  await expect(page.getByTestId("input-wrapper")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("button-send").last()).toBeVisible();
  expect(fired, "the config mock never fired, so the flag under test was not applied").toBeGreaterThan(0);
}

test(
  "should able to see and interact with voice assistant",
  { tag: ["@release", "@playground"] },
  async ({ page }) => {
    await test.step("open the public playground with voice mode available", async () => {
      await openPublicPlayground(page, true);
    });

    await test.step("the voice button opens the assistant with its settings popover", async () => {
      await page.getByTestId("voice-button").click();
      await expect(page.getByTestId("voice-assistant-container")).toBeVisible();
      await expect(page.getByTestId("voice-assistant-settings-modal-header")).toBeVisible();
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
