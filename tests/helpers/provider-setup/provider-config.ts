export type Provider = "openai" | "anthropic" | "google" | "ollama";

/**
 * How a provider is configured in Settings → Model Providers.
 *
 * Until #1187 every provider was assumed to be `api-key`, and the assumption was
 * spread across the suite as *direct field reads* (`config.keyPlaceholder`,
 * `config.invalidKey`) rather than as a check anything could branch on. Ollama has
 * no key at all — its only variable is `OLLAMA_BASE_URL`, which Langflow persists as
 * a `Global` variable, not a `Credential` (confirmed on 1.12.0.dev10 via
 * `GET /api/v1/models`: `is_secret: false`, `langchain_param: "base_url"`).
 *
 * So the shape is a discriminated union on purpose: a consumer that fills an API key
 * can no longer reach `keyPlaceholder` without narrowing first, which makes the
 * compiler — not a CI run — name every place that must decide what to do with a
 * keyless provider. `keyedProviders` in `index.ts` is the ready-made narrowing for
 * "every provider that has a key".
 */
export type ProviderCredentialKind = "api-key" | "base-url";

interface ProviderConfigBase {
  providerTestId: string;
  /** All env vars this provider needs; the first is the primary one. */
  envKeys: string[];
}

export interface ApiKeyProviderConfig extends ProviderConfigBase {
  credential: "api-key";
  keyPlaceholder: string;
  invalidKey: string;
}

export interface BaseUrlProviderConfig extends ProviderConfigBase {
  credential: "base-url";
  /** The `data-testid` of the URL input in the provider panel. */
  variableInputTestId: string;
}

export type ProviderConfig = ApiKeyProviderConfig | BaseUrlProviderConfig;

// ─── Fonte única de configuração por provider ─────────────────────────────────
// Ao adicionar um novo provider, inclua uma entrada aqui.
// Todos os demais arquivos (index.ts, collect-models.ts, specs) derivam seus
// dados a partir deste mapa — nenhuma mudança adicional é necessária nesses arquivos.
//
// ORDER IS LOAD-BEARING: several specs fall back to `Object.keys(providerConfigMap)[0]`
// when a target carries no provider, so `openai` must stay first. Keyless providers
// are appended, never inserted.

// `satisfies` rather than a `Record<Provider, ProviderConfig>` annotation: the
// annotation would widen every entry to the union, so even `providerConfigMap.ollama`
// — a statically known key — would hide `variableInputTestId` behind a narrowing that
// cannot fail. `satisfies` enforces the same contract while keeping each entry's
// literal type, which is also what lets `KeyedProvider` be DERIVED below instead of
// re-listing the keyed providers by hand.
export const providerConfigMap = {
  openai: {
    credential: "api-key",
    providerTestId: "provider-item-OpenAI",
    keyPlaceholder: "sk-...",
    invalidKey: "sk-invalid-openai-key-for-testing-12345",
    envKeys: ["OPENAI_API_KEY"],
  },
  anthropic: {
    credential: "api-key",
    providerTestId: "provider-item-Anthropic",
    keyPlaceholder: "sk-ant-...",
    invalidKey: "sk-ant-invalid-for-testing-12345",
    envKeys: ["ANTHROPIC_API_KEY"],
  },
  google: {
    credential: "api-key",
    providerTestId: "provider-item-Google Generative AI",
    keyPlaceholder: "AIza...",
    invalidKey: "AIza-invalid-google-key-for-testing-12345",
    envKeys: ["GOOGLE_API_KEY"],
  },
  // A LOCAL SERVICE, not a keyed cloud API: no credit, no secret, no quota — which
  // is the whole point of routing the `any-completion` tier here (#1187). Its env
  // gate is the base URL, so `hasProviderEnvKeys("ollama")` answers "was a local
  // instance declared", exactly as it answers "is there a key" for the other three.
  ollama: {
    credential: "base-url",
    providerTestId: "provider-item-Ollama",
    variableInputTestId: "provider-variable-input-OLLAMA_BASE_URL",
    envKeys: ["OLLAMA_BASE_URL"],
  },
} satisfies Record<Provider, ProviderConfig>;

/**
 * The providers configured by an API key, derived from the map above.
 *
 * Derived rather than listed so a new entry cannot be forgotten here: everything
 * whose subject is a key (the invalid-key journey, the `collect-models` sweep, the
 * build-axis component table) is typed against this, so adding a keyless provider
 * cannot silently widen those surfaces, and adding a keyed one cannot silently miss
 * them — the compiler decides, from `credential`.
 */
export type KeyedProvider = {
  [P in Provider]: (typeof providerConfigMap)[P]["credential"] extends "api-key"
    ? P
    : never;
}[Provider];

/**
 * Every keyed provider with its config narrowed to `ApiKeyProviderConfig` — the
 * ready-made iteration for consumers whose subject IS the key.
 *
 * Declared here rather than in `index.ts` because `index.ts` pulls in the setup
 * helpers (and through them `@playwright/test`), while `collect-models.ts` and the
 * `node --test` units lane need this list without that weight.
 *
 * Ordered as declared above, so `[0]` is still `openai`.
 */
export const keyedProviders: Array<[KeyedProvider, ApiKeyProviderConfig]> = (
  Object.entries(providerConfigMap) as Array<[Provider, ProviderConfig]>
).flatMap(([provider, config]) =>
  config.credential === "api-key"
    ? [[provider as KeyedProvider, config] as [KeyedProvider, ApiKeyProviderConfig]]
    : [],
);

/** Names only, for the `Object.keys(providerConfigMap)`-shaped call sites. */
export const keyedProviderNames: KeyedProvider[] = keyedProviders.map(
  ([provider]) => provider,
);
