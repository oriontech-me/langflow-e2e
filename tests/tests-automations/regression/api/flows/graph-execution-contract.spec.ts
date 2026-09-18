import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { parseNdjson } from "../../../../helpers/other/parse-ndjson";
import {
  createCustomComponentGraphFlow,
  fetchComponentCatalog,
  type GraphFlow,
  type GraphSpec,
} from "../../../../helpers/flows/build-custom-component-graph";

// Validates the graph-execution engine's contract as it is observable over REST —
// POST /api/v1/build/{flow_id}/flow?event_delivery=direct (the NDJSON build
// stream) and POST /api/v2/workflows (mode=sync). Issue #1896;
// docs/api/flows/graph-execution-contract.md.
//
// Every node is a CustomComponent whose Python body fixes its behavior (echo,
// raise, stop), so the graph SHAPE is the only variable and no provider key is
// needed. The runs answer HTTP 200, so the deliberate component failures never
// reach the fixture's HTTP-error monitor; there is no page, so no
// allowFlowErrors() is needed.

const BUILD_OP = "POST /api/v1/build/{flow_id}/flow";
const WORKFLOWS_OP = "POST /api/v2/workflows";

interface EndVertex {
  id: string;
  valid: boolean;
  order: number;
  inactivated: string[];
  outputText: string;
}

/** The end_vertex records of a /build direct NDJSON stream, in finish order. */
function endVertices(body: string): EndVertex[] {
  const out: EndVertex[] = [];
  let order = 0;
  for (const event of parseNdjson(body)) {
    if (event.event !== "end_vertex") continue;
    const build = (event as { data?: { build_data?: Record<string, unknown> } }).data?.build_data;
    if (!build) continue;
    const outputs = ((build.data as { outputs?: Record<string, { message?: unknown }> })?.outputs) ?? {};
    let text = "";
    for (const value of Object.values(outputs)) {
      const message = value?.message;
      if (typeof message === "string") text = message;
      else if (message && typeof message === "object") {
        text = String((message as { errorMessage?: unknown; text?: unknown }).errorMessage ?? (message as { text?: unknown }).text ?? "");
      }
    }
    out.push({
      id: String(build.id),
      valid: Boolean(build.valid),
      order: order++,
      inactivated: ((build.inactivated_vertices as string[]) ?? []).map(String),
      outputText: text,
    });
  }
  return out;
}

function byId(vertices: EndVertex[], id: string): EndVertex | undefined {
  return vertices.find((v) => v.id === id);
}

