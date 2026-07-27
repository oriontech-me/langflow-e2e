// Key-parameterized provider probe, shared by collect-models.ts and
// scripts/resolve-provider-keys.ts (issue #976).
//
// The probe must be a REAL 1-token inference call. An auth-only endpoint
// (GET /v1/models) answers 200 on a zero-balance account and would not have
// caught the failure that drained the 2026-07-27 daily (#967): "Your credit
// balance is too low to access the Anthropic API".
import { type Provider } from "./provider-config";

export type ProbeFailureKind = "key" | "model" | "transport";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  kind?: ProbeFailureKind;
  error?: string;
}

// Same wording set the collect-models.spec.ts gate keys off (#952/#955).
const BILLING_OR_QUOTA =
  /credit balance is too low|insufficient[_ ]?quota|exceeded your current quota|\bquota\b|resource[_ ]?exhausted|billing|payment required/i;

const MODEL_SCOPED = /model|does not exist|not found|not supported/i;

/**
 * Decide whether a failed probe indicts the KEY (advance to the next
 * candidate), the MODEL (the key is fine — the model-candidate loop in
 * collect-models owns that call), or is inconclusive TRANSPORT noise.
 *
 * Deliberately conservative: anything unrecognised is transport, so an
 * unexpected provider response can never burn through the key candidates.
 */
export function classifyProbeFailure(status: number | null, message: string): ProbeFailureKind {
  if (status === null) return "transport";
  if (status >= 500) return "transport";
  // Billing wording wins over the status code: a drained account answering 404
  // is still a key/account problem, not a missing model.
  if (BILLING_OR_QUOTA.test(message)) return "key";
  if (status === 404 || MODEL_SCOPED.test(message)) return "model";
  if (status === 401 || status === 402 || status === 403 || status === 429) return "key";
  return "transport";
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function buildRequest(provider: Provider, apiKey: string, model: string): ProviderRequest {
  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: { model, messages: [{ role: "user", content: "hi" }] },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        headers: { "Content-Type": "application/json" },
        body: { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } },
      };
  }
}

/**
 * Probe one (provider, key, model) triple. Never throws — a transport failure
 * comes back as an inconclusive ProbeResult.
 *
 * The error string is the provider's own `error.message`, verbatim, so callers
 * that pattern-match on it (the collect-models gate) keep working unchanged.
 */
export async function probeProviderKey(
  provider: Provider,
  apiKey: string,
  model: string,
): Promise<ProbeResult> {
  const { url, headers, body } = buildRequest(provider, apiKey, model);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, status: null, kind: "transport", error };
  }

  if (res.ok) return { ok: true, status: res.status };

  const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  const error = payload?.error?.message ?? `HTTP ${res.status}`;
  return { ok: false, status: res.status, kind: classifyProbeFailure(res.status, error), error };
}
