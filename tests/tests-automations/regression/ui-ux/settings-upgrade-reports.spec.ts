import { readFileSync } from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { OUTDATED_SAFE_CHAT_OUTPUT_ID, buildOutdatedSafeFlow } from "../../../helpers/flows/outdated-safe-flow";

// Settings › Upgrade reports (#2567). Spec doc: docs/ui-ux/settings-upgrade-reports.md
// The API contract under the page is api/instance/api-upgrade-reports.spec.ts.
//
// Both tests are @destructive (the serial lane): each runs a check, which dry-runs every
// outdated node on the instance (242 s measured with 30 flows), and the second turns
// database maintenance on. The page has no test ids below its root; controls are
// located by role and accessible name.

const OUTDATED_FIXTURE = "tests/assets/flows/outdated_flow.json";
const SEARCH_LABEL = "Search names, owners, projects, or labels";
/** How long one check may run once it starts (242 s measured with 30 flows). */
const CHECK_RUN_MS = 600_000;
/** How long to wait for another check to release the lock, separately. */
const LOCK_WAIT_MS = 300_000;

type FlowNode = {
  id: string;
  data: { type: string; node: { template: Record<string, { value?: unknown }> } };
  [k: string]: unknown;
};
type FlowData = { nodes: FlowNode[]; edges: Array<{ source: string; target: string; [k: string]: unknown }>; [k: string]: unknown };

