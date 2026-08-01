// Where the local Ollama instance is, from the two vantage points that differ —
// and the model to exercise on it (#1187).
//
// Two URLs, not one, and conflating them is the failure #583 documented: the
// address the TEST HOST probes is not the address LANGFLOW calls. On a dockerized
// Langflow the container reaches the host as `host.docker.internal`, while the test
// process reaches Ollama on `localhost`. In CI both are the service hostname
// (`http://ollama:11434`) because Langflow and Ollama are sibling containers on one
// network — see `daily-stable.yml`.
//
// Langflow's SSRF layer blocks private addresses unless they are allow-listed, so
// the URL typed into Langflow only validates when the container was started with
// `LANGFLOW_SSRF_ALLOWED_HOSTS` covering it (`ollama` in CI; the RFC-1918 CIDRs for
// `host.docker.internal` locally). Measured on 1.12.0.dev10: without it,
// `POST /api/v1/models/validate-provider` answers **HTTP 200** with
// `{"valid": false, "error": "Invalid Ollama base URL"}` — a rejection that does not
// look like one at the status level.
//
// NOTE: `core-functionality/model-provider/ollama-provider.spec.ts` predates this
// module and holds the same two defaults inline. It is deliberately not touched by
// the enabling PR (it is `@stable` and green); migrating it onto these functions
// belongs to the first adoption follow-up, which edits that area anyway.

/** What the TEST HOST probes for reachability. */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/** What LANGFLOW is told to call — the container's route back to the host. */
export const OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW = "http://host.docker.internal:11434";

/** Reachability URL for the test process. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OLLAMA_BASE_URL || OLLAMA_DEFAULT_BASE_URL;
}

/** The URL typed INTO Langflow. Falls back to the reachability URL's counterpart. */
export function ollamaBaseUrlFromLangflow(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.OLLAMA_BASE_URL_FROM_LANGFLOW || OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW
  );
}

/**
 * The model to run, or `undefined` when the lane pinned none.
 *
 * Deliberately NOT defaulted to the model the CI image happens to bake
 * (`llama3.2:1b`). `ollama-provider.spec.ts` carried such a fallback and it lied:
 * with the baked model changed, the probe reported "model not pulled" and the test
 * skipped silently on the very surface it exists to guard. Callers that cannot
 * proceed without a name must report that, not guess one.
 */
export function ollamaTestModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OLLAMA_TEST_MODEL || undefined;
}
