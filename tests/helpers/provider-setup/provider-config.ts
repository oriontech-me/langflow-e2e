export type Provider = "openai" | "anthropic" | "google";

export interface ProviderConfig {
  providerTestId: string;
  keyPlaceholder: string;
  invalidKey: string;
  envKeys: string[]; // todas as env vars necessárias; a primeira é a chave primária
  // Model used to probe a raw API key before the suite runs (#976). Must be a
  // cheap, broadly available model: key resolution happens before models.json
  // exists, so it cannot be picked from the collected catalog.
  probeModel: string;
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
    probeModel: "gpt-4o-mini",
  },
  anthropic: {
    providerTestId: "provider-item-Anthropic",
    keyPlaceholder: "sk-ant-...",
    invalidKey: "sk-ant-invalid-for-testing-12345",
    envKeys: ["ANTHROPIC_API_KEY"],
    probeModel: "claude-3-5-haiku-latest",
  },
  google: {
    providerTestId: "provider-item-Google Generative AI",
    keyPlaceholder: "AIza...",
    invalidKey: "AIza-invalid-google-key-for-testing-12345",
    envKeys: ["GOOGLE_API_KEY"],
    probeModel: "gemini-2.5-flash",
  },
};
