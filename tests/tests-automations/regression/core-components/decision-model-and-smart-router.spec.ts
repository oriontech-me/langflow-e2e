import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  type CatalogComponent,
  createCatalogFlow,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

/**
 * Decision Model and Smart Router's decision mode (#2571) — Langflow 1.14's decision models
 * (upstream #15861, #16330, #16122): a typed question answered by a provider's decision
 * endpoint, with the distribution and confidence kept as evidence. Neither component had a
 * spec in either mode.
 *
 * Tests 1–3 call no model. Tests 4–7 call OpenAI's decision endpoint with `gpt-6-luna` and
 * assert the outcome's identity on unambiguous inputs, never wording or an exact probability
 * (#1187). Test 7 also needs tracing on.
 *
 * Contract and measurements: docs/core-components/decision-model-and-smart-router.md.
 */

type Template = Record<string, { value?: unknown; show?: boolean; model_type?: string; [key: string]: unknown }>;
type Output = { name: string; [key: string]: unknown };
type RunBody = {
  status: string;
  errors: Array<{ error: string }>;
  outputs: Record<string, { content: unknown; status: string }>;
};
type DecisionResult = {
  kind: string;
  provider: string;
  model: string;
  status: string;
  probability_true?: number;
  selected_option?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  request_id?: string;
};

const DECISION_MODEL = [{ name: "gpt-6-luna", provider: "OpenAI" }];
const QUESTION = "Which team should handle this message?";
const CANDIDATES = [
  { id: "billing", label: "Billing", description: "Charges, invoices, refunds, payments" },
  { id: "technical", label: "Technical", description: "Crashes, errors, bugs, outages" },
];
const BILLING_MESSAGE = "I was charged twice for my subscription this month, please refund the last payment.";
const CRASH_MESSAGE = "The app crashes with error 500 every time I open settings.";
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Which of `fields` the template shows. */
const shown = (template: Template, fields: string[]) =>
  Object.fromEntries(fields.map((field) => [field, template[field]?.show === true]));

/**
 * Applies field changes the way the editor does: the new value is written into the template
 * first, then the template and outputs the update endpoint returns are adopted. The adopted
 * template is what a flow must carry — a field with `show: false` is not passed to the
 * component at build (`lfx/graph/vertex/param_handler.py`).
 */
async function applyChanges(
  request: APIRequestContext,
  headers: Record<string, string>,
  component: CatalogComponent,
  changes: Array<[string, unknown]>,
): Promise<{ template: Template; outputs: Output[] }> {
  let template = JSON.parse(JSON.stringify(component.template)) as Template;
  let outputs = component.outputs as Output[];
  for (const [field, value] of changes) {
    template[field].value = value;
    const res = await request.post("/api/v1/custom_component/update", {
      headers,
      data: { code: template.code.value, field, field_value: value, template },
    });
    expect(res.status(), `custom_component/update ${field}=${JSON.stringify(value)}`).toBe(200);
    const body = (await res.json()) as { template: Template; outputs?: Output[] };
    template = body.template;
    outputs = body.outputs ?? outputs;
  }
  return { template, outputs };
}

