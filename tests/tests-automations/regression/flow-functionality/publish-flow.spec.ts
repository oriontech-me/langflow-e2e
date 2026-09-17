import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

const FLOW_BASE = {
  description: "Publish flow test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

// The 2026-09-07 and 2026-09-08 dailies read `access_type` back as "PUBLIC" after the
// unpublish, byte-identical on both, which cost this test `@stable` AND a `test.fixme`
// at triage (#1760).
//
// The quarantine is LIFTED and `@stable` is BACK on the mechanism, not on a green run:
// it is `LE-2598` — every write route taking `DbSession` answered its 2xx BEFORE the
// transaction committed, so the read-back below could correctly read the pre-commit
// row. `PATCH /api/v1/flows/{id}` never commits (`grep -n commit` is empty for
// `api/v1/flows.py` and `flows_helpers.py`); the commit belongs to `session_scope`'s
// yield-dependency teardown, which FastAPI runs after the response is written.
// Measured for THIS test's shape (`PATCH {access_type: PRIVATE}` then `GET
// /api/v1/flows/{id}`) with a 300 ms delay gated on a marker file between
// `session_scope`'s `yield` and its `commit`, control and mutation in one process:
//
//   1.13.0.dev6    (the 2026-09-08 daily's image) mutation 0/10 — the read-back
//                  answered "PUBLIC" every time, PATCH 9-19 ms, row PRIVATE 301-524 ms
//                  later; this spec itself fails under the same toggle
//   1.13.0.dev14   mutation 10/10 "PRIVATE", PATCH 319-345 ms — the delay moved from
//                  after the response to inside it; this spec passes under the toggle
//
// Un-forced both images are 10/10 and this spec passes on dev6 in 8.9 s, which is why
// a green run was never the evidence. `langflow#15078`
// (`Depends(injectable_session_scope, scope="function")`) is the fix and reached the
// nightly at 1.13.0.dev14. Sibling symptoms of the same defect: #1759, #1777, #1807.
//
// Keep the two read-backs and their `accessTypePatches` message: the defect has a
// second route into this test — the editor derives the toggle's DIRECTION from a store
// that the same pre-commit response can leave stale, so the unpublish click then sends
// `access_type: PUBLIC` — and which of the two happened is all the daily triage gets.
test(
  "user can publish a flow and access it via shareable URL, then unpublish to revoke access",
  { tag: ["@stable", "@release", "@workspace", "@playground"] },
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

    // Record the direction of every access_type write the EDITOR issues. It is the
    // discriminator when a read-back below disagrees: `[PUBLIC, PRIVATE]` means the read
    // raced the write's commit, `[PUBLIC, PUBLIC]` means the toggle re-published because
    // the store it reads was stale. Both are LE-2598; the spec doc has the measurement.
    const accessTypePatches: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() !== "PATCH" ||
        !req.url().includes(`/api/v1/flows/${flowId}`)
      ) {
        return;
      }
      const body = req.postData();
      if (!body?.includes("access_type")) return;
      try {
        accessTypePatches.push(JSON.parse(body).access_type);
      } catch {
        accessTypePatches.push("<unparseable body>");
      }
    });
    const patchTrail = () =>
      `access_type PATCHes the editor sent: [${accessTypePatches.join(", ")}]`;

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
      expect((await flowAfterPublish.json()).access_type, patchTrail()).toBe(
        "PUBLIC",
      );

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
        expect(
          (await flowAfterUnpublish.json()).access_type,
          patchTrail(),
        ).toBe("PRIVATE");

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
      await deleteFlow(request, flowId, {
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
      await deleteFlow(request, flowId, {
        headers: { Authorization: authToken },
      });
    }
  },
);
