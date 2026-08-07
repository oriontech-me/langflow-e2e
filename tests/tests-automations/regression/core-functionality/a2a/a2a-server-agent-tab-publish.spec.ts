import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { setupBlankFlow } from "../../../../helpers/flows/setup-blank-flow";

// Spec doc: docs/core-functionality/a2a/a2a-server-agent-tab-publish.md
//
// The Agent tab is the ONLY way a user publishes a flow as an A2A agent, and
// LE-2007 lived exactly here: A2A was visible in the UI and could not be enabled
// from it. #1242's nine API assertions cannot see that failure, because the flow
// row they PATCH is precisely what the broken UI never wrote.
//
// Every UI assertion below is therefore paired with an API observable — the card
// the server actually serves. Without that pairing the spec would only prove the
// tab re-renders its own state, which is the half that was never broken.

const cardPath = (flowId: string) =>
  `/api/v1/a2a/${flowId}/.well-known/agent-card.json`;

/**
 * The Name / Version / Description inputs of the card editor carry no testid, no
 * `id` and no `aria-label`, and their `<label>` has no `htmlFor` — so
 * `getByLabel()` does not resolve them (measured on 1.12.0.dev14). The label's own
 * container is the working handle.
 */
const cardField = (page: Page, label: string) =>
  page
    .locator("div")
    .filter({ has: page.locator(`label:text-is("${label}")`) })
    .last()
    .locator("input, textarea")
    .first();

async function openAgentTab(page: Page) {
  await page.getByTestId("sidebar-nav-agent").click();
  await expect(page.getByTestId("agent-status")).toBeVisible();
}

/**
 * Clicks `agent-save` and waits for the write it fires to land.
 *
 * The tab updates its own chrome optimistically — `agent-status` reads `Live`, and
 * the header keeps its mount-time value — so no DOM state marks the end of the
 * save. Measured on 1.12.0.dev14: the button fires `PATCH /api/v1/flows/{id}`, and
 * a card fetched before that response returns the PREVIOUS state (observed once in
 * a 3-run burst: `card.name` still the flow name). Waiting on the response is the
 * product's own completion signal — not a timeout dressed up as one.
 */
async function saveAgentTab(page: Page, flowId: string) {
  const saved = page.waitForResponse(
    (res) =>
      res.request().method() === "PATCH" &&
      new URL(res.url()).pathname === `/api/v1/flows/${flowId}` &&
      res.status() === 200,
  );
  await page.getByTestId("agent-save").click();
  await saved;
}

async function publishViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { flow_type: "agent", a2a_enabled: true },
  });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
}

