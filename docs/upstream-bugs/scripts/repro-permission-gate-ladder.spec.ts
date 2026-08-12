import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// REPRO for LE-2176 — not part of the suite, and kept out of `tests/` so the
// runner never collects it. The relative imports above are written for its run
// location; copy it there first:
//
//   cp docs/upstream-bugs/scripts/repro-permission-gate-ladder.spec.ts \
//      tests/tests-automations/regression/core-components/
//
// Measures how WIDE the dead window gets when the permissions call fails and
// the shared request wrapper retries it (the LE-2123 ladder:
// min(1000 * 2^n, 30000), 5 attempts => ~31 s). Needs --reporter=list.

const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(
      () => {},
    );
  }
});

const NODES = '[data-testid^="rf__node-"]';
const AUTHZ = "authz/me/permissions";

test("LADDER — a failing permissions call widens the dead window", async ({
  page,
}) => {
  test.setTimeout(180000);
  const t0 = Date.now();
  const attempts: number[] = [];

  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((b: { id?: string }) => b?.id && createdFlowIds.push(b.id))
        .catch(() => {});
    }
  });

  // The suite fails a test on a 4xx/5xx we did not declare; this one is ours.
  await page.allowHttpErrors();

  await page.route(`**/${AUTHZ}`, async (route) => {
    attempts.push(Date.now() - t0);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "injected" }),
    });
  });

  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("blank-flow").click();
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 20000,
  });

  const button = page.getByTestId("sidebar-custom-component-button");
  await expect(button).toBeVisible({ timeout: 15000 });

  // Probe the add every 5 s until it lands or 60 s elapse. The first probe that
  // produces a node marks the far edge of the dead window.
  let landedAt: number | null = null;
  for (let i = 0; i < 12 && landedAt === null; i += 1) {
    const before = await page.locator(NODES).count();
    const tClick = Date.now() - t0;
    await button.click();
    await page.waitForTimeout(1500);
    const after = await page.locator(NODES).count();
    console.log(
      `[LADDER] probe#${i} click@${tClick}ms added=${after - before} attemptsSoFar=${attempts.length}`,
    );
    if (after > before) landedAt = tClick;
    else await page.waitForTimeout(3500);
  }

  console.log(
    `[LADDER] window closed at ${landedAt ?? "NEVER (>60s)"} ms — ` +
      `${attempts.length} permissions attempts at [${attempts.join(", ")}] ms`,
  );

  expect(attempts.length, "the client retried the failing call").toBeGreaterThan(1);
});
