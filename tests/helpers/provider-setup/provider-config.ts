export type Provider = "openai" | "anthropic" | "google";

export interface ProviderConfig {
  providerTestId: string;
  keyPlaceholder: string;
  invalidKey: string;
  envKeys: string[]; // todas as env vars necessárias; a primeira é a chave primária
}

// ─── Fonte única de configuração por provider ─────────────────────────────────
// Ao adicionar um novo provider, inclua uma entrada aqui.
// Todos os demais arquivos (index.ts, collect-models.ts, specs) derivam seus
// dados a partir deste mapa — nenhuma mudança adicional é necessária nesses arquivos.

export const providerConfigMap: Record<Provider, ProviderConfig> = {
  openai: {
    providerTestId: "provider-item-OpenAI",
    keyPlaceholder: "sk-...",
    invalidKey: "sk-invalid-openai-key-for-testing-12345",
    envKeys: ["OPENAI_API_KEY"],
  },
  anthropic: {
    providerTestId: "provider-item-Anthropic",
    keyPlaceholder: "sk-ant-...",
    invalidKey: "sk-ant-invalid-for-testing-12345",
    envKeys: ["ANTHROPIC_API_KEY"],
  },
  google: {
    providerTestId: "provider-item-Google Generative AI",
    keyPlaceholder: "AIza...",
    invalidKey: "AIza-invalid-google-key-for-testing-12345",
    envKeys: ["GOOGLE_API_KEY"],
  },
};