/** Runs a saved flow synchronously through the v2 workflow API. */
async function runSync(request: APIRequestContext, headers: Record<string, string>, flowId: string, input: string) {
  const res = await request.post("/api/v2/workflows", {
    headers,
    data: { flow_id: flowId, input_value: input, mode: "sync" },
    timeout: 120_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as RunBody;
}

/** The Decision Model's JSON result as a Chat Output renders it (a ```json fence). */
function decisionResult(body: RunBody, chatOutputId: string): DecisionResult {
  const content = String(body.outputs[chatOutputId]?.content ?? "");
  const json = /```json\s*([\s\S]*?)```/.exec(content)?.[1] ?? content;
  return JSON.parse(json) as DecisionResult;
}

test.describe("Decision Model and Smart Router's decision mode", () => {
  // In order, in one worker: the decision model's on/off setting is per user, every worker
  // shares the superuser, and one test switching it off while another runs would refuse
  // that run. "default" (not "serial") so one failure does not skip the rest.
  test.describe.configure({ mode: "default" });

  let headers: Record<string, string>;
  let catalog: Record<string, unknown>;
  let flows: string[];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    catalog = await fetchComponentCatalog(request, headers);
  });

  test.beforeEach(() => {
    flows = [];
  });

  test.afterEach(async ({ request }) => {
    for (const id of flows.splice(0)) await deleteFlow(request, id, { headers });
  });

  async function track(promise: Promise<string>) {
    const id = await promise;
    flows.push(id);
    return id;
  }

  /** ChatInput → Decision Model (Choice or Boolean) → Chat Output. */
  function decisionFlow(request: APIRequestContext, values: Record<string, unknown>, input?: string) {
    return track(
      createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            { id: "ChatInput-in", type: "ChatInput", values: input === undefined ? {} : { input_value: input } },
            { id: "DecisionModel-d", type: "DecisionModel", values: { model: DECISION_MODEL, ...values } },
            { id: "ChatOutput-o", type: "ChatOutput" },
          ],
          edges: [
            { source: "ChatInput-in", output: "message", target: "DecisionModel-d", field: "context" },
            { source: "DecisionModel-d", output: "result", target: "ChatOutput-o", field: "input_value" },
          ],
        },
        { name: `decision-${uid()}`, headers },
      ),
    );
  }

  /** Reads whether gpt-6-luna is switched on for this user, and returns a setter for it. */
  async function decisionModelSetting(request: APIRequestContext) {
    const read = await request.get("/api/v1/models/enabled_models", { headers });
    expect(read.status()).toBe(200);
    const wasOn = Boolean((await read.json()).enabled_models?.OpenAI?.["gpt-6-luna"]);
    const set = async (enabled: boolean) => {
      const res = await request.post("/api/v1/models/enabled_models", {
        headers,
        data: [{ provider: "OpenAI", model_id: "gpt-6-luna", enabled }],
        timeout: 90_000,
      });
      expect(res.status(), await res.text()).toBe(200);
    };
    return { wasOn, set };
  }

  /**
   * Runs `body` with gpt-6-luna switched on, then switches it back off unless it was on.
   * A switched-off model is refused at build, and the editor clears a never-toggled one;
   * "never toggled" itself cannot be restored (the stored sets are internal variables the
   * API does not list), and ending on "off" reads the same `false` derived flag.
   */
  async function withDecisionModelOn(request: APIRequestContext, body: () => Promise<void>) {
    const setting = await decisionModelSetting(request);
    await setting.set(true);
    try {
      await body();
    } finally {
      if (!setting.wasOn) await setting.set(false);
    }
  }

  async function openFlow(page: Page, flowId: string) {
    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("publish-button")).toBeVisible({ timeout: 60_000 });
  }

  test("Smart Router's routing mode swaps the language model for the decision fields, per decision type", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ request }) => {
    const router = findCatalogComponent(catalog, "SmartRouter");
    const fields = [
      "model",
      "decision_model",
      "decision_kind",
      "decision_question",
      "minimum_probability",
      "routes",
      "score_levels",
      "yes_message",
      "no_message",
    ];
    const names = (outputs: Output[]) => outputs.map((output) => output.name);

    await test.step("Decision Model mode hides the language model and shows the decision fields (Choice)", async () => {
      const { template, outputs } = await applyChanges(request, headers, router, [["routing_mode", "Decision Model"]]);
      expect(shown(template, fields)).toEqual({
        model: false,
        decision_model: true,
        decision_kind: true,
        decision_question: true,
        minimum_probability: true,
        routes: true,
        score_levels: false,
        yes_message: false,
        no_message: false,
      });
      expect(names(outputs)).toEqual(["category_1_result", "category_2_result", "default_result"]);
    });

    await test.step("Boolean trades the routes for yes/no outputs", async () => {
      const { template, outputs } = await applyChanges(request, headers, router, [
        ["routing_mode", "Decision Model"],
        ["decision_kind", "Boolean"],
      ]);
      expect(shown(template, ["routes", "yes_message", "no_message", "decision_model"])).toEqual({
        routes: false,
        yes_message: true,
        no_message: true,
        decision_model: true,
      });
      expect(names(outputs)).toEqual(["yes_result", "no_result", "default_result"]);
    });

    await test.step("Score trades them for levels", async () => {
      const { template, outputs } = await applyChanges(request, headers, router, [
        ["routing_mode", "Decision Model"],
        ["decision_kind", "Score"],
      ]);
      expect(shown(template, ["routes", "score_levels", "minimum_probability"])).toEqual({
        routes: false,
        score_levels: true,
        minimum_probability: false,
      });
      expect(names(outputs)).toEqual(["level_1_result", "level_2_result", "level_3_result", "default_result"]);
    });

    await test.step("back to Language Model restores the default", async () => {
      const { template } = await applyChanges(request, headers, router, [
        ["routing_mode", "Decision Model"],
        ["routing_mode", "Language Model"],
      ]);
      expect(shown(template, ["model", "decision_model", "decision_kind", "decision_question"])).toEqual({
        model: true,
        decision_model: false,
        decision_kind: false,
        decision_question: false,
      });
    });
  });

  test("Decision Model's type decides which fields show", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ request }) => {
    const decision = findCatalogComponent(catalog, "DecisionModel");
    const fields = ["candidates", "yes_description", "no_description"];

    await test.step("Boolean hides the options and shows what yes and no mean", async () => {
      const { template } = await applyChanges(request, headers, decision, [["kind", "Boolean"]]);
      expect(shown(template, fields)).toEqual({ candidates: false, yes_description: true, no_description: true });
    });

    await test.step("Score and Choice show the options and hide the yes/no descriptions", async () => {
      for (const kind of ["Score", "Choice"]) {
        const { template } = await applyChanges(request, headers, decision, [
          ["kind", "Boolean"],
          ["kind", kind],
        ]);
        expect(shown(template, fields), kind).toEqual({
          candidates: true,
          yes_description: false,
          no_description: false,
        });
      }
    });
  });

  test("decision models form their own catalog, and incomplete or switched-off decisions are refused", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ request }) => {
    await test.step("the decision catalog lists decision models only, gpt-6-luna among them", async () => {
      const res = await request.get("/api/v1/models", { headers, params: { model_type: "decision" } });
      expect(res.status()).toBe(200);
      const providers = (await res.json()) as Array<{
        provider: string;
        models: Array<{ model_name: string; metadata: { model_type: string; capabilities?: string[] } }>;
      }>;
      const models = providers.flatMap((p) => p.models.map((m) => ({ provider: p.provider, ...m })));
      expect(models.length).toBeGreaterThan(0);
      expect(new Set(models.map((m) => m.metadata.model_type))).toEqual(new Set(["decision"]));
      const luna = models.find((m) => m.provider === "OpenAI" && m.model_name === "gpt-6-luna");
      expect(luna?.metadata.capabilities?.sort()).toEqual(["boolean", "choice", "score"]);
    });

    await test.step("the components type their model fields apart", async () => {
      expect(findCatalogComponent(catalog, "DecisionModel").template.model.model_type).toBe("decision");
      const router = findCatalogComponent(catalog, "SmartRouter").template;
      expect(router.decision_model.model_type).toBe("decision");
      expect(router.model.model_type).toBe("language");
    });

    const router = findCatalogComponent(catalog, "SmartRouter");
    const decisionValues = { decision_model: DECISION_MODEL, decision_question: QUESTION };

    await test.step("decision mode with the Else output off is refused before any call", async () => {
      const { template, outputs } = await applyChanges(request, headers, router, [["routing_mode", "Decision Model"]]);
      for (const [field, value] of Object.entries(decisionValues)) template[field].value = value;
      const flowId = await track(
        createCatalogFlow(
          request,
          catalog,
          {
            nodes: [
              { id: "ChatInput-in", type: "ChatInput" },
              {
                id: "SmartRouter-r",
                type: "SmartRouter",
                configure: (c) => {
                  c.template = template as never;
                  c.outputs = outputs as never;
                },
              },
            ],
            edges: [{ source: "ChatInput-in", output: "message", target: "SmartRouter-r", field: "input_text" }],
          },
          { name: `decision-refusal-else-${uid()}`, headers },
        ),
      );
      const body = await runSync(request, headers, flowId, BILLING_MESSAGE);
      expect(body.status).toBe("failed");
      expect(body.errors[0]?.error).toContain(
        "Decision Model mode needs Include Else Output on and its Else output connected.",
      );
    });

    await test.step("with the Else on but no minimum probability, it is refused too", async () => {
      const { template, outputs } = await applyChanges(request, headers, router, [
        ["routing_mode", "Decision Model"],
        ["enable_else_output", true],
      ]);
      for (const [field, value] of Object.entries(decisionValues)) template[field].value = value;
      const flowId = await track(
        createCatalogFlow(
          request,
          catalog,
          {
            nodes: [
              { id: "ChatInput-in", type: "ChatInput" },
              {
                id: "SmartRouter-r",
                type: "SmartRouter",
                configure: (c) => {
                  c.template = template as never;
                  c.outputs = outputs as never;
                },
              },
              { id: "ChatOutput-else", type: "ChatOutput" },
            ],
            edges: [
              { source: "ChatInput-in", output: "message", target: "SmartRouter-r", field: "input_text" },
              { source: "SmartRouter-r", output: "default_result", target: "ChatOutput-else", field: "input_value" },
            ],
          },
          { name: `decision-refusal-probability-${uid()}`, headers },
        ),
      );
      const body = await runSync(request, headers, flowId, BILLING_MESSAGE);
      expect(body.status).toBe("failed");
      expect(body.errors[0]?.error).toContain("Enter a Minimum Probability from 0 to 1, such as 0.7.");
    });

    await test.step("a switched-off decision model is refused at build, naming Model Providers", async () => {
      // Switching off validates nothing against the provider, so this needs no key.
      const setting = await decisionModelSetting(request);
      await setting.set(false);
      try {
        const flowId = await decisionFlow(request, { kind: "Boolean", question: "Is this about billing?" });
        const body = await runSync(request, headers, flowId, BILLING_MESSAGE);
        expect(body.status).toBe("failed");
        expect(body.errors[0]?.error).toContain(
          "gpt-6-luna is switched off in Model Providers. Turn it on there, or pick another Decision Model.",
        );
      } finally {
        if (setting.wasOn) await setting.set(true);
      }
    });
  });

  test("Decision Model answers a Boolean and a Choice question with structured evidence", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ request }) => {
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    await withDecisionModelOn(request, async () => {
      await test.step("Boolean: a billing message is billing", async () => {
        const flowId = await decisionFlow(request, {
          kind: "Boolean",
          question: "Is this message about billing or payments?",
        });
        const body = await runSync(request, headers, flowId, BILLING_MESSAGE);
        expect(body.status, JSON.stringify(body.errors)).toBe("completed");
        const result = decisionResult(body, "ChatOutput-o");
        expect(result).toMatchObject({ kind: "boolean", provider: "OpenAI", model: "gpt-6-luna", status: "success" });
        expect(result.probability_true).toBeGreaterThan(0.5);
      });

      await test.step("Choice: a crash is for the technical team, scored over the declared options only", async () => {
        const flowId = await decisionFlow(request, { kind: "Choice", question: QUESTION, candidates: CANDIDATES });
        const body = await runSync(request, headers, flowId, CRASH_MESSAGE);
        expect(body.status, JSON.stringify(body.errors)).toBe("completed");
        const result = decisionResult(body, "ChatOutput-o");
        expect(result).toMatchObject({
          kind: "choice",
          provider: "OpenAI",
          status: "success",
          selected_option: "technical",
        });
        expect(Object.keys(result.probabilities ?? {}).sort()).toEqual(["billing", "technical"]);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  test("Smart Router in decision mode fires the chosen route and leaves the others empty", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ request }) => {
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);
    const router = findCatalogComponent(catalog, "SmartRouter");
    const { template, outputs } = await applyChanges(request, headers, router, [
      ["routing_mode", "Decision Model"],
      ["enable_else_output", true],
    ]);
    const values: Record<string, unknown> = {
      decision_model: DECISION_MODEL,
      decision_question: QUESTION,
      minimum_probability: 0.5,
      routes: [
        { route_category: "Billing", route_description: CANDIDATES[0].description, output_value: "ROUTED-BILLING" },
        { route_category: "Technical", route_description: CANDIDATES[1].description, output_value: "ROUTED-TECHNICAL" },
      ],
    };
    for (const [field, value] of Object.entries(values)) template[field].value = value;

    const flowId = await track(
      createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            { id: "ChatInput-in", type: "ChatInput" },
            {
              id: "SmartRouter-r",
              type: "SmartRouter",
              configure: (c) => {
                c.template = template as never;
                c.outputs = outputs as never;
              },
            },
            { id: "ChatOutput-billing", type: "ChatOutput" },
            { id: "ChatOutput-technical", type: "ChatOutput" },
            { id: "ChatOutput-else", type: "ChatOutput" },
          ],
          edges: [
            { source: "ChatInput-in", output: "message", target: "SmartRouter-r", field: "input_text" },
            { source: "SmartRouter-r", output: "category_1_result", target: "ChatOutput-billing", field: "input_value" },
            { source: "SmartRouter-r", output: "category_2_result", target: "ChatOutput-technical", field: "input_value" },
            { source: "SmartRouter-r", output: "default_result", target: "ChatOutput-else", field: "input_value" },
          ],
        },
        { name: `decision-router-${uid()}`, headers },
      ),
    );

    await withDecisionModelOn(request, async () => {
      const body = await runSync(request, headers, flowId, BILLING_MESSAGE);
      expect(body.status, JSON.stringify(body.errors)).toBe("completed");
      expect(body.outputs["ChatOutput-billing"]?.content).toBe("ROUTED-BILLING");
      expect(body.outputs["ChatOutput-technical"]?.content ?? null).toBeNull();
      expect(body.outputs["ChatOutput-else"]?.content ?? null).toBeNull();
    });
  });

  test("the output inspection shows the decision evidence", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ page, request }) => {
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    await withDecisionModelOn(request, async () => {
      const flowId = await decisionFlow(request, { kind: "Choice", question: QUESTION, candidates: CANDIDATES }, CRASH_MESSAGE);

      await test.step("run the Decision Model node on the canvas", async () => {
        await openFlow(page, flowId);
        await page.getByTestId("button_run_decision model").click();
        await expect(page.getByTestId("output-inspection-decision result-decisionmodel")).toBeEnabled({
          timeout: 90_000,
        });
      });

      await test.step("the inspection names the pick among the declared options, and the model", async () => {
        await page.getByTestId("output-inspection-decision result-decisionmodel").click();
        const inspection = page.getByTestId("decision-inspection");
        await expect(inspection).toBeVisible({ timeout: 30_000 });
        await expect(inspection.getByTestId("decision-row-technical")).toContainText("Provider's pick");
        await expect(inspection.getByTestId("decision-row-billing")).toBeVisible();
        await expect(inspection.getByTestId("decision-row-billing")).not.toContainText("Provider's pick");
        await expect(inspection.getByTestId("decision-model")).toContainText("OpenAI · gpt-6-luna");
        await expect(inspection.getByTestId("decision-type")).toContainText("Choice");
        await expect(inspection.getByTestId("decision-question")).toContainText(QUESTION);
      });
    });
  });

  test("the trace records the decision, and the trace view renders it", {
    tag: ["@stable", "@components", "@model-provider"],
  }, async ({ page, request }) => {
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    await withDecisionModelOn(request, async () => {
      const flowId = await decisionFlow(request, { kind: "Choice", question: QUESTION, candidates: CANDIDATES });
      let traceId = "";
      let spanId = "";
      let requestId = "";

      await test.step("the run's trace holds a Decision Model span carrying the decision", async () => {
        const body = await runSync(request, headers, flowId, CRASH_MESSAGE);
        expect(body.status, JSON.stringify(body.errors)).toBe("completed");
        let traces: Array<{ id: string }> = [];
        for (let i = 0; i < 20 && traces.length === 0; i++) {
          const res = await request.get("/api/v1/monitor/traces", { headers, params: { flow_id: flowId } });
          expect(res.status()).toBe(200);
          traces = (await res.json()).traces;
          if (traces.length === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(
          traces.length,
          "no trace was recorded for the run — an instance started with LANGFLOW_DEACTIVATE_TRACING=true " +
            "writes none at all; run this test against one with tracing on",
        ).toBeGreaterThan(0);
        traceId = traces[0].id;

        const detail = await request.get(`/api/v1/monitor/traces/${traceId}`, { headers });
        expect(detail.status()).toBe(200);
        const spans = (await detail.json()).spans as Array<{
          id: string;
          name: string;
          outputs: { result?: { data?: DecisionResult } };
        }>;
        const span = spans.find((s) => s.name === "Decision Model");
        expect(span, `spans: ${spans.map((s) => s.name).join(", ")}`).toBeTruthy();
        const result = span!.outputs.result?.data;
        expect(result).toMatchObject({ kind: "choice", status: "success", selected_option: "technical" });
        expect(Object.keys(result?.probabilities ?? {}).sort()).toEqual(["billing", "technical"]);
        expect(typeof result?.request_id).toBe("string");
        spanId = span!.id;
        requestId = result!.request_id!;
      });

      await test.step("the trace view renders the same decision for that span", async () => {
        await openFlow(page, flowId);
        await page.getByTestId("sidebar-nav-traces").click();
        await page.getByRole("row").filter({ hasText: traceId }).click();
        await expect(page.getByTestId("trace-detail-view")).toBeVisible({ timeout: 30_000 });
        await page.getByTestId(`span-node-${spanId}`).click();
        const inspection = page.getByTestId("span-detail").getByTestId("decision-inspection");
        await expect(inspection).toBeVisible({ timeout: 30_000 });
        await expect(inspection.getByTestId("decision-row-technical")).toContainText("Provider's pick");
        await expect(inspection.getByTestId("decision-request-id")).toContainText(requestId);
      });
    });
  });
});
