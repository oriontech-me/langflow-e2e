import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { renameFlow } from "../../../../helpers/flows/rename-flow";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses, and delete them id-scoped in afterEach. The canvas URL id races
// the bootstrap flow's stale id (blank-flow opens behind the templates modal),
// so a bare page.url() capture deleted the wrong flow and leaked the renamed
// one; the response ids are authoritative. Only ids this page created are
// captured, so it stays safe under parallel workers.
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

const OVERLONG = "Flow Name Test ".repeat(70); // > every field cap on 1.11
const DESCRIPTION_CAP = 250; // enforced maxLength of input-flow-description

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

test(
  "flow settings enforce character limits and persist name & description",
  { tag: ["@stable", "@release", "@workspace"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await test.step("open a blank flow", async () => {
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();
      await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
    });

    const randomName = `flow-${Math.random().toString(36).substring(2)}`;
    let truncatedDescription = "";

    await test.step("modal enforces the name and description character limits", async () => {
      // Let the entry autosave settle before opening the modal, or an in-flight
      // PATCH re-renders the dialog and detaches its inputs mid-edit (#357).
      await waitForFlowSaveSettled(page);
      await expect(page.getByTestId("flow_name")).toBeVisible({
        timeout: 15000,
      });
      await page.getByTestId("flow_name").click();

      const nameInput = page.getByTestId("input-flow-name");
      await expect(nameInput).toBeVisible({ timeout: 15000 });

      // Overlong name: the cap message appears and the field truncates in place.
      await nameInput.fill(OVERLONG);
      await expect(page.getByText("Character limit reached")).toBeVisible({
        timeout: 15000,
      });
      const cappedName = await nameInput.inputValue();
      expect(
        cappedName.length,
        "name field must cap below the overlong input",
      ).toBeLessThan(OVERLONG.length);

      // Replace with a valid short name.
      await nameInput.fill(randomName);
      await expect(nameInput).toHaveValue(randomName);

      // Overlong description: the field truncates to its enforced cap.
      const descriptionInput = page.getByTestId("input-flow-description");
      await expect(descriptionInput).toBeVisible({ timeout: 15000 });
      await descriptionInput.fill(OVERLONG);
      truncatedDescription = await descriptionInput.inputValue();
      expect(
        truncatedDescription.length,
        "description must cap at its enforced maxLength",
      ).toBe(DESCRIPTION_CAP);
    });

    await test.step("saving succeeds (the modal closes on a resolved save)", async () => {
      const saveButton = page.getByTestId("save-flow-settings");
      await expect(saveButton).toBeEnabled({ timeout: 15000 });
      await saveButton.click();
      // Modal-closed is the deterministic success signal: handleSubmit only
      // closes after the save resolves (the error path keeps it open). This is
      // race-free unlike asserting the auto-dismissing "Changes saved" toast.
      await expect(page.getByTestId("input-flow-name")).toBeHidden({
        timeout: 15000,
      });
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("reopening shows the persisted name and description", async () => {
      // No-edit reopen: renameFlow reads the current (persisted) values and,
      // with nothing changed, asserts save is disabled and cancels.
      const { flowName, flowDescription } = await renameFlow(page);
      expect(flowName, "persisted name must match the saved name").toBe(
        randomName,
      );
      expect(
        flowDescription,
        "persisted description must match the saved (truncated) description",
      ).toBe(truncatedDescription);
    });
  },
);
