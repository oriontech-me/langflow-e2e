import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { clearApiKeyBadges } from "../../../helpers/ui/clear-api-key-badges";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { fillSidebarSearch } from "../../../helpers/flows/fill-sidebar-search";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach — the legacy spec built a
// flow via the blank-flow UI and leaked it every run (#490/#681 pattern; the
// response ids are authoritative and worker-safe).
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

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

// The ReactFlow pane, addressed the way this file always has.
const CANVAS = '//*[@id="react-flow-id"]';

// Every canvas node carries `rf__node-<id>`, so one count covers all three
// component types — the OpenAI node's id comes from an extension type key
// (`ext:openai:OpenAIModelComponent@official`), so a type-scoped prefix would be
// a guess.
const ANY_NODE = '[data-testid^="rf__node-"]';

// How long the editor may stay read-only after it opens. Not a sleep: the wait
// ends the moment the entry turns draggable — 1.2-3.1 s with the permissions
// response held for 4 s (#2197). The budget covers the worst case upstream
// documents instead of one round trip: a transient 5xx on the first permissions
// call is retried 5 times with `min(1000 * 2 ** n, 30000)` backoff, which keeps
// the editor read-only for roughly half a minute (langflow#14523).
const EDITOR_READY_TIMEOUT_MS = 45000;

/**
 * Drags a component out of the sidebar onto the canvas, and only once the editor
 * will accept it (#2197).
 *
 * A sidebar entry renders `draggable={!error && !isUnavailable}`, and upstream
 * folds the flow's write-permission verdict into `isUnavailable`, failing CLOSED
 * while `POST /api/v1/authz/me/permissions` is in flight (langflow#14068 for the
 * add path, langflow#14523 for the affordance). A drag issued in that window
 * starts no native drag session at all — no `dragstart`, no `drop` — so no node
 * is created and nothing downstream of it can appear. Measured on
 * 1.13.0.dev34: holding that response for 4 s lost the old bare drag 4 of 4;
 * waiting for `draggable="true"` first landed it 5 of 5.
 *
 * The drag is issued ONCE. A blind second drag would also have "repaired" this,
 * but would equally hide a drop the editor discards while the entry IS
 * draggable — a real defect, so it fails here under its own name.
 */
async function dragFromSidebar(
  page: Page,
  term: string,
  entryTestId: string,
  targetPosition?: { x: number; y: number },
): Promise<void> {
  await fillSidebarSearch(page, term, entryTestId);

  const entry = page.getByTestId(entryTestId);
  await expect(
    entry,
    `the "${entryTestId}" sidebar entry never became draggable: the editor ` +
      `stayed read-only. Upstream does that by design only while POST ` +
      `/api/v1/authz/me/permissions is in flight (#2197) — a verdict that never ` +
      `arrives, or one that denies write to the flow's own creator, is a defect`,
  ).toHaveAttribute("draggable", "true", { timeout: EDITOR_READY_TIMEOUT_MS });

  const nodes = page.locator(ANY_NODE);
  const before = await nodes.count();
  await entry.dragTo(
    page.locator(CANVAS),
    targetPosition ? { targetPosition } : undefined,
  );
  await expect(
    nodes,
    `dragging the draggable "${entryTestId}" entry onto the canvas added no ` +
      `node — the entry accepted the gesture, so this is not #2197's ` +
      `permission-pending window but a drop the editor discarded`,
  ).toHaveCount(before + 1);
}

