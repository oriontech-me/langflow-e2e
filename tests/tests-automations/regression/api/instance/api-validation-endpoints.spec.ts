import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// The four hidden validation endpoints the UI leans on constantly.
// Spec doc: docs/api/instance/api-validation-endpoints.md
//
// The finding both validators share: they answer 200 for input they consider
// broken, with the verdict in the BODY — the same trap as
// POST /api/v1/models/validate-provider (#1709).
test.describe("Validation API — code, prompt and custom components", () => {
  let headers: Record<string, string> = {};

  const COMPONENT_CODE = [
    "from langflow.custom import Component",
    "from langflow.io import MessageTextInput, Output",
    "",
    "class Probe(Component):",
    "    display_name = 'Probe'",
    "    inputs = [MessageTextInput(name='probe_field', display_name='Probe Field')]",
    "    outputs = [Output(display_name='Out', name='out', method='build')]",
    "",
    "    def build(self):",
    "        return None",
    "",
  ].join("\n");

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
  });

  test(
    "code validation answers 200 for broken code, with the verdict in the body",
    { tag: ["@stable", "@api", "@components"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/validate/code"]);

      await test.step("valid code returns the two verdict objects", async () => {
        const res = await request.post("/api/v1/validate/code", {
          headers,
          data: { code: COMPONENT_CODE },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["function", "imports"]);
        expect(typeof body.function).toBe("object");
        expect(typeof body.imports).toBe("object");
      });

      await test.step("a syntax error is ALSO a 200 — the status is not the verdict", async () => {
        const res = await request.post("/api/v1/validate/code", {
          headers,
          data: { code: "def broken(:\n    pass\n" },
        });
        // 200, not 4xx: a status-only assertion here would report a compile error
        // as valid code.
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["function", "imports"]);
        expect(
          JSON.stringify(body.function).length,
          "the failure must be described inside `function`",
        ).toBeGreaterThan(2);
      });

      await test.step("a body without code is refused on the field", async () => {
        const res = await request.post("/api/v1/validate/code", { headers, data: {} });
        expect(res.status()).toBe(422);
        expect((await res.json()).detail[0].loc).toEqual(["body", "code"]);
      });
    },
  );

  test(
    "prompt validation extracts variables only when it is given a node",
    { tag: ["@stable", "@api", "@components"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/validate/prompt", "GET /api/v1/all"]);

      await test.step("without a frontend_node it short-circuits, template unparsed", async () => {
        const res = await request.post("/api/v1/validate/prompt", {
          headers,
          data: { name: "template", template: "Hello {who}" },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // NOT a parse failure — the documented path: no node, no work.
        expect(body.input_variables).toEqual([]);
        expect(body.frontend_node).toBeNull();
      });

      await test.step("with the real Prompt Template node it extracts the variable and adds the field", async () => {
        const catalog = await request.get("/api/v1/all", { headers });
        expect(catalog.status()).toBe(200);
        // The catalog is keyed by DISPLAY NAME: "Prompt Template", not "Prompt".
        const node = (await catalog.json()).models_and_agents?.["Prompt Template"];
        expect(node, "the Prompt Template node is missing from GET /api/v1/all").toBeTruthy();
        expect(Object.keys(node.template)).not.toContain("who");

        const res = await request.post("/api/v1/validate/prompt", {
          headers,
          data: {
            name: "template",
            template: "Hello {who}",
            frontend_node: node,
            custom_fields: {},
          },
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(body.input_variables).toEqual(["who"]);
        // This endpoint is what turns a template variable into a node input: the
        // returned template carries a field the submitted one did not have.
        expect(Object.keys(body.frontend_node.template)).toContain("who");
      });

      await test.step("a body without a template is refused", async () => {
        const res = await request.post("/api/v1/validate/prompt", {
          headers,
          data: { name: "template" },
        });
        expect(res.status()).toBe(422);
        expect((await res.json()).detail[0].loc).toEqual(["body", "template"]);
      });
    },
  );

  test(
    "a custom component is described, and a field update echoes the code back",
    { tag: ["@stable", "@api", "@components"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/custom_component",
        "POST /api/v1/custom_component/update",
      ]);

      await test.step("POST describes the component as a frontend node", async () => {
        const res = await request.post("/api/v1/custom_component", {
          headers,
          data: { code: COMPONENT_CODE, frontend_node: { template: {} } },
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["data", "type"]);
        // The declared input is in the derived template, which is the whole point
        // of the endpoint.
        expect(Object.keys(body.data.template)).toContain("probe_field");
        expect(body.data.display_name).toBe("Probe");
      });

      await test.step("update returns the template with the submitted code inside it", async () => {
        const res = await request.post("/api/v1/custom_component/update", {
          headers,
          data: {
            code: COMPONENT_CODE,
            field: "probe_field",
            field_value: "probe-value",
            template: {},
          },
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(body.template, "the update answers with a template").toBeTruthy();
        expect(body.template.code.value).toBe(COMPONENT_CODE);
      });
    },
  );
});
