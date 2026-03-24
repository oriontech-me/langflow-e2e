import type { Page } from "@playwright/test";
import { adjustScreenView } from "../ui/adjust-screen-view";
import { updateOldComponents } from "../flows/update-old-components";
import { setupOpenAI } from "../provider-setup/setup-openai";
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
    await setupOpenAI(page);
  }
  if (!options?.skipAdjustScreenView) {
    await adjustScreenView(page);
  }

  await unselectNodes(page);
}
