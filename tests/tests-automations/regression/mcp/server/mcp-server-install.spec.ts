import type { Page, Response } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { mcpHandshake } from "../../../../helpers/mcp/mcp-streamable-client";
import { waitForPageEntry } from "../../../../helpers/other/page-entry-barrier";

/**
 * MCP Server — connecting a project to an MCP client (QA-CHECKLIST §14.1, #1395).
 * Spec doc: `docs/mcp/server/mcp-server-install.md`.
 *
 * The consumption side: the URL a user copies into their client, and the
 * per-client install state the tab reports.
 *
 * THE MECHANISM, because the obvious reading is wrong and it decides what these
 * assertions may claim. The MCP Server tab never fetches `composer-url` — that
 * query is gated on an OAuth project with MCP Composer enabled
 * (`useMcpServer.ts`), which the default deployment is not. So the two URLs are
 * **independent derivations of the same address**: the backend builds
 * `http://{settings.host}:{port}/…` (`api/utils/mcp/config_utils.py`), the
 * frontend builds `${window.location.origin}/…`
 * (`customization/utils/custom-mcp-url.ts`). Nothing propagates from one to the
 * other, so asserting they are the same STRING asserts a coincidence of
 * deployment — measured: it fails on a healthy instance merely reached as
 * `127.0.0.1` instead of `localhost`. What is invariant, and what this spec
 * pins, is one property from each side: the UI roots the URL at the origin the
 * user is browsing, and the two agree on the PATH.
 *
 * Read-only by construction — no project, no flow, nothing to clean up.
 *
 * NOT exercised: `POST /{project_id}/install`, for two measured reasons. It
 * rewrites the REAL MCP client configuration of whichever machine runs Langflow
 * (`~/.cursor/mcp.json` and friends — against a local pip instance, the
 * developer's own), and it refuses any caller whose TCP peer is not loopback,
 * which every containerised lane is. The §14.1 bullet is `[~]`, not `[x]`; the
 * spec doc records the write-safe route a follow-up can take.
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
  // Marks the rejection handled: if the click below throws, this waiter rejects
  // with nothing awaiting it, and the worker-level unhandled rejection would be
  // printed alongside — and confused with — the real failure.
  installedResponse.catch(() => {});

  await page.goto("/");
  // Attributed (#1262): on a wedged backend a bare 30 s wait on `mcp-btn` reads
  // as a UI defect, and the `@stable` auto-removal cannot tell it apart from one.
  await waitForPageEntry(page, '[data-testid="mcp-btn"]', 30000);
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

/** The single connection URL out of the JSON configuration the copy control yields. */
async function copyConnectionUrlFromJsonTab(page: Page): Promise<URL> {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(page.locator("pre").first()).toBeVisible({ timeout: 30000 });
  await page.getByTestId("icon-copy").first().click();

  // Polled on the CLIPBOARD, not on the `icon-check` confirmation: that icon
  // resets after 1 s (`useCopyToClipboard`), so asserting on it fails hard on a
  // SUCCESSFUL copy whenever the first sample lands late.
  let clipboard = "";
  await expect
    .poll(
      async () => {
        clipboard = await page.evaluate(() => navigator.clipboard.readText());
        return clipboard.length;
      },
      { timeout: 10000, message: "the copy control never filled the clipboard" },
    )
    .toBeGreaterThan(0);

  const config = JSON.parse(clipboard) as {
    mcpServers: Record<string, { args?: string[] }>;
  };
  const servers = Object.keys(config.mcpServers ?? {});
  expect(
    servers,
    "the copied configuration must declare exactly this project's server",
  ).toHaveLength(1);

  const urls = (config.mcpServers[servers[0]].args ?? []).filter((a) =>
    a.startsWith("http"),
  );
  expect(
    urls,
    `the copied configuration must carry exactly one connection URL: ${clipboard}`,
  ).toHaveLength(1);
  return new URL(urls[0]);
}

/**
 * Assert each auto-install button against the state the page was given.
 *
 * The product's own rule, mirrored rather than assumed: a button is disabled
 * when its client is unavailable OR the connection is not local, where
 * `useCustomIsLocalConnection` reads the BROWSER's hostname (the backend uses a
 * different rule for the write — see the spec doc's Notes). Taking locality from
 * the page keeps this correct on any base URL.
 */
