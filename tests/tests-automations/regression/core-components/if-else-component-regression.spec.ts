import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { expandFocusedNode } from "../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
import { zoomOut } from "../../../helpers/ui/zoom-out";

// Ids of the flows each test creates on the blank canvas (Langflow autosaves
// them). Teardown deletes ONLY these via the API (scoped, #515/#553) — never a
// global cleanAllFlows / name-scoped / diff-based wipe, which races flows other
// parallel workers are actively driving.
const createdFlowIds: string[] = [];

// Before the first document load — the only point at which the assistant onboarding
// tooltip can be suppressed, because upstream reads its flag once at mount of the
// canvas-controls bar and then arms a 10 s timer. `expandFocusedNode` asserts this
// ran; the probe it used to make instead fired ~2 s after that mount and never saw
// the tooltip in 39 measured executions (#1220). This spec also clicks the bar
// itself (`zoomOut`, `adjustScreenView`), which is what the tooltip covers.
test.beforeEach(async ({ page }) => {
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a
  // flow we are about to delete, then pass an explicit auth header — page.request
  // is unauthenticated under AUTO_LOGIN and would 401 otherwise. Not swallowed:
  // a failed cleanup surfaces instead of silently leaking the flow (#547).
  await page.goto("/");
  const authHeader = await getAuthToken(page.request);
  const opts = authHeader
    ? { headers: { Authorization: authHeader } }
    : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

async function selectOperator(
  page: Page,
  operatorName: string,
): Promise<void> {
  await page.getByTestId("value-dropdown-dropdown_str_operator").click();
  // Match by exact role+name — robust across option-index churn. Click via
  // `dispatchEvent` because the bottom of the options list (numeric operators)
  // overlaps `main_canvas_controls`, which intercepts ordinary pointer events.
  // The `toHaveText` guard below catches a no-op dispatch (e.g. a detached
  // option), so the event-level click is safe here.
  await page
    .getByRole("option", { name: operatorName, exact: true })
    .dispatchEvent("click");
  // Confirm the trigger reflects the new value before proceeding — guards
  // against the real_time_refresh round-trip not having landed yet.
  await expect(
    page.getByTestId("value-dropdown-dropdown_str_operator"),
  ).toHaveText(operatorName);
}

async function exposeCaseSensitive(page: Page): Promise<void> {
  // In the dev46 inspector panel the per-field "add to node" toggle is
  // `inspector-add-<field>` (was `show<field>` — here `showcase_sensitive`).
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-case_sensitive").click();
  await closeAdvancedOptions(page);
}

// Builds: If-Else (operator=equals) + two Chat Output components, one renamed
// to `chatoutputfalse` so the True/False branches can be inspected
// independently by testid. Direct-value path: `input_text` and `match_text`
// are typed into the If-Else inspector popovers — no ChatInput/Playground
// involved, mirroring `general-bugs-reset-flow-run.spec.ts` which validated
// that the canvas node-status icons (`node_duration_*` vs
// `node_status_icon_*_inactive`) are the most reliable assertion surface for
// conditional routing.
async function buildIfElseRoutingFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  // Capture the id from the flow-creation POST (NOT the transient canvas-URL id,
  // which does not match the persisted flow on this Langflow version) so the
  // afterEach can delete exactly this flow (scoped teardown, #515).
  const flowCreation = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByTestId("blank-flow").click();
  const created = (await (await flowCreation).json()) as { id?: string };
  if (!created.id) {
    throw new Error("blank-flow creation returned no flow id");
  }
  createdFlowIds.push(created.id);

  // Wait for the canvas/sidebar to settle before interacting — clicking the
  // search input immediately after the blank-flow transition can resolve a
  // node that is then detached mid-render (observed flake under parallelism).
  await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
    timeout: 15000,
  });

  // If-Else
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("if else");
  await expect(page.getByTestId("flow_controlsIf-Else")).toBeVisible({
    timeout: 10000,
  });
  await page.getByTestId("flow_controlsIf-Else").hover();
  await page.getByTestId("add-component-button-if-else").click();

  await zoomOut(page, 3);

  // Chat Output (will be wired to True branch — default name `chat output`).
  // Chat Output is added minimized; expand it so the run button and the
  // `shownode` input handle are present in the DOM.
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 10000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  await page.getByTestId("title-Chat Output").click();
  await expandFocusedNode(page);

  // Second Chat Output — will be wired to False branch and renamed to
  // `chatoutputfalse` so the False-branch status icon has a stable testid.
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 10000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 200, y: 400 },
    });

  await adjustScreenView(page);

  // Focus and expand the newly added (second) Chat Output before renaming/wiring.
  await page.getByTestId("title-Chat Output").last().click();
  await expandFocusedNode(page);

  // Rename the second Chat Output to `chatoutputfalse`. The node-title edit flow
  // was restructured in the nightly (~dev46): the `panel-description` hover
  // wrapper is gone; the edit/save controls gained a `node-` prefix and the
  // title field is now a dynamic `input-title-<currentName>` (still "Chat Output"
  // here, since the fill hasn't landed when the testid is resolved).
  await page.getByTestId("generic-node-title-arrangement").last().click();
  await page.getByTestId("node-edit-name-description-button").click();
  await page.getByTestId("input-title-Chat Output").fill("chatoutputfalse");
  await page.getByTestId("node-save-name-description-button").click();

  // Connect True → first Chat Output
  await page
    .getByTestId("handle-conditionalrouter-shownode-true-right")
    .click();
  await page
    .getByTestId("handle-chatoutput-shownode-inputs-left")
    .first()
    .click();

  // Connect False → second Chat Output (chatoutputfalse)
  await page
    .getByTestId("handle-conditionalrouter-shownode-false-right")
    .click();
  await page
    .getByTestId("handle-chatoutput-shownode-inputs-left")
    .last()
    .click();
}

