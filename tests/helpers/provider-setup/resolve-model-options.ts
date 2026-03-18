import type { Provider } from "./index";

export interface ModelOptions {
  provider?: Provider;
  model?: string;
}

/**
 * Resolves which provider/model to use based on env vars.
 *
 * MODEL_TEST_STRATEGY=all      → returns options as-is (caller iterates all DB models)
 * MODEL_TEST_STRATEGY=provider → returns { provider: MODEL_TEST_PROVIDER }
 * MODEL_TEST_STRATEGY=model    → returns { model: MODEL_TEST_ID }
 *
 * Explicit options always take precedence over env vars.
 */
export function resolveModelOptions(options: ModelOptions = {}): ModelOptions {
  if (options.provider || options.model) {
    return options;
  }

  const strategy = process.env.MODEL_TEST_STRATEGY ?? "all";

  if (strategy === "provider" && process.env.MODEL_TEST_PROVIDER) {
    return { provider: process.env.MODEL_TEST_PROVIDER as Provider };
  }

  if (strategy === "model" && process.env.MODEL_TEST_ID) {
    return { model: process.env.MODEL_TEST_ID };
  }

  return options;
}
