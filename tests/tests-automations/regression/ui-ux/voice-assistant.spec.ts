import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// PARKED — all three tests, #1915. The surface they assert is not in the image this
// suite tests: measured on the nightly `1.13.0.dev15`, the served bundle carries ZERO
// occurrences of `voice-button`, `voice_mode_available` or `voice-assistant`, and the
// open playground reports `voice-button` 0 / `audio-button` 1 with
// `voice_mode_available: true` mocked and the route confirmed to fire. The cause is a
// component swap rather than a feature flag: `ENABLE_VOICE_ASSISTANT` is still `true`
// and the OLD chat input still gates a `VoiceButton` on it, but the shipped playground
// renders `components/core/playgroundComponent/chat-view/chat-input`, whose button row
// holds an `AudioButton` and no voice button at all.
//
// The TODO this replaces ("review the voice assistant vs text to voice") is answered:
// the product chose text-to-voice. See docs/ui-ux/voice-assistant.md.
//
// `test.fixme`, not `test.skip`: the modifier now carries an owner (#1915) instead of a
// note. Nothing here runs in any lane either way — the difference is that a fixme is
// reconciled against an open issue and a bare skip is not (#1568/#1569).
test.fixme(
  "should able to see and interact with voice assistant",
  { tag: ["@release", "@workspace", "@api"] },

  async ({ page }) => {
    // Left on env-var presence (#1029 audit): the `test.fixme` above makes this body
    // unreachable, so it can never reach a provider call and cannot wedge a shard.
    // Whoever lifts the park must swap this for `providerSkipGate("openai")` — a key
    // that EXISTS but is dead is what #1029 is about, and presence does not answer it.
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          voice_mode_available: true,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.getByTestId("playground-btn-flow-io").click();

    await expect(page.getByTestId("voice-button")).toBeVisible();

    await page.getByTestId("voice-button").click();

    try {
      const apiKeyInput = page.getByTestId("popover-anchor-openai-api-key");

      const isVisible = await apiKeyInput
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (isVisible) {
        await apiKeyInput.fill(process.env.OPENAI_API_KEY || "");
        await page
          .getByTestId("voice-assistant-settings-modal-save-button")
          .click();
      }
    } catch (e) {
      console.error(e);
    }

    await expect(page.getByTestId("voice-assistant-container")).toBeVisible();
    await page.getByTestId("voice-assistant-settings-icon").click();
    await expect(
      page.getByTestId("voice-assistant-settings-modal-microphone-select"),
    ).toBeVisible();
    await expect(
      page.getByTestId("voice-assistant-settings-modal-header"),
    ).toBeVisible();

    await page.keyboard.press("Escape");

    await page.getByTestId("voice-assistant-close-button").click();

    await expect(
      page.getByTestId("voice-assistant-settings-modal-microphone-select"),
    ).not.toBeVisible();

    await expect(page.getByTestId("input-wrapper")).toBeVisible();
  },
);

// Measured `3/3 green` in the #1784 dispatches, and parked anyway — this is the finding
// #1913 was filed to look for, arriving from the opposite direction. The assertion is
// `not.toBeVisible()` on an element that cannot exist under ANY config value, so the
// test passes for a reason unrelated to its subject. Both mutations were RUN, not
// argued: with the mock inverted to `true` it passes (5.2 s), and with the route mock
// deleted outright it passes (5.0 s). Green here measures the absence of a
// component, not the behaviour of a flag, so promoting it would put a test that cannot
// fail into the daily.
test.fixme(
  "user should not be able to see voice button if voice mode is not available",
  { tag: ["@release", "@workspace", "@api"] },
  async ({ page, request }) => {
    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          voice_mode_available: false,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.getByTestId("playground-btn-flow-io").click();

    await expect(page.getByTestId("voice-button")).not.toBeVisible();
  },
);

test.fixme(
  "user should be able to see voice button if voice mode is available",
  { tag: ["@release", "@workspace", "@api"] },
  async ({ page, request }) => {
    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          voice_mode_available: true,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.getByTestId("playground-btn-flow-io").click();

    await expect(page.getByTestId("voice-button")).toBeVisible();

    await page.getByTestId("voice-button").click();
  },
);
