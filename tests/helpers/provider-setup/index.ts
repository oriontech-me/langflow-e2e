import type { Page } from "@playwright/test";
import { setupOpenAI } from "./setup-openai";
import { setupAnthropic } from "./setup-anthropic";
import { setupGoogle } from "./setup-google";

export type Provider = "openai" | "anthropic" | "google";

// Chaves de ambiente correspondentes às definidas no arquivo .env
// Ao adicionar um novo provider, inclua aqui todas as chaves necessárias declaradas no .env
// O test.skip irá verificar se TODAS as chaves do provider estão presentes antes de rodar
export const providerEnvKeyMap: Record<Provider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY"],
};

export const providerSetupMap: Record<
  Provider,
  (page: Page, modelTestId?: string) => Promise<void>
> = {
  openai: setupOpenAI,
  anthropic: setupAnthropic,
  google: setupGoogle,
};

/** Retorna true se todas as env vars do provider estiverem definidas */
export function hasProviderEnvKeys(provider: Provider): boolean {
  return providerEnvKeyMap[provider].every((key) => !!process.env[key]);
}

/** Retorna a lista de env vars ausentes para o provider */
export function missingProviderEnvKeys(provider: Provider): string[] {
  return providerEnvKeyMap[provider].filter((key) => !process.env[key]);
}
