import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createThrowawayUser,
  deleteThrowawayUser,
  type ThrowawayUser,
} from "../../../../helpers/auth/throwaway-user";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  describePolicyState,
  isPolicyPristine,
  readCatalogTypes,
  readPolicyBundle,
  restorePolicy,
  snapshotPolicy,
  type PolicySnapshot,
} from "../../../../helpers/governance/policy-state";

// Catalog policy — usage reports the blast radius of a block (QA-CHECKLIST §21.4).
// Spec doc: docs/governance/catalog-policy/usage-blast-radius.md
//
// The policy is instance-global, so this file is @destructive: excluded from every
// normal run by playwright.config.ts, run alone under PW_DESTRUCTIVE=1 at
// workers=1. Serial because the three tests share one set of flows (created in
// beforeAll) and the policy; each test still reaches its assertions when run
// alone, which is what lets each one be force-failed on its own.
test.describe.configure({ mode: "serial" });

// Core `data_source`, neither legacy nor beta, used by no starter project and by
// no other spec — so the blocked window cannot break anyone else's fixture.
const TARGET = "MockDataGenerator";
// The Python class name: an index-only alias the report must fold into TARGET.
const TARGET_ALIAS = "MockDataGeneratorComponent";
const CONTROL_TYPE = "ChatInput";
const USAGE = "/api/v1/catalog-policy/usage";
const USAGE_FLOWS = "/api/v1/catalog-policy/usage/flows";
// Upstream serves both usage endpoints from one flow scan cached for
// USAGE_SCAN_CACHE_TTL_SECONDS = 30; a write may take that long to show. The
// bound is the contract plus margin — a report that never converges still fails.
const REPORT_CONVERGENCE_MS = 45_000;
// The endpoint's own maximum, so the baseline is never silently truncated.
const USAGE_FLOWS_MAX_LIMIT = 500;

type FlowKey = "single" | "double" | "alias" | "control" | "foreign";

interface SpecFlow {
  key: FlowKey;
  id: string;
  /** Whether any of its nodes resolves to TARGET — i.e. the block must refuse it. */
  usesTarget: boolean;
  /** The flow's owner — only the owner can read or save it. */
  owner: "superuser" | "foreign";
}

interface UsageFlowsResponse {
  component: string;
  total: number;
  flows: Array<{ id: string; name: string }>;
}

interface UsageResponse {
  components: Record<string, number>;
  flows_scanned: number;
}

