import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addCustomComponent } from "../../../helpers/flows/add-custom-component";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";

// Check & Save posts the component code to `POST /api/v1/custom_component`, which
// resolves every `import` (lfx `prepare_global_scope` → `importlib.import_module`)
// before it evaluates the class. An import the server cannot resolve must be
// refused there, and the Code Modal must say which module is missing. See
// docs/flow-functionality/generalBugs-shard-6.md.
//
// The module is named per run so that the refusal can only be about THIS import
// and can be matched exactly: the inherited version asserted `error.length > 20`,
// which any error satisfies — a `SyntaxError` from a mangled paste included.
function missingModuleName(): string {
  return `e2e_missing_module_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// The scaffold's own `lfx` imports, so the added line is the only one that cannot
// resolve. The inherited version imported `langflow.custom` / `langflow.io` /
// `langflow.schema`, which would have kept it green on the wrong import the day
// those aliases stop resolving.
function codeImporting(moduleName: string): string {
  return `import ${moduleName}
from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.data import Data


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Use as a template to create your own component."
    documentation: str = "https://docs.langflow.org/components-custom-components"
    icon = "code"
    name = "CustomComponent"

    inputs = [
        MessageTextInput(name="input_value", display_name="Input Value", value="Hello, World!"),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Data:
        data = Data(value=self.input_value)
        self.status = data
        return data
`;
}

// The one flow each test creates, deleted id-scoped in afterEach. The inherited
// version went through `awaitBootstrapTest` + `blank-flow` and deleted nothing:
// 3 flows leaked per run on an empty project (#1908).
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
      `generalBugs-shard-6: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

test(
  "should be able to see error when something goes wrong on Code Modal",
  { tag: ["@stable", "@release", "@regression", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    // The build POST is driven into a 400 on purpose — declare it so the
    // fixture's advisory HTTP log stays trustworthy for every other spec (#1084).
    (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();

    const moduleName = missingModuleName();
    const node = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Custom Component") });

    await test.step("Open a blank flow created over the API", async () => {
      const bearer = await getAuthToken(request);
      const id = await createFlow(
        request,
        {
          name: `Code Modal Error ${Date.now()}-${Math.random()
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

    await test.step("Add a Custom Component", async () => {
      // Requires LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true — the image default hides
      // this button.
      await ensureCustomComponentButton(page);
      await addCustomComponent(page);
      await expect(page.getByTestId("title-Custom Component")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
    });

    let buildStatus = 0;
    let buildBody = "";

    await test.step("Check & Save code that imports a module the server does not have", async () => {
      await page.getByTestId("title-Custom Component").click();
      await page.getByTestId("code-button-modal").last().click();
      const codeDialog = page
        .getByRole("dialog")
        .filter({ has: page.getByTestId("checkAndSaveBtn") });
      await expect(codeDialog).toBeVisible({ timeout: 15000 });

      await codeDialog.locator(".ace_content").click();
      await page.keyboard.press("ControlOrMeta+A");
      await codeDialog.locator("textarea").fill(codeImporting(moduleName));

      const buildResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/custom_component" &&
          response.request().method() === "POST",
        { timeout: 60000 },
      );
      await page.getByTestId("checkAndSaveBtn").click();
      const response = await buildResponse;
      buildStatus = response.status();
      buildBody = await response.text();
    });

    await test.step("The build refused the code because of that import", async () => {
      expect(
        buildStatus,
        `POST /api/v1/custom_component answered ${buildStatus}: ${buildBody.slice(0, 300)}`,
      ).toBe(400);
      expect(buildBody).toContain(`No module named '${moduleName}'`);
    });

    await test.step("The Code Modal names the missing module and keeps the code unsaved", async () => {
      await expect(page.getByTestId("title_error_code_modal")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId("title_error_code_modal")).toContainText(
        moduleName,
      );
      // The modal closes only when the build succeeds.
      await expect(page.getByTestId("checkAndSaveBtn")).toBeVisible();
    });

    await test.step("The canvas is unaffected", async () => {
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await expect(node).toHaveCount(1);
    });
  },
);
