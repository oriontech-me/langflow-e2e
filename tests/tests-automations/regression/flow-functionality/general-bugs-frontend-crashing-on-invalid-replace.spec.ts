import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addCustomComponent } from "../../../helpers/flows/add-custom-component";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";

// Regression guard for upstream langflow-ai/langflow#10110: a `replacement` entry
// whose CATEGORY does not exist used to throw inside the Legacy banner's catalog
// lookup (`data[category][component]`) and crash the canvas. The fix reads
// `data[category]?.[component]` and falls back to "No direct replacement." when no
// entry resolves. See
// docs/flow-functionality/general-bugs-frontend-crashing-on-invalid-replace.md.
//
// All three entries below are unresolvable on purpose, and two of them through the
// missing-category branch: measured on 1.13.0.dev16, `GET /api/v1/all` has no
// `knowledgebases` category (the knowledge components live under
// `files_and_knowledge`). Pointing an entry at a component that exists turns the
// fallback into "Use <display name>." — which is exactly what this test must see
// fail, not a reason to loosen it.
const UNRESOLVABLE_REPLACEMENT_CODE = `
# from lfx.field_typing import Data
from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.data import Data


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Use as a template to create your own component."
    documentation: str = "https://docs.langflow.org/components-custom-components"
    icon = "code"
    name = "CustomComponent"
    replacement = ["knowledgebases.KnowledgeRetrieval", "knowledgebases.KnowledgeIngestion", "THISISNOTEXISTING.COMPONENT"]  # This line was causing the crash
    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Input Value",
            info="This is a custom component Input",
            value="Hello, World!",
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Data:
        data = Data(value=self.input_value)
        self.status = data
        return data

    `;

// The one flow this file creates, deleted id-scoped in afterEach. The inherited
// version went through `awaitBootstrapTest` + `blank-flow` and deleted nothing:
// 3 flows leaked per run on an empty project (#1907).
let createdFlow: { id: string; bearer: string } | undefined;

test.afterEach(async ({ page, request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit this binding.
  const flow = createdFlow;
  createdFlow = undefined;
  if (!flow) return;
  // Leave the editor first: an editor mounted over a deleted flow keeps polling
  // `GET /flows/{id}/events` and 404s into the backend-error log (#1288).
  await unmountEditorForCleanup(page);
  await deleteFlow(request, flow.id, {
    headers: { Authorization: flow.bearer },
  }).catch((error: unknown) => {
    console.warn(
      `general-bugs-frontend-crashing-on-invalid-replace: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

test(
  "user must be able to use a component with undefined replacement",
  { tag: ["@stable", "@release", "@regression", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const node = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Custom Component") });

    await test.step("Open a blank flow created over the API", async () => {
      const bearer = await getAuthToken(request);
      const id = await createFlow(
        request,
        {
          name: `Invalid Replacement ${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 7)}`,
          description: "",
          data: { nodes: [], edges: [] },
          is_component: false,
        },
        { headers: { Authorization: bearer } },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
    });

    await test.step("Add a Custom Component — its scaffold declares no replacement, so no Legacy banner yet", async () => {
      // Requires LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true — the image default hides
      // this button.
      await ensureCustomComponentButton(page);
      await addCustomComponent(page);
      await expect(page.getByTestId("title-Custom Component")).toBeVisible({
        timeout: 15000,
      });
      await expect(node).toHaveCount(1);
      await expect(node.getByTestId("dismiss-warning-bar")).toHaveCount(0);
    });

    await test.step("Save code whose replacement entries resolve to no component", async () => {
      await page.getByTestId("title-Custom Component").click();
      await page.getByTestId("code-button-modal").last().click();
      const codeDialog = page
        .getByRole("dialog")
        .filter({ has: page.getByTestId("checkAndSaveBtn") });
      await expect(codeDialog).toBeVisible({ timeout: 15000 });

      await codeDialog.locator(".ace_content").click();
      await page.keyboard.press("ControlOrMeta+A");
      await codeDialog.locator("textarea").fill(UNRESOLVABLE_REPLACEMENT_CODE);
      await page.getByTestId("checkAndSaveBtn").click();
      // The editor closes only when the code was accepted.
      await expect(page.getByTestId("checkAndSaveBtn")).toBeHidden({
        timeout: 30000,
      });
    });

    await test.step("The canvas keeps the node and its banner falls back to 'No direct replacement.'", async () => {
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await expect(page.getByTestId("title-Custom Component")).toBeVisible();
      await expect(node.getByTestId("dismiss-warning-bar")).toBeVisible({
        timeout: 30000,
      });
      await expect(
        node.getByText("No direct replacement.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("No direct replacement.", { exact: true }),
      ).toHaveCount(1);
    });
  },
);
