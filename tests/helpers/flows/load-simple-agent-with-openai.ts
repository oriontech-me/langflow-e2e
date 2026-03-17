import type { Page } from "@playwright/test";
import { loadSimpleAgent } from "./load-simple-agent";

export async function loadSimpleAgentWithOpenAI(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  await loadSimpleAgent(page, { provider: "openai", model: modelTestId });
}
