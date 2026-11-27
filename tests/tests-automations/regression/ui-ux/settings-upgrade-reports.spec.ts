import { readFileSync } from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { buildCatalogFlow, fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { classifyHttpError } from "../../../fixtures/http-error-policy";

// Settings › Upgrade reports (#2567). Spec doc: docs/ui-ux/settings-upgrade-reports.md
// The API contract under the page is api/instance/api-upgrade-reports.spec.ts.
// The page has no test ids below its root; controls are located by role and name.

const OUTDATED_FIXTURE = "tests/assets/flows/outdated_flow.json";
const CHAT_OUTPUT_ID = "ChatOutput-cur01";
const CHECK_TIMEOUT_MS = 240_000;
const CHECKS_PATH = "/api/v1/upgrade-reports/checks";
const PAGE_LOAD_TIMEOUT_MS = 150_000;

type FlowNode = {
  id: string;
  data: { type: string; node: { template: Record<string, { value?: unknown }> } };
  [k: string]: unknown;
};
type FlowData = { nodes: FlowNode[]; edges: Array<{ source: string; target: string; [k: string]: unknown }>; [k: string]: unknown };

function encodeHandle(handle: Record<string, unknown>): string {
  return JSON.stringify(handle).replace(/"/g, "œ");
}

test.describe("Settings — Upgrade reports", () => {
  let headers: Record<string, string>;
  let mainVersion: string;
  let breaking: { id: string; name: string };
  let safe: { id: string; name: string };
  let openAiNodeId: string;
  let openAiCode: string;
  let unexpectedHttpErrors: string[] = [];

  test.beforeEach(async ({ page, request }) => {
    // A check holds an instance-wide lock, so a check from the page can meet one another
    // spec started and get `409 check_running`; checkFromPage retries it. The fixture's
    // gate has no "allowed when it happens" form, so it is switched off here and replaced
    // by the same policy minus that one response: every other monitored 4xx/5xx still
    // fails the test, in afterEach.
    (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
    unexpectedHttpErrors = [];
    page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      if (!classifyHttpError({ url, status }).monitored) return;
      const lockRefusal = status === 409 && response.request().method() === "POST" && new URL(url).pathname === CHECKS_PATH;
      if (!lockRefusal) unexpectedHttpErrors.push(`${status} ${response.request().method()} ${new URL(url).pathname}`);
    });

    headers = { Authorization: await getAuthToken(request) };
    mainVersion = (await (await request.get("/api/v1/version")).json()).main_version;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const fixture = JSON.parse(readFileSync(OUTDATED_FIXTURE, "utf-8"));
    const breakingName = `E2E upgrade breaking ${suffix}`;
    breaking = { name: breakingName, id: await createFlow(request, { name: breakingName, data: fixture.data }, { headers }) };

    // The fixture's OpenAI node is outdated but safe to update; the Chat Output is current.
    const openAi = (fixture.data.nodes as FlowNode[]).find((n) => n.data.type === "OpenAIModel")!;
    openAiNodeId = openAi.id;
    openAiCode = openAi.data.node.template.code.value as string;
    const catalog = await fetchComponentCatalog(request, headers);
    const chatOutput = buildCatalogFlow(catalog, { nodes: [{ id: CHAT_OUTPUT_ID, type: "ChatOutput" }], edges: [] })
      .nodes[0] as unknown as FlowNode;
    const sourceHandle = { dataType: "OpenAIModel", id: openAiNodeId, name: "text_output", output_types: ["Message"] };
    const targetHandle = { fieldName: "input_value", id: CHAT_OUTPUT_ID, inputTypes: ["Data", "DataFrame", "Message"], type: "str" };
    const safeData: FlowData = {
      nodes: [openAi, { ...chatOutput, position: { x: 600, y: 0 } }],
      edges: [
        {
          id: `reactflow__edge-${openAiNodeId}-${CHAT_OUTPUT_ID}`,
          source: openAiNodeId,
          target: CHAT_OUTPUT_ID,
          sourceHandle: encodeHandle(sourceHandle),
          targetHandle: encodeHandle(targetHandle),
          data: { sourceHandle, targetHandle },
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const safeName = `E2E upgrade safe ${suffix}`;
    safe = { name: safeName, id: await createFlow(request, { name: safeName, data: safeData }, { headers }) };
  });

  test.afterEach(async ({ page, request }) => {
    await page.goto("about:blank");
    const failures: string[] = [];
    const httpErrors = unexpectedHttpErrors.splice(0);
    const status = await request.get("/api/v1/maintenance/status", { headers });
    if (status.ok() && (await status.json()).maintenance) {
      const off = await request.post("/api/v1/maintenance/off", { headers, data: {} });
      if (!off.ok()) failures.push(`maintenance off: ${off.status()}`);
    }
    for (const flow of [breaking, safe]) {
      if (flow?.id) await deleteFlow(request, flow.id, { headers }).catch((e) => failures.push(String(e)));
    }
    expect(failures, "teardown leaves nothing behind").toEqual([]);
    expect(httpErrors, "no backend error other than the check lock's 409").toEqual([]);
  });

  async function storedData(request: APIRequestContext, flowId: string): Promise<FlowData> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status()).toBe(200);
    return (await res.json()).data as FlowData;
  }

  /** Runs a check from the page; retries while the instance-wide lock refuses it. Returns the report id. */
  async function checkFromPage(page: Page): Promise<string> {
    // A check runs inside the server process and took ~40 s; while another spec's check
    // runs, a one-worker server answers the page's own requests late (measured: the root
    // missed a 30 s wait once with the API spec in parallel, never alone in 5 runs).
    await page.goto("/settings/upgrade-reports", { timeout: PAGE_LOAD_TIMEOUT_MS });
    const root = page.getByTestId("upgrade-reports-page");
    await expect(root).toBeVisible({ timeout: PAGE_LOAD_TIMEOUT_MS });
    const feedback = page.locator("#upgrade-check-feedback");
    const ready = `The report for Langflow ${mainVersion} is ready.`;
    await expect(async () => {
      await page.getByLabel("Target release").fill(mainVersion);
      await page.getByRole("button", { name: "Check upgrade" }).click();
      // Either the report is ready, or the check was refused (e.g. another check holds
      // the lock): a refusal fails this attempt and toPass clicks again.
      await expect(feedback).toContainText(ready, { timeout: 120_000 });
    }).toPass({ timeout: CHECK_TIMEOUT_MS, intervals: [5_000] });
    await expect(page).toHaveURL(/[?&]report=[0-9a-f-]{36}/);
    return new URL(page.url()).searchParams.get("report")!;
  }

  async function previewFromPage(page: Page, flows: Array<{ name: string }>): Promise<void> {
    for (const flow of flows) await page.getByLabel(`Select ${flow.name} for preview`).check();
    await page.getByRole("button", { name: "Preview selected updates" }).click();
    await expect(page.getByText("Preview complete. No flows have changed.")).toBeVisible({ timeout: 60_000 });
  }

  test(
    "a check from the page reports both flows, and its preview matches the API and changes nothing",
    { tag: ["@stable", "@settings", "@database"] },
    async ({ page, request }) => {
      test.setTimeout(CHECK_TIMEOUT_MS + 120_000);
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
      test.setTimeout(CHECK_TIMEOUT_MS + 120_000);
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

        await test.step("review and apply the update", async () => {
          await page.getByLabel(/^I reviewed this 1 update/).check();
          const apply = page.getByRole("button", { name: "Apply 1 reviewed update" });
          await expect(apply).toBeEnabled({ timeout: 15_000 });
          await apply.click();
        });

        await test.step("the flow is updated, its edge intact, its recovery version retained", async () => {
          await expect
            .poll(
              async () => {
                const node = (await storedData(request, safe.id)).nodes.find((n) => n.id === openAiNodeId)!;
                return node.data.node.template.code.value !== openAiCode;
              },
              { message: "the apply replaces the outdated OpenAI code", timeout: 30_000 },
            )
            .toBe(true);
          const data = await storedData(request, safe.id);
          expect(data.edges.map((e) => [e.source, e.target])).toEqual([[openAiNodeId, CHAT_OUTPUT_ID]]);
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
