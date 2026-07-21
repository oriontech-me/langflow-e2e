import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { configureMcpServer } from "../../../helpers/mcp/configure-mcp-server";
import { configureCustomComponent } from "../../../helpers/flows/configure-custom-component";

/**
 * Validates the two "To implement" config helpers (QA-CHECKLIST helper
 * inventory): configureMcpServer and configureCustomComponent (#821).
 *
 *   T1 — configure an MCP server via the HTTP form and verify it registered
 *        (sidebar entry + persisted in GET /api/v2/mcp/servers).
 *   T2 — configure a custom component from code and verify the node
 *        materializes the code-declared interface.
 *
 * Deterministic, no LLM. T2 requires LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true.
 */

// Track flows this page creates (POST /api/v1/flows -> 201) for id-scoped
// teardown — awaitBootstrapTest makes a bare page.url() capture race the
// bootstrap flow's stale id (#490/#681); response ids are authoritative.
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
}

// Unique per run so the UI + API assertions cannot be satisfied by a stale
// server, and cross-worker registrations do not collide.
const MCP_SERVER_NAME = `configure-mcp-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now()}`;

// A custom component whose declared strings are absent from the default
// scaffold — the on-canvas assertions can only pass if Check & Save compiled
// THIS code.
const FULL_COMPONENT_CODE = `
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema.message import Message


class CustomComponent(Component):
    display_name = "My Full Component"
    description = "A fully authored custom component."
    icon = "custom_components"
    name = "MyFullComponent"

    inputs = [
        MessageTextInput(name="input_value", display_name="My Input", value="Hello, World!"),
    ]
    outputs = [
        Output(display_name="My Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        return Message(text=self.input_value)`;

// Serial: shared MCP server namespace + custom-component flow naming.
test.describe.configure({ mode: "serial" });

test.afterEach(async ({ request }) => {
  const bearer = await getAuthToken(request);
  const opts = bearer ? { headers: { Authorization: bearer } } : undefined;
  // Best-effort MCP server cleanup by name.
  await request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, opts).catch(() => {});
  // Scoped flow cleanup by id (never a global wipe).
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, opts).catch(() => {});
  }
});

test(
  "configureMcpServer registers an MCP server via the HTTP form",
  { tag: ["@regression", "@mcp"] },
  async ({ page, request }) => {
    trackCreatedFlows(page);

    await test.step("open a blank flow", async () => {
      await awaitBootstrapTest(page);
      await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
      await page.getByTestId("blank-flow").click();
      await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("pre-clean any leftover server with this name", async () => {
      const bearer = await getAuthToken(request);
      await request
        .delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: bearer },
        })
        .catch(() => {});
    });

    await test.step("configure the MCP server via helper", async () => {
      await configureMcpServer(page, {
        name: MCP_SERVER_NAME,
        url: "http://localhost:1/mcp",
      });
    });

    await test.step("server appears in the sidebar and is persisted", async () => {
      await expect(
        page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`),
      ).toBeVisible({ timeout: 30000 });

      const bearer = await getAuthToken(request);
      const resp = await request.get("/api/v2/mcp/servers", {
        headers: { Authorization: bearer },
      });
      expect(resp.status()).toBe(200);
      const servers: Array<{ name: string }> = await resp.json();
      expect(
        servers.find((s) => s.name === MCP_SERVER_NAME),
        `Server "${MCP_SERVER_NAME}" not found in GET /api/v2/mcp/servers`,
      ).toBeTruthy();
    });
  },
);

test(
  "configureCustomComponent compiles code into a node with its declared interface",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await test.step("open a blank flow", async () => {
      await awaitBootstrapTest(page);
      await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
      await page.getByTestId("blank-flow").click();
      await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("configure the custom component via helper", async () => {
      await configureCustomComponent(page, FULL_COMPONENT_CODE);
    });

    await test.step("node materializes the code-declared interface", async () => {
      await expect(page.getByTestId("title-My Full Component")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId("title-my input")).toBeVisible({
        timeout: 15000,
      });
      await expect(
        page.getByTestId("handle-myfullcomponent-shownode-my output-right"),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        page.getByTestId("button_run_my full component"),
      ).toBeVisible({ timeout: 15000 });
    });
  },
);
