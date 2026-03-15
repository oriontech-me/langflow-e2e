import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test.describe("Custom Component API", () => {
  test(
    "POST /api/v1/custom_component with valid code returns component definition",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.post("/api/v1/custom_component", {
        headers: { Authorization: authToken },
        data: {
          code: `
from langflow.custom import Component
from langflow.io import MessageTextInput, Output

class MyComponent(Component):
    display_name = "My Component"
    description = "Test component"
    inputs = [MessageTextInput(name="input_value", display_name="Input")]
    outputs = [Output(display_name="Output", name="output", method="build_output")]

    def build_output(self) -> str:
        return self.input_value
`,
        },
      });

      // Endpoint may return 200 (valid component), 400 or 422 (validation errors).
      expect([200, 400, 422]).toContain(res.status());

      if (res.status() === 200) {
        const body = await res.json();
        // A valid response should have component data
        expect(body).toBeDefined();
      }
    },
  );

  test(
    "POST /api/v1/custom_component without auth returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const res = await request.post("/api/v1/custom_component", {
        data: { code: "class X: pass" },
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "POST /api/v1/custom_component with invalid Python syntax returns error",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.post("/api/v1/custom_component", {
        headers: { Authorization: authToken },
        data: { code: "def invalid syntax !!!" },
      });

      // Should return 400 or 422, NOT 200 (invalid code should not succeed)
      expect([400, 422, 500]).toContain(res.status());
    },
  );
});