test(
  "If-Else routes matching input through the True branch and skips the False branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Set matching input (input_text === match_text) and run", async () => {
      // Match: input_text === match_text → True branch should build.
      await page.getByTestId("popover-anchor-input-input_text").fill("hello");
      await page.getByTestId("popover-anchor-input-match_text").fill("hello");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else routes non-matching input through the False branch and skips the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Set non-matching input (input_text !== match_text) and run", async () => {
      // No match: input_text !== match_text → False branch should build.
      await page.getByTestId("popover-anchor-input-input_text").fill("world");
      await page.getByTestId("popover-anchor-input-match_text").fill("hello");

      await page.getByTestId("button_run_chatoutputfalse").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert False branch built and True branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chatoutputfalse"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chat output_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=contains routes a substring match through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'contains', set substring input, and run", async () => {
      await selectOperator(page, "contains");

      // `lang` is a substring of `langflow` → contains evaluates True.
      await page
        .getByTestId("popover-anchor-input-input_text")
        .fill("langflow");
      await page.getByTestId("popover-anchor-input-match_text").fill("lang");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=regex routes a valid pattern match through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'regex', set a regex-only pattern, and run", async () => {
      await selectOperator(page, "regex");

      // `^abc\d+$` fully matches `abc123` and is satisfiable only by a real
      // regex engine — `contains`/`starts with` cannot express the trailing
      // `\d+$`, so this exercises the regex path distinctly (not just
      // re.match's implicit start-anchor).
      await page.getByTestId("popover-anchor-input-input_text").fill("abc123");
      await page
        .getByTestId("popover-anchor-input-match_text")
        .fill("^abc\\d+$");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=regex hides the case_sensitive advanced field",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Baseline: case_sensitive toggle is exposed with the default operator", async () => {
      // Focus the If-Else node — `openAdvancedOptions` operates on the
      // currently-focused node, and the build helper leaves focus on the last
      // Chat Output it renamed.
      await page.getByTestId("title-If-Else").click();

      await openAdvancedOptions(page);
      // In the inspector panel each input is a `inspector-param-<field>` row;
      // its presence is the modern signal that the field exists in the build
      // config (was the `showcase_sensitive` show-toggle count).
      await expect(
        page.getByTestId("inspector-param-case_sensitive"),
      ).toHaveCount(1);
      await closeAdvancedOptions(page);
    });

    await test.step("Switch to regex and assert case_sensitive toggle disappears", async () => {
      // After switching to regex, `update_build_config` removes case_sensitive
      // from the build config — the inspector row should disappear.
      await selectOperator(page, "regex");

      await page.getByTestId("title-If-Else").click();
      await openAdvancedOptions(page);
      await expect(
        page.getByTestId("inspector-param-case_sensitive"),
      ).toHaveCount(0);
      await closeAdvancedOptions(page);
    });
  },
);

