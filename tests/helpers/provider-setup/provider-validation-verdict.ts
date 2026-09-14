// Consumed by: tests/helpers/provider-setup/collect-models.ts (the sweep's Save path).
import type { Page, Response } from "@playwright/test";

/**
 * What the panel's own credential check said, and why the collector has to read
 * it (#1823).
 *
 * `POST /api/v1/models/validate-provider` answers **200 whatever the verdict is**
 * — the verdict lives in the BODY (`{"valid": false, "error": "Invalid API key
 * for Anthropic"}`). The frontend's save handler gates on it:
 *
 * ```ts
 * const isValid = await validateCredentials();
 * if (!isValid || !canUseCurrentProviderPolicy(providerName)) return;
 * ```
 *
 * so a rejected key produces **no `POST /api/v1/variables/` at all**. Measured on
 * `1.13.0.dev9`: the whole Save settles in **0.55 s**, the button returns to
 * `Save` (never busy), and the panel renders the reason in `#provider-validation-error`.
 *
 * The collector watched only `/api/v1/variables/`, so that definite refusal was
 * indistinguishable from a backend that never answers, and was reported as its
 * opposite — `collector stall: no credential write answered within 240s` and then
 * *"this is NOT a key or account problem, the key was never probed"*. On the
 * 2026-09-11 daily (run 34599745145) that cost 300 s of the sweep's 450 s budget
 * and an unreviewed `@stable` removal on a correct test.
 *
 * The gate is not new and is not a regression: it landed upstream on 2026-02-27
 * (`langflow-ai/langflow#11446`) and is byte-identical on `release-1.12.0`,
 * `release-1.13.0` and `main`. What was new on that daily was a key that finally
 * failed the way the backend rejects rather than the way it tolerates — see
 * {@link parseValidationVerdict}.
 */

/**
 * Marks a key the PROVIDER refused, as opposed to one the collector never got a
 * verdict about.
 *
 * Same convention as `COLLECTOR_STALL_PREFIX` and `build axis: `, and the
 * distinction is the point of it: a stall is the ABSENCE of a verdict, so
 * `collect-models.spec.ts` deliberately declines to call it a key problem; a
 * rejection IS the verdict, and must reach the spec's hard-failure step as the
 * real key/account problem it is (#570). Keeping them apart is also what makes a
 * future `@stable` auto-removal exemption possible to write at all: exempting the
 * TIMEOUT shape would equally exempt a genuine panel regression that stops issuing
 * the write, which is the failure this suite exists to catch.
 */
export const CREDENTIAL_REJECTED_PREFIX = "credential rejected: ";

export function isCredentialRejectedReason(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(CREDENTIAL_REJECTED_PREFIX);
}

/** The three states a validate-provider body can leave the caller in. */
export type ValidationVerdict =
  | { kind: "rejected"; error: string }
  | { kind: "accepted" }
  | { kind: "unreadable"; reason: string };

/** Stated rather than empty: a rejection with no message still has to say something. */
export const UNSTATED_REJECTION_REASON =
  "the body carried no error message";

/**
 * Reads the verdict out of a validate-provider body.
 *
 * Three states, never two. `unreadable` is not "accepted": a body this code cannot
 * parse says nothing about the key, and collapsing it into either verdict would
 * make an unknown look like a measurement (#1012). The caller's fail-open is to
 * keep waiting for the write, i.e. exactly the behaviour that existed before —
 * which is why only a DEFINITE `valid: false` may short-circuit the wait.
 *
 * `valid` is required to be a real boolean. A truthy-string `"false"` would read
 * as accepted under `!== false`, and the endpoint has no reason to send one — but
 * the whole point of this function is that the status line lies, so the body is
 * checked rather than trusted.
 */
