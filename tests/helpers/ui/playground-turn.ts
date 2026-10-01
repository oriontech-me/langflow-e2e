import { expect, type Page } from "@playwright/test";

/**
 * Send the Playground prompt and wait until THIS turn has finished (#2046).
 *
 * The wait this replaces was, in some 21 spec files:
 *
 *   const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
 *   if (stopVisible) await expect(stopButton).toBeHidden({ timeout: 120000 });
 *
 * It does not wait. `locator.isVisible()` returns immediately, and Playwright
 * documents its `timeout` option as `@deprecated This option is ignored`, so the
 * probe samples the single instant after the Send click. Measured on
 * `1.13.0.dev28`, sampling the DOM every 10 ms after Send (3 of 3 runs):
 *
 *   ~0 ms        button-stop absent, no bot message — the probe reads `false`
 *   380–450 ms   button-stop visible AND the bot `div-chat-message` mounts EMPTY
 *   1.4–2.0 s    tokens stream into that bubble
 *   1.6–2.4 s    button-stop gone, button-send back
 *
 * So the wait was skipped every time, and a spec that read the reply once read
 * `""` — the "empty reply" of #2095. `agent-component-regression`'s quarantined
 * interaction suite failed 0/3 with the probe and passed 3/3 with this gate.
 *
 * The gate is the #569/#354 shape `memory-history-regression` and
 * `agent-max-tokens` already use, made shared:
 *
 *  1. The turn STARTED: the `div-chat-message` count rises above what it was
 *     before Send, or an `error-card-stack` appears. Upstream renders the error
 *     card INSTEAD of the bot bubble (#1188), so an errored run still counts as a
 *     started one and is left to the spec's own assertion and to the fixture's
 *     flow-error gate to name. Without this step, step 2 could pass on a
 *     button-stop that has not rendered YET — the same race in a new place.
 *  2. The turn FINISHED: `button-stop` is hidden and `button-send` is back.
 *
 * The gate keys on the `button-stop` TESTID, not on `getByRole("button",
 * { name: "Stop" })`: they are different elements, and the role one stays
 * visible ~400 ms after the testid one has cleared.
 *
 * The budgets are the ones the replaced probe and its callers already used —
 * 60 s for the reply to mount (what `div-chat-message` waits used), 120 s for
 * generation — so no failure is outwaited that used to surface.
 *
 * `send` replaces the default `button-send` click for a caller that has to send
 * some other way (#2123): the MCP client specs set the textarea value and click
 * Send inside one `page.evaluate`, so the #226 prefill cannot reset the prompt
 * between fill and click. The counts are still taken BEFORE `send` runs, which
 * is the whole reason it is a callback and not a separate "await the turn" call.
 */
export async function sendAndAwaitPlaygroundTurn(
  page: Page,
  options: { send?: () => Promise<void> } = {},
): Promise<void> {
  const messages = page.getByTestId("div-chat-message");
  const errorCards = page.getByTestId("error-card-stack");
  const messagesBefore = await messages.count();
  const errorsBefore = await errorCards.count();

  if (options.send) await options.send();
  else await page.getByTestId("button-send").last().click();

  await expect
    .poll(
      async () =>
        (await messages.count()) > messagesBefore || (await errorCards.count()) > errorsBefore,
      {
        timeout: 60000,
        message:
          "the Playground turn never started: no new div-chat-message and no error card within 60 s of Send",
      },
    )
    .toBe(true);

  await expect(
    page.getByTestId("button-stop"),
    "the Playground turn never finished: button-stop still visible after 120 s",
  ).toBeHidden({ timeout: 120000 });
  await expect(
    page.getByTestId("button-send").last(),
    "button-send did not come back after the turn finished",
  ).toBeVisible({ timeout: 10000 });
}
