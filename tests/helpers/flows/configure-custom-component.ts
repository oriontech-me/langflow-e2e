import { expect, type Page } from "@playwright/test";

/**
 * Configure a Custom Component end-to-end: add one to the canvas, open its code
 * editor, replace the scaffold with `code`, and run Check & Save so Langflow
 * compiles the code into a real node.
 *
 * Precondition: a flow canvas is open and `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`
 * (the nightly image defaults it to `false`, which hides
 * `sidebar-custom-component-button` and 403s creation — #668). Asserting the
 * resulting node's declared interface is the caller's job.
 *
 * Mirrors the flow validated by
 * `core-components/full-custom-component.spec.ts`.
 */
export async function configureCustomComponent(
  page: Page,
  code: string,
): Promise<void> {
  await page.getByTestId("sidebar-custom-component-button").click();

  const codeButton = page.getByTestId("code-button-modal").last();
  await expect(codeButton).toBeVisible({ timeout: 10000 });
  await codeButton.click();

  // Select all scaffold code in the Ace editor and replace it.
  await page.locator(".ace_content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.locator("textarea").fill(code);

  await page.getByText("Check & Save").last().click();
}
