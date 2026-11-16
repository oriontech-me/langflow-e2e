import type { Page, Response } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// Dedicated integration actions in Tool Mode (#2452).
// Spec doc: docs/core-functionality/integrations/connector-tool-mode.md
//
// The tool schema an Agent would see is `tools_metadata`, which the canvas reads
// back from POST /api/v1/custom_component/update when Tool Mode is turned on. The
// connection is the flow author's choice, so it must stay on the component and
// never become a tool argument.
test.describe("Connectors on the canvas — actions in Tool Mode", () => {
  // The first nightly serving the whole 1.14 connectors batch (#16315 is dev23).
  const SINCE = "1.14.0.dev26";
  const FIELD = "connectionref_connection_ref_connection";
  const UPDATE = "/api/v1/custom_component/update";
  /** Measured on 1.14.0.dev28: every provider whose actions ship with a connection field. */
  const PROVIDERS = [
    "confluence",
    "discord",
    "github",
    "gitlab",
    "google",
    "jira",
    "microsoft",
    "salesforce",
    "servicenow",
    "slack",
    "telegram",
    "whatsapp",
  ];

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let headers: Record<string, string> = {};

  interface CatalogEntry {
    template?: Record<string, { provider?: string } | unknown>;
    outputs?: Array<{ name: string; tool_mode?: boolean }>;
    metadata?: { trigger_kind?: string };
  }

  interface ToolMetadata {
    name: string;
    args: Record<string, unknown>;
  }

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `Tool Mode on dedicated actions is served from ${SINCE}; this build does not carry the whole batch`,
    );
    headers = { Authorization: await getAuthToken(request) };
  });

  test.afterEach(async ({ page, request }) => {
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  interface ToolModeUpdate {
    tools: ToolMetadata[];
    outputs: string[];
  }

  /** Opens a flow holding one action, turns on Tool Mode, and returns what the server described. */
  async function enterToolMode(page: Page, flowId: string, nodeId: string): Promise<ToolModeUpdate> {
    const updates: ToolModeUpdate[] = [];
    page.on("response", async (res: Response) => {
      if (new URL(res.url()).pathname !== UPDATE || res.request().method() !== "POST") return;
      try {
        const body = (await res.json()) as {
          template?: { tools_metadata?: { value?: ToolMetadata[] } };
          outputs?: Array<{ name: string }>;
        };
        const value = body.template?.tools_metadata?.value;
        if (Array.isArray(value)) updates.push({ tools: value, outputs: (body.outputs ?? []).map((output) => output.name) });
      } catch {
        // A response the page dropped is not one this test reads.
      }
    });
    await openFlowById(page, flowId);
    const node = page.getByTestId(`rf__node-${nodeId}`);
    await expect(node.getByTestId(FIELD)).toBeVisible({ timeout: 20_000 });
    await node.getByTestId("generic-node-title-arrangement").click();
    await page.getByTestId("tool-mode-button").click({ timeout: 15_000 });
    await expect.poll(() => updates.length, { message: "the update answers the tools", timeout: 20_000 }).toBeGreaterThan(0);
    return updates[updates.length - 1];
  }

  test(
    "every dedicated integration action offers Tool Mode",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ request }) => {
      const catalog = (await fetchComponentCatalog(request, headers)) as unknown as Record<string, Record<string, CatalogEntry>>;
      const byProvider = new Map<string, Array<{ key: string; toolMode: boolean }>>();
      for (const [category, components] of Object.entries(catalog)) {
        if (category === "component_display_names" || !components || typeof components !== "object") continue;
        for (const [key, component] of Object.entries(components)) {
          const connection = component.template?.connection as { provider?: string } | undefined;
          if (!connection?.provider || component.metadata?.trigger_kind) continue;
          const entries = byProvider.get(connection.provider) ?? [];
          entries.push({ key, toolMode: (component.outputs ?? []).some((output) => output.tool_mode === true) });
          byProvider.set(connection.provider, entries);
        }
      }
      for (const provider of PROVIDERS) {
        expect(byProvider.get(provider)?.length ?? 0, `${provider} ships at least one action`).toBeGreaterThan(0);
      }
      const withoutToolMode = [...byProvider.values()].flat().filter((entry) => !entry.toolMode).map((entry) => entry.key);
      expect(withoutToolMode, "every action has an output that can run as a tool").toEqual([]);
    },
  );

  test(
    "an action in Tool Mode is one tool whose arguments exclude the connection",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const catalog = await fetchComponentCatalog(request, headers);
      const flowId = await createCatalogFlow(
        request,
        catalog,
        { nodes: [{ id: "gmail", type: "ext:google:GmailSendComponent@official" }], edges: [] },
        { name: `E2E tool mode gmail ${run}`, headers },
      );
      flowIds.push(flowId);

      const { tools, outputs } = await enterToolMode(page, flowId, "gmail");
      expect(outputs, "the action's output becomes a toolset").toEqual(["component_as_tool"]);
      const node = page.getByTestId("rf__node-gmail");
      await expect(node.locator('[data-testid^="tool_"]')).toHaveCount(1);
      await expect(node.getByTestId("tool_send_email")).toBeVisible();
      expect(tools.map((tool) => tool.name)).toEqual(["send_email"]);
      const args = Object.keys(tools[0].args);
      expect(args).toEqual(expect.arrayContaining(["to", "subject", "body"]));
      expect(args, "the connection is never a tool argument").not.toContain("connection");
      await expect(node.getByTestId(FIELD), "the connection stays on the component").toBeVisible();
    },
  );

  test(
    "an action with a pagination output becomes two tools",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const catalog = await fetchComponentCatalog(request, headers);
      const flowId = await createCatalogFlow(
        request,
        catalog,
        { nodes: [{ id: "slack", type: "ext:slack:SlackSearchComponent@official" }], edges: [] },
        { name: `E2E tool mode slack ${run}`, headers },
      );
      flowIds.push(flowId);

      const { tools } = await enterToolMode(page, flowId, "slack");
      const node = page.getByTestId("rf__node-slack");
      await expect(node.locator('[data-testid^="tool_"]')).toHaveCount(2);
      await expect(node.getByTestId("tool_build_matches")).toBeVisible();
      await expect(node.getByTestId("tool_build_pagination")).toBeVisible();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["build_matches", "build_pagination"]);
      for (const tool of tools) {
        expect(Object.keys(tool.args), `${tool.name} takes the query`).toContain("query");
        expect(Object.keys(tool.args), `${tool.name} never takes the connection`).not.toContain("connection");
      }
      await expect(node.getByTestId(FIELD), "the connection stays on the component").toBeVisible();
    },
  );
});
