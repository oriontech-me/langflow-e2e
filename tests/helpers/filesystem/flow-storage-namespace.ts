import type { APIRequestContext } from "@playwright/test";
import { versionAtLeast } from "../other/served-version";

/**
 * Which folder a Langflow build stores a flow's attachments under (#2338).
 *
 * LE-3242 (langflow-ai/langflow#15982) moved them from a bare `<flow_id>/` folder,
 * the namespace user uploads are keyed in too, to the typed `flow-<flow_id>/`. The
 * change reached the two release lines a lane may run at different builds, so one
 * floor cannot describe it:
 *
 * - **1.13 line:** from `1.13.1rc0` (measured: the on-demand run of 2026-10-26).
 * - **1.14 line:** from `1.14.0.dev16`, the first nightly whose tag contains
 *   `9567e202d` (`dev15` does not; checked with the GitHub compare API).
 * - Every later line carries it; every earlier one does not.
 *
 * Decided from the VERSION the instance declares and never from the response, for
 * the reason `served-version.ts` gives: asking "does the path start with `flow-`?"
 * would pass a build that lost the separation by accident, which is the regression
 * this exists to catch. An unreadable version throws instead of picking a side.
 */
export function usesTypedFlowNamespace(version: unknown): boolean {
  if (versionAtLeast(version, "1.14.0.dev16")) return true;
  if (versionAtLeast(version, "1.14.0.dev0")) return false;
  return versionAtLeast(version, "1.13.1rc0");
}

/** The folder `flowId`'s attachments are stored under on a build of `version`. */
export function flowStorageFolder(version: unknown, flowId: string): string {
  return usesTypedFlowNamespace(version) ? `flow-${flowId}` : flowId;
}

/** `flowStorageFolder` against the instance's own `GET /api/v1/version`. */
export async function servedFlowStorageFolder(
  request: APIRequestContext,
  flowId: string,
): Promise<string> {
  const res = await request.get("/api/v1/version");
  if (!res.ok()) {
    throw new Error(
      `GET /api/v1/version answered HTTP ${res.status()}: the instance is unhealthy, which says ` +
        "nothing about which storage layout it uses.",
    );
  }
  return flowStorageFolder(((await res.json()) as { version?: unknown }).version, flowId);
}