export function parseValidationVerdict(body: string): ValidationVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `the body is not JSON (${firstLine(error)}): ${truncate(body, 120)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: `the body is not a JSON object: ${truncate(body, 120)}` };
  }
  const valid = (parsed as { valid?: unknown }).valid;
  if (valid === false) {
    const error = (parsed as { error?: unknown }).error;
    return {
      kind: "rejected",
      error:
        typeof error === "string" && error.trim().length > 0
          ? error.trim()
          : UNSTATED_REJECTION_REASON,
    };
  }
  if (valid === true) return { kind: "accepted" };
  return {
    kind: "unreadable",
    reason: `the body carries no boolean "valid" field: ${truncate(body, 120)}`,
  };
}

/**
 * Which provider a validate-provider REQUEST was about, read from its payload.
 *
 * The sweep configures three providers in one page, so a response arriving inside
 * this provider's window is not necessarily this provider's — and the body's error
 * string ("Invalid API key for Anthropic") is a message, not an identifier. The
 * request payload carries `provider` as a field, which is the only exact key
 * available.
 *
 * `null` means "cannot tell", and the caller must treat that as NOT a match: a
 * misattributed rejection would blame the wrong provider's key, which is a worse
 * failure than the 240 s stall it replaces. Failing to match only costs the fast
 * verdict — i.e. degrades to the behaviour that shipped before this existed.
 */
export function validationPayloadProvider(postData: string | null | undefined): string | null {
  if (typeof postData !== "string" || postData.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(postData);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const provider = (parsed as { provider?: unknown }).provider;
    return typeof provider === "string" && provider.length > 0 ? provider : null;
  } catch {
    return null;
  }
}

/**
 * Reads the verdict off a live response without ever throwing.
 *
 * The read is the part that can fail, and a helper whose job is to explain a
 * failure must not be able to cause one — so an unreadable body becomes the
 * `unreadable` VALUE, which is neither verdict and fails an assertion on its own
 * terms (#1432's lesson, #1012's rule).
 *
 * Shared by the collector's watcher and by the provider specs, so "what did the
 * panel's check say" has exactly one reader. A spec carrying its own copy would
 * fail by disagreeing about a body — i.e. by reporting the wrong verdict.
 */
export async function readValidationVerdict(response: {
  text: () => Promise<string>;
}): Promise<ValidationVerdict> {
  try {
    return parseValidationVerdict(await response.text());
  } catch (error) {
    return { kind: "unreadable", reason: `the body could not be read (${firstLine(error)})` };
  }
}

/** A rejection is the one verdict the caller may act on, so it is narrowed at the type. */
export interface CredentialRejection extends ValidationObservation {
  verdict: { kind: "rejected"; error: string };
}

/** One observed validate-provider exchange, decisive or not. */
export interface ValidationObservation {
  /** The `provider` field of the REQUEST, or null when it could not be read. */
  payloadProvider: string | null;
  status: number;
  verdict: ValidationVerdict;
  /** Milliseconds from the Save click to this response. */
  elapsedMs: number;
}

/**
 * The sentence that replaces *"the key was never probed"*.
 *
 * It names all three things that sentence got wrong: WHO decided (the provider,
 * via Langflow's live check), WHAT they said (verbatim), and WHY no write
 * followed (the panel declined to issue one) — so nobody re-derives it from a
 * timeout. The elapsed time is in it because the contrast is the finding: a
 * verdict in under a second, against a wait budget of minutes.
 */
export function formatCredentialRejection(options: {
  displayName: string;
  error: string;
  elapsedMs: number;
}): string {
  const { displayName, error, elapsedMs } = options;
  return (
    `the provider REJECTED the key — POST /api/v1/models/validate-provider answered ` +
    `{"valid":false} for "${displayName}" ${(elapsedMs / 1000).toFixed(1)}s after Save: ${error}. ` +
    `The panel therefore issued NO credential write, by design (the save handler gates on this ` +
    `check, upstream #11446). This IS a key verdict — the key was probed, live, and refused.`
  );
}

/**
 * Watches the panel's credential check for a DEFINITE refusal of `displayName`.
 *
 * Armed before the Save click, like the credential-write waiter it races: the
 * response is ~0.4 s and would be missed by anything registered after.
 *
 * `rejected` settles ONLY on a definite `valid: false` whose request payload names
 * this provider. It deliberately never settles otherwise — an accepted key means
 * the write is still coming, and an unreadable body means this run has no verdict —
 * so the race falls through to the existing wait and the behaviour is unchanged.
 * That asymmetry is what keeps this additive: it can end a wait early, never
 * extend one, and never decide anything on its own.
 *
 * Bodies are read as the responses arrive (#1432's lesson) and every read is
 * wrapped: an async `page.on("response")` handler that throws becomes an unhandled
 * rejection, which FAILS the test — and a helper whose job is to explain a failure
 * must not be able to cause one.
 */
export function watchProviderValidation(
  page: Page,
  displayName: string,
  startedAt: () => number,
): {
  rejected: Promise<CredentialRejection>;
  observations: () => ValidationObservation[];
  stop: () => void;
} {
  const seen: ValidationObservation[] = [];
  let resolveRejected: ((observation: CredentialRejection) => void) | null = null;
  const rejected = new Promise<CredentialRejection>((resolve) => {
    resolveRejected = resolve;
  });

  const handler = (response: Response) => {
    void (async () => {
      try {
        if (response.request().method() !== "POST") return;
        if (!isValidateProviderUrl(response.url())) return;
        const payloadProvider = validationPayloadProvider(response.request().postData());
        const verdict = await readValidationVerdict(response);
        const observation: ValidationObservation = {
          payloadProvider,
          status: response.status(),
          verdict,
          elapsedMs: Math.max(0, Date.now() - startedAt()),
        };
        seen.push(observation);
        if (verdict.kind === "rejected" && payloadProvider === displayName) {
          resolveRejected?.({ ...observation, verdict });
        }
      } catch {
        // Nothing here may escape: see the note above.
      }
    })();
  };

  page.on("response", handler);
  return {
    rejected,
    observations: () => [...seen],
    stop: () => page.off("response", handler),
  };
}

/**
 * Matched on the PATHNAME, never with `includes` (#1162's trap, and the query
 * string this endpoint carries — `?flowId=…&projectId=…` — is why a trailing-glob
 * match would have been the other way to get it wrong).
 */
export function isValidateProviderUrl(url: string): boolean {
  try {
    return /^\/api\/v1\/models\/validate-provider\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function firstLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split("\n").find((entry) => entry.trim().length > 0);
  return truncate((line ?? "no reason given").trim(), 160);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
