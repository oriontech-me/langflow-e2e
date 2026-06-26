import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

const FLOW_BASE = {
  description: "Publish flow test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test(
  "user can publish a flow and access it via shareable URL, then unpublish to revoke access",
  { tag: ["@release", "@workspace", "@playground", "@stable"] },
  async ({ page, browser, request }) => {
    await awaitBootstrapTest(page);

    await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("blank-flow").click();
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });

    // Add a Chat Input so the flow has IO and the publish toggle is enabled (hasIO controls disabled state)
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
      timeout: 5000,
    });

    await page.getByTestId("input_outputChat Input").hover({ timeout: 3000 });
    await page.getByTestId("add-component-button-chat-input").last().click();

    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 10000,
    });

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    // Editor URL pattern is /flow/{flowId}; the regex match is the contract this test depends on
    expect(page.url()).toMatch(/\/flow\/[0-9a-f-]+/);
    const flowId = page.url().match(/\/flow\/([0-9a-f-]+)/)![1];
    const authToken = await getAuthToken(request);

    try {
      await page.getByTestId("publish-button").click();
      await expect(page.getByTestId("shareable-playground")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByTestId("publish-switch")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByTestId("publish-switch")).toBeChecked({
        checked: false,
      });
      await page.getByTestId("publish-switch").click();
      await expect(page.getByTestId("publish-switch")).toBeChecked({
        checked: true,
        timeout: 10000,
      });

      // Verify the PATCH committed (UI switch alone does not prove the backend stored PUBLIC)
      const flowAfterPublish = await request.get(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
      expect(flowAfterPublish.status()).toBe(200);
      expect((await flowAfterPublish.json()).access_type).toBe("PUBLIC");

      // Read the shareable URL from the rendered <a> — the stable contract Langflow exposes to
      // consumers, and the locator the sibling playground-shareable-url spec also relies on.
      const shareLink = page.locator('[data-testid="shareable-playground"] a');
      await expect(shareLink).toBeVisible({ timeout: 5000 });
      const shareHref = await shareLink.getAttribute("href");
      expect(shareHref).not.toBeNull();
      expect(shareHref!).toMatch(new RegExp(`/playground/${flowId}$`));

      // Close the deploy dropdown so its portal overlay does not intercept later toolbar clicks.
      // (The previous version implicitly closed the dropdown by clicking the <a>; reading href does not.)
      await page.keyboard.press("Escape");

      // Open the public URL in a fresh browser context so the access check does not piggyback on
      // the editor's authenticated cookies. With LANGFLOW_AUTO_LOGIN on (the default) this still
      // auto-authenticates, but the test is now structured to catch a regression that requires an
      // existing editor session — and to surface immediately if AUTO_LOGIN is later turned off.
      const sharedContext = await browser.newContext();
      try {
        const sharedPage = await sharedContext.newPage();
        await sharedPage.goto(shareHref!);
        await sharedPage.waitForLoadState("domcontentloaded");
        await expect(sharedPage).toHaveURL(
          new RegExp(`/playground/${flowId}$`),
        );

        // Public URL must render the chat playground, not redirect away
        await expect(
          sharedPage.getByPlaceholder("Send a message..."),
        ).toBeVisible({ timeout: 15000 });

        await sharedPage.getByPlaceholder("Send a message...").fill("Hello");
        await sharedPage.getByTestId("button-send").last().click();
        // Stop button appearing confirms the public URL accepts input and the build started
        await expect(
          sharedPage.getByRole("button", { name: "Stop" }),
        ).toBeVisible({ timeout: 30000 });

        // Unpublish from the editor while keeping the shared context alive, then re-navigate to
        // the same URL — proves the route is gated by access_type, not by stale cached state.
        await page.bringToFront();
        await page.getByTestId("publish-button").click();
        await expect(page.getByTestId("publish-switch")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("publish-switch").click();
        await expect(page.getByTestId("publish-switch")).toBeChecked({
          checked: false,
          timeout: 10000,
        });

        const flowAfterUnpublish = await request.get(
          `/api/v1/flows/${flowId}`,
          { headers: { Authorization: authToken } },
        );
        expect(flowAfterUnpublish.status()).toBe(200);
        expect((await flowAfterUnpublish.json()).access_type).toBe("PRIVATE");

        // Previously-public URL must no longer render the playground — the SPA redirects to the
        // home dashboard (mainpage_title is the home heading)
        await sharedPage.goto(shareHref!);
        await expect(sharedPage.getByTestId("mainpage_title")).toBeVisible({
          timeout: 15000,
        });
      } finally {
        await sharedContext.close();
      }
    } finally {
      // Navigate the editor off the flow before deleting it. The open flow editor keeps an
      // events subscription (GET /api/v1/flows/{id}/events) polling for build state; deleting
      // the flow while that poll is in flight produces a benign-but-noisy 404 during teardown.
      // Unmounting the editor first stops the subscription, so the delete is race-free.
      await page.goto("/").catch(() => {});

      // Clean up the flow so repeated runs do not accumulate workspace artifacts
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
    }
  },
);

test(
  "publish flow via API toggles access_type between PUBLIC and PRIVATE",
  { tag: ["@release", "@workspace", "@api", "@stable"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);
    const originalName = `Publish API Test - ${Date.now()}`;

    const createRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: { ...FLOW_BASE, name: originalName },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    const flowId = created.id;
    // New flows default to PRIVATE
    expect(created.access_type).toBe("PRIVATE");

    try {
      const publishRes = await request.patch(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
        data: { access_type: "PUBLIC" },
      });
      expect(publishRes.status()).toBe(200);
      expect((await publishRes.json()).access_type).toBe("PUBLIC");

      // GET round-trip confirms the change persists (PATCH could echo without writing)
      const getPublic = await request.get(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
      expect(getPublic.status()).toBe(200);
      expect((await getPublic.json()).access_type).toBe("PUBLIC");

      const unpublishRes = await request.patch(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
        data: { access_type: "PRIVATE" },
      });
      expect(unpublishRes.status()).toBe(200);
      expect((await unpublishRes.json()).access_type).toBe("PRIVATE");

      const getPrivate = await request.get(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
      expect(getPrivate.status()).toBe(200);
      expect((await getPrivate.json()).access_type).toBe("PRIVATE");
    } finally {
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
    }
  },
);
