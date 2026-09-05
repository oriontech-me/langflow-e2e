import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { PERMISSIONS_GATE_TIMEOUT_MS } from "../../../../helpers/flows/permissions-gate";
import { setupBlankFlow } from "../../../../helpers/flows/setup-blank-flow";
import { expandFocusedNode } from "../../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../../helpers/ui/assistant-onboarding";

test.describe("Output Modal — Copy Button", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  // Before the first document load — the only point at which the assistant
  // onboarding tooltip can be suppressed, because upstream reads its flag once at
  // mount of the canvas-controls bar and then arms a 10 s timer.
  // `expandFocusedNode` asserts this ran; the probe it used to make instead fired
  // ~2 s after that mount and never saw the tooltip in 39 measured executions
  // (#1220).
  test.beforeEach(async ({ page }) => {
    await seedAssistantDiscovered(page);
  });

  test.afterEach(async ({ page, request }) => {
    if (!createdFlowId) return;
    const id = createdFlowId;
    createdFlowId = null;
    // Navigate to home before deleting to stop background browser requests
    // for the current flow; without this, pending polling GETs complete
    // after the DELETE and trigger spurious 404 fixture errors.
    await page.goto("/");
    // Explicit bearer: under AUTO_LOGIN a bare request context is
    // unauthenticated, so an unheadered DELETE 401s and silently leaks the flow.
    const bearer = await getAuthToken(request);
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  });

  test(
    "copy button copies Chat Input output and toggles Check icon",
    { tag: ["@stable", "@release", "@workspace", "@playground"] },
    async ({ page }) => {
      await test.step("create blank flow and capture flow id", async () => {
        // setupBlankFlow creates the flow over the API and navigates to it,
        // instead of the home page → "New Flow" → templates modal →
        // `blank-flow` path this step used to drive. That path is what made this
        // spec flake (#1063): "New Flow" opens the welcome overlay before
        // navigating, and while it is open FlowPage mounts the whole
        // FlowSidebarComponent inside a `display: none` wrapper — so the
        // `sidebar-search-input` fill below raced an element that was in the DOM
        // with an empty box. Creating over the API never opens the overlay.
        createdFlowId = await setupBlankFlow(page);
        expect(createdFlowId, "created flow id has an unexpected shape").toMatch(
          /^[0-9a-f-]{36}$/,
        );
      });

      await test.step("add Chat Input and fill its value", async () => {
        // Gate on write permission having RESOLVED before adding: useAddComponent
        // bails out SILENTLY while `useIsFlowReadOnly` is true, which it is for
        // the whole time the effective-permissions query is in flight. The
        // header's flow-name button is disabled by the same expression, so its
        // enabled state is an exact observable for "the add will register".
        // Without this the add is dropped with no error and the count assertion
        // below fails without naming the cause.
        await expect(page.getByTestId("menu_bar_display")).toBeEnabled({
          timeout: PERMISSIONS_GATE_TIMEOUT_MS,
        });
        await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId("sidebar-search-input").fill("chat input");
        await page
          .getByTestId("input_outputChat Input")
          .hover()
          .then(async () => {
            await page.getByTestId("add-component-button-chat-input").click();
          });

        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 10000,
        });

        // Chat Input is added minimized — expand it so the Input Text field and
        // run button rendered on the node body are present in the DOM.
        await page.getByTestId("title-Chat Input").click();
        await expandFocusedNode(page);

        await page
          .getByTestId("textarea_str_input_value")
          .fill("Test content to copy");
      });

      await test.step("run component and open output modal", async () => {
        await page.getByTestId("button_run_chat input").click();
        await expect(page.getByText("built successfully").last()).toBeVisible({
          timeout: 30000,
        });

        await page
          .locator('[data-testid^="output-inspection-"]')
          .first()
          .click();
        await expect(page.getByText("Component Output").first()).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("click copy and verify Check → Copy icon transition", async () => {
        const copyButton = page.getByTestId("copy-output-button");
        await expect(copyButton).toBeVisible();
        await copyButton.click();

        await expect(page.getByText("Copied to clipboard")).toBeVisible({
          timeout: 5000,
        });
        await expect(
          copyButton.locator('[data-testid="icon-Check"]'),
        ).toBeVisible();

        // Icon reverts to Copy after the success state expires (~2s in UI).
        // Web-first assertion polls until the Copy icon reappears.
        await expect(
          copyButton.locator('[data-testid="icon-Copy"]'),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );
});
