import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// A rejected import creates no flow, but track POST /api/v1/flows → 201 ids
// defensively and delete them id-scoped in afterEach (repo convention,
// #490/#681) — a no-op here, present so a future behavior change that starts
// persisting a dropped file cannot silently leak.
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

// Drop one crafted File onto the flows-page drop zone (cards-wrapper) via a
// synthetic DataTransfer — the same event an OS drag-and-drop fires.
async function dropFile(
  page: Page,
  content: string,
  name: string,
  type: string,
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    (d: { content: string; name: string; type: string }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([d.content], d.name, { type: d.type }));
      return dt;
    },
    { content, name, type },
  );
  await page.getByTestId("cards-wrapper").dispatchEvent("drop", { dataTransfer });
}

// After a drop, assert the transient toast AND the persistent notification
// dropdown entry carry the upload error + the case-specific detail, and that no
// success message appeared. The persistent dropdown entry is race-free (the
// slide-in toast auto-dismisses) — same lesson as #693/#695.
async function expectUploadError(page: Page, detail: string): Promise<void> {
  await expect(
    page.getByText("Error occurred while uploading file").first(),
  ).toBeVisible({ timeout: 10000 });

  await page.getByTestId("notification_button").click();
  const dropdown = page.getByTestId("notification-dropdown-content");
  await expect(dropdown).toBeVisible({ timeout: 10000 });
  await expect(dropdown).toContainText("Error occurred while uploading file");
  await expect(dropdown).toContainText(detail);

  await expect(page.getByText("uploaded successfully")).toHaveCount(0);
}

async function openFlowsPage(page: Page): Promise<void> {
  await awaitBootstrapTest(page, { skipModal: true });
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });
}

test(
  "import invalid JSON must show error message",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await openFlowsPage(page);

    await dropFile(
      page,
      "{ this is not valid json !!!",
      "invalid.json",
      "application/json",
    );

    // Malformed JSON: the parser rejects it before it is even a candidate flow.
    await expectUploadError(page, "Expected property name or '}'");
  },
);

test(
  "import non-JSON file must show error message",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await openFlowsPage(page);

    await dropFile(
      page,
      "This is a plain text file, not a flow.",
      "notaflow.txt",
      "text/plain",
    );

    // Non-JSON MIME type: rejected on file type, not content.
    await expectUploadError(page, "Invalid file type");
  },
);

test(
  "import JSON with missing data field must show error",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await openFlowsPage(page);

    const incompleteFlow = JSON.stringify({
      name: "Incomplete Flow",
      description: "This flow is missing the data field",
      // no "data" property
    });
    await dropFile(page, incompleteFlow, "incomplete.json", "application/json");

    // Well-formed JSON, but not a valid flow shape (no "data").
    await expectUploadError(page, "Invalid flow data");
  },
);
