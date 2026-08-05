import type { Page } from "@playwright/test";
import { setupOpenAI } from "./setup-openai";
import { setupAnthropic } from "./setup-anthropic";
import { setupGoogle } from "./setup-google";
import { setupOllama } from "./setup-ollama";
import { providerConfigMap, type Provider } from "./provider-config";

export type {
  ApiKeyProviderConfig,
  BaseUrlProviderConfig,
  KeyedProvider,
  Provider,
  ProviderConfig,
} from "./provider-config";
export {
  providerConfigMap,
  keyedProviders,
  keyedProviderNames,
  langflowProviderName,
} from "./provider-config";

// Derivado de provider-config.ts — edite lá para alterar as chaves de ambiente
export const providerEnvKeyMap: Record<string, string[]> = Object.fromEntries(
  (Object.keys(providerConfigMap) as (keyof typeof providerConfigMap)[]).map((p) => [
    p,
    providerConfigMap[p].envKeys,
  ]),
);

export const providerSetupMap: Record<
  Provider,
  (page: Page, modelTestId?: string) => Promise<void>
> = {
  openai: setupOpenAI,
  anthropic: setupAnthropic,
  google: setupGoogle,
  ollama: setupOllama,
};

/** Retorna true se todas as env vars do provider estiverem definidas */
export function hasProviderEnvKeys(provider: Provider): boolean {
  return providerEnvKeyMap[provider].every((key) => !!process.env[key]);
}

/** Retorna a lista de env vars ausentes para o provider */
export function missingProviderEnvKeys(provider: Provider): string[] {
  return providerEnvKeyMap[provider].filter((key) => !process.env[key]);
}
