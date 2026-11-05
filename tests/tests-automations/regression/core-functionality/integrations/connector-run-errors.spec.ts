import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import { parseStreamEvents } from "../../../../fixtures/flow-error-policy";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { DRIVE_LIST_TYPE, driveListFlowSpec } from "../../../../helpers/integrations/connection-probe";
import {
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";

// What a connector's failure looks like on the canvas, and the connection field no edge can reach (#2355).
// Spec doc: docs/core-functionality/integrations/connector-run-errors.md
//
// Runs as the superuser: the canvas under auto-login cannot switch users. Flows come from the component catalog
// through the API; every flow and connection is deleted after its test, by id.

const DRIVE_NODE = "DriveList-oracle";
const RUN_BUTTON = "button_run_drive: list files (app files)";
const CONNECTION_FIELD = "connectionref_connection_ref_connection";
const DRIVE_HANDLES = [
  "handle-googledrivelistcomponent-shownode-files-right",
  "handle-googledrivelistcomponent-shownode-query-left",
];
const CHAT_OUTPUT_HANDLE = "handle-chatinput-shownode-chat message-right";
const QUERY_HANDLE = "handle-googledrivelistcomponent-shownode-query-left";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

// Exact copy, measured on 1.14.0.dev7 (lfx/integrations/errors.py; the canvas renders "[code] message").
const RUN_FAILED = "Workflow run failed";
/** The node's build panel: a `role=region` labelled by its title. */
const BUILD_FAILED = "Flow build failed";
const unresolved = (handle: string) => ({
  code: "connection-unresolved",
  message: `Connection '${handle}' could not be resolved. Configure the connection for this execution environment.`,
  hint: "Configure the connection for this execution environment.",
});
const AUTH_EXPIRED = {
  code: "auth-expired",
  message: "The provider credential is expired or was rejected.",
  hint: "Reconnect the integration and try again.",
};

interface RunError {
  type: "RUN_ERROR";
  code?: string;
  message?: string;
}

test.describe("Connector runs — the integration's own error on the canvas, and a connection field no edge can reach", () => {
  let superHeaders: Record<string, string>;
  let catalog: Record<string, unknown>;
  const flows: string[] = [];
  const rows: CreatedConnection[] = [];

  test.beforeEach(async ({ request }) => {
    superHeaders = { Authorization: await getAuthToken(request) };
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of flows.splice(0)) {
      await deleteFlow(request, id, { headers: superHeaders }).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow and connection this test created is deleted").toEqual([]);
  });

  async function saveFlow(request: APIRequestContext, spec: Parameters<typeof createCatalogFlow>[2]): Promise<string> {
    catalog ??= await fetchComponentCatalog(request, superHeaders);
    const flowId = await createCatalogFlow(request, catalog, spec, {
      name: `e2e-2355-run-errors-${uniqueConnectionName("flow")}`,
      headers: superHeaders,
    });
    flows.push(flowId);
    return flowId;
  }

  /** Presses the Drive node's run button and returns the run's one `RUN_ERROR` and its raw stream. */
  async function runNodeForError(page: Page): Promise<{ error: RunError; body: string }> {
    const run = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/v2/workflows" && res.request().method() === "POST",
    );
    await page.locator(`[data-id="${DRIVE_NODE}"]`).getByTestId(RUN_BUTTON).click();
    const body = await (await run).text();
    const errors = parseStreamEvents(body).filter(
      (event): event is RunError => (event as { type?: unknown } | null)?.type === "RUN_ERROR",
    );
    expect(errors, `exactly one RUN_ERROR in: ${body.slice(0, 500)}`).toHaveLength(1);
    return { error: errors[0], body };
  }

  /** The two places the canvas reports a run's failure: the notice and the node's build panel. */
  function failureSurfaces(page: Page): Locator[] {
    return [page.getByRole("alert").filter({ hasText: RUN_FAILED }), page.getByLabel(BUILD_FAILED)];
  }

  async function expectCanvasShows(page: Page, expected: { code: string; message: string; hint: string }) {
    for (const surface of failureSurfaces(page)) {
      await expect(surface.getByText(`[${expected.code}] ${expected.message}`, { exact: true })).toBeVisible();
      await expect(surface.getByText(expected.hint, { exact: true })).toBeVisible();
    }
  }

  test(
    "a connector that cannot resolve its connection shows the integration's code and hint, on the canvas and in the run stream",
    { tag: ["@stable", "@integrations", "@ui-ux"] },
    async ({ page, request }) => {
      const handle = `google/${uniqueConnectionName("connrunerr_missing")}`;
      const expected = unresolved(handle);
      const flowId = await saveFlow(request, driveListFlowSpec(handle));
      (page as PageWithErrorHooks).allowFlowErrors();
      await openFlowById(page, flowId);

      await test.step("the run's RUN_ERROR carries the code, and the hint after the message", async () => {
        const { error } = await runNodeForError(page);
        expect(error).toMatchObject({ code: expected.code, message: `${expected.message}\n\n${expected.hint}` });
      });

      await test.step("the canvas shows [code] message, and the hint on its own line", async () => {
        await expectCanvasShows(page, expected);
      });

      await test.step("the fixture counted the run as a failure, not as an unread or provider-outage stream", async () => {
        const report = await (page as PageWithErrorHooks).flowErrorReport();
        expect(report.evaluated, "the run stream was read").toBeGreaterThan(0);
        expect(report.unevaluatedTotal, report.summary).toBe(0);
        expect(report.failures.map((failure) => failure.message).join("\n")).toContain(expected.message);
      });
    },
  );

  test(
    "a run refused for an expired credential says so with its code and hint, leaks no token, and leaves the connection Expired on its page",
    { tag: ["@stable", "@integrations", "@ui-ux"] },
    async ({ page, request }) => {
      const token = `E2E-SENTINEL-connrunerr-${Date.now().toString(36)}`;
      const row = await createConnectionViaApi(request, superHeaders, {
        label: "connrunerr_expired",
        grantedScopes: [DRIVE_FILE],
        credentials: { access_token: token, expires_at: "2020-01-01T00:00:00Z" },
      });
      rows.push(row);
      expect(row.connection).toMatchObject({ status: "ready", health: "unknown" });
      const flowId = await saveFlow(request, driveListFlowSpec(`google/${row.name}`));
      (page as PageWithErrorHooks).allowFlowErrors();
      await openFlowById(page, flowId);

      await test.step("the run fails with auth-expired and its hint, in the stream and on the canvas", async () => {
        const { error, body } = await runNodeForError(page);
        expect(error).toMatchObject({ code: AUTH_EXPIRED.code, message: `${AUTH_EXPIRED.message}\n\n${AUTH_EXPIRED.hint}` });
        expect(body, "the run stream").not.toContain(token);
        await expectCanvasShows(page, AUTH_EXPIRED);
        expect(await page.content(), "the canvas").not.toContain(token);
      });

      await test.step("the connection's page shows Expired, and still does after a reload", async () => {
        await page.goto("/settings/connections");
        const listed = page.getByTestId(`connection-row-${row.name}`);
        await expect(listed).toBeVisible({ timeout: 30000 });
        await expect(listed.getByText("Expired", { exact: true })).toBeVisible();
        await page.reload();
        await expect(listed.getByText("Expired", { exact: true })).toBeVisible({ timeout: 30000 });
      });

      await test.step("the API agrees: expired and unhealthy", async () => {
        const res = await request.get("/api/v1/connections", { headers: superHeaders });
        expect(res.status()).toBe(200);
        const read = ((await res.json()) as Array<{ id: string }>).find((candidate) => candidate.id === row.id);
        expect(read).toMatchObject({ status: "expired", health: "unhealthy" });
      });
    },
  );

  test(
    "a connection field has no canvas handle, so no edge can reach it",
    { tag: ["@stable", "@integrations", "@ui-ux"] },
    async ({ page, request }) => {
      const flowId = await saveFlow(request, {
        nodes: [
          { id: "ChatInput-src", type: "ChatInput" },
          { id: DRIVE_NODE, type: DRIVE_LIST_TYPE, values: { connection: `google/${uniqueConnectionName("connrunerr_field")}` } },
        ],
        edges: [],
      });
      await openFlowById(page, flowId);
      const drive = page.locator(`[data-id="${DRIVE_NODE}"]`);
      const source = page.locator('[data-id="ChatInput-src"]').getByTestId(CHAT_OUTPUT_HANDLE);
      const edges = page.locator(".react-flow__edge");

      await test.step("the connection field is on the node, and none of the node's handles is its", async () => {
        await expect(drive.getByTestId(CONNECTION_FIELD)).toBeVisible();
        const handles = await drive.locator('[data-testid^="handle-"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-testid")!).sort(),
        );
        expect(handles).toEqual(DRIVE_HANDLES);
      });

      await test.step("neither a click-to-connect nor a drag onto the connection field draws an edge", async () => {
        await source.click();
        await drive.getByTestId(CONNECTION_FIELD).click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("Escape");
        await expect(edges).toHaveCount(0);
        await source.dragTo(drive.getByTestId(CONNECTION_FIELD));
        await expect(edges).toHaveCount(0);
      });

      await test.step("control: the same click-to-connect onto query draws one, and the flow saves it on query", async () => {
        await source.click();
        await drive.getByTestId(QUERY_HANDLE).click();
        await expect(edges).toHaveCount(1);
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/flows/${flowId}`, { headers: superHeaders });
              const saved = (await res.json()) as { data?: { edges?: Array<{ targetHandle?: string }> } };
              return (saved.data?.edges ?? []).map((edge) => /œfieldNameœ:œ([^œ]+)œ/.exec(edge.targetHandle ?? "")?.[1]);
            },
            { timeout: 15000, message: "the autosaved flow's edges, by target field" },
          )
          .toEqual(["query"]);
      });
    },
  );
});
