import { readFileSync } from "fs";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import { fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { OUTDATED_SAFE_CHAT_OUTPUT_ID, buildOutdatedSafeFlow } from "../../../../helpers/flows/outdated-safe-flow";

// Upgrade reports and repairs (#2567, upstream #16255 / #16583 / #16584).
// Spec doc: docs/api/instance/api-upgrade-reports.md
//
// Two lanes. The normal lane (@stable) never runs a check and never turns maintenance
// on: preview, the maintenance gate and the superuser gate. The serial @destructive
// lane holds the two instance-wide operations: a check (it dry-runs every outdated
// node on the instance; 242 s measured with 30 flows) and an applied repair (it needs
// database maintenance, which pauses writes for everyone).

const OUTDATED_FIXTURE = "tests/assets/flows/outdated_flow.json";
const MAINTENANCE_REQUIRED = "Enable database maintenance before applying repairs";
const TARGET_CHANGED = "The target registry changed. Preview the selected flows again";
const NOT_SUPERUSER = "The user doesn't have enough privileges";
/** How long one check may run once it starts (242 s measured with 30 flows). */
const CHECK_RUN_MS = 600_000;
/** How long to wait for another check to release the lock, separately. */
const LOCK_WAIT_MS = 300_000;

type FlowNode = {
  id: string;
  data: { type: string; node: { template: Record<string, { value?: unknown }> } };
  [k: string]: unknown;
};
type FlowEdge = { source: string; target: string; [k: string]: unknown };
type FlowData = { nodes: FlowNode[]; edges: FlowEdge[]; [k: string]: unknown };
type CheckEvent = { event?: string; code?: string; report_id?: string; [k: string]: unknown };
type RepairResult = {
  flow_id: string;
  status: string;
  version_token: string | null;
  data_sha256: string | null;
  updated_nodes: number;
  recovery_version_id: string | null;
  reason_codes: string[];
};
type RepairBatch = { target_sha256: string; results: RepairResult[] };
type ReportFlow = { id: string; status: string; nodes: Array<{ type: string; status: string; reasons: unknown[] }> };

function unique(label: string): string {
  return `E2E upgrade report ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Instance API — upgrade reports and repairs", () => {
  let headers: Record<string, string>;
  let mainVersion: string;
  let breakingId: string | undefined;
  let safeId: string | undefined;
  let safeData: FlowData;
  let ownFlow: (request: APIRequestContext) => Promise<string>;
  const extraFlowIds: string[] = [];
  let openAiNodeId: string;
  let openAiCode: string;
  const users: ThrowawayUser[] = [];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const version = await request.get("/api/v1/version");
    mainVersion = (await version.json()).main_version;
    expect(mainVersion, "the server reports its main version").toMatch(/^\d+\.\d+\.\d+$/);

    const fixture = JSON.parse(readFileSync(OUTDATED_FIXTURE, "utf-8"));
    breakingId = await createFlow(request, { name: unique("breaking"), data: fixture.data }, { headers });

    const safe = buildOutdatedSafeFlow(await fetchComponentCatalog(request, headers), fixture.data);
    safeData = safe.data as unknown as FlowData;
    openAiNodeId = safe.openAiNodeId;
    openAiCode = safe.openAiCode;
    safeId = await createFlow(request, { name: unique("safe"), data: safe.data }, { headers });
    // A fresh copy of the safe flow, for a test that repairs it: the shared one stays outdated.
    ownFlow = async (req) => {
      const id = await createFlow(req, { name: unique("safe repaired"), data: safe.data }, { headers });
      extraFlowIds.push(id);
      return id;
    };
  });

  test.afterAll(async ({ request }) => {
    const failures: string[] = [];
    // Never leave the instance paused, whatever a destructive test did.
    const status = await request.get("/api/v1/maintenance/status", { headers });
    if (status.ok() && (await status.json()).maintenance) {
      const off = await request.post("/api/v1/maintenance/off", { headers, data: {} });
      if (!off.ok()) failures.push(`maintenance off: ${off.status()}`);
    }
    for (const id of [breakingId, safeId, ...extraFlowIds.splice(0)]) {
      if (id) await deleteFlow(request, id, { headers }).catch((e) => failures.push(String(e)));
    }
    for (const user of users.splice(0)) {
      await deleteThrowawayUser(request, headers, user).catch((e: unknown) => failures.push(String(e)));
    }
    expect(failures, "teardown leaves nothing behind").toEqual([]);
  });

  /**
   * Runs a check against the running release. The lock is refused two ways: `409
   * check_running` from the route, or, in the window before the run takes the lock, a
   * `200` stream whose only event is `{event: "error", code: "check_running"}`. Both
   * wait and retry, on their own budget; the check itself gets CHECK_RUN_MS.
   */
  async function runCheck(request: APIRequestContext): Promise<{ events: CheckEvent[]; reportId: string }> {
    const lockDeadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const res: APIResponse = await request.post("/api/v1/upgrade-reports/checks", {
        headers,
        data: { target_version: mainVersion },
        timeout: CHECK_RUN_MS,
      });
      const raw = await res.text();
      const events =
        res.status() === 200
          ? raw
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => JSON.parse(l) as CheckEvent)
          : [];
      const lockRefused =
        res.status() === 409 || (events.length === 1 && events[0].event === "error" && events[0].code === "check_running");
      if (!lockRefused) {
        expect(res.status(), `POST /api/v1/upgrade-reports/checks — ${raw.slice(0, 300)}`).toBe(200);
        const last = events[events.length - 1];
        expect(last?.event, `the check ends with "imported" — last event: ${JSON.stringify(last)}`).toBe("imported");
        return { events, reportId: last.report_id as string };
      }
      expect(Date.now(), "another check released the lock in time").toBeLessThan(lockDeadline);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  async function preview(request: APIRequestContext, flowIds: string[], reportId?: string): Promise<RepairBatch> {
    const res = await request.post("/api/v1/upgrade-repairs/preview", {
      headers,
      data: reportId ? { flow_ids: flowIds, report_id: reportId } : { flow_ids: flowIds },
    });
    const raw = await res.text();
    expect(res.status(), `POST /api/v1/upgrade-repairs/preview — ${raw.slice(0, 300)}`).toBe(200);
    return JSON.parse(raw) as RepairBatch;
  }

  function resultFor(batch: RepairBatch, flowId: string): RepairResult {
    const result = batch.results.find((r) => r.flow_id === flowId);
    expect(result, `a result for flow ${flowId}`).toBeTruthy();
    return result!;
  }

  async function storedData(request: APIRequestContext, flowId: string): Promise<FlowData> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status()).toBe(200);
    return (await res.json()).data as FlowData;
  }

  async function versions(request: APIRequestContext, flowId: string): Promise<Array<Record<string, unknown>>> {
    const res = await request.get(`/api/v1/flows/${flowId}/versions/`, { headers });
    expect(res.status(), `GET /api/v1/flows/${flowId}/versions/`).toBe(200);
    return (await res.json()).entries as Array<Record<string, unknown>>;
  }

  function selection(result: RepairResult) {
    return { flow_id: result.flow_id, version_token: result.version_token, data_sha256: result.data_sha256 };
  }

  test(
    "preview is read-only: ready for the safe flow, manual for the breaking one",
    { tag: ["@stable", "@api", "@database"] },
    async ({ request }) => {
      const before = { breaking: await storedData(request, breakingId!), safe: await storedData(request, safeId!) };
      const batch = await preview(request, [safeId!, breakingId!]);

      await test.step("the safe flow is ready and the breaking one needs manual repair", async () => {
        expect(batch.target_sha256).toMatch(/^[0-9a-f]{64}$/);
        const safe = resultFor(batch, safeId!);
        expect({ status: safe.status, updated_nodes: safe.updated_nodes }).toEqual({ status: "ready", updated_nodes: 1 });
        expect(safe.version_token, "a ready result carries the flow's version token").toBeTruthy();
        expect(safe.data_sha256).toMatch(/^[0-9a-f]{64}$/);
        const breaking = resultFor(batch, breakingId!);
        expect({ status: breaking.status, reason_codes: breaking.reason_codes }).toEqual({
          status: "manual",
          reason_codes: ["outdated_breaking"],
        });
      });

      await test.step("nothing was written: deep-equal data, no saved version", async () => {
        expect(await storedData(request, safeId!)).toEqual(before.safe);
        expect(await storedData(request, breakingId!)).toEqual(before.breaking);
        expect(await versions(request, safeId!)).toEqual([]);
        expect(await versions(request, breakingId!)).toEqual([]);
      });
    },
  );

  test(
    "apply outside maintenance is refused and writes nothing",
    { tag: ["@stable", "@api", "@database"] },
    async ({ request }) => {
      const status = await request.get("/api/v1/maintenance/status", { headers });
      expect((await status.json()).maintenance, "maintenance is off in the normal lane").toBe(false);
      const before = await storedData(request, safeId!);
      const batch = await preview(request, [safeId!]);

      const res = await request.post("/api/v1/upgrade-repairs/apply", {
        headers,
        data: { flows: [selection(resultFor(batch, safeId!))], target_sha256: batch.target_sha256 },
      });
      const raw = await res.text();
      expect(res.status(), `apply without maintenance — ${raw}`).toBe(409);
      expect(JSON.parse(raw).detail).toBe(MAINTENANCE_REQUIRED);
      expect(await storedData(request, safeId!), "the flow is unchanged").toEqual(before);
      expect(await versions(request, safeId!), "no recovery version").toEqual([]);
    },
  );

  test(
    "every upgrade-report and repair route refuses a non-superuser",
    { tag: ["@stable", "@api", "@database"] },
    async ({ request, playwright, baseURL }) => {
      const user = await createThrowawayUser(request, {
        superHeaders: headers,
        newContext: () => playwright.request.newContext({ baseURL }),
        prefix: "upgradereport",
        track: (u) => users.push(u),
      });
      const someId = "00000000-0000-0000-0000-000000000000";
      const routes: Array<[string, string, unknown]> = [
        ["GET", "/api/v1/upgrade-reports", undefined],
        ["GET", `/api/v1/upgrade-reports/${someId}`, undefined],
        ["GET", `/api/v1/upgrade-reports/${someId}/export`, undefined],
        ["GET", `/api/v1/upgrade-reports/${someId}/repairs`, undefined],
        ["GET", "/api/v1/upgrade-reports/checks/releases", undefined],
        ["POST", "/api/v1/upgrade-reports/checks", { target_version: mainVersion }],
        ["POST", "/api/v1/upgrade-reports", {}],
        ["POST", "/api/v1/upgrade-repairs/preview", { flow_ids: [safeId] }],
        ["POST", "/api/v1/upgrade-repairs/apply", { flows: [], target_sha256: "0".repeat(64) }],
      ];
      for (const [method, path, data] of routes) {
        await test.step(`${method} ${path.replace(someId, "{id}")} → 403`, async () => {
          const res = await user.request.fetch(path, { method, headers: user.headers, data });
          const raw = await res.text();
          expect(res.status(), `${method} ${path} as a regular user — ${raw}`).toBe(403);
          expect(JSON.parse(raw).detail).toBe(NOT_SUPERUSER);
        });
      }
    },
  );

  test(
    "a check against the running release reports the breaking flow and the safe one",
    { tag: ["@destructive", "@api", "@database"] },
    async ({ request }) => {
      test.setTimeout(LOCK_WAIT_MS + CHECK_RUN_MS + 60_000);
      const { events, reportId } = await runCheck(request);

      await test.step("the stream starts with started and ends with imported", async () => {
        expect(events[0]?.event).toBe("started");
        expect(reportId, "the imported event names the report").toMatch(/^[0-9a-f-]{36}$/);
      });

      let flows: ReportFlow[] = [];
      let errors: unknown[] = [];

      await test.step("the report holds both flows, and no error names them", async () => {
        const res = await request.get(`/api/v1/upgrade-reports/${reportId}`, { headers });
        expect(res.status()).toBe(200);
        const document = (await res.json()).document as { flows: ReportFlow[]; errors?: unknown[] };
        flows = document.flows;
        errors = document.errors ?? [];
        expect(flows.map((f) => f.id), "our flows are in the report (other flows may be too)").toEqual(
          expect.arrayContaining([breakingId, safeId]),
        );
        // Other flows on the instance may fail to read (the report is then
        // `incomplete`); only an error about OUR flows is this test's business.
        const ours = JSON.stringify(errors);
        expect(ours.includes(breakingId!) || ours.includes(safeId!), `report errors: ${ours.slice(0, 300)}`).toBe(false);
      });

      await test.step("the breaking flow fails, with breaking nodes and their reasons", async () => {
        const breaking = flows.find((f) => f.id === breakingId)!;
        expect(breaking.status).toBe("fail");
        const broken = breaking.nodes.filter((n) => n.status === "outdated_breaking");
        expect(broken.length, "at least one node would break").toBeGreaterThan(0);
        for (const node of broken) expect(node.reasons.length, `${node.type} says why it breaks`).toBeGreaterThan(0);
      });

      await test.step("the safe flow is ok, its OpenAI node outdated but safe", async () => {
        const safe = flows.find((f) => f.id === safeId)!;
        expect(safe.status).toBe("ok");
        expect(safe.nodes.find((n) => n.type === "OpenAIModel")?.status).toBe("outdated_safe");
      });

      await test.step("the report is in the history", async () => {
        const res = await request.get("/api/v1/upgrade-reports?limit=100", { headers });
        expect(res.status()).toBe(200);
        const ids = ((await res.json()).items as Array<{ id: string }>).map((i) => i.id);
        expect(ids).toContain(reportId);
      });
    },
  );

  test(
    "under maintenance, a repair updates the flow, keeps its edges and a retained recovery version",
    { tag: ["@destructive", "@api", "@database"] },
    async ({ request }) => {
      const repairId = await ownFlow(request);
      const batch = await preview(request, [repairId]);
      const ready = resultFor(batch, repairId);
      expect(ready.status).toBe("ready");
      const edgesBefore = (await storedData(request, repairId)).edges;

      const on = await request.post("/api/v1/maintenance/on", { headers, data: {} });
      expect(on.status(), "maintenance turns on").toBe(200);
      try {
        await test.step("a stale target registry is refused", async () => {
          const res = await request.post("/api/v1/upgrade-repairs/apply", {
            headers,
            data: { flows: [selection(ready)], target_sha256: "0".repeat(64) },
          });
          const raw = await res.text();
          expect(res.status(), raw).toBe(409);
          expect(JSON.parse(raw).detail).toBe(TARGET_CHANGED);
        });

        await test.step("a stale flow hash is a conflict and changes nothing", async () => {
          const before = await storedData(request, repairId);
          const res = await request.post("/api/v1/upgrade-repairs/apply", {
            headers,
            data: { flows: [{ ...selection(ready), data_sha256: "1".repeat(64) }], target_sha256: batch.target_sha256 },
          });
          expect(res.status()).toBe(200);
          expect(resultFor((await res.json()) as RepairBatch, repairId).status).toBe("conflict");
          expect(await storedData(request, repairId)).toEqual(before);
        });

        let applied: RepairResult | undefined;

        await test.step("apply updates the flow and names its recovery version", async () => {
          const res = await request.post("/api/v1/upgrade-repairs/apply", {
            headers,
            data: { flows: [selection(ready)], target_sha256: batch.target_sha256 },
          });
          const raw = await res.text();
          expect(res.status(), raw.slice(0, 300)).toBe(200);
          applied = resultFor(JSON.parse(raw) as RepairBatch, repairId);
          expect({ status: applied.status, updated_nodes: applied.updated_nodes }).toEqual({
            status: "updated",
            updated_nodes: 1,
          });
          expect(applied.recovery_version_id).toBeTruthy();
        });

        await test.step("the OpenAI node is updated, the Chat Output untouched, the edges exactly as before", async () => {
          const data = await storedData(request, repairId);
          const openAi = data.nodes.find((n) => n.id === openAiNodeId)!;
          expect(openAi.data.node.template.code.value, "the outdated code was replaced").not.toBe(openAiCode);
          const chatOutput = data.nodes.find((n) => n.id === OUTDATED_SAFE_CHAT_OUTPUT_ID)!;
          const originalChatOutput = safeData.nodes.find((n) => n.id === OUTDATED_SAFE_CHAT_OUTPUT_ID)!;
          expect(chatOutput.data.node.template.code.value).toBe(originalChatOutput.data.node.template.code.value);
          expect(data.edges, "the repair keeps every stored edge as it was").toEqual(edgesBefore);
        });

        await test.step("the recovery version is retained as admin-upgrade-repair", async () => {
          const entries = await versions(request, repairId);
          expect(
            entries.map((e) => ({ id: e.id, retained: e.retained, reason: e.retained_reason, description: e.description })),
          ).toEqual([
            {
              id: applied!.recovery_version_id,
              retained: true,
              reason: "admin-upgrade-repair",
              description: "Recovery before an administrator upgraded this flow",
            },
          ]);
        });

        await test.step("a new preview reads unchanged", async () => {
          expect(resultFor(await preview(request, [repairId]), repairId).status).toBe("unchanged");
        });
      } finally {
        const off = await request.post("/api/v1/maintenance/off", { headers, data: {} });
        expect(off.status(), "maintenance turns off").toBe(200);
      }
    },
  );
});
