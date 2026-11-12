import type { APIRequestContext } from "@playwright/test";
import { createProjectViaApi } from "../flows/create-project-via-api";
import { createRunnableChatFlowViaApi } from "../flows/create-runnable-chat-flow-via-api";

/**
 * A Chat Input -> Chat Output passthrough flow living in a **public** project of
 * its own — the precondition of every A2A spec that calls the agent with no key.
 *
 * **Why a project of its own (#2412).** Until `1.14.0.dev22` the caller's default
 * project had no `auth_settings`, which A2A and MCP treat as public under
 * `AUTO_LOGIN=true`, so a flow created anywhere was a public agent. Upstream #16186 +
 * #16151 (first nightly `1.14.0.dev23`, also `release-1.13.2` / `1.13.3`) changed
 * that: every project created under `AUTO_LOGIN=true` defaults to `auth_type:
 * "apikey"` unless `LANGFLOW_SKIP_AUTH_AUTO_LOGIN` is set (no lane sets it), and the
 * MCP startup pass flips existing projects with no auth — the default one included.
 * A flow left there answers a keyless JSON-RPC call with `401 API key required`.
 *
 * So public has to be asked for, and asked for **explicitly**: omitting
 * `auth_settings` is precisely what now yields an `apikey` project.
 * `createProjectViaApi` asserts the server stored `{ auth_type: "none" }` as sent,
 * so a build that stopped honouring it fails at creation, naming the cause, instead
 * of surfacing as an unexplained `401` three steps later.
 *
 * The shared default project is never touched: flipping it would change the auth of
 * every flow of the shared superuser under specs running in parallel (#1010 class).
 */
export interface PublicRunnableChatFlow {
  /** The created flow's id. */
  flowId: string;
  /** The public project the flow was created in — usable as another flow's `folderId`. */
  projectId: string;
  /**
   * Deletes the flow, then the project (which also sweeps the API key the backend
   * mints for an `auth_settings` project). Both halves always run; the first
   * failure is rethrown, so a leak is reported rather than swallowed. Safe in
   * `finally`, and after the flow was moved to another project — the flow is
   * deleted by id, wherever it lives.
   */
  cleanup: (reqOverride?: APIRequestContext) => Promise<void>;
}

export async function createRunnableChatFlowInPublicProject(
  request: APIRequestContext,
  headers: Record<string, string>,
  { namePrefix = "a2a-public" }: { namePrefix?: string } = {},
): Promise<PublicRunnableChatFlow> {
  const project = await createProjectViaApi(request, headers, {
    namePrefix,
    description: "Public (auth_type none) project for an A2A E2E spec",
    authSettings: { auth_type: "none" },
  });

  let flow: Awaited<ReturnType<typeof createRunnableChatFlowViaApi>>;
  try {
    flow = await createRunnableChatFlowViaApi(request, headers, {
      folderId: project.projectId,
    });
  } catch (e) {
    // The caller never receives a handle when this throws, so nothing else would
    // ever delete the project made for the flow.
    await project
      .deleteProject()
      .catch((cleanupError) => console.warn(`⚠️ project cleanup failed: ${cleanupError}`));
    throw e;
  }

  return {
    flowId: flow.flowId,
    projectId: project.projectId,
    cleanup: async (reqOverride?: APIRequestContext) => {
      let firstError: unknown;
      try {
        await flow.deleteFlow(reqOverride);
      } catch (e) {
        firstError = e;
      }
      // After the flow, never before: a project still holding flows is a
      // different delete path.
      try {
        await project.deleteProject(reqOverride);
      } catch (e) {
        firstError ??= e;
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}
