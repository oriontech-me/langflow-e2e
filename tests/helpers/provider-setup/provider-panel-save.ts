import { expect, type Page, type Response } from "@playwright/test";
import {
  UNREADABLE_VARIABLE_WRITE_BODY,
  type VariableWrite,
} from "./variable-write-refusal";

/**
 * The provider panel's ONE submit control (#1431).
 *
 * There is no distinct "Replace" button: the same control renders `Save`,
 * `Replace` or `Retry Save` depending on state, so it is located by testid and
 * never by role+name.
 */
export const PROVIDER_SAVE_BUTTON = "provider-save-button";

/**
 * Waits until the provider panel KNOWS whether the credential is already stored,
 * before anything clicks its submit control.
 *
 * Why this exists (#1424, mechanism from #1431): the label is derived from
 * `isAlreadyConfigured`, which is derived from the credential variables — so it
 * reads `Save` until `GET /api/v1/variables/` resolves, while the key input and
 * the models badge are ALREADY rendered. A click inside that window makes the
 * frontend take the CREATE branch for a name that already exists, and the backend
 * answers `400 {"detail":"Variable name already exists"}` — measured twice on the
 * 2026-08-11 daily (run 31475108157, shard 1) and reproduced on demand on
 * 1.12.0.dev24 by delaying that one request: label `Save`, `POST → 400`, toast
 * "Error Saving Configuration — Variable name already exists", control relabelled
 * `Retry Save`. With the panel settled, the same save is a `PATCH → 200`.
 *
 * `expectConfigured` is the caller's OWN reading of the instance state (from
 * `GET /api/v1/variables/`), not a guess: passing it makes this a two-sided gate —
 * the panel is settled AND it agrees with the backend, which is what lets the
 * caller then assert the write's verb.
 */
export async function awaitProviderPanelSettled(
  page: Page,
  opts: { expectConfigured: boolean; timeout?: number },
): Promise<void> {
  const timeout = opts.timeout ?? 20000;
  const saveButton = page.getByTestId(PROVIDER_SAVE_BUTTON);
  await expect(saveButton).toBeVisible({ timeout });
  // While loading, the control keeps its accessible name but is blocked via
  // `aria-disabled` rather than `disabled` (#1431), so settle on `aria-busy`
  // first — otherwise the name below can be read off a mid-request render.
  await expect(saveButton).not.toHaveAttribute("aria-busy", "true", { timeout });
  await expect(
    saveButton,
    opts.expectConfigured
      ? "the panel must read `Replace` for a credential the instance already stores — " +
          "`Save` here means GET /api/v1/variables/ has not resolved yet and the next " +
          "click would CREATE a duplicate (#1424/#1431)"
      : "the panel must read `Save` while the instance stores no credential for this provider",
  ).toHaveAccessibleName(opts.expectConfigured ? "Replace" : "Save", { timeout });
}

/**
 * Reads a response body without ever throwing, keeping "empty" distinguishable
 * from "could not read".
 *
 * A refused write's body is the only thing that explains its status, and the
 * suite's own monitor loses it when `response.text()` throws (#1432). Here the
 * failure is a value, not an exception, and `classifyVariableWriteRefusal` treats
 * the sentinel as UNKNOWN — so an unread reason fails the test instead of buying a
 * skip.
 */
export async function readResponseBodySafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return UNREADABLE_VARIABLE_WRITE_BODY;
  }
}

/**
 * Records EVERY credential write the panel issues, with its body.
 *
 * A single-variable provider issues one write, so a `waitForResponse` sees all
 * there is. A two-variable provider (Azure AI Foundry: key + endpoint) issues
 * **two**, and the waiter resolves on the FIRST — which on the 2026-08-10 and
 * 2026-08-12 dailies was the endpoint's `201`, while the refusal that mattered was
 * the key's `400`. Watching one write therefore reports the failure as "the pair
 * never completed" 30 s later, with the cause nowhere in the assertion (#1424).
 *
 * Bodies are read as the responses arrive, so a refusal's reason is captured while
 * it is still readable (#1432's lesson, applied at the source).
 */
export function collectCredentialWrites(page: Page): {
  settled: () => Promise<VariableWrite[]>;
  stop: () => void;
} {
  const pending: Array<Promise<VariableWrite>> = [];
  const handler = (response: Response) => {
    const method = response.request().method();
    if (!response.url().includes("/api/v1/variables/")) return;
    if (method !== "POST" && method !== "PATCH") return;
    pending.push(
      readResponseBodySafely(response).then((body) => ({
        method,
        url: response.url(),
        status: response.status(),
        body,
      })),
    );
  };
  page.on("response", handler);
  return {
    settled: () => Promise.all([...pending]),
    stop: () => page.off("response", handler),
  };
}

/**
 * Arms a waiter for the credential persist call — `POST /api/v1/variables/`
 * (create) or `PATCH /api/v1/variables/{id}` (update).
 *
 * Both verbs, because the frontend branches on existence (#636): a PATCH-only
 * predicate waits forever on a fresh instance, which is the flake that preceded
 * this one on the same step.
 */
export function waitForCredentialPersist(page: Page, timeout = 30000): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/variables/") &&
      (r.request().method() === "POST" || r.request().method() === "PATCH"),
    { timeout },
  );
}

