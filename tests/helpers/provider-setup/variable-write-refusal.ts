/**
 * Classification of a refused global-variable write, and how to describe one.
 *
 * `POST` / `PATCH /api/v1/variables/` is not a dumb persist: when the name is a
 * provider's PRIMARY credential variable (`get_model_provider_variable_mapping()`
 * — `OPENAI_API_KEY`, `AZURE_AI_FOUNDRY_API_KEY`, …) the endpoint calls
 * `validate_model_provider_key`, which makes a REAL call to the provider
 * (`llm.invoke("test")` for OpenAI, `request_azure_ai_foundry_model_entries` for
 * Foundry) and turns any `ValueError` into a **400 whose body carries the
 * reason** (`langflow/api/v1/variable.py` on 1.12.0.dev24).
 *
 * So a 400 on that endpoint has several causes that mean opposite things, and
 * #1424 is the issue where three of them arrived behind ONE assert
 * (`expect(persistResp.ok()).toBe(true)`) and one generic signature:
 *
 * | Body (measured) | Means | Verdict |
 * |---|---|---|
 * | `Variable name already exists` | the frontend took the CREATE branch for a name that is already stored — the #1431 window, our timing | ours: fail |
 * | `Invalid API key for OpenAI` | the backend authenticated the key live and the provider rejected it | environment: skip |
 * | `Could not validate Azure AI Foundry credentials: HTTPSConnectionPool(…): Read timed out. (read timeout=10.0)` | the backend could not reach the provider inside its 10 s budget | environment: skip |
 * | `Variable value cannot be empty` | the panel submitted nothing | ours: fail |
 *
 * The first and last must stay RED — muting them is how a test-side defect rots
 * (and `Variable value cannot be empty` is exactly the empty-key-field symptom
 * seen on the anthropic panel). The middle two say nothing about Langflow, so a
 * spec is allowed to skip on them — but only while QUOTING the backend's own
 * `detail`, never silently (#1012).
 *
 * Kept free of `@playwright/test` on purpose: these functions are covered by the
 * `npm run test:units` lane (`node --test`), which must not pull a browser-facing
 * dependency graph. The browser-side settle helper lives in
 * `provider-panel-save.ts`.
 */

export type VariableWriteRefusalKind =
  /** The name is already stored — a CREATE was issued where an UPDATE was due. */
  | "duplicate"
  /** The provider itself rejected the credential the backend sent it. */
  | "invalid-credential"
  /** The backend could not reach the provider (timeout / connection error). */
  | "transport"
  /** Anything else, including an unreadable or empty body. */
  | "unknown";

export interface VariableWriteRefusal {
  kind: VariableWriteRefusalKind;
  /** The backend's `detail`, or the raw body when it is not the usual envelope. */
  detail: string;
}

/**
 * Sentinel for a body the fixture could not read.
 *
 * An unread body is UNKNOWN, not empty (#1432 is open on the monitor discarding
 * this distinction in silence), so it classifies as `unknown` — i.e. it FAILS the
 * test rather than skipping it. A refusal we cannot read must never buy a skip.
 */
export const UNREADABLE_VARIABLE_WRITE_BODY = "<body could not be read>";

/** Pulls FastAPI's `detail` out of the body, tolerating non-JSON and arrays. */
export function variableWriteDetail(body: string): string {
  const raw = (body ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    const detail = parsed?.detail;
    if (typeof detail === "string") return detail;
    if (detail !== undefined) return JSON.stringify(detail);
    return raw;
  } catch {
    return raw;
  }
}

// ORDER IS LOAD-BEARING. Azure's transport failure and its auth failure share the
// same `Could not validate … credentials: …` prefix and differ only in the nested
// cause, so transport is tested BEFORE credential — otherwise a read timeout
// would be reported as a rejected key, which is the opposite diagnosis.
const DUPLICATE = /variable name already exists/i;
const TRANSPORT =
  /(timed?\s?out|timeout|connectionpool|max retries|connection (?:refused|reset|error|aborted)|could not reach|unreachable|temporarily unavailable|name or service not known|\b50[234]\b)/i;
const INVALID_CREDENTIAL =
  /(invalid api key|invalid subscription key|permissiondenied|unauthoriz|authentication|invalid_api_key|\b40[13]\b)/i;

/**
 * Classifies a refused variables write from its response body.
 *
 * Deliberately body-driven rather than status-driven: every one of these arrives
 * as a plain `400`, so the status carries no information at all — which is most
 * of why #1424 stayed descriptive across three dailies.
 */
export function classifyVariableWriteRefusal(body: string): VariableWriteRefusal {
  const detail = variableWriteDetail(body);
  if (!detail || detail === UNREADABLE_VARIABLE_WRITE_BODY) {
    return { kind: "unknown", detail };
  }
  if (DUPLICATE.test(detail)) return { kind: "duplicate", detail };
  if (TRANSPORT.test(detail)) return { kind: "transport", detail };
  if (INVALID_CREDENTIAL.test(detail)) return { kind: "invalid-credential", detail };
  return { kind: "unknown", detail };
}

/**
 * Whether a spec may end as a skip on this refusal instead of failing.
 *
 * True only for the two causes that are about the provider account or the network
 * between Langflow and it. Everything else — our own timing, an empty submit, a
 * body we could not read — stays a failure.
 */
export function isEnvironmentalRefusal(kind: VariableWriteRefusalKind): boolean {
  return kind === "invalid-credential" || kind === "transport";
}

export interface VariableWrite {
  method: string;
  url: string;
  status: number;
  body: string;
}

/**
 * One-line, self-describing rendering of a variables write, for assertion
 * messages: a #1424 deliverable is that the next occurrence reads its cause off
 * the failure message instead of digging through artifacts.
 */
export function describeVariableWrite(write: VariableWrite): string {
  const detail = variableWriteDetail(write.body);
  return `${write.method} ${write.url} -> ${write.status}${detail ? ` ${detail}` : ""}`;
}
