import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { addCustomComponent } from "../../../helpers/flows/add-custom-component";
import { addLegacyComponents } from "../../../helpers/flows/add-legacy-components";

// Code submitted to the paths that only claim to INSPECT it must never run
// (langflow-ai/langflow#696 in 2023 and #13336 in 2026 — the same endpoint, three
// years apart, fixed upstream in #13696 / GHSA-2wcq-pvw2-xh7v), and the path that
// DOES execute posted code by design must stay behind authentication (#7900 /
// GHSA-4xph-gxg8-rp48). See docs/security/code-execution-endpoints.md.
//
// "Rejects" here means "refuses to execute", NOT "answers 4xx": the crafted
// payload is syntactically valid, so a healthy `validate/code` answers 200 with
// empty error lists in milliseconds — #696's PoC is explicit that the exploit
// comes back clean. A spec asserting 4xx on that endpoint would be red on a fixed
// instance and green on a vulnerable one.
//
// So the payload is crafted to make execution observable in the response itself:
// evaluating the default argument both sleeps and raises, which gives two
// independent discriminators out of one request —
//   pre-fix (exec):   function.errors == ["division by zero"], >= SLEEP_SECONDS
//   fixed (compile):  function.errors == [],                   milliseconds
// The error list is the primary signal; the timing still catches a regression
// that re-introduces exec but swallows the exception. `1 / 0` is not
// constant-folded (measured: compile() succeeds and the endpoint answers clean),
// and it cannot be produced by the imports checker, so "division by zero" in the
// response can only mean the expression ran.

/**
 * Seconds the crafted default argument sleeps before raising. Long enough that a
 * loaded instance cannot be mistaken for an executing one (measured on nightly
 * 1.12.0.dev30: a clean validate answers in ~50-230 ms, i.e. >15x under the
 * no-exec ceiling below), and short enough that the control in Test 2 — which
 * DOES execute it — costs one sleep, not several.
 */
const SLEEP_SECONDS = 8;

/** A response this fast cannot have evaluated the sleeping default argument. */
const MAX_NO_EXEC_MS = 4000;

/**
 * Floor for the build path, which is MEANT to execute the payload. Below the
 * sleep budget on purpose: it proves the expression ran without pinning the test
 * to the exact scheduling of a container under load (measured: 8.27 s in the UI,
 * 8.0-8.3 s over the API).
 */
const MIN_EXEC_MS = SLEEP_SECONDS * 1000 * 0.75;

/**
 * The catalog's own Custom Component scaffold, used only as Test 3's benign
 * control. Kept verbatim (imports included) so the build exercises the same code
 * path the crafted payload takes, minus the default argument.
 */
const SCAFFOLD_COMPONENT_CODE = `from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.data import Data


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Use as a template to create your own component."
    icon = "code"
    name = "CustomComponent"

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

/**
 * The `#696` / `#13336` payload shape: a MODULE-LEVEL function whose default
 * argument is an executable expression. `validate_code()` walks `tree.body` for
 * `ast.FunctionDef` nodes, so only a module-level def reaches the line the fix
 * changed — a method inside the class body would never be visited and the test
 * would pass vacuously.
 *
 * `sleep()` returns `None`, so the `or` always evaluates `1 / 0`.
 */
function canaryFunction(name: string, sentinel: string): string {
  return `def ${name}(_probe=__import__("time").sleep(${SLEEP_SECONDS}) or 1 / 0) -> str:
    return "${sentinel}"
`;
}

/** Unique per test so a match in a stored flow can never be coincidental. */
function uniqueSentinel(): string {
  return `E2E-CODEEXEC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Read one template field of the flow's single node from the saved flow. */
async function readNodeTemplateValue(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  field: string,
): Promise<string | undefined> {
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: {
      nodes: Array<{
        data: { node: { template: Record<string, { value?: unknown }> } };
      }>;
    };
  };
  const value = body.data.nodes[0]?.data?.node?.template?.[field]?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Replace the open ACE editor's content. `fill()` does not reach ACE — the repo
 * convention is to go through ACE's own API (#496).
 */
async function setAceValue(page: Page, value: string): Promise<void> {
  await page.locator(".ace_editor").waitFor({ state: "visible", timeout: 10000 });
  await page.evaluate((code) => {
    const w = window as unknown as {
      ace: {
        edit: (el: Element | null) => {
          setValue: (v: string, cursor: number) => void;
          getValue: () => string;
        };
      };
    };
    w.ace.edit(document.querySelector(".ace_editor")).setValue(code, -1);
  }, value);
}

/** The open ACE editor's current content. */
async function getAceValue(page: Page): Promise<string> {
  await page.locator(".ace_editor").waitFor({ state: "visible", timeout: 10000 });
  return page.evaluate(() => {
    const w = window as unknown as {
      ace: { edit: (el: Element | null) => { getValue: () => string } };
    };
    return w.ace.edit(document.querySelector(".ace_editor")).getValue();
  });
}

// Ids of flows created by each test — deleted id-scoped in afterEach (repo
// convention #490/#681). Every flow here is created through the API by this
// file, so nothing else can be caught by the sweep.
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(
      () => {},
    );
  }
});

/** Create a blank flow via the API (parallel-safe unique name) and open it. */
async function openBlankFlow(
  page: Page,
  request: APIRequestContext,
  bearer: string,
): Promise<string> {
  const flowId = await createFlow(
    request,
    {
      name: `Code Exec ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      data: { nodes: [], edges: [] },
      is_component: false,
    },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);
  await openFlowById(page, flowId);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });
  return flowId;
}