/**
 * Judges a `POST /api/v1/models/validate-provider` answer on its BODY, never on its
 * status alone: `null` when it accepted the credential, else the failure message.
 *
 * The endpoint answers HTTP 200 in both directions and puts the verdict in the body —
 * `{"valid": false, "error": "Invalid API key for OpenAI"}` for a refused key (#1829,
 * measured again on 1.13.0.dev12 for #1849). Only a 200 carrying `valid: true` is an
 * acceptance. Anything else fails, saying what was actually read: a body that could not
 * be read, or is not the JSON the endpoint sends, is reported as that and never as a
 * refusal the provider did not make (#1012).
 */
export function validateProviderFailure(
  subject: string,
  status: number,
  body: string,
): string | null {
  const excerpt = body.trim().slice(0, 300) || "<empty body>";
  if (body === UNREADABLE_VARIABLE_WRITE_BODY) {
    return `validate-provider answered HTTP ${status} for the ${subject}, and its body could not be read`;
  }
  if (status !== 200) {
    return `validate-provider answered HTTP ${status} for the ${subject}: ${excerpt}`;
  }
  let verdict: unknown;
  try {
    verdict = JSON.parse(body);
  } catch {
    return `validate-provider answered the ${subject} with a body that is not JSON: ${excerpt}`;
  }
  const { valid, error } = (verdict ?? {}) as { valid?: unknown; error?: unknown };
  if (valid === true) return null;
  if (valid === false) {
    const reason = typeof error === "string" && error.trim() !== "" ? error.trim() : "no reason given";
    return `validate-provider rejected the ${subject}: ${reason}`;
  }
  return `validate-provider answered the ${subject} with no boolean \`valid\`: ${excerpt}`;
}

/** The two requests one Save issues, read in the order the panel issues them. */
export interface ProviderSave {
  /**
   * Resolves once `validate-provider` accepted the credential; throws otherwise, naming
   * the provider's own reason. Await it FIRST.
   */
  validated(): Promise<Response>;
  /** The credential write that followed an accepted validation. Await it after `validated()`. */
  persisted(): Promise<Response>;
}

/** Arms a waiter for the Save's verdict, matched on the pathname so a query string cannot hide it. */
function waitForValidateProvider(page: Page, timeout: number): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /^\/api\/v1\/models\/validate-provider\/?$/.test(new URL(r.url()).pathname),
    { timeout },
  );
}

type Settled = { response: Response } | { error: unknown };

function settle(waiter: Promise<Response>): Promise<Settled> {
  return waiter.then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "no detail";
}

/**
 * Arms the waiters for a provider panel Save — call it BEFORE clicking — and reads them
 * in the order the panel issues them: the `validate-provider` verdict first, the
 * credential write second (#1849).
 *
 * The order is the point. The panel persists only after an accepted validation
 * (`handleSaveAllVariables` returns when `!isValid`), so after a refusal no
 * `POST|PATCH /api/v1/variables/` is issued at all. Four provider specs awaited the two
 * together, `Promise.all([validate, persist])`, which settles only when BOTH do — so a
 * refusal the product reached in well under a second surfaced as the persistence waiter's
 * 30-60 s timeout, and the already-resolved verdict, with the provider's reason in it, was
 * discarded. Measured on 1.13.0.dev12, one refusal per spec, before this existed:
 * ollama-provider 64.6 s, openai-provider 32.6 s, openai-compatible-provider-setup 63.4 s,
 * azure-ai-foundry-provider-setup 63.9 s — each a bare `waitForResponse` timeout.
 *
 * Both waiters are still armed before the click, so the pass is caused by THIS save and a
 * write that lands right after the verdict cannot be missed. They are settled into values
 * here, at arm time, so the one the caller never reads — the write after a refusal, or
 * both when the click itself throws — resolves quietly instead of rejecting unobserved
 * when the page closes.
 *
 * `subject` names what was saved ("key", "base URL", "credentials") in the failures.
 */
export function armProviderSave(
  page: Page,
  opts: { subject: string; timeout?: number; persistTimeout?: number },
): ProviderSave {
  const timeout = opts.timeout ?? 30000;
  const persistTimeout = opts.persistTimeout ?? timeout;
  const validate = settle(waitForValidateProvider(page, timeout));
  const persist = settle(waitForCredentialPersist(page, persistTimeout));

  return {
    async validated() {
      const outcome = await validate;
      if ("error" in outcome) {
        throw new Error(
          `the Save issued no POST /api/v1/models/validate-provider for the ${opts.subject} ` +
            `within ${timeout / 1000} s: ${firstLine(outcome.error)}`,
        );
      }
      const failure = validateProviderFailure(
        opts.subject,
        outcome.response.status(),
        await readResponseBodySafely(outcome.response),
      );
      if (failure) throw new Error(failure);
      return outcome.response;
    },
    async persisted() {
      const outcome = await persist;
      if ("error" in outcome) {
        throw new Error(
          `no POST/PATCH /api/v1/variables/ followed the Save of the ${opts.subject} ` +
            `within ${persistTimeout / 1000} s: ${firstLine(outcome.error)}`,
        );
      }
      return outcome.response;
    },
  };
}
