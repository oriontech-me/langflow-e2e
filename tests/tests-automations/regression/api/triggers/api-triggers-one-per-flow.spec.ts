import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  buildCatalogFlow,
  type CatalogFlowData,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// One trigger per flow, on every route that writes a graph (#2450).
// Spec doc: docs/api/triggers/api-triggers-one-per-flow.md
//
// From 1.14 the rule lives in the flow model itself: `FlowCreate` and `FlowUpdate`
// run `validate_single_trigger_per_flow` over `data`, so a second trigger is refused
// by create, update, put, fork and overwrite alike, and an import carrying one bad
// flow writes none of them. Every refusal below is asserted by the rule's exact
// message and the `loc` its route produces — a 422 for any other reason (a malformed
// body, a missing precondition) carries neither, so it cannot pass for the rule.
//
// The canvas half of the same rule (palette, paste, duplicate) is
// `core-functionality/integrations/trigger-placement.spec.ts`, which also pins the
// one way past the rule this image has: a trigger inside a group (LE-3453).
test.describe("Triggers — one trigger per flow on every write path", () => {
  // First tag carrying upstream #16120. The 1.13.x patch lines validated on demand
  // do not carry the rule, so a refusal there would be a false red.
  const RULE_SINCE = "1.14.0.dev18";
  const RULE = "A flow can have only one trigger. Remove the extra triggers and try again.";

  const SCHEDULE = "ScheduleTrigger-one01";
  const SECOND_SCHEDULE = "ScheduleTrigger-two02";
  const WEBHOOK = "InboundWebhookTrigger-two01";
  const CHAT_OUTPUT = "ChatOutput-none01";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowName = (label: string) => `E2E one-trigger ${label} ${run}`;

  interface Graphs {
    one: CatalogFlowData;
    two: CatalogFlowData;
    twoSchedules: CatalogFlowData;
    none: CatalogFlowData;
  }

  interface TriggerRead {
    id: string;
    kind: string;
    node_id: string | null;
    state: string;
  }

  // Ids this test created, and names a request was expected to create or — for a
  // refusal — expected NOT to create. The names are swept in the teardown, so a
  // refusal that wrongly wrote something is still cleaned up after its assertion
  // has failed. Every name carries the per-run suffix, so the sweep is id-scoped in
  // effect.
  const createdFlowIds: string[] = [];
  const sweepFlowNames: string[] = [];
  const sweepProjectNames: string[] = [];

  /** `generate_unique_flow_name` / `generate_unique_folder_name` suffix a taken name with ` (n)`. */
  const named = (rowName: string, name: string) => rowName === name || rowName.startsWith(`${name} (`);

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, RULE_SINCE)),
      `one trigger per flow ships in ${RULE_SINCE} (upstream #16120); this build does not carry the rule`,
    );
  });

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    const flowIds = new Set(createdFlowIds);
    const projectIds = new Set<string>();
    if (sweepProjectNames.length > 0) {
      const res = await request.get("/api/v1/projects/", { headers });
      if (res.ok()) {
        for (const row of (await res.json()) as Array<{ id: string; name: string }>) {
          if (!sweepProjectNames.some((name) => named(row.name, name))) continue;
          projectIds.add(row.id);
          const read = await request.get(`/api/v1/projects/${row.id}`, { headers });
          if (!read.ok()) continue;
          for (const flow of ((await read.json()).flows ?? []) as Array<{ id: string }>) flowIds.add(flow.id);
        }
      }
    }
    if (sweepFlowNames.length > 0) {
      for (const row of await listFlows(request, headers)) {
        if (sweepFlowNames.some((name) => named(row.name, name))) flowIds.add(row.id);
      }
    }
    for (const id of flowIds) {
      await deleteFlow(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    for (const id of projectIds) {
      await deleteProject(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
    sweepFlowNames.length = 0;
    sweepProjectNames.length = 0;
  });

  async function authHeaders(request: APIRequestContext): Promise<Record<string, string>> {
    return { Authorization: await getAuthToken(request) };
  }

  /** The four graphs, built from the running image's own catalog. */
  async function graphs(request: APIRequestContext, headers: Record<string, string>): Promise<Graphs> {
    const catalog = await fetchComponentCatalog(request, headers);
    const build = (nodes: Array<{ id: string; type: string }>) => buildCatalogFlow(catalog, { nodes, edges: [] });
    return {
      one: build([{ id: SCHEDULE, type: "ScheduleTrigger" }]),
      two: build([
        { id: SCHEDULE, type: "ScheduleTrigger" },
        { id: WEBHOOK, type: "InboundWebhookTrigger" },
      ]),
      twoSchedules: build([
        { id: SCHEDULE, type: "ScheduleTrigger" },
        { id: SECOND_SCHEDULE, type: "ScheduleTrigger" },
      ]),
      none: build([{ id: CHAT_OUTPUT, type: "ChatOutput" }]),
    };
  }

  async function listFlows(
    request: APIRequestContext,
    headers: Record<string, string>,
  ): Promise<Array<{ id: string; name: string }>> {
    const res = await request.get("/api/v1/flows/?remove_example_flows=true&header_flows=true", { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as Array<{ id: string; name: string }>;
  }

  /** Which of `names` exist as flows right now, exactly or with a uniqueness suffix. */
  async function flowsNamed(
    request: APIRequestContext,
    headers: Record<string, string>,
    names: string[],
  ): Promise<string[]> {
    const rows = await listFlows(request, headers);
    return names.filter((name) => rows.some((row) => named(row.name, name)));
  }

  async function triggersOf(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
  ): Promise<TriggerRead[]> {
    const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead[];
  }

  async function createFlow(
    request: APIRequestContext,
    headers: Record<string, string>,
    name: string,
    data: CatalogFlowData,
  ): Promise<string> {
    const res = await request.post("/api/v1/flows/", { headers, data: { name, data, is_component: false } });
    const text = await res.text();
    expect(res.status(), `POST /flows/ "${name}": ${text}`).toBe(201);
    const id = (JSON.parse(text) as { id: string }).id;
    createdFlowIds.push(id);
    return id;
  }

  /**
   * The refusal is the rule's and nothing else's: `422`, a non-empty `detail`, and
   * every entry the rule's own entry with the route's `loc`. `prefixed` is the
   * request-validation handler's shape (`"Value error, "` in front); the routes that
   * parse the body themselves strip it (`api/v1/flow_validation.py`). No entry count
   * is asserted: `POST /flows/` validates `FlowCreate` twice and lists the entry twice.
   */
  async function expectRuleRefusal(
    res: APIResponse,
    what: string,
    loc: Array<string | number>,
    prefixed: boolean,
  ): Promise<void> {
    const text = await res.text();
    // An accepted write answers the whole flow back; the head of it is enough to read.
    const head = text.slice(0, 600);
    expect(res.status(), `${what} is refused by the one-trigger rule: ${head}`).toBe(422);
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
    expect(Array.isArray(detail) && detail.length > 0, `${what}: "detail" is a non-empty list: ${head}`).toBe(true);
    for (const entry of detail as Array<Record<string, unknown>>) {
      expect(entry, `${what}: every detail entry is the rule's`).toMatchObject({
        loc,
        msg: prefixed ? `Value error, ${RULE}` : RULE,
      });
    }
  }

  /** A JSON file part for the two multipart import routes. */
  const jsonFile = (name: string, body: unknown) => ({
    file: { name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(body)) },
  });

  test(
    "a single-flow write that carries a second trigger is refused, and changes nothing",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}",
        "PATCH /api/v1/flows/{flow_id}",
        "PUT /api/v1/flows/{flow_id}",
        "POST /api/v1/flows/{flow_id}/fork",
        "POST /api/v1/flows/{flow_id}/overwrite",
        "GET /api/v1/flows/{flow_id}/version-state",
        "GET /api/v1/triggers",
      ]);
      const headers = await authHeaders(request);
      const g = await graphs(request, headers);

      await test.step("create refuses a second trigger of either kind, and leaves no flow behind", async () => {
        const refused: string[] = [];
        for (const [label, data] of [
          ["schedule and webhook", g.two],
          ["two schedules", g.twoSchedules],
        ] as const) {
          const name = flowName(`refused ${label}`);
          refused.push(name);
          sweepFlowNames.push(name);
          const res = await request.post("/api/v1/flows/", { headers, data: { name, data, is_component: false } });
          await expectRuleRefusal(res, `POST /flows/ with ${label}`, ["body", "data"], true);
        }
        expect(await flowsNamed(request, headers, refused), "no refused create left a flow").toEqual([]);
      });

      const originalName = flowName("one");

      const flowId = await test.step("control: one trigger is created, with one trigger row on its node", async () => {
        return createFlow(request, headers, originalName, g.one);
      });

      const baseline = await test.step("the one-trigger flow has a single schedule row on the node", async () => {
        const rows = await triggersOf(request, headers, flowId);
        expect(rows, JSON.stringify(rows)).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "schedule", node_id: SCHEDULE });
        return rows[0];
      });

      /** A refused update must leave the stored graph, the name and the trigger row as they were. */
      const expectUnchanged = async (after: string) => {
        const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const flow = JSON.parse(text) as { name: string; data: { nodes: Array<{ id: string }> } };
        expect(flow.name, `after ${after}, the flow keeps its name`).toBe(originalName);
        expect(
          flow.data.nodes.map((node) => node.id),
          `after ${after}, the stored graph still holds its one node`,
        ).toEqual([SCHEDULE]);
        const rows = await triggersOf(request, headers, flowId);
        expect(rows, `after ${after}, the trigger row is untouched: ${JSON.stringify(rows)}`).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: baseline.id, state: baseline.state, node_id: SCHEDULE });
      };

      await test.step("PATCH with a second trigger is refused and changes nothing", async () => {
        const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data: { data: g.two } });
        await expectRuleRefusal(res, "PATCH /flows/{id}", ["body", "data"], true);
        await expectUnchanged("the refused PATCH");
      });

      await test.step("PUT with a second trigger is refused and changes nothing", async () => {
        const res = await request.put(`/api/v1/flows/${flowId}`, {
          headers,
          data: { name: flowName("put"), data: g.two },
        });
        await expectRuleRefusal(res, "PUT /flows/{id}", ["body", "data"], true);
        await expectUnchanged("the refused PUT");
      });

      await test.step("overwrite with a current If-Match and a second trigger is refused, and the version token stays", async () => {
        const versionToken = async () => {
          const res = await request.get(`/api/v1/flows/${flowId}/version-state`, { headers });
          const text = await res.text();
          expect(res.status(), text).toBe(200);
          const token = (JSON.parse(text) as { version_token?: unknown }).version_token;
          expect(typeof token === "string" && token.length > 0, `version-state carries a token: ${text}`).toBe(true);
          return token as string;
        };
        const before = await versionToken();
        // Without If-Match the route answers 428 before it reads the graph, so the
        // current token is what makes the 422 the rule's.
        const res = await request.post(`/api/v1/flows/${flowId}/overwrite`, {
          headers: { ...headers, "If-Match": before },
          data: { data: g.two },
        });
        await expectRuleRefusal(res, "POST /flows/{id}/overwrite", ["data"], false);
        expect(await versionToken(), "a refused overwrite does not move the version token").toBe(before);
        await expectUnchanged("the refused overwrite");
      });

      await test.step("fork with a second trigger is refused and creates no flow; the same fork without it is created", async () => {
        const refusedName = flowName("fork refused");
        sweepFlowNames.push(refusedName);
        const refused = await request.post(`/api/v1/flows/${flowId}/fork`, {
          headers,
          data: { name: refusedName, data: g.two },
        });
        await expectRuleRefusal(refused, "POST /flows/{id}/fork", ["data"], false);
        expect(await flowsNamed(request, headers, [refusedName]), "the refused fork left no flow").toEqual([]);

        const forkName = flowName("fork");
        sweepFlowNames.push(forkName);
        const res = await request.post(`/api/v1/flows/${flowId}/fork`, { headers, data: { name: forkName } });
        const text = await res.text();
        expect(res.status(), `the control fork is created: ${text}`).toBe(201);
        createdFlowIds.push((JSON.parse(text) as { id: string }).id);
      });
    },
  );

  test(
    "an import that carries one bad flow creates none of the flows in it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/batch/",
        "POST /api/v1/flows/upload/",
        "POST /api/v1/projects/upload/",
        "GET /api/v1/flows/",
        "GET /api/v1/projects/",
      ]);
      const headers = await authHeaders(request);
      const g = await graphs(request, headers);

      await test.step("batch create of [one trigger, two triggers] is refused at index 1 and creates neither", async () => {
        const names = [flowName("batch ok"), flowName("batch bad")];
        sweepFlowNames.push(...names);
        const res = await request.post("/api/v1/flows/batch/", {
          headers,
          data: { flows: [{ name: names[0], data: g.one }, { name: names[1], data: g.two }] },
        });
        await expectRuleRefusal(res, "POST /flows/batch/", ["body", "flows", 1, "data"], true);
        expect(await flowsNamed(request, headers, names), "the refused batch created no flow").toEqual([]);
      });

      await test.step("control: batch create of [one trigger, no trigger] creates both", async () => {
        const names = [flowName("batch one"), flowName("batch none")];
        sweepFlowNames.push(...names);
        const res = await request.post("/api/v1/flows/batch/", {
          headers,
          data: { flows: [{ name: names[0], data: g.one }, { name: names[1], data: g.none }] },
        });
        const text = await res.text();
        expect(res.status(), `the control batch is created: ${text}`).toBe(201);
        expect(await flowsNamed(request, headers, names), "the control batch created both flows").toEqual(names);
      });

      await test.step("flow upload of [one trigger, two triggers] is refused at index 1 and creates neither", async () => {
        const names = [flowName("upload ok"), flowName("upload bad")];
        sweepFlowNames.push(...names);
        const res = await request.post("/api/v1/flows/upload/", {
          headers,
          multipart: jsonFile("flows.json", {
            flows: [
              { name: names[0], data: g.one, is_component: false },
              { name: names[1], data: g.two, is_component: false },
            ],
          }),
        });
        await expectRuleRefusal(res, "POST /flows/upload/", ["flows", 1, "data"], false);
        expect(await flowsNamed(request, headers, names), "the refused upload created no flow").toEqual([]);
      });

      await test.step("project upload of [one trigger, two triggers] is refused at index 1 and creates no project and no flow", async () => {
        // Short: a project derives an MCP server name from its first 26 characters,
        // which must be unique per user (#1409).
        const projectName = `t2450-${run}`;
        sweepProjectNames.push(projectName);
        const names = [flowName("project ok"), flowName("project bad")];
        sweepFlowNames.push(...names);
        const res = await request.post("/api/v1/projects/upload/", {
          headers,
          multipart: jsonFile("project.json", {
            folder_name: projectName,
            folder_description: "",
            flows: [
              { name: names[0], data: g.one, is_component: false },
              { name: names[1], data: g.two, is_component: false },
            ],
          }),
        });
        await expectRuleRefusal(res, "POST /projects/upload/", ["flows", 1, "data"], false);

        const projects = await request.get("/api/v1/projects/", { headers });
        const text = await projects.text();
        expect(projects.status(), text).toBe(200);
        const rows = JSON.parse(text) as Array<{ name: string }>;
        expect(
          rows.filter((row) => named(row.name, projectName)).map((row) => row.name),
          "the refused project upload created no project",
        ).toEqual([]);
        expect(await flowsNamed(request, headers, names), "the refused project upload created no flow").toEqual([]);
      });
    },
  );

  test(
    "one trigger and no trigger are accepted, and an edit without data still saves",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const headers = await authHeaders(request);
      const g = await graphs(request, headers);

      await test.step("a flow with no trigger is created and has no trigger row", async () => {
        const id = await createFlow(request, headers, flowName("none"), g.none);
        expect(await triggersOf(request, headers, id)).toEqual([]);
      });

      await test.step("a description-only PATCH on a one-trigger flow saves", async () => {
        const id = await createFlow(request, headers, flowName("meta"), g.one);
        const description = `description only ${run}`;
        const res = await request.patch(`/api/v1/flows/${id}`, { headers, data: { description } });
        const text = await res.text();
        expect(res.status(), `a PATCH without data is not the rule's business: ${text}`).toBe(200);
        const read = await request.get(`/api/v1/flows/${id}`, { headers });
        expect(read.status()).toBe(200);
        expect(((await read.json()) as { description: string }).description).toBe(description);
      });
    },
  );
});
