import type { Page } from "@playwright/test";
import { adjustScreenView } from "../ui/adjust-screen-view";
import { updateOldComponents } from "../flows/update-old-components";
import { setupOpenAI } from "../provider-setup/setup-openai";
import { resolveGptModel } from "../provider-setup/resolve-gpt-model";
import { unselectNodes } from "../ui/unselect-nodes";

export async function initialGPTsetup(
  page: Page,
  options?: {
    skipAdjustScreenView?: boolean;
    skipUpdateOldComponents?: boolean;
    skipProviderSetup?: boolean;
  },
) {
  if (!options?.skipAdjustScreenView) {
    await adjustScreenView(page);
  }
  if (!options?.skipUpdateOldComponents) {
    await updateOldComponents(page);
  }
  if (!options?.skipProviderSetup) {
    // Pin a deterministic GPT model from models.json instead of relying on
    // the dropdown's runtime contents (#606 — same class as #596: the
    // catalog-order fallback silently changes which model every consumer
    // runs). If the pinned model left the live lineup (stale models.json),
    // setupOpenAI falls through to its UI preference-ranking in-dropdown
    // rather than failing every consumer spec.
    await setupOpenAI(page, resolveGptModel(), { fallbackToRanking: true });
  }
  if (!options?.skipAdjustScreenView) {
    await adjustScreenView(page);
  }

  await unselectNodes(page);
}
