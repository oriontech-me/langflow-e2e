// Wait for an MCP toolset to reach the STORED flow before a prompt is sent (#2541, #2576).
//
// Shared by every spec that builds "Simple Agent + MCP Tools in tool mode, connected to
// the Agent" on the canvas and then runs it from the Playground. Tool calls are
// authorized against the database copy of the flow, which the canvas edits reach only
// through the debounced autosave; a prompt sent before that save lands is refused.
// Moved here from `mcp-client-agent.spec.ts` (#2541) when the Gemini sibling needed it.
import { expect, type Page } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import {
  SAVE_COMPLETION_BUDGET_MS,
  describeAutosaveInterval,
  saveScheduledDeadlineMs,
} from "../flows/autosave-interval";

/** What the stored flow says about the MCP toolset the agent is about to call. */
export type ToolsetPersistState = "persisted" | "no-mcp-node" | "tool-mode-off" | "no-edge-to-agent-tools";

export function readToolsetPersistState(flow: any): ToolsetPersistState {
  const nodes: any[] = flow?.data?.nodes ?? [];
  const edges: any[] = flow?.data?.edges ?? [];
  // The component's `name` is `MCPTools`, but the MCP sidebar group adds it with the
  // hardcoded item name `MCP` (`McpSidebarGroup.tsx`): the stored node measured on
  // `1.14.0.dev35` was `MCP-8tf5p`, and the frontend derives the id from `data.type`
  // (`getNodeId`). Both spellings are accepted, bare or namespaced
  // (`ext:<vendor>:MCPTools@official`). The id prefix only helps a type rewritten
  // after creation; a rename to any other key misses both and reads `no-mcp-node`.
  // Exactly one match is required, as `validate_tool_call` matches one exact node id:
  // with two MCP nodes the predicate could read the wrong one and pass while the
  // authorization still denies the other.
  const mcpNodes = nodes.filter(
    (n) =>
      /(^|:)MCP(Tools)?(@|$)/.test(String(n?.data?.type ?? "")) ||
      /^MCP(Tools)?-/.test(String(n?.id ?? "")),
  );
  if (mcpNodes.length !== 1) return "no-mcp-node";
  const mcp = mcpNodes[0];
  if (mcp.data?.node?.tool_mode !== true) return "tool-mode-off";
  // The Agent is identified by its type, not by an id prefix, so a component whose
  // id merely starts with "Agent" cannot stand in for it.
  const agentIds = new Set(
    nodes.filter((n) => /(^|:)Agent(@|$)/.test(String(n?.data?.type ?? ""))).map((n) => n.id),
  );
  const wired = edges.some(
    (e) =>
      e?.source === mcp.id &&
      agentIds.has(e?.target) &&
      e?.data?.targetHandle?.fieldName === "tools",
  );
  return wired ? "persisted" : "no-edge-to-agent-tools";
}

/**
 * Block until the MCP toolset the agent will call is in the STORED flow (#2541).
 *
 * The Playground runs the frontend's in-memory graph, but every tool call is
 * authorized against the flow in the database: `AuthService.validate_tool_call`
 * (`src/backend/base/langflow/services/auth/service.py`) re-reads it and refuses
 * the call when the tool's node is not there. The canvas edits of the previous
 * steps (add MCPTools, tool mode, connect) reach the database only through the
 * debounced autosave, `auto_saving_interval` after the last edit (5000 ms on
 * `1.14.0.dev35`), and the prompt is sent well inside that window.
 *
 * Measured on `1.14.0.dev35` with the check instrumented: every refused call was
 * `node_count` (the MCP node absent from the stored flow), never tool mode, tag,
 * name, status or approval actions. openai `gpt-4o-mini` was refused twice too
 * and passed only because its third call came after the save landed;
 * anthropic `claude-haiku-4-5` gave up after three refusals within ~3 s and
 * answered "the tool is unavailable". With this wait: 5/5 passed, zero refusals.
 *
 * Scope: the wait covers the node (the only condition measured to deny), its tool
 * mode, and the edge (not checked by `validate_tool_call`, but the last canvas
 * edit, so its save carries the others). It does not check the `tools_metadata` row (tag, name, status, approval actions) that
 * `validate_tool_call` also matches; no run denied on it. If one ever does, the
 * refusal comes back with the wait green, and this predicate is what to extend.
 *
 * Reads the API on purpose, unlike `node-config-guard.ts`, which reads the
 * widget because the RUN executes the in-memory graph. Here the question is what
 * the AUTHORIZATION reads, and that is the stored flow.
 */
export async function waitForToolsetPersisted(page: Page, flowId: string): Promise<void> {
  const auth = await getAuthToken(page.request);
  const headers = auth ? { Authorization: auth } : undefined;
  const timeout = saveScheduledDeadlineMs() + SAVE_COMPLETION_BUDGET_MS;
  const startedAt = Date.now();
  let state: ToolsetPersistState | "never-read" = "never-read";
  let lastReadError: string | undefined;

  try {
    await expect(async () => {
      try {
        const res = await page.request.get(`/api/v1/flows/${flowId}`, { headers });
        expect(res.ok(), `GET /api/v1/flows/${flowId} -> ${res.status()}`).toBe(true);
        state = readToolsetPersistState(await res.json());
        lastReadError = undefined;
      } catch (e: any) {
        lastReadError = e?.message ?? String(e);
        throw e;
      }
      expect(state).toBe("persisted");
    }).toPass({ timeout, intervals: [250, 500] });
  } catch {
    throw new Error(
      `The MCP toolset never reached the stored flow ${flowId} within ${timeout} ms ` +
        `(${describeAutosaveInterval()}). Last state: ${state}` +
        (lastReadError ? `; last read error: ${lastReadError}` : "") +
        ` (no-mcp-node also covers more than one MCP node). If the state never moved, ` +
        `a save may have been blocked rather than late, e.g. by a flow conflict. ` +
        `Every tool call would be refused by validate_tool_call, so the prompt ` +
        `is not sent (#2541). Elapsed: ${Date.now() - startedAt} ms.`,
    );
  }
}
