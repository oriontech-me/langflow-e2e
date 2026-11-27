import { readFileSync } from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { DatasetTracker, addItems, createDataset, readEvalsSurface } from "../../../helpers/api/evals/datasets";
import {
  EvaluationTracker,
  createEchoFlow,
  createEvaluation,
  startRun,
  waitForRunEnd,
} from "../../../helpers/api/evals/evaluations";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { buildOutdatedSafeFlow } from "../../../helpers/flows/outdated-safe-flow";

// Flow versions: a retained version is Protected (#2566, upstream #16578).
// Spec doc: docs/flow-functionality/flow-version-protected.md
//
// Since 1.14 the server retains a flow version that something still needs: the version
// an evaluation ran, or the recovery point an upgrade repair kept. The API refuses to
// delete it (409, the reason in the detail) and the version history marks it Protected,
// with the reason in a tooltip and its Delete item disabled.
//
// Test 1 retains a version through a keyless evaluation run (#2564's helpers), and runs
// in the normal lane. Test 2 retains one through an upgrade repair, which needs database
// maintenance (instance-wide), so it is @destructive.

const OUTDATED_FIXTURE = "tests/assets/flows/outdated_flow.json";
/** `version.protectedReason.*` (en). */
const EVALUATION_REASON = "An evaluation uses this version, so it can't be deleted.";
const REPAIR_REASON = "This version is a recovery point from an upgrade repair, so it can't be deleted.";