/** A saveable flow whose nodes carry the given stored component keys, in order. */
function flowWithNodes(name: string, types: string[]) {
  return {
    name,
    description: "Created by the catalog-policy usage spec",
    data: {
      nodes: types.map((type, index) => {
        const id = `${type}-${index}`;
        return {
          id,
          type: "genericNode",
          position: { x: index * 300, y: 0 },
          data: { id, type, node: { display_name: type, template: {} } },
        };
      }),
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
}

async function readUsageFlows(
  request: APIRequestContext,
  auth: string,
  component: string,
  limit = USAGE_FLOWS_MAX_LIMIT,
): Promise<UsageFlowsResponse> {
  const response = await request.get(USAGE_FLOWS, {
    headers: { Authorization: auth },
    params: { component, limit },
  });
  expect(response.status(), `GET ${USAGE_FLOWS}?component=${component}`).toBe(200);
  const body = (await response.json()) as UsageFlowsResponse;
  expect(body.component).toBe(component);
  return body;
}

async function readUsage(request: APIRequestContext, auth: string): Promise<UsageResponse> {
  const response = await request.get(USAGE, { headers: { Authorization: auth } });
  expect(response.status(), `GET ${USAGE}`).toBe(200);
  return (await response.json()) as UsageResponse;
}

const sortedIds = (body: UsageFlowsResponse) => body.flows.map((flow) => flow.id).sort();

test.describe("governance — catalog-policy usage reports the blast radius of a block", () => {
  let token: string;
  let snapshot: PolicySnapshot;
  let pristine = false;
  let skipReason = "";
  let foreignUser: ThrowawayUser | null = null;
  const flows: SpecFlow[] = [];
  // An UPPER BOUND on what else the report may name, never an exact expectation:
  // it is served from the up-to-30 s scan cache, so it can still carry flows
  // deleted since — measured on a back-to-back re-run, whose baseline held the
  // previous run's four deleted flows.
  let baselineIds: string[] = [];

  const flowsUsingTarget = () => flows.filter((flow) => flow.usesTarget);

  const ownerContext = (flow: SpecFlow, request: APIRequestContext) =>
    flow.owner === "foreign"
      ? { ctx: foreignUser!.request, headers: foreignUser!.headers }
      : { ctx: request, headers: { Authorization: token } };

  /**
   * Re-save a flow as its owner with its own stored data — what the editor's save
   * sends. Returns the status and body of the PATCH.
   */
  async function resave(request: APIRequestContext, flow: SpecFlow) {
    const { ctx, headers } = ownerContext(flow, request);
    const read = await ctx.get(`/api/v1/flows/${flow.id}`, { headers });
    expect(read.status(), `owner GET of ${flow.key}`).toBe(200);
    const { data } = (await read.json()) as { data: unknown };
    const response = await ctx.patch(`/api/v1/flows/${flow.id}`, {
      headers,
      data: { data },
    });
    return { status: response.status(), body: await response.text() };
  }

  /**
   * The report once it has caught up with the setup's writes: every flow the spec
   * saved with the target, and nothing outside baseline ∪ those. Bounded by the
   * upstream scan-cache TTL plus margin; a report that never gets there fails
   * here, printing what it was missing and what it named that it should not.
   */
  async function convergedReport(request: APIRequestContext): Promise<UsageFlowsResponse> {
    const expectedIds = flowsUsingTarget().map((flow) => flow.id);
    const allowed = new Set([...baselineIds, ...expectedIds]);
    let last: UsageFlowsResponse | null = null;
    await expect
      .poll(
        async () => {
          last = await readUsageFlows(request, token, TARGET);
          const ids = sortedIds(last);
          return {
            missing: expectedIds.filter((id) => !ids.includes(id)),
            unexpected: ids.filter((id) => !allowed.has(id)),
          };
        },
        {
          timeout: REPORT_CONVERGENCE_MS,
          intervals: [1_000],
          message: `usage/flows?component=${TARGET} never named single, double, alias and foreign with nothing outside the baseline`,
        },
      )
      .toEqual({ missing: [], unexpected: [] });
    return last!;
  }

  test.beforeAll(async ({ request, playwright }, testInfo) => {
    token = await getAuthToken(request);
    const bundle = await readPolicyBundle(request, token);
    pristine = isPolicyPristine(bundle);
    skipReason = `instance already carries a catalog policy (${describePolicyState(bundle)}) — "refused only once blocked" would be unfalsifiable`;
    if (!pristine) return;
    snapshot = await snapshotPolicy(request, token);

    // Without it the queries would resolve an unknown key to itself and prove nothing.
    expect((await readCatalogTypes(request, token)).has(TARGET), `${TARGET} in /api/v1/all`).toBe(true);

    const baseline = await readUsageFlows(request, token, TARGET);
    expect(baseline.total).toBe(baseline.flows.length);
    baselineIds = sortedIds(baseline);

    // Directly, twice, by alias, as another user — and one flow that does not use it.
    const stamp = Date.now();
    const superHeaders = { headers: { Authorization: token } };
    const own: Array<[FlowKey, string[], boolean]> = [
      ["single", [TARGET], true],
      ["double", [TARGET, TARGET, CONTROL_TYPE], true],
      ["alias", [TARGET_ALIAS], true],
      ["control", [CONTROL_TYPE], false],
    ];
    for (const [key, types, usesTarget] of own) {
      const id = await createFlow(request, flowWithNodes(`gov-usage-${key}-${stamp}`, types), superHeaders);
      flows.push({ key, id, usesTarget, owner: "superuser" });
    }

    await createThrowawayUser(request, {
      superHeaders: { Authorization: token },
      newContext: () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      prefix: "govusage",
      track: (user) => {
        foreignUser = user;
      },
    });
    const foreignId = await createFlow(
      foreignUser!.request,
      flowWithNodes(`gov-usage-foreign-${stamp}`, [TARGET]),
      { headers: foreignUser!.headers },
    );
    flows.push({ key: "foreign", id: foreignId, usesTarget: true, owner: "foreign" });
  });

  test.afterAll(async ({ request }) => {
    // Safety net, not the assertion: the last test restores and verifies. This
    // runs so an early failure cannot leave the shared instance with the target
    // blocked for the rest of the lane.
    if (pristine) {
      await restorePolicy(request, token, snapshot);
    }
    for (const flow of flows) {
      const { ctx, headers } = ownerContext(flow, request);
      await deleteFlow(ctx, flow.id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${flow.key} ${flow.id}): ${error}`);
      });
    }
    flows.length = 0;
    if (foreignUser) {
      await deleteThrowawayUser(request, { Authorization: token }, foreignUser);
      foreignUser = null;
    }
  });

  test(
    "the usage report names exactly the flows that use the component, across owners and aliases",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([`GET ${USAGE}`, `GET ${USAGE_FLOWS}`]);

      let reportedIds: string[] = [];

      await test.step("usage/flows converges on exactly the flows that use it", async () => {
        const report = await convergedReport(request);
        reportedIds = sortedIds(report);
        const control = flows.find((flow) => flow.key === "control")!;
        expect(reportedIds).not.toContain(control.id);
        expect(report.total).toBe(report.flows.length);
      });

      await test.step("usage counts each flow once and folds the alias into the canonical key", async () => {
        const usage = await readUsage(request, token);
        // One per flow `usage/flows` named from the same scan — `double`, which
        // carries the component on two nodes, would otherwise make it one more.
        expect(usage.components[TARGET]).toBe(reportedIds.length);
        expect(usage.components).not.toHaveProperty(TARGET_ALIAS);
      });

      await test.step("querying by the alias returns the same set", async () => {
        expect(sortedIds(await readUsageFlows(request, token, TARGET_ALIAS))).toEqual(reportedIds);
      });

      await test.step("limit truncates the list, never the total", async () => {
        const truncated = await readUsageFlows(request, token, TARGET, 1);
        expect(truncated.flows).toHaveLength(1);
        expect(truncated.total).toBe(reportedIds.length);
      });

      await test.step("a regular user cannot read the report", async () => {
        // It names every user's flows, so reading it is an admin act.
        const response = await foreignUser!.request.get(USAGE, { headers: foreignUser!.headers });
        expect(response.status()).toBe(403);
      });
    },
  );

  test(
    "blocking the component refuses exactly the flows the report named",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare([
        "PUT /api/v1/catalog-policy/components",
        `GET ${USAGE_FLOWS}`,
        "PATCH /api/v1/flows/{flow_id}",
      ]);

      let reportedIds: string[] = [];

      await test.step("the report names the flows that use it before anything is blocked", async () => {
        reportedIds = sortedIds(await convergedReport(request));
      });

      await test.step("the policy write is accepted and echoed", async () => {
        const put = await request.put("/api/v1/catalog-policy/components", {
          headers: { Authorization: token },
          data: { blocked: [TARGET] },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).blocked).toContain(TARGET);
      });

      await test.step("the report still names the same flows once the block is applied", async () => {
        expect(sortedIds(await readUsageFlows(request, token, TARGET))).toEqual(reportedIds);
      });

      await test.step("re-saving each flow as its owner is refused exactly where the report said", async () => {
        const results: Array<{ flow: SpecFlow; status: number; body: string }> = [];
        for (const flow of flows) {
          results.push({ flow, ...(await resave(request, flow)) });
        }
        // A 500 is a failure, not an equivalent refusal: the block is a policy
        // decision the API is expected to make cleanly.
        expect(Object.fromEntries(results.map(({ flow, status }) => [flow.key, status]))).toEqual({
          single: 400,
          double: 400,
          alias: 400,
          control: 200,
          foreign: 400,
        });

        const refused = results.filter(({ status }) => status === 400);
        // A refusal must be the policy's and say so — naming the canonical key even
        // for the node stored under the alias.
        for (const { flow, body } of refused) {
          expect(body, `refusal of ${flow.key}`).toContain(TARGET);
        }
        const specIds = new Set(flows.map((flow) => flow.id));
        expect(refused.map(({ flow }) => flow.id).sort()).toEqual(
          reportedIds.filter((id) => specIds.has(id)),
        );
      });

      await test.step("every refused flow is still readable by its owner", async () => {
        for (const flow of flowsUsingTarget()) {
          const { ctx, headers } = ownerContext(flow, request);
          const read = await ctx.get(`/api/v1/flows/${flow.id}`, { headers });
          expect(read.status(), `owner GET of ${flow.key}`).toBe(200);
        }
      });
    },
  );

  test(
    "clearing the policy lifts the refusal on the same flows",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request, apiCoverage }) => {
      test.skip(!pristine, skipReason);
      apiCoverage.declare(["PUT /api/v1/catalog-policy/components", "PATCH /api/v1/flows/{flow_id}"]);

      const single = flows.find((flow) => flow.key === "single")!;

      await test.step("the block is in force", async () => {
        // Idempotent after the previous test; what makes this one runnable alone.
        // Without a refusal here, a lifted refusal below would prove nothing.
        const put = await request.put("/api/v1/catalog-policy/components", {
          headers: { Authorization: token },
          data: { blocked: [TARGET] },
        });
        expect(put.status()).toBe(200);
        expect((await resave(request, single)).status).toBe(400);
      });

      await test.step("the snapshot is restored", async () => {
        // An assertion, not a teardown convenience: a failed restore leaves the
        // shared instance with the target blocked for the rest of the lane.
        await restorePolicy(request, token, snapshot);
        const bundle = await readPolicyBundle(request, token);
        expect(bundle.blocked_component_keys ?? []).toEqual(snapshot.blockedComponents);
      });

      await test.step("every flow the block refused saves again", async () => {
        const outcomes: Array<[FlowKey, number]> = [];
        for (const flow of flowsUsingTarget()) {
          outcomes.push([flow.key, (await resave(request, flow)).status]);
        }
        expect(Object.fromEntries(outcomes)).toEqual({
          single: 200,
          double: 200,
          alias: 200,
          foreign: 200,
        });
      });
    },
  );
});
