import { expect, test } from "../../../fixtures/fixtures";
import {
  addPromptComponent,
  dynamicHandlesLocator,
  fillPromptTemplate,
} from "../../../helpers/ui/prompt-template";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

// Flows are created via the REST API (setupBlankFlow) and deleted in afterEach
// (issue #545). Kept serial so the per-file flow lifecycle stays deterministic
// under load.
test.describe.configure({ mode: "serial" });

let createdFlowId: string | null = null;

test.beforeEach(async ({ page }) => {
  // setupBlankFlow creates the flow via API (no UI-creation 500 race) and
  // returns its id so afterEach can delete it. Capturing the id before the
  // component add means a failure in addPromptComponent still cleans up.
  createdFlowId = await setupBlankFlow(page);
  await addPromptComponent(page);
});

test.afterEach(async ({ page }) => {
  if (createdFlowId) {
    // Leave the editor first: staying on it while the flow is deleted makes
    // background polling 404, which the fixture's error monitor would flag.
    await page.goto("/").catch(() => {});
    await page.request.delete(`/api/v1/flows/${createdFlowId}`);
    createdFlowId = null;
  }
});

test(
  "Prompt Template component — renders on canvas with output handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Node title is visible on the canvas", async () => {
      await expect(page.getByTestId("title-Prompt Template")).toBeVisible({
        timeout: 10000,
      });
    });

    await test.step(
      "Right-side output handle for the `prompt` port is visible",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-prompt-right"),
        ).toBeVisible({ timeout: 5000 });
      },
    );

    await test.step("Exactly one node is rendered on the canvas", async () => {
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
    });
  },
);

test(
  "Prompt Template component — variables in curly braces generate dynamic input handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step(
      "Save template with two {variable} placeholders",
      async () => {
        await fillPromptTemplate(page, "Hello {name}, your job is {profession}.");
      },
    );

    await test.step(
      "Both variable handles are rendered on the left side of the node",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-profession-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Exactly 2 dynamic handles exist — no extras leaked in",
      async () => {
        await expect(dynamicHandlesLocator(page)).toHaveCount(2);
      },
    );
  },
);

test(
  "Prompt Template component — removing a variable removes its input handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    const nameHandle = page.getByTestId(
      "handle-prompt template-shownode-name-left",
    );

    await test.step(
      "Save template `Hello {name}!` — expect 1 dynamic handle for {name}",
      async () => {
        await fillPromptTemplate(page, "Hello {name}!");
        await expect(nameHandle).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );

    await test.step(
      "Save template without variables — expect 0 dynamic handles",
      async () => {
        await fillPromptTemplate(page, "Hello world!");
        await expect(nameHandle).toHaveCount(0, { timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(0);
      },
    );
  },
);

test(
  "Prompt Template component — replacing a variable updates handles accordingly",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step(
      "Save template `Hello {name}, you are {role}.` — both handles render",
      async () => {
        await fillPromptTemplate(page, "Hello {name}, you are {role}.");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-role-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Replace {role} with {title} — old handle is gone, new one appears, {name} stays",
      async () => {
        await fillPromptTemplate(page, "Hello {name}, you are {title}.");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-role-left"),
        ).toHaveCount(0, { timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-title-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );
  },
);

test(
  "Prompt Template component — clearing the template removes all dynamic handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step(
      "Save template with 3 variables — expect 3 dynamic handles",
      async () => {
        await fillPromptTemplate(page, "{a} and {b} and {c}");
        await expect(dynamicHandlesLocator(page)).toHaveCount(3, {
          timeout: 10000,
        });
      },
    );

    await test.step(
      "Save plain-text template — all dynamic handles disappear",
      async () => {
        await fillPromptTemplate(page, "No variables here.");
        await expect(dynamicHandlesLocator(page)).toHaveCount(0, {
          timeout: 10000,
        });
      },
    );
  },
);

test(
  "Prompt Template component — modal edits persist in UI and in saved flow",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    const expected = "Persisted prompt text {topic}.";
    // The flow is created in beforeEach; `createdFlowId` is its authoritative
    // API id — assert its shape here to keep the original UUID sanity check.
    expect(createdFlowId).toMatch(/^[0-9a-f-]{36}$/);
    const flowId = createdFlowId as string;

    await test.step(
      "Save template — the {topic} handle confirms save was applied",
      async () => {
        await fillPromptTemplate(page, expected);
        await expect(
          page.getByTestId("handle-prompt template-shownode-topic-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Reopen the modal — sanitized preview shows the saved value",
      async () => {
        await page.getByTestId("button_open_prompt_modal").click();
        const preview = page.getByTestId("edit-prompt-sanitized");
        await expect(preview).toBeVisible({ timeout: 10000 });
        await expect(preview).toContainText("Persisted prompt text");
        await expect(preview).toContainText("topic");
      },
    );

    await test.step(
      "Re-enter edit mode — textarea holds the exact saved value",
      async () => {
        await page.getByTestId("edit-prompt-sanitized").click();
        const textarea = page.getByTestId("modal-promptarea_prompt_template");
        await expect(textarea).toBeVisible({ timeout: 5000 });
        await expect(textarea).toHaveValue(expected);
        await page.keyboard.press("Escape");
      },
    );

    await test.step(
      "Backend persistence — autosaved flow contains the template string",
      async () => {
        // `page.request` inherits session cookies — `GET /api/v1/flows/{id}`
        // requires session auth in Langflow's auto-login mode.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`/api/v1/flows/${flowId}`);
              if (!res.ok()) return null;
              const flow = await res.json();
              // The frontend sets `node.data.type` to the human-readable name
              // ("Prompt Template"), which is the `display_name` of the
              // PromptComponent on the upstream Langflow source.
              const promptNode = (flow?.data?.nodes ?? []).find(
                (n: { data?: { type?: string } }) =>
                  n?.data?.type === "Prompt Template",
              );
              return promptNode?.data?.node?.template?.template?.value ?? null;
            },
            { timeout: 15000, intervals: [500, 1000, 2000] },
          )
          .toBe(expected);
      },
    );
  },
);