type VersionEntry = {
  id: string;
  version_number: number;
  version_tag: string;
  description: string | null;
  retained: boolean;
  retained_reason?: string | null;
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe("Flow versions — a retained version is Protected", () => {
  let headers: Record<string, string>;
  let catalog: Record<string, unknown>;
  let evalsSkip: string | null = null;
  let datasets: DatasetTracker;
  let evaluations: EvaluationTracker;
  let flows: string[];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const verdict = await readEvalsSurface(request, headers);
    if (verdict.state === "absent") evalsSkip = verdict.reason;
    else if (verdict.state !== "enabled") throw new Error(`evals premise: ${verdict.reason}`);
    catalog = await fetchComponentCatalog(request, headers);
  });

  test.beforeEach(() => {
    datasets = new DatasetTracker();
    evaluations = new EvaluationTracker();
    flows = [];
  });

  // Evaluations first: deleting one releases its version, and deleting a flow does not
  // delete its evaluations. Maintenance off before anything else, whatever a test did.
  test.afterEach(async ({ page, request }) => {
    await page.goto("about:blank").catch(() => undefined);
    const failures: string[] = [];
    const status = await request.get("/api/v1/maintenance/status", { headers });
    if (status.ok() && (await status.json()).maintenance) {
      const off = await request.post("/api/v1/maintenance/off", { headers });
      if (!off.ok()) failures.push(`maintenance off: ${off.status()}`);
    }
    await evaluations.cleanup(request, headers).catch((e: unknown) => failures.push(String(e)));
    for (const id of flows.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((e: unknown) => failures.push(String(e)));
    }
    await datasets.cleanup(request, headers).catch((e: unknown) => failures.push(String(e)));
    expect(failures, "teardown leaves nothing behind").toEqual([]);
  });

  async function versions(request: APIRequestContext, flowId: string): Promise<VersionEntry[]> {
    const res = await request.get(`/api/v1/flows/${flowId}/versions/`, { headers });
    expect(res.status(), `GET /api/v1/flows/${flowId}/versions/`).toBe(200);
    return (await res.json()).entries as VersionEntry[];
  }

  /** `DELETE` of a retained version: `409`, the reason in the detail, and still listed. */
  async function expectDeleteRefused(request: APIRequestContext, flowId: string, version: VersionEntry, reason: string) {
    const res = await request.delete(`/api/v1/flows/${flowId}/versions/${version.id}`, { headers });
    const raw = await res.text();
    expect(res.status(), `DELETE a retained version — ${raw.slice(0, 300)}`).toBe(409);
    expect(JSON.parse(raw).detail).toBe(`Version entry ${version.id} is retained and cannot be deleted. Reason: ${reason}.`);
    expect((await versions(request, flowId)).map((v) => v.id), "the retained version is still listed").toContain(version.id);
  }

  async function openHistory(page: Page, flowId: string): Promise<void> {
    await page.goto(`/flow/${flowId}`);
    const nav = page.getByTestId("sidebar-nav-versions");
    await expect(nav).toBeVisible({ timeout: 60_000 });
    await nav.click();
    await expect(page.getByRole("listitem").filter({ hasText: "Working version" })).toBeVisible();
  }

  /** The history row of one version, by its label ("v1 — Evaluation run"). */
  function row(page: Page, version: VersionEntry) {
    return page.getByRole("listitem").filter({ hasText: `${version.version_tag} — ${version.description}` });
  }

  /** Opens a version's menu and returns its Delete item. The rest of the page is inert while it is open. */
  async function openMenu(page: Page, version: VersionEntry) {
    await row(page, version).getByTitle("More options").click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    return { menu, deleteItem: menu.getByTestId("version-delete-item") };
  }

  /** Escape closes the tooltip first, then the menu: press until the menu is gone. */
  async function closeMenu(page: Page): Promise<void> {
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }

  /** The badge, its tooltip, and the Delete item disabled with the same reason on hover. */
  async function expectProtectedInHistory(page: Page, version: VersionEntry, reason: string): Promise<void> {
    const badge = row(page, version).getByTestId("version-protected-badge");
    await expect(badge).toHaveText("Protected");
    await badge.hover();
    await expect(page.getByRole("tooltip")).toHaveText(reason);

    const { menu, deleteItem } = await openMenu(page, version);
    await expect(deleteItem).toHaveText("Delete");
    await expect(deleteItem, "a retained version's Delete is disabled").toBeDisabled();
    // A disabled item ignores the pointer: the tooltip sits on its wrapper. The pointer
    // has to arrive from outside it for the tooltip to open, so it re-enters until it does.
    const wrapper = menu.locator("div:has(> [data-testid='version-delete-item'])");
    await expect(async () => {
      await menu.getByRole("menuitem", { name: "Export" }).hover();
      await wrapper.hover();
      await expect(page.getByRole("tooltip")).toHaveText(reason, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await closeMenu(page);
  }

  test(
    "an evaluation's version is Protected: the API refuses its delete, the history shows the badge and a disabled Delete, and a plain version still deletes",
    { tag: ["@stable", "@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      test.skip(evalsSkip !== null, evalsSkip ?? "");
      let retained!: VersionEntry;
      let plain!: VersionEntry;
      let flowId = "";

      await test.step("an evaluation run retains v1; a manual snapshot v2 is not retained", async () => {
        flowId = await createEchoFlow(request, headers, `E2E protected ${uid()}`, { catalog });
        flows.push(flowId);
        const dataset = await createDataset(request, headers, { name: `E2E protected ${uid()}` }, datasets);
        await addItems(request, headers, dataset.id, [{ input: "alpha", expected_output: "alpha" }]);
        const evaluation = await createEvaluation(
          request,
          headers,
          { flow_id: flowId, dataset_id: dataset.id, scorers: [{ type: "exact_match", name: "exact" }] },
          evaluations,
        );
        const run = await waitForRunEnd(request, headers, (await startRun(request, headers, evaluation.id)).id);
        expect(run.status).toBe("completed");
        const snap = await request.post(`/api/v1/flows/${flowId}/versions/`, {
          headers,
          data: { description: "E2E plain snapshot" },
        });
        expect(snap.status()).toBe(201);

        const list = await versions(request, flowId);
        retained = list.find((v) => v.version_number === 1)!;
        plain = list.find((v) => v.version_number === 2)!;
        expect(retained).toMatchObject({
          id: run.flow_version_id,
          version_tag: "v1",
          description: "Evaluation run",
          retained: true,
          retained_reason: "evaluation",
        });
        expect(plain).toMatchObject({ version_tag: "v2", description: "E2E plain snapshot", retained: false });
      });

      await test.step("the API refuses to delete the retained version", async () => {
        await expectDeleteRefused(request, flowId, retained, "evaluation");
      });

      await test.step("the history marks v1 Protected, with the reason and its Delete disabled", async () => {
        await openHistory(page, flowId);
        await expectProtectedInHistory(page, retained, EVALUATION_REASON);
      });

      await test.step("v2 has no badge and its Delete is enabled", async () => {
        await expect(row(page, plain).getByTestId("version-protected-badge")).toHaveCount(0);
        const { deleteItem } = await openMenu(page, plain);
        await expect(deleteItem).toBeEnabled();
        await closeMenu(page);
      });

      await test.step("deleting v2 from the history removes it; v1 stays", async () => {
        const { deleteItem } = await openMenu(page, plain);
        await deleteItem.click();
        await expect(page.getByText(`This will permanently delete ${plain.version_tag}.`)).toBeVisible();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(row(page, plain)).toHaveCount(0);
        await expect(row(page, retained)).toBeVisible();
        expect((await versions(request, flowId)).map((v) => v.id)).toEqual([retained.id]);
      });
    },
  );

  test(
    "an upgrade repair's recovery version is Protected with its own reason",
    { tag: ["@destructive", "@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      let flowId = "";
      let recovery!: VersionEntry;

      await test.step("apply a repair under maintenance: the recovery version is retained", async () => {
        const fixture = JSON.parse(readFileSync(OUTDATED_FIXTURE, "utf-8"));
        const safe = buildOutdatedSafeFlow(catalog, fixture.data);
        flowId = await createFlow(request, { name: `E2E protected repair ${uid()}`, data: safe.data }, { headers });
        flows.push(flowId);
        const previewRes = await request.post("/api/v1/upgrade-repairs/preview", { headers, data: { flow_ids: [flowId] } });
        expect(previewRes.status()).toBe(200);
        const preview = (await previewRes.json()) as {
          target_sha256: string;
          results: Array<{ flow_id: string; status: string; version_token: string; data_sha256: string }>;
        };
        const ready = preview.results.find((r) => r.flow_id === flowId)!;
        expect(ready.status, "the repair is ready").toBe("ready");

        const on = await request.post("/api/v1/maintenance/on", { headers, data: { reason: "E2E #2566 repair" } });
        expect(on.status(), "maintenance turns on").toBe(200);
        try {
          const apply = await request.post("/api/v1/upgrade-repairs/apply", {
            headers,
            data: {
              flows: [{ flow_id: flowId, version_token: ready.version_token, data_sha256: ready.data_sha256 }],
              target_sha256: preview.target_sha256,
            },
          });
          const raw = await apply.text();
          expect(apply.status(), raw.slice(0, 300)).toBe(200);
          const result = (JSON.parse(raw).results as Array<{ flow_id: string; status: string; recovery_version_id: string }>).find(
            (r) => r.flow_id === flowId,
          )!;
          expect(result.status).toBe("updated");
          const list = await versions(request, flowId);
          expect(list).toHaveLength(1);
          recovery = list[0];
          expect(recovery).toMatchObject({
            id: result.recovery_version_id,
            retained: true,
            retained_reason: "admin-upgrade-repair",
          });
        } finally {
          const off = await request.post("/api/v1/maintenance/off", { headers });
          expect(off.status(), "maintenance turns off").toBe(200);
        }
      });

      await test.step("the API refuses to delete it", async () => {
        await expectDeleteRefused(request, flowId, recovery, "admin-upgrade-repair");
      });

      await test.step("the history marks it Protected with the repair's reason", async () => {
        await openHistory(page, flowId);
        await expectProtectedInHistory(page, recovery, REPAIR_REASON);
      });
    },
  );
});
