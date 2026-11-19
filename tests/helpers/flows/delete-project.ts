import type { APIRequestContext } from "@playwright/test";
import { revokeProjectMintedKeys } from "./revoke-project-minted-keys";

/**
 * Deletes a project (folder) via the Langflow REST API and surfaces a failed
 * deletion — the project-level sibling of `deleteFlow`.
 *
 * Why a helper instead of `request.delete(...).catch(() => {})`: on Langflow
 * 1.12 `DELETE /api/v1/projects/{id}` answers **500** — not the documented
 * `204` — whenever another write transaction is in flight, and the project
 * survives (#965; `(sqlite3.OperationalError) database is locked` on
 * `DELETE FROM folder`). Measured on `1.12.0.dev7` with only 2 concurrent
 * clients, 44% of deletes came back 500. Under `fullyParallel` that contention
 * is normal, so every cleanup site that ignored the status was silently
 * accumulating orphan projects on the instance — one per failed teardown,
 * forever.
 *
 * The retry here is cleanup robustness, NOT a workaround for the defect: the
 * assertion in `api/flows/api-folders-crud.spec.ts` still demands a bare `204`
 * from the endpoint under test, and that test stays quarantined until the
 * upstream fix for LE-2020 lands. See `docs/api/flows/api-folders-crud.md` and
 * `docs/upstream-bugs/UPSTREAM-BUG-project-delete-500-under-contention.md`.
 *
 * Contract, mirroring `deleteFlow` so the two can't drift:
 *  - `2xx` or `404` (already gone) is the desired idempotent end state;
 *  - a non-5xx error is deterministic (401/403/422/…) — it won't change on
 *    retry, so it throws immediately with the original body;
 *  - a 5xx is retried on a short backoff (the lock clears in milliseconds once
 *    the competing writer commits) before throwing.
 *
 * **It also revokes the API key Langflow minted for the project (#2512).**
 * Creating a project issues an account key named `MCP Project <name> -
 * default`, and the `204` of the delete leaves it active. The name is read from
 * the project list BEFORE the delete (the list, not `GET /projects/{id}`, so a
 * project the test already deleted costs no 404), and the key is revoked only
 * after a delete this call performed. That reads the CURRENT name, which is the
 * key's name unless the test renamed the project; a caller that renames, or that
 * deletes the project in its own body, passes the creation-time name to
 * `revokeProjectMintedKeys` itself. Revocation never throws.
 *
 * Pass `page.request` (browser-context auth is reused automatically) or a
 * standalone `request` with an explicit Authorization header via
 * `options.headers`.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param id       The project (folder) ID to delete.
 * @param options  Optional Playwright request options (same shape as `request.delete`'s), e.g. `{ headers: { Authorization } }`.
 */
export async function deleteProject(
  request: APIRequestContext,
  id: string,
  options?: Parameters<APIRequestContext["delete"]>[1],
): Promise<void> {
  const url = `/api/v1/projects/${id}`;
  const isDone = (r: { ok(): boolean; status(): number }) =>
    r.ok() || r.status() === 404;

  // 3 attempts total: enough for the #965 lock window (a competing write
  // commits in milliseconds) without turning a genuinely broken teardown into a
  // multi-second stall.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = 250;

  const headers = (options?.headers ?? {}) as Record<string, string>;
  const name = await currentProjectName(request, id, headers);

  let last: { status(): number; text(): Promise<string> } | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await request.delete(url, options);
    if (isDone(res)) {
      if (name !== undefined) {
        await revokeProjectMintedKeys(request, headers, [name]);
      }
      return;
    }
    last = res;
    if (res.status() < 500) {
      throw new Error(
        `Project cleanup failed: ${res.status()} — ${await res.text()}`,
      );
    }
    if (attempt < MAX_ATTEMPTS) {
      // Surfaced in stdout so a run's artifacts show how often the #965 defect
      // fired during teardown, instead of the retry hiding it entirely.
      console.warn(
        `⚠️ Project cleanup got ${res.status()} for ${id} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }

  throw new Error(
    `Project cleanup failed after ${MAX_ATTEMPTS} attempts: ${last?.status()} — ${await last?.text()}`,
  );
}

/**
 * The project's name as the project list reports it, or `undefined` when the
 * project is not listed (already deleted) or the list cannot be read. Never
 * throws: the name only serves the key revocation, which is best-effort.
 */
async function currentProjectName(
  request: APIRequestContext,
  id: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  try {
    const res = await request.get("/api/v1/projects/", { headers });
    if (!res.ok()) return undefined;
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return undefined;
    const row = rows.find((r) => (r as { id?: unknown })?.id === id) as
      | { name?: unknown }
      | undefined;
    return typeof row?.name === "string" ? row.name : undefined;
  } catch {
    return undefined;
  }
}
