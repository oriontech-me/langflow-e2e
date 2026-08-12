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
