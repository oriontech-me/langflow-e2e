import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { resolveAssetPath } from "../../../helpers/filesystem/resolve-asset-path";
import { generateRandomFilename } from "../../../helpers/filesystem/generate-filename";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// REPRO for LE-2208 — not part of the suite, and kept out of `tests/` so the
// runner never collects it. The relative imports above are written for its run
// location; copy it there first:
//
//   cp docs/upstream-bugs/scripts/repro-2208-stale-file-list.spec.ts \
//      tests/tests-automations/regression/core-components/
//
// Recreates the one condition the defect needs: a single `GET /api/v2/files`
// response that does not mention an already-attached file — a read that has not
// caught up with the write. Everything else is a normal attach.
//
// Order matters, and getting it wrong measures a different thing. The strip is
// armed only AFTER the selection is confirmed: a stale list served while the
// modal is still open removes the row the modal renders its own selection from,
// so the checkbox comes back `unchecked` and the user never confirms anything —
// a broken precondition, not the defect. With the attachment already made and
// saved, reopening the file manager is the deterministic carrier: the modal
// refetches (that read is the stripped one) and closing it without confirming
// is what lets the reconcile effect run, since the effect is inert while the
// modal is open.
//
// Before langflow#14541 the effect read "this list does not mention the file"
// as "the user has no file selected" and wrote `value`/`file_path` back as `""`,
// which the flow then persisted — terminal, since an empty selection leaves
// nothing for a later correct response to restore.
//
// PREDICTION (fixed build): the chip survives and `file_path` keeps the path,
// because a missing path now forces a fresh read before anything is dropped.
// PREDICTION (build before the fix): the chip renders and then disappears, and
// `GET /api/v1/flows/{id}` shows `file_path` empty.

const ASSET = "test-file.txt";
const STRIP_HOLD_MS = 1500;

const createdFlowIds: string[] = [];
const createdFileIds: string[] = [];

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
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(
      () => {},
    );
  }
  for (const id of createdFileIds.splice(0)) {
    await request
      .delete(`/api/v2/files/${id}`, { headers: { Authorization: bearer } })
      .catch(() => {});
  }
});

test("repro LE-2208: one stale file-list response must not destroy the attachment", async ({
  page,
  request,
}) => {
  trackCreatedFlows(page);
  const stem = generateRandomFilename();
  const buffer = fs.readFileSync(resolveAssetPath(ASSET));

  // Armed only after the attachment is confirmed and saved, and spends itself
  // on the first list response it sees — every later read is served untouched,
  // which is what makes this "one response lagged", not "the file is gone".
  let armed = false;
  let stripped = 0;
  await page.route("**/api/v2/files*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET" || !armed || stripped > 0) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      await route.fulfill({ response });
      return;
    }
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    const kept = (body as { name?: string }[]).filter((f) => f.name !== stem);
    if (kept.length === body.length) {
      // This read predates the upload — leave it alone and stay armed.
      await route.fulfill({ response });
      return;
    }
    stripped += 1;
    await route.fulfill({ response, json: kept });
  });

  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();
  await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
  await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
    timeout: 30000,
  });

  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("Read File");
  await expect(page.getByTestId("add-component-button-read-file")).toBeVisible({
    timeout: 15000,
  });
  await page.getByTestId("add-component-button-read-file").click();
  await expect(page.getByTestId("title-Read File")).toBeVisible({
    timeout: 15000,
  });

  await page.getByTestId("button_open_file_management").click();
  await expect(page.getByTestId("drag-files-component")).toBeVisible({
    timeout: 15000,
  });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("drag-files-component").click(),
  ]);
  const uploadDone = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v2/files") &&
      r.request().method() === "POST" &&
      r.status() < 300,
    { timeout: 30000 },
  );
  await chooser.setFiles([
    { name: `${stem}.txt`, mimeType: "text/plain", buffer },
  ]);
  const uploaded: { id?: string; name?: string } = await (
    await uploadDone
  ).json();
  expect(uploaded.id).toBeTruthy();
  createdFileIds.push(uploaded.id as string);
  expect(uploaded.name).toBe(stem);

  // The row is correct at this point — the optimistic cache entry still holds
  // the file, so the selection the user confirms is the right one.
  await expect(page.getByTestId(`file-item-${stem}`)).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId(`checkbox-${stem}`)).toHaveAttribute(
    "data-state",
    "checked",
    { timeout: 15000 },
  );

  await page.getByTestId("select-files-modal-button").click();
  await expect(page.getByTestId("select-files-modal-button")).toBeHidden({
    timeout: 15000,
  });

  // Precondition, asserted rather than assumed: the attach worked and reached
  // the flow. Without this a wipe and a never-attached file look the same.
  await expect(page.getByTestId(`file-item-${stem}`)).toBeVisible({
    timeout: 15000,
  });
  const flowId = createdFlowIds[createdFlowIds.length - 1];
  const bearer = await getAuthToken(request);
  // The persisted attachment lives in `template.path` — `value` holds the file
  // NAME and `file_path` the storage path (`<user>/<name>.txt`); neither carries
  // the file's uuid, so the id is the wrong anchor and reads as a permanent
  // wipe. The per-run random stem is what identifies it. Falling back to the
  // whole template when `path` is absent keeps a shape drift visible as a drift
  // instead of reporting it as a wipe.
  const readSavedTemplate = async (): Promise<string> => {
    const flow = await request.get(`/api/v1/flows/${flowId}`, {
      headers: { Authorization: bearer },
    });
    const saved = await flow.json();
    const node = (saved?.data?.nodes ?? []).find((n: { data?: { type?: string } }) =>
      String(n?.data?.type ?? "").toLowerCase().includes("file"),
    );
    const template = node?.data?.node?.template ?? {};
    return JSON.stringify(template.path ?? template);
  };
  await expect
    .poll(readSavedTemplate, { timeout: 20000, intervals: [500] })
    .toContain(stem);
  const pathBefore = await readSavedTemplate();

  // Now the defect's one condition. Reopening the file manager issues the read
  // that gets stripped; closing it without confirming is what releases the
  // reconcile effect against that stale cache.
  armed = true;
  await page.getByTestId("button_open_file_management").click();
  await expect(page.getByTestId("drag-files-component")).toBeVisible({
    timeout: 15000,
  });
  await expect
    .poll(() => stripped, { timeout: 20000, intervals: [250] })
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("select-files-modal-button")).toBeHidden({
    timeout: 15000,
  });

  // Let the reconcile effect run, plus the fresh read the fixed build issues
  // in response to the missing path.
  await page.waitForTimeout(STRIP_HOLD_MS + 4000);

  const chipVisible = await page
    .getByTestId(`file-item-${stem}`)
    .isVisible()
    .catch(() => false);
  const pathAfter = await readSavedTemplate();

  console.log(
    `[LE-2208] stripped=${stripped} chipVisible=${chipVisible} ` +
      `stemPersistedBefore=${pathBefore.includes(stem)} ` +
      `stemPersistedAfter=${pathAfter.includes(stem)} after=${pathAfter}`,
  );

  expect(
    chipVisible,
    "one stale list response must not remove the file chip",
  ).toBe(true);
  expect(
    pathAfter,
    "one stale list response must not wipe the persisted attachment",
  ).toContain(stem);
});
