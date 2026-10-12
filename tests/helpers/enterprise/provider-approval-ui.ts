import type { APIRequestContext, Page, Response } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Approving a model provider through the Enterprise admin console, shared by the
 * Providers and Models screen specs.
 *
 * On 1.12 the Providers screen offered recommended-provider CARDS with an
 * `Approve` button. The 1.13 console removed them (EE PR 326): approval is the
 * header's `Add provider` button, which opens `dialog "Add provider"` — pick the
 * provider in the `Provider / API` combobox, submit `Add Provider`. Still keyless:
 * credentials are optional, so a provider can be approved with none (#2259).
 */

export const GOVERNANCE = "/api/v1/model-provider-governance";
const BUNDLE = "/api/v1/policy-bundle";

export function providersPanel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-providers");
}

export function addProviderDialog(page: Page) {
  return page.getByRole("dialog", { name: "Add provider" });
}

/** Open `/admin/providers` and the Add provider dialog, with `label` picked. */
export async function openAddProviderDialog(page: Page, label: string): Promise<void> {
  await page.goto("/admin/providers");
  await expect(providersPanel(page)).toBeVisible({ timeout: 30_000 });
  const dialog = addProviderDialog(page);
  // Exact: the empty state's inline button reads "add a provider", and the
  // dialog's own submit reads "Add Provider".
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Provider / API" }).click();
  // Exact, or "OpenAI" would also match "OpenAI Compatible".
  await page.getByRole("option", { name: label, exact: true }).click();
}

/**
 * Submit the open Add provider dialog and return the governance write it made.
 * The dialog closing is asserted too: a write that left the dialog open would
 * leave the next step clicking through its overlay.
 */
export async function submitAddProvider(page: Page): Promise<Response> {
  const dialog = addProviderDialog(page);
  const written = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === GOVERNANCE &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await dialog.getByRole("button", { name: "Add Provider", exact: true }).click();
  const response = await written;
  await expect(dialog).toBeHidden();
  return response;
}

/** Approve `label` through the screen that owns approving. Asserts the 201. */
export async function approveProviderThroughUi(page: Page, label: string): Promise<void> {
  await openAddProviderDialog(page, label);
  expect((await submitAddProvider(page)).status()).toBe(201);
}

/**
 * Remove an approval the way the product does — the console's own `Remove
 * provider` sends exactly this.
 *
 * `expected_revision` is optimistic concurrency over the whole policy bundle.
 * Deliberately NOT `PUT /api/v1/model-provider-policy` with an empty list: that
 * answers `200` and clears the policy while the governance record stays
 * `active`, so the two surfaces then disagree about whether the provider is
 * approved — the exact state a careless cleanup hands to the next spec.
 *
 * A failed bundle read THROWS rather than skipping the cleanup: on 1.13 that read
 * is tier-gated, and a silent skip left the next test starting from an approval
 * it never made.
 */
export async function revokeProviderApproval(
  request: APIRequestContext,
  auth: string,
  providerId: string,
): Promise<void> {
  const headers = { Authorization: auth };
  const bundle = await request.get(BUNDLE, { headers });
  expect(bundle.status(), await bundle.text()).toBe(200);
  const { revision } = (await bundle.json()) as { revision: number };
  await request
    .delete(`${GOVERNANCE}/${providerId}`, { headers, data: { expected_revision: revision } })
    .catch(() => undefined);
}
