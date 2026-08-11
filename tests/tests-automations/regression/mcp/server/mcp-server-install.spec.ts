import type { Page, Response } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { mcpHandshake } from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — installing a project into an MCP client (QA-CHECKLIST §14.1, #1395).
 * Spec doc: `docs/mcp/server/mcp-server-install.md`.
 *
 * The consumption side: the URL a user copies into their client, and the
 * per-client install state the tab reports. Both halves are asserted across the
 * API/UI boundary rather than on one side of it.
 *
 * Read-only by construction — no project, no flow, nothing to clean up.
 *
 * NOT exercised, for two independent measured reasons (see the spec doc):
 * `POST /{project_id}/install` writes the REAL MCP client configuration of
 * whichever machine runs Langflow — `~/.cursor/mcp.json` and friends, i.e. the
 * developer's own editor config against a local pip instance — and it refuses
 * any caller whose TCP peer is not loopback, which every containerised lane is.
 * The §14.1 bullet is `[~]`, not `[x]`, and that is the gap.
 */

/** The clients `check_installed_mcp_servers` reports on, and their UI titles. */
const CLIENTS = [
  { api: "cursor", title: "Cursor" },
  { api: "windsurf", title: "Windsurf" },
  { api: "claude", title: "Claude" },
] as const;

interface InstalledClient {
  name: string;
  installed: boolean;
  available: boolean;
}

/**
 * Open the MCP Server tab from the home page and return the project the UI is
 * actually showing, together with the install state **the page itself received**.
 *
 * Both facts come from the page's own request on purpose. Resolving the project
 * from `GET /api/v1/projects/` and taking the first entry would be a different
 * project whenever another spec created one (they run `fullyParallel`), and
 * re-fetching `installed` afterwards could observe a different state than the one
 * the UI rendered — turning a real UI/API disagreement into a green run.
 */
async function openMcpServerTab(
  page: Page,
): Promise<{ projectId: string; installed: InstalledClient[] }> {
  const installedResponse = page.waitForResponse(
    (r: Response) =>
      /\/api\/v1\/mcp\/project\/[^/]+\/installed$/.test(
        new URL(r.url()).pathname,
      ) && r.request().method() === "GET",
    { timeout: 30000 },
  );

  await page.goto("/");
  await page.getByTestId("mcp-btn").click({ timeout: 30000 });
  await expect(page.getByTestId("mcp-server-title")).toBeVisible({
    timeout: 30000,
  });

  const response = await installedResponse;
  expect(
    response.status(),
    "the MCP Server tab's own installed request must succeed, or every " +
      "assertion below would be about a state the UI never had",
  ).toBe(200);

  const projectId = new URL(response.url()).pathname.split("/").at(-2)!;
  expect(
    projectId,
    "the project id must be readable from the tab's own request",
  ).toMatch(/^[0-9a-f-]{36}$/i);

  return { projectId, installed: (await response.json()) as InstalledClient[] };
}

test.describe("MCP Server — install into a client", () => {
  test("the composer URL resolves, and the JSON the UI copies carries the same value", { tag: ["@stable", "@api", "@mcp"] },
    async ({ page }) => {
      const { projectId } = await openMcpServerTab(page);
      const authorization = await getAuthToken(page.request);
      let composerUrl = "";

      await test.step("composer-url publishes both transport URLs for this project", async () => {
        const res = await page.request.get(
          `/api/v1/mcp/project/${projectId}/composer-url`,
          { headers: { Authorization: authorization } },
        );
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();

        expect(
          body.uses_composer,
          "the default deployment does not route through MCP Composer; a true " +
            "here means the assertions below are about a different surface",
        ).toBe(false);
        expect(body.error_message).toBeNull();
        expect(body.streamable_http_url).toContain(
          `/api/v1/mcp/project/${projectId}/streamable`,
        );
        expect(body.legacy_sse_url).toContain(
          `/api/v1/mcp/project/${projectId}/sse`,
        );

        composerUrl = body.streamable_http_url;
      });

      await test.step("the published URL is a live MCP endpoint for THIS project", async () => {
        // "Resolves" asserted against the protocol, not a status code: a URL
        // that 200s but belongs to another project would pass a status check.
        // The absolute URL is used as published — that is the string a user
        // pastes into their client.
        const info = await mcpHandshake(page.request, composerUrl, authorization);
        expect(info.serverInfo.name).toBe(`langflow-mcp-project-${projectId}`);
      });

      await test.step("the JSON tab copies that exact URL to the clipboard", async () => {
        await page.getByRole("button", { name: "JSON", exact: true }).click();
        await expect(page.locator("pre").first()).toBeVisible({
          timeout: 30000,
        });

        await page.getByTestId("icon-copy").first().click();
        // The control's own confirmation — it swaps icon-copy for icon-check —
        // so the clipboard read below cannot race the write.
        await expect(page.getByTestId("icon-check")).toBeVisible({
          timeout: 10000,
        });

        const clipboard = await page.evaluate(() =>
          navigator.clipboard.readText(),
        );
        const config = JSON.parse(clipboard) as {
          mcpServers: Record<string, { args?: string[] }>;
        };

        const servers = Object.keys(config.mcpServers ?? {});
        expect(
          servers,
          "the copied configuration must declare exactly this project's server",
        ).toHaveLength(1);

        // String for string: `toContain(projectId)` would pass on a URL with the
        // wrong scheme, host or transport, and a UI that rebuilt the URL from its
        // own state would still look correct.
        expect(
          config.mcpServers[servers[0]].args,
          `the copied config must carry the published URL verbatim (${composerUrl})`,
        ).toContain(composerUrl);
      });
    },
  );

  test("installed state is reported per client and the auto-install list reflects it", { tag: ["@stable", "@api", "@mcp"] },
    async ({ page }) => {
      const { installed } = await openMcpServerTab(page);

      await test.step("the API reports the three supported clients", async () => {
        expect(
          installed.map((c) => c.name).sort(),
          "check_installed_mcp_servers reports cursor, windsurf and claude; a " +
            "changed list must fail here rather than silently narrowing the UI check",
        ).toEqual([...CLIENTS].map((c) => c.api).sort());

        for (const client of installed) {
          expect(typeof client.installed, `${client.name}.installed`).toBe(
            "boolean",
          );
          expect(typeof client.available, `${client.name}.available`).toBe(
            "boolean",
          );
        }
      });

      await test.step("every auto-install button agrees with what the page was told", async () => {
        // The product's own locality rule, mirrored rather than assumed:
        // `useCustomIsLocalConnection` reads the BROWSER's hostname (the backend
        // uses a different rule for the write — see the spec doc's Notes). Taking
        // it from the page keeps this assertion correct on any base URL instead
        // of hard-coding "everything is disabled here".
        const isLocalConnection = await page.evaluate(() =>
          ["localhost", "127.0.0.1", "0.0.0.0"].includes(
            window.location.hostname,
          ),
        );

        await page
          .getByRole("button", { name: "Auto install", exact: true })
          .click();

        for (const { api, title } of CLIENTS) {
          const reported = installed.find((c) => c.name === api);
          expect(reported, `${api} must be in the reported list`).toBeDefined();

          const expectedDisabled = !reported!.available || !isLocalConnection;
          const button = page.getByRole("button", { name: title, exact: true });
          await expect(button).toBeVisible({ timeout: 15000 });
          // Polled, not a one-shot `await button.isDisabled()`: the list renders before
          // the installed query resolves, so a one-shot read can sample the
          // pre-answer state. The message names both inputs so a failure says
          // WHICH side disagreed.
          await expect
            .poll(() => button.isDisabled(), {
              timeout: 15000,
              message:
                `${title}: the button must be ` +
                `${expectedDisabled ? "disabled" : "enabled"} — ` +
                `available=${reported!.available}, ` +
                `isLocalConnection=${isLocalConnection}`,
            })
            .toBe(expectedDisabled);
        }
      });
    },
  );
});
