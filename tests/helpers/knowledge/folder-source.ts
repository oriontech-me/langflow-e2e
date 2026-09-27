import type { APIRequestContext } from "@playwright/test";

/**
 * Helpers for driving the knowledge-base **`folder` connector** against a folder
 * the spec owns (#2043).
 *
 * The connector walks a directory on the SERVER, and only inside the operator
 * allow-list `LANGFLOW_KB_ALLOWED_FOLDER_ROOTS` (empty by default, which refuses
 * every walk). A spec cannot write to the server's filesystem directly, but the
 * product can: `POST /api/v1/files/upload/{flow_id}` stores each upload under
 * `<config_dir>/<flow_id>/`, a directory keyed by a flow the spec creates. So the
 * lanes set the allow-list to the config directory, and the spec uploads its files
 * to its own flow and points the connector at `<root>/<flow_id>`.
 *
 * The root is READ from the server rather than configured on the test side, because
 * the config directory differs per lane — `~/.cache/langflow` in the nightly image,
 * `${STATE_DIR}/data` on the source starter (one per shard port on the VM lane),
 * `~/Library/Caches/langflow` on a macOS pip install — and the connector's own
 * refusal names the roots it enforces, resolved, on every one of them.
 */

/** What the server said about a folder walk it was asked to start. */
export interface FolderAttempt {
  status: number;
  /** The response's `detail` on a refusal (a string in every refusal measured). */
  detail: unknown;
  /** The ingestion run id, present on a 200. */
  runId?: string;
}

export type AllowListVerdict =
  | { kind: "unset" }
  | { kind: "roots"; roots: string[] }
  | { kind: "unknown"; detail: string };

const UNSET_MARKER = "refuses to walk without an allow-list";
const OUTSIDE_MARKER = "is outside the configured allow-list (";
const MISSING_FOLDER = /^Folder .* does not exist\.$/;

/**
 * Reads the allow-list out of the connector's refusal.
 *
 * Measured on 1.13.0.dev22 (`FolderSource.validate_config`):
 *   unset     → "FolderSource refuses to walk without an allow-list. Configure LANGFLOW_KB_ALLOWED_FOLDER_ROOTS."
 *   outside   → "Folder / is outside the configured allow-list (/app/data/.cache/langflow)."
 * The roots are joined with ", " and printed resolved. Anything else is `unknown`
 * — never an empty allow-list, which would read as a configuration it is not.
 */
export function parseFolderAllowList(detail: unknown): AllowListVerdict {
  if (typeof detail !== "string" || detail === "") {
    return { kind: "unknown", detail: JSON.stringify(detail) ?? String(detail) };
  }
  if (detail.includes(UNSET_MARKER)) return { kind: "unset" };

  const start = detail.indexOf(OUTSIDE_MARKER);
  const end = detail.lastIndexOf(").");
  if (start === -1 || end <= start) return { kind: "unknown", detail };
  const roots = detail
    .slice(start + OUTSIDE_MARKER.length, end)
    .split(", ")
    .filter((root) => root.length > 0);
  return roots.length > 0 ? { kind: "roots", roots } : { kind: "unknown", detail };
}

/** `<root>/<flowId>`, without doubling a trailing slash on the root. */
export function folderUnderRoot(root: string, flowId: string): string {
  return `${root.replace(/\/+$/, "")}/${flowId}`;
}

/**
 * Asks the server which roots its allow-list enforces.
 *
 * `probe` must request a walk of a directory that exists everywhere and lies
 * outside any sane allow-list — `/`, non-recursive, with an extension no file
 * carries, so that even a server whose allow-list DOES admit `/` starts a walk that
 * reads nothing. That case fails here all the same: a spec cannot tell which root
 * holds the config directory when one of them is the whole filesystem.
 */
export async function resolveAllowListRoots(
  probe: () => Promise<FolderAttempt>,
): Promise<string[]> {
  const answer = await probe();
  if (answer.status === 200) {
    throw new Error(
      "The folder connector ACCEPTED a walk of `/`: the instance's allow-list admits the " +
        "whole filesystem, so this spec cannot tell which root holds Langflow's config " +
        "directory. Set LANGFLOW_KB_ALLOWED_FOLDER_ROOTS to the config directory only.",
    );
  }
  const verdict = parseFolderAllowList(answer.detail);
  if (verdict.kind === "unset") {
    throw new Error(
      "The folder connector refuses every walk: LANGFLOW_KB_ALLOWED_FOLDER_ROOTS is not set " +
        "on this Langflow instance. Every CI lane and every start script sets it " +
        "(scripts/start-langflow-docker.sh, start-langflow-pip.sh, start-langflow-source.sh, " +
        "start-langflow-serving-identity.sh) to the instance's config directory — restart " +
        "the instance with one of them, or set it by hand.",
    );
  }
  if (verdict.kind === "unknown") {
    throw new Error(
      `The folder connector's refusal did not name an allow-list (HTTP ${answer.status}): ` +
        `${verdict.detail}`,
    );
  }
  return verdict.roots;
}

