import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// REPRO for LE-2176 — not part of the suite, and kept out of `tests/` so the
// runner never collects it. The relative imports above are written for its run
// location; copy it there first:
//
//   cp docs/upstream-bugs/scripts/repro-permission-gate-add.spec.ts \
//      tests/tests-automations/regression/core-components/
//
// Validates that the swallowed sidebar add is `useIsFlowReadOnly` failing
// closed while POST /api/v1/authz/me/permissions is in flight.
//
// The two arms differ in ONE variable: whether the FIRST click lands inside the
// permissions window. Both delay the endpoint by 3 s, both click exactly once.
// That isolates "in the window" from "first click after mount", which is the
// confound (#1301's repair works on the second click for either reason).

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
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(
      () => {},
    );
  }
});

const NODES = '[data-testid^="rf__node-"]';
const AUTHZ = "authz/me/permissions";
const DELAY_MS = 3000;

/** In-flight counter for the permissions endpoint, plus a timestamped log. */
function instrumentAuthz(page: Page, t0: number) {
  const log: string[] = [];
  const state = { inFlight: 0, requests: 0, responses: 0 };
  page.on("request", (req) => {
    if (req.url().includes(AUTHZ)) {
      state.inFlight += 1;
      state.requests += 1;
      log.push(`req@${Date.now() - t0}`);
    }
  });
  page.on("requestfinished", (req) => {
    if (req.url().includes(AUTHZ)) {
      state.inFlight -= 1;
      log.push(`fin@${Date.now() - t0}`);
    }
  });
  page.on("requestfailed", (req) => {
    if (req.url().includes(AUTHZ)) {
      state.inFlight -= 1;
      log.push(`fail@${Date.now() - t0}`);
    }
  });
  return { log, state };
}

async function openBlankFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("blank-flow").click();
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 20000,
  });
}

/**
 * One measurement: open a blank flow with the permissions endpoint delayed,
 * optionally settle the gate, then click the add button exactly once.
 */
async function measure(
  page: Page,
  arm: "IN-WINDOW" | "OUT-OF-WINDOW",
): Promise<void> {
  const t0 = Date.now();
  const { log, state } = instrumentAuthz(page, t0);
  trackCreatedFlows(page);

  await page.route(`**/${AUTHZ}`, async (route) => {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await route.continue();
  });

  await openBlankFlow(page);

  const button = page.getByTestId("sidebar-custom-component-button");
  await expect(button).toBeVisible({ timeout: 15000 });

  if (arm === "OUT-OF-WINDOW") {
    // Wait for the delayed ladder to drain: no permissions request in flight
    // and none started for a full second.
    await expect
      .poll(async () => state.inFlight, { timeout: 30000, intervals: [250] })
      .toBe(0);
    await page.waitForTimeout(2000);
    await expect.poll(async () => state.inFlight, { timeout: 5000 }).toBe(0);
  }

  const before = await page.locator(NODES).count();
  const inFlightAtClick = state.inFlight;
  const tClick = Date.now() - t0;

  await button.click();
  await page.waitForTimeout(2500);
  const after = await page.locator(NODES).count();

  console.log(
    `[${arm}] added=${after - before} inFlightAtClick=${inFlightAtClick} ` +
      `click@${tClick}ms reqs=${state.requests} log=${log.join(",")}`,
  );

  if (arm === "IN-WINDOW") {
    expect(inFlightAtClick, "the click must land inside the window").toBeGreaterThan(0);
    expect(after - before, "prediction: the add is discarded").toBe(0);
  } else {
    expect(inFlightAtClick, "the click must land outside the window").toBe(0);
    expect(after - before, "prediction: the add lands on the first click").toBe(1);
  }
}

test.describe("repro: permission gate swallows the sidebar add", () => {
  test("IN-WINDOW — first click while permissions are in flight", async ({
    page,
  }) => {
    await measure(page, "IN-WINDOW");
  });

  test("OUT-OF-WINDOW — first click after permissions resolved", async ({
    page,
  }) => {
    await measure(page, "OUT-OF-WINDOW");
  });
});