test(
  "should copy code from playground modal",
  {
    tag: ["@stable", "@release", "@playground"],
  },
  async ({ page }) => {
    trackCreatedFlows(page);

    // A real playground send runs below, so gate on provider HEALTH rather than on
    // the mere presence of the env var: a key that exists but is drained blocks
    // the backend past gunicorn's 300s timeout and kills the shard's Langflow
    // worker (#1029). After the .env load, so a key that lives only in .env is
    // visible to the gate on a local run.
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });

    await page.getByTestId("blank-flow").click();
    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });
    // Distinct drop points so the three nodes do not stack and the handle clicks
    // below each reach their own node.
    await dragFromSidebar(page, "chat output", "input_outputChat Output", {
      x: 400,
      y: 100,
    });
    await dragFromSidebar(page, "chat input", "input_outputChat Input", {
      x: 100,
      y: 100,
    });
    await dragFromSidebar(page, "openai", "openaiOpenAI", { x: 100, y: 200 });

    await initialGPTsetup(page);
    await adjustScreenView(page);

    await page.getByText("OpenAI", { exact: true }).last().click();

    await expect(
      page.getByTestId("handle-chatinput-noshownode-chat message-source"),
    ).toBeVisible();

    await clearApiKeyBadges(page);

    await page
      .getByTestId("popover-anchor-input-api_key")
      .fill(process.env.OPENAI_API_KEY || "");

    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-openaimodelcomponent-shownode-input-left")
      .click();

    await page
      .getByTestId("handle-openaimodelcomponent-shownode-model response-right")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .last()
      .click();
    await adjustScreenView(page);

    await page.getByRole("button", { name: "Playground", exact: true }).click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });
    await page.getByTestId("input-chat-playground").click();
    await page
      .getByTestId("input-chat-playground")
      .fill(
        "Could you provide a Python example for a 'Hello, World!' program?",
      );

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.getByTestId("api_tab_python").isVisible({
      timeout: 100000,
    });

    await page.waitForSelector('[data-testid="copy-code-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("copy-code-button").first().click();

    const handle = await page.evaluateHandle(() =>
      navigator.clipboard.readText(),
    );
    const clipboardContent = await handle.jsonValue();
    expect(clipboardContent.length).toBeGreaterThan(0);
    expect(clipboardContent).toContain("Hello");
  },
);

// The quarantine's TODO guessed that "current Langflow behavior may not match what
// was originally expected". Measured on 1.13.0.dev9, the product is fine and the
// EXPECTATION was stale: `getByText("Langflow Chat")` targets the i18n value of
// `misc.chatTitle`, a key that occurs exactly ONCE in the whole frontend bundle —
// inside the translation dictionary, with zero call sites — so the string is never
// rendered and the assertion could not pass at any timeout (#1791; same shape as
// the dead `viewExchange` key). Both testids the test drives are live:
// `playground-btn-flow-io` is the Playground trigger 10+ specs already click, and
// `playground-btn-flow` is its disabled twin, rendered with
// `cursor-not-allowed text-muted-foreground` — which is exactly what the first
// assertion wants. The modal is therefore asserted by its own dialog role/name.
const PLAYGROUND_DIALOG = { role: "dialog" as const, name: "Playground" };

// #2197: the click on `playground-btn-flow-io` timed out because the Chat Output
// drag was issued while the editor was still read-only (see `dragFromSidebar`),
// so no node landed and only the disabled twin was ever rendered.
test(
  "playground button should be enabled or disabled",
  { tag: ["@stable", "@release", "@workspace", "@playground"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });

    await page.getByTestId("blank-flow").click();

    // The editor mounts twice on the way in, and between the two mounts the
    // toolbar is not in the DOM at all — measured up to ~4.3 s unforced, which
    // the 5 s default lost on 2026-09-22 (#2197). The trigger is still asserted
    // as the disabled twin; it is only given the editor-mount budget.
    await expect(page.getByTestId("playground-btn-flow")).toBeDisabled({
      timeout: EDITOR_READY_TIMEOUT_MS,
    });

    await expect(
      page.getByRole(PLAYGROUND_DIALOG.role, { name: PLAYGROUND_DIALOG.name }),
    ).toBeHidden();

    await dragFromSidebar(page, "chat output", "input_outputChat Output");
    await expect(
      page.locator('[data-testid^="rf__node-ChatOutput-"]'),
    ).toHaveCount(1);

    await adjustScreenView(page);

    // The gate's state change is the assertion; the click only follows it.
    await expect(page.getByTestId("playground-btn-flow-io")).toBeEnabled();
    await expect(page.getByTestId("playground-btn-flow")).toHaveCount(0);

    await page.getByTestId("playground-btn-flow-io").click();

    await expect(
      page.getByRole(PLAYGROUND_DIALOG.role, { name: PLAYGROUND_DIALOG.name }),
    ).toBeVisible({ timeout: 30000 });
  },
);