/**
 * Starts the folder ingestion of `<root>/<flowId>` under the first allow-listed
 * root that holds it.
 *
 * Only a "Folder … does not exist." refusal moves on to the next root; any other
 * answer is quoted and stops the search, because it is about the walk rather than
 * about where the folder is.
 */
export async function ingestFlowFolder(
  roots: string[],
  flowId: string,
  attempt: (folder: string) => Promise<FolderAttempt>,
): Promise<{ folder: string; runId: string }> {
  const tried: string[] = [];
  for (const root of roots) {
    const folder = folderUnderRoot(root, flowId);
    tried.push(folder);
    const answer = await attempt(folder);
    if (answer.status === 200) {
      if (!answer.runId) {
        throw new Error(`The folder ingestion of ${folder} answered 200 with no run id`);
      }
      return { folder, runId: answer.runId };
    }
    if (typeof answer.detail === "string" && MISSING_FOLDER.test(answer.detail)) {
      continue;
    }
    throw new Error(
      `The folder ingestion of ${folder} was refused (HTTP ${answer.status}): ` +
        `${typeof answer.detail === "string" ? answer.detail : JSON.stringify(answer.detail)}`,
    );
  }
  throw new Error(
    `None of the allow-listed roots holds this flow's upload folder (tried: ${tried.join(", ")}). ` +
      "Uploads land in Langflow's config directory, so LANGFLOW_KB_ALLOWED_FOLDER_ROOTS must " +
      "name that config directory.",
  );
}

/**
 * Uploads one file into the flow's own folder, `<config_dir>/<flowId>/`, and
 * returns the name it was stored under (the server prefixes a timestamp —
 * `2026-09-24_17-07-13_a.txt` — which is also the `file_name` its chunks carry).
 */
export async function uploadToFlowFolder(
  request: APIRequestContext,
  flowId: string,
  file: { name: string; content: string },
  options?: { headers?: Record<string, string> },
): Promise<string> {
  const url = `/api/v1/files/upload/${flowId}`;
  const res = await request.post(url, {
    headers: options?.headers ?? {},
    multipart: {
      file: {
        name: file.name,
        mimeType: "text/plain",
        buffer: Buffer.from(file.content, "utf8"),
      },
    },
  });
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`POST ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { file_path?: string };
  const stored = body.file_path?.split("/").pop();
  if (!stored) {
    throw new Error(`POST ${url} answered ${res.status()} with no file_path`);
  }
  return stored;
}

/**
 * Deletes every file in the flow's upload folder and confirms the folder lists
 * empty. Call it BEFORE deleting the flow: deleting a flow does NOT remove its
 * uploads (measured on 1.13.0.dev22 — the files outlive the flow on disk), and the
 * delete route resolves the flow first, so once the flow is gone its files can no
 * longer be reached through the API at all.
 *
 * Driven from the folder's own listing rather than from the upload responses, so a
 * file whose upload response was never read is removed too. Every call is
 * idempotent (a second delete of the same name answers 200), so each one may re-dial
 * a dropped connection.
 */
export async function emptyFlowFolder(
  request: APIRequestContext,
  flowId: string,
  retry: <T>(call: () => Promise<T>) => Promise<T>,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  const listUrl = `/api/v1/files/list/${flowId}`;
  const list = async (): Promise<string[]> => {
    const res = await retry(() => request.get(listUrl, { headers: options?.headers ?? {} }));
    if (res.status() !== 200) {
      throw new Error(`GET ${listUrl} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
    }
    return ((await res.json()) as { files?: string[] }).files ?? [];
  };

  for (const name of await list()) {
    const url = `/api/v1/files/delete/${flowId}/${encodeURIComponent(name)}`;
    const res = await retry(() => request.delete(url, { headers: options?.headers ?? {} }));
    if (res.status() !== 200) {
      throw new Error(`DELETE ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
    }
  }
  const left = await list();
  if (left.length > 0) {
    throw new Error(`The upload folder of flow ${flowId} still lists ${left.join(", ")} after cleanup`);
  }
}
