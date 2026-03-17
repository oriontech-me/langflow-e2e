import type { Page } from "@playwright/test";
import { setupOpenAI } from "./setup-openai";
import { setupAnthropic } from "./setup-anthropic";
import { setupGoogle } from "./setup-google";

export type Provider = "openai" | "anthropic" | "google";

export const providerSetupMap: Record<
  Provider,
  (page: Page, modelTestId?: string) => Promise<void>
> = {
  openai: setupOpenAI,
  anthropic: setupAnthropic,
  google: setupGoogle,
};