test.describe("A2A Server — Agent tab publish flow", () => {
  test("a flow without chat input and output cannot be published", { tag: ["@stable", "@release", "@workspace", "@ui-ux", "@a2a"] }, async ({
    page,
  }) => {
    const headers = { Authorization: await getAuthToken(page.request) };
    await requireA2aEnabled(page.request, headers);

    const flowId = await setupBlankFlow(page);

    try {
      await test.step("the tab refuses to publish and names the remedy", async () => {
        await openAgentTab(page);

        await expect(page.getByTestId("agent-status")).toHaveText("Unavailable");
        await expect(page.getByTestId("agent-publish-switch")).toBeDisabled();
        await expect(
          page.getByText("Add a chat input and output to serve this flow."),
        ).toBeVisible();
      });

      await test.step("the API agrees there is nothing published", async () => {
        // The UI's "cannot publish" and the server's "nothing served" have to be the
        // same fact; a tab that gates on one thing while the server gates on another
        // is how a flow ends up advertised but unreachable.
        const card = await page.request.get(cardPath(flowId), { headers });
        expect(card.status()).toBe(404);
      });

      await test.step("adding Chat Input and Chat Output lifts the gate", async () => {
        await page.getByTestId("sidebar-nav-components").click();
        await addComponentFromSidebar(page, "Chat Input", "add-component-button-chat-input");
        await addComponentFromSidebar(page, "Chat Output", "add-component-button-chat-output");
        await expect(page.locator(".react-flow__node")).toHaveCount(2);

        // Deliberately NOT wired: eligibility is decided by the presence of the two
        // node types, measured on 1.12.0.dev14 with zero edges on the canvas. Drawing
        // an edge here would exercise the drag-and-drop helper, not the gate.
        await expect(page.locator(".react-flow__edge")).toHaveCount(0);

        // No reload — the tab must react to the canvas it is already showing.
        await openAgentTab(page);
        await expect(page.getByTestId("agent-publish-switch")).toBeEnabled();
        await expect(page.getByTestId("agent-status")).toHaveText("Draft");
      });
    } finally {
      await deleteFlow(page.request, flowId);
    }
  });

  test("publishing from the Agent tab serves a card at the advertised URL", { tag: ["@stable", "@release", "@workspace", "@ui-ux", "@a2a"] }, async ({
    page,
  }) => {
    const headers = { Authorization: await getAuthToken(page.request) };
    await requireA2aEnabled(page.request, headers);

    const flow = await createRunnableChatFlowViaApi(page.request, headers);

    try {
      await openFlowById(page, flow.flowId);
      await openAgentTab(page);

      let advertisedUrl = "";

      await test.step("the URL is advertised while still a draft, and does not answer", async () => {
        await expect(page.getByTestId("agent-status")).toHaveText("Draft");
        await expect(page.getByTestId("agent-save")).toBeDisabled();

        advertisedUrl = await page.getByTestId("agent-card-url").inputValue();
        expect(new URL(advertisedUrl).pathname).toBe(cardPath(flow.flowId));

        // The negative control: the input is populated before anything is published,
        // so asserting only the URL's text would pass against an unpublished flow.
        const before = await page.request.get(advertisedUrl, { headers });
        expect(before.status()).toBe(404);
      });

      await test.step("toggling the switch arms the save", async () => {
        await page.getByTestId("agent-publish-switch").click();
        // The switch keeps its state in data-state; its `value` is the fixed string
        // "on" in both states, so asserting on `value` would pass either way.
        await expect(page.getByTestId("agent-publish-switch")).toHaveAttribute(
          "data-state",
          "checked",
        );
        await expect(page.getByTestId("agent-save")).toBeEnabled();
      });

      await test.step("saving publishes, and the advertised URL now answers", async () => {
        await saveAgentTab(page, flow.flowId);
        await expect(page.getByTestId("agent-status")).toHaveText("Live");

        const card = await page.request.get(advertisedUrl, { headers });
        expect(card.status()).toBe(200);
        expect((await card.json()).skills[0].id).toBe(flow.flowId);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("the card editor changes what the API serves", { tag: ["@stable", "@release", "@workspace", "@ui-ux", "@a2a"] }, async ({
    page,
  }) => {
    const headers = { Authorization: await getAuthToken(page.request) };
    await requireA2aEnabled(page.request, headers);

    const flow = await createRunnableChatFlowViaApi(page.request, headers);
    const sentinelName = `a2a-card-editor-${Date.now()}`;
    const sentinelTag = `tag-${Date.now()}`;

    try {
      // Publishing is the previous test's subject; this one starts from the published
      // state instead of re-proving it.
      await publishViaApi(page.request, headers, flow.flowId);

      await openFlowById(page, flow.flowId);
      await openAgentTab(page);
      await expect(page.getByTestId("agent-status")).toHaveText("Live");

      await test.step("edit the name and add a tag", async () => {
        await cardField(page, "Name").fill(sentinelName);

        // The add-tag and add-example buttons share the testid
        // `input-list-plus-btn_-0`; their accessible names are what separate them.
        await page.getByRole("button", { name: "Add tag" }).click();
        await page.getByTestId("agent-tags_0").fill(sentinelTag);

        await expect(page.getByTestId("agent-save")).toBeEnabled();
        await saveAgentTab(page, flow.flowId);
      });

      await test.step("the card the server serves carries the edit", async () => {
        const res = await page.request.get(cardPath(flow.flowId), { headers });
        expect(res.status()).toBe(200);
        const card = await res.json();

        // The name override lands in TWO places; asserting only card.name would miss
        // half the change.
        expect(card.name).toBe(sentinelName);
        expect(card.skills[0].name).toBe(sentinelName);
        // Equality, not containment: a tag override REPLACES the default ["langflow"]
        // wholesale, and "contains" would hide that wipe.
        expect(card.skills[0].tags).toEqual([sentinelTag]);

        // The editor edits the advertisement, never the endpoint.
        expect(card.protocolVersion).toBe("0.3.0");
        expect(new URL(card.url).pathname).toBe(`/api/v1/a2a/${flow.flowId}/jsonrpc`);
      });

      await test.step("and the override survives a round-trip back into the tab", async () => {
        // Asserted only AFTER a reload, deliberately. agent-card-name is mount-time
        // state: measured on 1.12.0.dev14, the header keeps showing the flow name
        // after a save — for 2.5 s, and after a second save — while the override is
        // already persisted and served. Asserting it live is what a spec written
        // from the issue body would do, and it fails against a product that saved
        // correctly (candidate product finding, recorded in the spec doc).
        await page.reload();
        await openAgentTab(page);
        await expect(page.getByTestId("agent-card-name")).toHaveText(sentinelName);
      });
    } finally {
      await flow.deleteFlow();
    }
  });
});