test.describe("Settings — Upgrade reports", () => {
  let headers: Record<string, string>;
  let mainVersion: string;
  let suffix: string;
  let breaking: { id: string; name: string };
  let safe: { id: string; name: string };
  let openAiNodeId: string;
  let openAiCode: string;

  test.beforeEach(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    mainVersion = (await (await request.get("/api/v1/version")).json()).main_version;
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const fixture = JSON.parse(readFileSync(OUTDATED_FIXTURE, "utf-8"));
    const breakingName = `E2E upgrade breaking ${suffix}`;
    breaking = { name: breakingName, id: await createFlow(request, { name: breakingName, data: fixture.data }, { headers }) };

    const built = buildOutdatedSafeFlow(await fetchComponentCatalog(request, headers), fixture.data);
    openAiNodeId = built.openAiNodeId;
    openAiCode = built.openAiCode;
    const safeName = `E2E upgrade safe ${suffix}`;
    safe = { name: safeName, id: await createFlow(request, { name: safeName, data: built.data }, { headers }) };
  });

  test.afterEach(async ({ page, request }) => {
    await page.goto("about:blank");
    const failures: string[] = [];
    const status = await request.get("/api/v1/maintenance/status", { headers });
    if (status.ok() && (await status.json()).maintenance) {
      const off = await request.post("/api/v1/maintenance/off", { headers, data: {} });
      if (!off.ok()) failures.push(`maintenance off: ${off.status()}`);
    }
    for (const flow of [breaking, safe]) {
      if (flow?.id) await deleteFlow(request, flow.id, { headers }).catch((e) => failures.push(String(e)));
    }
    expect(failures, "teardown leaves nothing behind").toEqual([]);
  });

  async function storedData(request: APIRequestContext, flowId: string): Promise<FlowData> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status()).toBe(200);
    return (await res.json()).data as FlowData;
  }

  /**
   * Runs a check from the page and returns the report id. The page either reports the
   * report ready or shows an alert (e.g. another check holds the lock); an alert waits
   * and clicks again on LOCK_WAIT_MS, while a running check gets CHECK_RUN_MS.
   */
  async function checkFromPage(page: Page): Promise<string> {
    await page.goto("/settings/upgrade-reports");
    const root = page.getByTestId("upgrade-reports-page");
    await expect(root).toBeVisible({ timeout: 60_000 });
    const feedback = page.locator("#upgrade-check-feedback");
    const ready = `The report for Langflow ${mainVersion} is ready.`;
    const refused = page.locator("#upgrade-check-feedback [role='alert']");
    const lockDeadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      await page.getByLabel("Target release").fill(mainVersion);
      await page.getByRole("button", { name: "Check upgrade" }).click();
      await expect(feedback.getByText(ready).or(refused)).toBeVisible({ timeout: CHECK_RUN_MS });
      if (await feedback.getByText(ready).isVisible()) break;
      expect(Date.now(), `the check kept being refused: ${await refused.innerText()}`).toBeLessThan(lockDeadline);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    await expect(page).toHaveURL(/[?&]report=[0-9a-f-]{36}/);
    return new URL(page.url()).searchParams.get("report")!;
  }

  /** Narrows the report's flow list to this run's flows (it pages 20 at a time), then previews them. */
  async function previewFromPage(page: Page, flows: Array<{ name: string }>): Promise<void> {
    await page.getByLabel(SEARCH_LABEL).fill(suffix);
    for (const flow of flows) await page.getByLabel(`Select ${flow.name} for preview`).check();
    await page.getByRole("button", { name: "Preview selected updates" }).click();
    await expect(page.getByText("Preview complete. No flows have changed.")).toBeVisible({ timeout: 60_000 });
  }

  test(
    "a check from the page reports both flows, and its preview matches the API and changes nothing",
    { tag: ["@destructive", "@settings", "@database"] },
    async ({ page, request }) => {
      test.setTimeout(LOCK_WAIT_MS + CHECK_RUN_MS + 120_000);
      const before = { breaking: await storedData(request, breaking.id), safe: await storedData(request, safe.id) };
      let reportId = "";

      await test.step("run a check from the page", async () => {
        reportId = await checkFromPage(page);
      });

      await test.step("the page's report is the API's report, with both flows", async () => {
        const res = await request.get(`/api/v1/upgrade-reports/${reportId}`, { headers });
        expect(res.status()).toBe(200);
        const flows = (await res.json()).document.flows as Array<{ id: string; status: string }>;
        expect(flows.find((f) => f.id === breaking.id)?.status).toBe("fail");
        expect(flows.find((f) => f.id === safe.id)?.status).toBe("ok");
      });

      await test.step("the preview lists each flow's outcome and the API's fingerprint", async () => {
        await previewFromPage(page, [safe, breaking]);
        const root = page.getByTestId("upgrade-reports-page");
        await expect(root.getByText(`${safe.name} · Ready for update`)).toBeVisible();
        await expect(root.getByText(`${breaking.name} · Manual repair required`)).toBeVisible();
        const api = await request.post("/api/v1/upgrade-repairs/preview", {
          headers,
          data: { flow_ids: [safe.id, breaking.id], report_id: reportId },
        });
        expect(api.status()).toBe(200);
        await expect(root, "the page shows the API's target registry fingerprint").toContainText(
          (await api.json()).target_sha256 as string,
        );
      });

      await test.step("nothing was written, and apply is disabled while maintenance is off", async () => {
        expect(await storedData(request, safe.id)).toEqual(before.safe);
        expect(await storedData(request, breaking.id)).toEqual(before.breaking);
        await expect(page.getByText("Maintenance is off.")).toBeVisible();
        await expect(page.getByRole("button", { name: /^Apply \d+ reviewed update/ })).toBeDisabled();
      });
    },
  );

  test(
    "apply from the page under maintenance updates the flow and keeps a retained recovery version",
    { tag: ["@destructive", "@settings", "@database"] },
    async ({ page, request }) => {
      test.setTimeout(LOCK_WAIT_MS + CHECK_RUN_MS + 120_000);
      const edgesBefore = (await storedData(request, safe.id)).edges;
      try {
        await test.step("check and preview the safe flow", async () => {
          await checkFromPage(page);
          await previewFromPage(page, [safe]);
          await expect(page.getByTestId("upgrade-reports-page").getByText(`${safe.name} · Ready for update`)).toBeVisible();
        });

        await test.step("turn maintenance on from the page", async () => {
          await page.getByRole("button", { name: "Turn maintenance on" }).click();
          // The page asks first: "Ordinary changes and new flow runs will pause for everyone."
          const dialog = page.getByRole("dialog");
          await expect(dialog).toContainText("will pause for everyone");
          await dialog.getByRole("button", { name: "Turn maintenance on" }).click();
          await expect
            .poll(async () => (await (await request.get("/api/v1/maintenance/status", { headers })).json()).maintenance, {
              message: "the API reports maintenance on",
              timeout: 15_000,
            })
            .toBe(true);
        });

        await test.step("review and apply the update; the page reports it updated", async () => {
          await page.getByLabel(/^I reviewed this 1 update/).check();
          const apply = page.getByRole("button", { name: "Apply 1 reviewed update" });
          await expect(apply).toBeEnabled({ timeout: 15_000 });
          await apply.click();
          await expect(page.getByTestId("upgrade-reports-page").getByText(`${safe.name} · Updated`).first()).toBeVisible({
            timeout: 30_000,
          });
        });

        await test.step("the flow is updated, its edges as before, its recovery version retained", async () => {
          const data = await storedData(request, safe.id);
          const node = data.nodes.find((n) => n.id === openAiNodeId)!;
          expect(node.data.node.template.code.value, "the apply replaced the outdated OpenAI code").not.toBe(openAiCode);
          expect(data.nodes.map((n) => n.id).sort()).toEqual([OUTDATED_SAFE_CHAT_OUTPUT_ID, openAiNodeId].sort());
          expect(data.edges, "the repair keeps every stored edge as it was").toEqual(edgesBefore);
          const versions = await request.get(`/api/v1/flows/${safe.id}/versions/`, { headers });
          const entries = (await versions.json()).entries as Array<{ retained: boolean; retained_reason: string }>;
          expect(entries.map((e) => ({ retained: e.retained, reason: e.retained_reason }))).toEqual([
            { retained: true, reason: "admin-upgrade-repair" },
          ]);
        });
      } finally {
        const off = await request.post("/api/v1/maintenance/off", { headers, data: {} });
        expect(off.status(), "maintenance turns off").toBe(200);
      }
    },
  );
});