async function assertAutoInstallButtons(
  page: Page,
  installed: InstalledClient[],
): Promise<void> {
  const isLocalConnection = await page.evaluate(() =>
    ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname),
  );

  await page.getByRole("button", { name: "Auto install", exact: true }).click();

  for (const { api, title } of CLIENTS) {
    const reported = installed.find((c) => c.name === api)!;
    const expectedDisabled = !reported.available || !isLocalConnection;
    const button = page.getByRole("button", { name: title, exact: true });
    await expect(button).toBeVisible({ timeout: 15000 });

    // Polled, not a one-shot `isDisabled()`: the list renders while the
    // installed query is still pending, and that first render is disabled — so
    // a single sample can read the loading state instead of the answer.
    await expect
      .poll(() => button.isDisabled(), {
        timeout: 15000,
        message:
          `${title}: the button must be ` +
          `${expectedDisabled ? "disabled" : "enabled"} — ` +
          `available=${reported.available}, isLocalConnection=${isLocalConnection}`,
      })
      .toBe(expectedDisabled);
  }
}

test.describe("MCP Server — connect a project to a client", () => {
  test("the URL the UI copies is rooted at the user's own origin, agrees with the API, and resolves", { tag: ["@stable", "@api", "@mcp"] },
    async ({ page }) => {
      const { projectId } = await openMcpServerTab(page);
      const authorization = await getAuthToken(page.request);
      let publishedPath = "";

      await test.step("composer-url publishes both transport paths for this project", async () => {
        const res = await page.request.get(
          `/api/v1/mcp/project/${projectId}/composer-url`,
          { headers: { Authorization: authorization } },
        );
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();

        expect(
          body.uses_composer,
          "the default deployment does not route through MCP Composer; a true " +
            "here means these assertions are about a different surface",
        ).toBe(false);
        expect(body.error_message).toBeNull();

        // Paths, not absolute URLs: the origin is the backend's own
        // `settings.host:port`, which is not required to equal the address this
        // run reached it at (see the header).
        publishedPath = new URL(body.streamable_http_url).pathname;
        expect(publishedPath).toBe(
          `/api/v1/mcp/project/${projectId}/streamable`,
        );
        expect(new URL(body.legacy_sse_url).pathname).toBe(
          `/api/v1/mcp/project/${projectId}/sse`,
        );
      });

      const copied = await test.step("the JSON tab yields one connection URL", () =>
        copyConnectionUrlFromJsonTab(page));

      await test.step("it is rooted at the origin the user is browsing", async () => {
        // The frontend's rule (`custom-mcp-url.ts` builds from
        // `window.location.origin`), and the property that matters to a user:
        // someone copying from a remote Langflow must get a URL pointing at that
        // remote, never at the server's own idea of its hostname.
        const pageOrigin = new URL(page.url()).origin;
        expect(
          copied.origin,
          `the copied URL must be rooted at ${pageOrigin}, not at the backend's ` +
            `configured host — that URL would not resolve for this user`,
        ).toBe(pageOrigin);
      });

      await test.step("the UI and the API agree on the path", async () => {
        // The two are independent derivations (header), so this is the strongest
        // agreement that holds across deployments — and a UI pointing at another
        // project or another transport fails here.
        expect(copied.pathname).toBe(publishedPath);
      });

      await test.step("the copied URL is a live MCP endpoint for THIS project", async () => {
        // Asserted against the protocol, on the string a user would actually
        // paste. Reachable by construction: its origin is the page's own.
        const info = await mcpHandshake(
          page.request,
          copied.toString(),
          authorization,
        );
        expect(info.serverInfo.name).toBe(`langflow-mcp-project-${projectId}`);
      });
    },
  );

  test("the auto-install list reflects the install state the page was given", { tag: ["@stable", "@api", "@mcp"] },
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

      await test.step("every button matches its client's reported availability", async () => {
        await assertAutoInstallButtons(page, installed);
      });
    },
  );

  test("a client reported as available is offered, while the others stay disabled", { tag: ["@stable", "@api", "@mcp"] },
    async ({ page }) => {
      // Every environment this suite runs in reports `available: false` for all
      // three clients — Langflow is containerised and no client's config
      // directory exists inside it. Against that constant, the correspondence
      // asserted above cannot tell "reflects the API" apart from "always
      // disabled": a mutation replacing the whole rule with `true` survives it.
      // Routing one client to `available: true` is what gives it discriminating
      // power in-lane.
      //
      // The button is only asserted to be OFFERED. It is never clicked: that
      // would POST /install, which writes real MCP client configuration.
      const routed: InstalledClient[] = [
        { name: "cursor", installed: false, available: true },
        { name: "windsurf", installed: false, available: false },
        { name: "claude", installed: false, available: false },
      ];
      await page.route(
        (url) => /\/api\/v1\/mcp\/project\/[^/]+\/installed$/.test(url.pathname),
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(routed),
          }),
      );

      const { installed } = await openMcpServerTab(page);
      expect(
        installed,
        "the page must have received the routed state, or this test is a " +
          "duplicate of the one above",
      ).toEqual(routed);

      await assertAutoInstallButtons(page, installed);
    },
  );
});