test.describe("Code execution endpoints", () => {
  test(
    "validating a crafted default-argument payload does not execute it",
    { tag: ["@stable", "@api", "@regression", "@components"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const sentinel = uniqueSentinel();
      // `python_function` is the name the component's scaffold already uses, so
      // the crafted code differs from a legitimate edit ONLY in the default
      // argument — the thing under test.
      const craftedCode = canaryFunction("python_function", sentinel);

      let flowId = "";

      await test.step("open a flow holding a Python Function component", async () => {
        flowId = await openBlankFlow(page, request, bearer);
        // Python Function carries `function_code`, the only `CodeInput` field in
        // the whole catalog and therefore the only UI surface that reaches
        // POST /api/v1/validate/code (a node's own source editor posts to
        // /custom_component instead — measured on 1.12.0.dev30). It is
        // `legacy: true`, so the sidebar hides it until the Legacy toggle is on.
        await addLegacyComponents(page);
        await addComponentFromSidebar(
          page,
          "Python Function",
          "add-component-button-python-function",
        );
        await expect(page.getByTestId("title-Python Function")).toBeVisible({
          timeout: 15000,
        });
      });

      let validateStatus = 0;
      let validateMs = 0;
      let validateBody: {
        imports?: { errors?: string[] };
        function?: { errors?: string[] };
      } = {};

      await test.step("submit the crafted code through the field's code editor", async () => {
        await page.getByTestId("codearea_code_function_code").click();
        await expect(page.getByTestId("checkAndSaveBtn")).toBeVisible({
          timeout: 15000,
        });
        await setAceValue(page, craftedCode);

        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes("/api/v1/validate/code") &&
            response.request().method() === "POST",
          { timeout: 60000 },
        );
        const startedAt = Date.now();
        await page.getByTestId("checkAndSaveBtn").click();
        const response = await responsePromise;
        validateMs = Date.now() - startedAt;
        validateStatus = response.status();
        validateBody = await response.json();
      });

      await test.step("the endpoint validated statically instead of executing", async () => {
        expect(validateStatus).toBe(200);
        // The pre-fix implementation exec'd the function definition, caught the
        // resulting exception and appended it here. An empty list is the fix.
        expect(validateBody.function?.errors ?? []).toEqual([]);
        expect(validateBody.imports?.errors ?? []).toEqual([]);
        // Belt and braces: catches a regression that re-introduces exec but
        // swallows the exception — the sleep would still be paid.
        expect(
          validateMs,
          `validate/code answered in ${validateMs}ms; the payload sleeps ${SLEEP_SECONDS}s when executed`,
        ).toBeLessThan(MAX_NO_EXEC_MS);
      });

      await test.step("the editor accepted the code and saved it", async () => {
        // A vulnerable backend would have reported "division by zero", which the
        // modal renders as an error while staying open. The modal closing is the
        // user-visible half of the same verdict.
        await expect(page.getByTestId("checkAndSaveBtn")).toBeHidden({
          timeout: 15000,
        });
        // Control: the click actually did something. Without this, both
        // assertions above would also hold for a click that never landed.
        await expect
          .poll(
            () =>
              readNodeTemplateValue(request, bearer, flowId, "function_code"),
            { timeout: 20000 },
          )
          .toContain(sentinel);
      });
    },
  );

  test(
    "the build endpoint refuses the same payload and leaves no partial component",
    { tag: ["@stable", "@api", "@regression", "@components"] },
    async ({ page, request }) => {
      // The build POST is driven into a 400 on purpose — declare it so the
      // fixture's advisory HTTP log stays trustworthy for every other spec
      // (#1084).
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();

      const bearer = await getAuthToken(request);
      const sentinel = uniqueSentinel();

      let flowId = "";
      let scaffoldCode = "";

      await test.step("open a flow holding a scaffold Custom Component", async () => {
        flowId = await openBlankFlow(page, request, bearer);
        await addCustomComponent(page);
        await expect(page.getByTestId("title-Custom Component")).toBeVisible({
          timeout: 15000,
        });
        // The scaffold as PERSISTED — the baseline the failed save must not move.
        await expect
          .poll(() => readNodeTemplateValue(request, bearer, flowId, "code"), {
            timeout: 30000,
          })
          .toContain("class CustomComponent");
        scaffoldCode =
          (await readNodeTemplateValue(request, bearer, flowId, "code")) ?? "";
      });

      let buildStatus = 0;
      let buildMs = 0;
      let buildBody = "";

      await test.step("submit the crafted code through the component's code editor", async () => {
        await page.getByTestId("code-button-modal").last().click();
        await expect(page.getByTestId("checkAndSaveBtn")).toBeVisible({
          timeout: 15000,
        });
        // Prepend the canary to the editor's own scaffold: everything else about
        // the component stays valid, so a failure can only come from the default
        // argument.
        const editorScaffold = await getAceValue(page);
        await setAceValue(
          page,
          `${canaryFunction("_e2e_code_exec_canary", sentinel)}\n\n${editorScaffold}`,
        );

        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes("/api/v1/custom_component") &&
            response.request().method() === "POST",
          { timeout: 90000 },
        );
        const startedAt = Date.now();
        await page.getByTestId("checkAndSaveBtn").click();
        const response = await responsePromise;
        buildMs = Date.now() - startedAt;
        buildStatus = response.status();
        buildBody = await response.text();
      });

      await test.step("the payload IS live code, and the build refuses it", async () => {
        // This is the control for the sibling test: the identical expression, on
        // the endpoint that is meant to execute posted code, both sleeps its full
        // budget and raises. A clean, instant `validate/code` therefore cannot be
        // explained by an inert payload.
        expect(buildStatus).toBe(400);
        expect(buildBody).toMatch(/ZeroDivisionError|division by zero/i);
        expect(
          buildMs,
          `the build answered in ${buildMs}ms; executing the payload costs ${SLEEP_SECONDS}s`,
        ).toBeGreaterThanOrEqual(MIN_EXEC_MS);
      });

      await test.step("the failure is visible to the user, not silent", async () => {
        await expect(page.getByTestId("title_error_code_modal")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("title_error_code_modal")).toContainText(
          /division by zero/i,
        );
        // The modal stays open: the code was not accepted.
        await expect(page.getByTestId("checkAndSaveBtn")).toBeVisible();
      });

      await test.step("no partial component was created", async () => {
        await expect(page.locator('[data-testid^="rf__node-"]')).toHaveCount(1);
        await expect(page.getByTestId("title-Custom Component")).toBeVisible();

        const persisted = await readNodeTemplateValue(
          request,
          bearer,
          flowId,
          "code",
        );
        expect(persisted).not.toContain(sentinel);
        expect(persisted).not.toContain("_e2e_code_exec_canary");
        // Byte-identical to the baseline: the rejected payload left no trace at
        // all, not merely "no sentinel".
        expect(persisted).toBe(scaffoldCode);
      });
    },
  );

  test(
    "both endpoints refuse an unauthenticated caller before executing anything",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // Pure API through the `request` fixture: these calls never go through the
      // page, so they are outside the fixture's HTTP monitor and need no
      // allowHttpErrors(). No Authorization header is sent.
      const sentinel = uniqueSentinel();
      const craftedCode = canaryFunction("python_function", sentinel);

      await test.step("validate/code refuses an anonymous caller", async () => {
        const startedAt = Date.now();
        const response = await request.post("/api/v1/validate/code", {
          data: { code: craftedCode },
        });
        const elapsed = Date.now() - startedAt;

        expect([401, 403]).toContain(response.status());
        expect(await response.text()).toMatch(/credential|authenticat/i);
        expect(
          elapsed,
          `answered in ${elapsed}ms; executing the payload costs ${SLEEP_SECONDS}s`,
        ).toBeLessThan(MAX_NO_EXEC_MS);
      });

      await test.step("the custom-component endpoint refuses an anonymous caller", async () => {
        // #7900's boundary: this route DOES execute posted code, so the refusal
        // has to land before the code is reached — which the timing is what
        // proves.
        const startedAt = Date.now();
        const response = await request.post("/api/v1/custom_component", {
          data: { code: craftedCode },
        });
        const elapsed = Date.now() - startedAt;

        expect([401, 403]).toContain(response.status());
        expect(await response.text()).toMatch(/credential|authenticat/i);
        expect(
          elapsed,
          `answered in ${elapsed}ms; executing the payload costs ${SLEEP_SECONDS}s`,
        ).toBeLessThan(MAX_NO_EXEC_MS);
      });

      await test.step("the same route answers an authenticated caller", async () => {
        // Without this, the refusals above are ambiguous: an instance with
        // LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false answers 403 to EVERY caller on
        // this route. A benign build proves the refusals are about credentials.
        const bearer = await getAuthToken(request);
        const response = await request.post("/api/v1/custom_component", {
          headers: { Authorization: bearer },
          data: { code: SCAFFOLD_COMPONENT_CODE },
        });
        expect(
          response.status(),
          `authenticated scaffold build failed: ${(await response.text()).slice(0, 300)}`,
        ).toBe(200);
      });
    },
  );
});