test.describe("Graph execution contract — order, partial failure, skipped branches", () => {
  let bearerToken: string;
  let catalog: Record<string, unknown>;
  const created: GraphFlow[] = [];

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);
    catalog = await fetchComponentCatalog(request, { Authorization: bearerToken });
  });

  test.afterEach(async ({ request }) => {
    // Id-scoped cleanup: every flow a test created is deleted, on green and red
    // alike (flow-cleanup-always). afterEach owns its own `request`.
    while (created.length > 0) {
      const flow = created.pop()!;
      await flow.deleteFlow(request);
    }
  });

  async function makeFlow(request: APIRequestContext, name: string, spec: GraphSpec): Promise<string> {
    const flow = await createCustomComponentGraphFlow(request, catalog, spec, {
      name: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      headers: { Authorization: bearerToken },
    });
    created.push(flow);
    return flow.flowId;
  }

  async function buildDirect(request: APIRequestContext, flowId: string): Promise<EndVertex[]> {
    const res = await request.post(`/api/v1/build/${flowId}/flow?event_delivery=direct`, {
      headers: { Authorization: bearerToken },
      data: { inputs: { input_value: "in" } },
    });
    expect(res.status(), "the /build direct call answers 200").toBe(200);
    return endVertices(await res.text());
  }

  test(
    "execution order follows data dependency, and a consumer receives its producers' output",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([BUILD_OP]);

      // A chain (Root -> A1 -> A2 -> A3) and a diamond (Root -> L, Root -> M,
      // L,M -> Join). The delays make a scheduling regression observable.
      const spec: GraphSpec = {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "A1", kind: "echo", fields: ["incoming"], delayS: 0.4 },
          { id: "A2", kind: "echo", fields: ["incoming"] },
          { id: "A3", kind: "echo", fields: ["incoming"] },
          { id: "L", kind: "echo", fields: ["incoming"], delayS: 0.4 },
          { id: "M", kind: "echo", fields: ["incoming"] },
          { id: "Join", kind: "echo", fields: ["left", "right"] },
        ],
        edges: [
          { source: "Root", target: "A1", field: "incoming" },
          { source: "A1", target: "A2", field: "incoming" },
          { source: "A2", target: "A3", field: "incoming" },
          { source: "Root", target: "L", field: "incoming" },
          { source: "Root", target: "M", field: "incoming" },
          { source: "L", target: "Join", field: "left" },
          { source: "M", target: "Join", field: "right" },
        ],
      };
      const flowId = await makeFlow(request, "gxc-order", spec);

      const vertices = await buildDirect(request, flowId);

      await test.step("every consumer finishes after all of its producers", () => {
        const pos = (id: string) => {
          const v = byId(vertices, id);
          expect(v, `${id} built`).toBeDefined();
          return v!.order;
        };
        const dependencies: Array<[string, string]> = [
          ["Root", "A1"], ["A1", "A2"], ["A2", "A3"],
          ["Root", "L"], ["Root", "M"], ["L", "Join"], ["M", "Join"],
        ];
        for (const [producer, consumer] of dependencies) {
          expect(pos(producer), `${producer} finishes before ${consumer}`).toBeLessThan(pos(consumer));
        }
      });

      await test.step("the join receives every upstream producer's output", () => {
        const join = byId(vertices, "Join")!;
        for (const tag of ["Root", "L", "M", "Join"]) {
          expect(join.outputText, `Join output carries ${tag}`).toContain(tag);
        }
        const a3 = byId(vertices, "A3")!;
        expect(a3.outputText).toBe("Root|A1|A2|A3");
      });
    },
  );

  test(
    "a component failure is contained: independent branches still build, the failed node is flagged",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([BUILD_OP]);

      // Root -> X(raise) -> X2 ; Root -> S(slow) -> T. The healthy branch is
      // slower than the failure, so "it finished after the failure" is the case.
      const spec: GraphSpec = {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "X", kind: "raise", fields: ["incoming"] },
          { id: "X2", kind: "echo", fields: ["incoming"] },
          { id: "S", kind: "echo", fields: ["incoming"], delayS: 0.5 },
          { id: "T", kind: "echo", fields: ["incoming"] },
        ],
        edges: [
          { source: "Root", target: "X", field: "incoming" },
          { source: "X", target: "X2", field: "incoming" },
          { source: "Root", target: "S", field: "incoming" },
          { source: "S", target: "T", field: "incoming" },
        ],
      };
      const flowId = await makeFlow(request, "gxc-partial", spec);

      const vertices = await buildDirect(request, flowId);

      await test.step("the independent branch builds to completion after the failure", () => {
        expect(byId(vertices, "S")?.valid, "S built valid").toBe(true);
        expect(byId(vertices, "T")?.valid, "T built valid").toBe(true);
      });

      await test.step("the failed node is flagged and its descendant never builds", () => {
        const x = byId(vertices, "X");
        expect(x, "X built (and failed)").toBeDefined();
        expect(x!.valid, "X is invalid").toBe(false);
        expect(x!.outputText, "X carries its error").toContain("boom-X");
        expect(byId(vertices, "X2"), "X2 never builds — it depends on X").toBeUndefined();
      });
    },
  );

  test(
    "a branch stopped by Component.stop() never builds and is reported inactive",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([BUILD_OP]);

      // Root -> Stopper(stop) -> D1 -> D2 ; Root -> K. The stop inactivates the
      // D-branch; K is the live sibling.
      const spec: GraphSpec = {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Stopper", kind: "stop", fields: ["incoming"] },
          { id: "D1", kind: "echo", fields: ["incoming"] },
          { id: "D2", kind: "echo", fields: ["incoming"] },
          { id: "K", kind: "echo", fields: ["incoming"] },
        ],
        edges: [
          { source: "Root", target: "Stopper", field: "incoming" },
          { source: "Stopper", target: "D1", field: "incoming" },
          { source: "D1", target: "D2", field: "incoming" },
          { source: "Root", target: "K", field: "incoming" },
        ],
      };
      const flowId = await makeFlow(request, "gxc-stop", spec);

      const vertices = await buildDirect(request, flowId);

      await test.step("the stopped branch never builds", () => {
        expect(byId(vertices, "D1"), "D1 never builds").toBeUndefined();
        expect(byId(vertices, "D2"), "D2 never builds").toBeUndefined();
      });

      await test.step("the stopped downstream is reported in inactivated_vertices", () => {
        const inactivated = new Set(vertices.flatMap((v) => v.inactivated));
        expect(inactivated.has("D1"), "D1 reported inactive").toBe(true);
      });

      await test.step("the sibling branch still builds", () => {
        expect(byId(vertices, "K")?.valid, "K built valid").toBe(true);
      });
    },
  );

  test(
    "sync reports an acyclic terminal as completed with its output (attribution control)",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([WORKFLOWS_OP]);

      // The acyclic equivalent of the declared-failing cycle test: a linear
      // Root -> Mid -> Leaf. Proves the harness reads a completed terminal, so a
      // red cycle test is the defect, not this machinery.
      const spec: GraphSpec = {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Mid", kind: "echo", fields: ["incoming"] },
          { id: "Leaf", kind: "echo", fields: ["incoming"] },
        ],
        edges: [
          { source: "Root", target: "Mid", field: "incoming" },
          { source: "Mid", target: "Leaf", field: "incoming" },
        ],
      };
      const flowId = await makeFlow(request, "gxc-acyclic", spec);

      const res = await request.post("/api/v2/workflows", {
        headers: { Authorization: bearerToken },
        data: { flow_id: flowId, mode: "sync", input_value: "in" },
      });
      expect(res.status(), "sync answers 200").toBe(200);
      const body = await res.json();
      const outputs = (body?.outputs ?? {}) as Record<string, { status?: unknown }>;

      expect(body?.status, "the run completed").toBe("completed");
      expect(body?.errors ?? [], "no errors").toEqual([]);
      expect(Object.keys(outputs), "Leaf, the terminal, is reported").toContain("Leaf");
      expect(outputs.Leaf?.status, "Leaf reported completed").toBe("completed");
    },
  );

  test(
    "sync must not report a node downstream of a regular-port cycle as completed",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request, apiCoverage }) => {
      // DECLARED FAILING (#1896). A graph with a cycle through regular (non-loop)
      // ports runs to status "completed" and lists Sink — the node downstream of
      // the cycle, which never builds — in outputs as completed. Root is the
      // external root and no node id matches the "webhook"/"chat" start heuristic,
      // so the cycle never runs and the call returns fast (the pure-cycle runaway
      // is out of scope, see the doc). The assertion below is the CORRECT contract;
      // it fails today, and test.fail() expects that. The day upstream fixes it,
      // this reports "expected to fail, but passed" — then delete test.fail() and
      // this comment, keep @stable, flip the QA-CHECKLIST §12.6 bullet, close #1896.
      test.fail();
      apiCoverage.declare([WORKFLOWS_OP]);

      const spec: GraphSpec = {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Alpha", kind: "echo", fields: ["incoming", "loopback"] },
          { id: "Beta", kind: "echo", fields: ["incoming"] },
          { id: "Sink", kind: "echo", fields: ["incoming"] },
        ],
        edges: [
          { source: "Root", target: "Alpha", field: "incoming" },
          { source: "Alpha", target: "Beta", field: "incoming" },
          { source: "Beta", target: "Alpha", field: "loopback" },
          { source: "Beta", target: "Sink", field: "incoming" },
        ],
      };
      const flowId = await makeFlow(request, "gxc-cycle", spec);

      const res = await request.post("/api/v2/workflows", {
        headers: { Authorization: bearerToken },
        data: { flow_id: flowId, mode: "sync", input_value: "in" },
      });
      expect(res.status(), "sync answers 200").toBe(200);
      const body = await res.json();
      const outputs = (body?.outputs ?? {}) as Record<string, unknown>;

      // Sink is downstream of the never-run cycle, so it never built — the
      // engine must not report it in outputs as a completed node.
      expect(Object.keys(outputs), "Sink never built and must not be reported completed").not.toContain("Sink");
    },
  );
});