test(
  "If-Else case_sensitive defaults to ON — mixed-case inputs route to the False branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Set mixed-case input (case_sensitive ON by default) and run", async () => {
      // case_sensitive is True by default in the Python source. With operator
      // equals, `HELLO` and `hello` differ — False branch should build.
      await page.getByTestId("popover-anchor-input-input_text").fill("HELLO");
      await page.getByTestId("popover-anchor-input-match_text").fill("hello");

      await page.getByTestId("button_run_chatoutputfalse").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert False branch built and True branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chatoutputfalse"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chat output_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else with case_sensitive=OFF treats mixed-case inputs as a match (True branch)",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Expose case_sensitive and toggle it OFF", async () => {
      // Focus If-Else and expose the case_sensitive field on the node body,
      // then toggle the switch from ON (default) to OFF.
      await page.getByTestId("title-If-Else").click();
      await exposeCaseSensitive(page);
      await page.getByTestId("toggle_bool_case_sensitive").click();
    });

    await test.step("Set mixed-case input and run", async () => {
      // With case-insensitive comparison, `HELLO` and `hello` are equal.
      await page.getByTestId("popover-anchor-input-input_text").fill("HELLO");
      await page.getByTestId("popover-anchor-input-match_text").fill("hello");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=greater than routes a numeric match (10 > 5) through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'greater than', set numeric input, and run", async () => {
      await selectOperator(page, "greater than");

      // Numeric: 10 > 5 → True.
      await page.getByTestId("popover-anchor-input-input_text").fill("10");
      await page.getByTestId("popover-anchor-input-match_text").fill("5");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=less than routes a numeric match (2.5 < 10) through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'less than', set a decimal numeric input, and run", async () => {
      await selectOperator(page, "less than");

      // Numeric (decimal): 2.5 < 10 → True. The decimal operand exercises the
      // shared `float(...)` cast on a non-integer, distinct from `greater than`
      // (integer inputs). If the operator were `greater than`, 2.5 > 10 is
      // False, so the True-branch assertion would fail.
      await page.getByTestId("popover-anchor-input-input_text").fill("2.5");
      await page.getByTestId("popover-anchor-input-match_text").fill("10");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=less than or equal routes an equal-operands match (5 <= 5) through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'less than or equal', set equal operands, and run", async () => {
      await selectOperator(page, "less than or equal");

      // Equality boundary: 5 <= 5 → True. This is the distinctive case that
      // separates `<=` from the strict `<` (5 < 5 is False → would route
      // False), so a regression swapping the inclusive operator for the strict
      // one flips the routed branch and fails this assertion.
      await page.getByTestId("popover-anchor-input-input_text").fill("5");
      await page.getByTestId("popover-anchor-input-match_text").fill("5");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);

test(
  "If-Else operator=greater than or equal routes an equal-operands match (5 >= 5) through the True branch",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Build If-Else flow with True/False Chat Output branches", async () => {
      await buildIfElseRoutingFlow(page);
    });

    await test.step("Switch to 'greater than or equal', set equal operands, and run", async () => {
      await selectOperator(page, "greater than or equal");

      // Equality boundary: 5 >= 5 → True. Distinctive vs the strict `>`
      // (5 > 5 is False → would route False); catches a regression swapping
      // the inclusive operator for the strict one.
      await page.getByTestId("popover-anchor-input-input_text").fill("5");
      await page.getByTestId("popover-anchor-input-match_text").fill("5");

      await page.getByTestId("button_run_chat output").click();
      await expect(page.locator("text=built successfully")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Assert True branch built and False branch stayed inactive", async () => {
      await expect(
        page.getByTestId("node_duration_chat output"),
      ).toHaveCount(1, { timeout: 30000 });
      await expect(
        page.getByTestId("node_status_icon_chatoutputfalse_inactive"),
      ).toHaveCount(1, { timeout: 30000 });
    });
  },
);
