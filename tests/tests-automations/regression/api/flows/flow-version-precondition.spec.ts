import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Multi-edit safety (upstream #14903 / #15824): a flow save is a conditional write
// keyed on `If-Match: <version_token>`. Spec doc: docs/api/flows/flow-version-precondition.md
//
// Only a GRAPH change claims the token, so every write here moves the viewport —
// a payload equal to the stored graph would not rotate it and the test would pass
// for the wrong reason.
test.describe("Flows API — save precondition (multi-edit safety)", () => {
  const CONFLICT_KEYS = [
    "code",
    "current_version_token",
    "expected_version_token",
    "flow_id",
    "message",
    "modified_at",
    "modified_by",
  ];

  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  function graph(n: number) {
    return { nodes: [], edges: [], viewport: { x: n, y: n, zoom: 1 } };
  }

  async function setup(request: APIRequestContext) {
    const authToken = await getAuthToken(request);
    const headers = { Authorization: authToken };
    const res = await request.post("/api/v1/flows/", {
      headers,
      data: {
        name: `flow-version-precondition ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        data: { nodes: [], edges: [] },
      },
    });
    expect(res.status()).toBe(201);
    const flow = (await res.json()) as { id: string; name: string };
    createdFlowIds.push(flow.id);
    return { headers, flowId: flow.id, flowName: flow.name };
  }

  async function versionState(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
  ) {
    const res = await request.get(`/api/v1/flows/${flowId}/version-state`, { headers });
    expect(res.status()).toBe(200);
    return (await res.json()) as {
      version_token: string;
      last_modified_by: string;
      last_modified_by_username: string;
      updated_at: string;
    };
  }

  async function storedData(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
  ) {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status()).toBe(200);
    return (await res.json()).data;
  }

  function patchGraph(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
    n: number,
    ifMatch?: string,
  ): Promise<APIResponse> {
    return request.patch(`/api/v1/flows/${flowId}`, {
      headers: ifMatch === undefined ? headers : { ...headers, "If-Match": ifMatch },
      data: { data: graph(n) },
    });
  }

  // Six: the count upstream's `claim_version_token` docstring records SQLite once accepting in full.
  const WRITERS = 6;

  async function race(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
  ) {
    const token = (await versionState(request, headers, flowId)).version_token;

    const responses = await test.step(
      `fire ${WRITERS} PATCHes in parallel with one token`,
      async () =>
        Promise.all(
          Array.from({ length: WRITERS }, (_, i) =>
            patchGraph(request, headers, flowId, 10 + i, token),
          ),
        ),
    );

    return { token, responses };
  }

  test(
    "a stale If-Match is refused with a structured 409 and nothing is written",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
        "GET /api/v1/users/whoami",
      ]);
      const { headers, flowId } = await setup(request);
      const me = await (await request.get("/api/v1/users/whoami", { headers })).json();
      const t0 = (await versionState(request, headers, flowId)).version_token;

      const t1 = await test.step("the first writer saves with T0 and wins", async () => {
        const res = await patchGraph(request, headers, flowId, 1, t0);
        expect(res.status()).toBe(200);
        const state = await versionState(request, headers, flowId);
        expect(state.version_token).not.toBe(t0);
        return state;
      });

      await test.step("the second writer, still holding T0, gets 409 flow_version_conflict", async () => {
        const res = await patchGraph(request, headers, flowId, 2, t0);
        expect(res.status()).toBe(409);
        const { detail } = await res.json();
        expect(Object.keys(detail).sort()).toEqual(CONFLICT_KEYS);
        expect(detail).toMatchObject({
          code: "flow_version_conflict",
          flow_id: flowId,
          expected_version_token: t0,
          current_version_token: t1.version_token,
        });
        expect(detail.message).toEqual(expect.any(String));
        expect(Object.keys(detail.modified_by).sort()).toEqual(["id", "username"]);
        expect(detail.modified_by).toEqual({
          id: t1.last_modified_by,
          username: t1.last_modified_by_username,
        });
        expect(detail.modified_by.username).toBe(me.username);
        expect(new Date(detail.modified_at).getTime()).toBe(
          new Date(t1.updated_at).getTime(),
        );
      });

      await test.step("the refused write left the row on the winner's graph and token", async () => {
        expect(await storedData(request, headers, flowId)).toEqual(graph(1));
        expect((await versionState(request, headers, flowId)).version_token).toBe(
          t1.version_token,
        );
      });
    },
  );

  test(
    "a current If-Match saves the graph and rotates the version token",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const { headers, flowId } = await setup(request);
      const t0 = (await versionState(request, headers, flowId)).version_token;

      await test.step("PATCH with the current token answers 200 with a new token", async () => {
        const res = await patchGraph(request, headers, flowId, 1, t0);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.version_token).toEqual(expect.any(String));
        expect(body.version_token).not.toBe(t0);
        expect((await versionState(request, headers, flowId)).version_token).toBe(
          body.version_token,
        );
        expect(await storedData(request, headers, flowId)).toEqual(graph(1));
      });
    },
  );

  test(
    "a malformed If-Match is refused with 400; quoted and weak forms are accepted",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const { headers, flowId } = await setup(request);
      const t0 = (await versionState(request, headers, flowId)).version_token;

      await test.step("If-Match: not-a-uuid answers 400 and writes nothing", async () => {
        const res = await patchGraph(request, headers, flowId, 1, "not-a-uuid");
        expect(res.status()).toBe(400);
        expect((await res.json()).detail).toBe(
          "Invalid If-Match header: expected a version token",
        );
        expect((await versionState(request, headers, flowId)).version_token).toBe(t0);
        expect(await storedData(request, headers, flowId)).toEqual({ nodes: [], edges: [] });
      });

      const t1 = await test.step('a quoted token ("…") is accepted and rotates', async () => {
        const res = await patchGraph(request, headers, flowId, 2, `"${t0}"`);
        expect(res.status()).toBe(200);
        const token = (await versionState(request, headers, flowId)).version_token;
        expect(token).not.toBe(t0);
        return token;
      });

      await test.step('a weak token (W/"…") is accepted and rotates', async () => {
        const res = await patchGraph(request, headers, flowId, 3, `W/"${t1}"`);
        expect(res.status()).toBe(200);
        expect((await versionState(request, headers, flowId)).version_token).not.toBe(t1);
        expect(await storedData(request, headers, flowId)).toEqual(graph(3));
      });
    },
  );

  test(
    "the precondition is optional: a PATCH without If-Match still saves",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const { headers, flowId } = await setup(request);
      const t0 = (await versionState(request, headers, flowId)).version_token;

      await test.step("PATCH with no If-Match answers 200, saves and rotates", async () => {
        const res = await patchGraph(request, headers, flowId, 1);
        expect(res.status()).toBe(200);
        expect(await storedData(request, headers, flowId)).toEqual(graph(1));
        expect((await versionState(request, headers, flowId)).version_token).not.toBe(t0);
      });
    },
  );

  test(
    "concurrent writers with the same token: exactly one wins, the rest get 409, none 5xx",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const { headers, flowId } = await setup(request);
      const { token, responses } = await race(request, headers, flowId);

      await test.step("exactly one 200, the rest 409 flow_version_conflict, no 5xx", async () => {
        const statuses = responses.map((r) => r.status());
        expect(statuses.filter((s) => s >= 500), `statuses: ${statuses}`).toEqual([]);
        expect(statuses.filter((s) => s === 200), `statuses: ${statuses}`).toHaveLength(1);
        expect(statuses.filter((s) => s === 409), `statuses: ${statuses}`).toHaveLength(
          WRITERS - 1,
        );
        for (const res of responses.filter((r) => r.status() === 409)) {
          expect((await res.json()).detail).toMatchObject({
            code: "flow_version_conflict",
            expected_version_token: token,
          });
        }
      });

      await test.step("the stored graph is the winner's payload", async () => {
        const winner = responses.findIndex((r) => r.status() === 200);
        expect(await storedData(request, headers, flowId)).toEqual(graph(10 + winner));
      });
    },
  );

  test(
    "concurrent losers are told the real current token",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      // Known product defect, measured 10/10 with two writers on 1.14.0.dev7: a
      // concurrent loser's 409 names a token the row never held, and the UI sends it
      // back as the overwrite If-Match. See "Known product defect" in the spec doc.
      // When this starts passing, the defect is fixed: drop test.fail().
      test.fail(true, "#2341: concurrent 409 reports a phantom current_version_token");
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/version-state",
        "PATCH /api/v1/flows/{flow_id}",
      ]);
      const { headers, flowId } = await setup(request);
      const { responses } = await race(request, headers, flowId);

      await test.step("every 409 names the token the row actually holds", async () => {
        const final = (await versionState(request, headers, flowId)).version_token;
        const losers = responses.filter((r) => r.status() === 409);
        expect(losers).toHaveLength(WRITERS - 1);
        const reported = await Promise.all(
          losers.map(async (r) => (await r.json()).detail.current_version_token),
        );
        expect(reported).toEqual(Array(WRITERS - 1).fill(final));
      });
    },
  );

  test(
    "fork copies inertly; overwrite is guarded and archives the replaced graph",
    { tag: ["@api", "@workspace", "@database"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}/version-state",
        "POST /api/v1/flows/{flow_id}/fork",
        "POST /api/v1/flows/{flow_id}/overwrite",
        "GET /api/v1/flows/{flow_id}/versions/",
        "GET /api/v1/flows/{flow_id}/versions/{version_id}",
      ]);
      const { headers, flowId, flowName } = await setup(request);
      expect((await patchGraph(request, headers, flowId, 1)).status()).toBe(200);
      const versionsUrl = `/api/v1/flows/${flowId}/versions/`;

      async function versionEntries() {
        const res = await request.get(versionsUrl, { headers });
        expect(res.status()).toBe(200);
        return (await res.json()).entries as Array<{ id: string; description: string | null }>;
      }

      await test.step("fork answers 201 with an inert copy and leaves the source untouched", async () => {
        const source = await (await request.get(`/api/v1/flows/${flowId}`, { headers })).json();
        const res = await request.post(`/api/v1/flows/${flowId}/fork`, {
          headers,
          data: { data: graph(42) },
        });
        expect(res.status()).toBe(201);
        const copy = await res.json();
        createdFlowIds.push(copy.id);
        expect(copy.id).not.toBe(flowId);
        expect(copy).toMatchObject({
          name: `${flowName} (copy)`,
          data: graph(42),
          endpoint_name: null,
          webhook: false,
          mcp_enabled: false,
          access_type: "PRIVATE",
        });

        const after = await (await request.get(`/api/v1/flows/${flowId}`, { headers })).json();
        expect({ name: after.name, data: after.data, version_token: after.version_token }).toEqual({
          name: source.name,
          data: source.data,
          version_token: source.version_token,
        });
      });

      await test.step("overwrite without If-Match answers 428 and archives nothing", async () => {
        const res = await request.post(`/api/v1/flows/${flowId}/overwrite`, {
          headers,
          data: { data: graph(98) },
        });
        expect(res.status()).toBe(428);
        expect(await versionEntries()).toHaveLength(0);
      });

      const reviewed = (await versionState(request, headers, flowId)).version_token;

      await test.step("overwrite with the reviewed token answers 200 and archives the replaced graph", async () => {
        const res = await request.post(`/api/v1/flows/${flowId}/overwrite`, {
          headers: { ...headers, "If-Match": reviewed },
          data: { data: graph(99) },
        });
        expect(res.status()).toBe(200);
        expect(await storedData(request, headers, flowId)).toEqual(graph(99));
        expect((await versionState(request, headers, flowId)).version_token).not.toBe(reviewed);

        const entries = await versionEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].description).toBe("Replaced by a newer edit");
        const archived = await request.get(`${versionsUrl}${entries[0].id}`, { headers });
        expect(archived.status()).toBe(200);
        expect((await archived.json()).data).toEqual(graph(1));
      });

      await test.step("overwrite with the now-stale token answers 409 and leaves no orphan version", async () => {
        const res = await request.post(`/api/v1/flows/${flowId}/overwrite`, {
          headers: { ...headers, "If-Match": reviewed },
          data: { data: graph(100) },
        });
        expect(res.status()).toBe(409);
        expect((await res.json()).detail.code).toBe("flow_version_conflict");
        expect(await versionEntries()).toHaveLength(1);
        expect(await storedData(request, headers, flowId)).toEqual(graph(99));
      });
    },
  );
});
