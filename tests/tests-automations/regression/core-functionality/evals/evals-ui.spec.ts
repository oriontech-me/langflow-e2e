import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  DATASETS,
  DatasetTracker,
  addItems,
  createDataset,
  listAllItems,
  readDataset,
  readEvalsSurface,
} from "../../../../helpers/api/evals/datasets";
import { EvaluationTracker, createEchoFlow, waitForRunEnd } from "../../../../helpers/api/evals/evaluations";
import { fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Evals UI (#2565) — the project sidebar's Evaluations entry, the Datasets page and the
 * flow toolbar's Evaluate stepper (Langflow 1.14, upstream #15999; on by default since
 * #16591). The API contracts behind these pages are #2563 (datasets) and #2564
 * (evaluations); this spec drives the pages a user meets and checks every count they show
 * against the API, so a page rendering its own optimistic state cannot pass.
 *
 * Every testid was measured live on 1.14.0.dev39 with playwright-cli.
 * Contract and measurements: docs/core-functionality/evals/evals-ui.md.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("Evals UI — evaluations entry, Datasets page and the Evaluate stepper", () => {
  let headers: Record<string, string>;
  let skipReason: string | null = null;
  let catalog: Record<string, unknown>;
  let datasets: DatasetTracker;
  let evaluations: EvaluationTracker;
  let flows: string[];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const verdict = await readEvalsSurface(request, headers);
    if (verdict.state === "absent") skipReason = verdict.reason;
    else if (verdict.state !== "enabled") throw new Error(`evals premise: ${verdict.reason}`);
    else catalog = await fetchComponentCatalog(request, headers);
  });

  test.beforeEach(() => {
    datasets = new DatasetTracker();
    evaluations = new EvaluationTracker();
    flows = [];
    test.skip(skipReason !== null, skipReason ?? "");
  });

  // Evaluations first: they do not cascade from the flow (#2564).
  test.afterEach(async ({ page, request }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await evaluations.cleanup(request, headers);
    for (const id of flows.splice(0)) await deleteFlow(request, id, { headers });
    await datasets.cleanup(request, headers);
  });

  /**
   * An echo flow, created first: an instance with no flow shows the empty welcome page,
   * which has no project sidebar and therefore no Evaluations entry.
   */
  async function echoFlow(request: Parameters<typeof createEchoFlow>[0], label: string) {
    const name = `evals-ui-${label}-${uid()}`;
    const id = await createEchoFlow(request, headers, name, { catalog });
    flows.push(id);
    return { id, name };
  }

  async function openFlow(page: Page, flowId: string) {
    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("publish-button")).toBeVisible({ timeout: 60_000 });
  }

  test("the evaluations entry, pages and Evaluate button follow the evals flag", {
    tag: ["@stable", "@mainpage", "@database", "@evals"],
  }, async ({ page, request }) => {
    const flow = await echoFlow(request, "flag");

    await test.step("flag on: the sidebar entry opens the Datasets page", async () => {
      await page.goto("/flows");
      await expect(page.getByTestId("sidebar-evaluations")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("sidebar-evaluations").click();
      await expect(page).toHaveURL(/\/assets\/datasets$/);
      await expect(page.getByTestId("datasets-title")).toBeVisible();
      await expect(page.getByTestId("evals-tab-datasets")).toBeVisible();
      await expect(page.getByTestId("evals-tab-evaluations")).toBeVisible();
    });

    await test.step("flag on: the flow toolbar carries Evaluate beside Publish", async () => {
      await openFlow(page, flow.id);
      await expect(page.getByTestId("evaluate-btn-flow")).toBeVisible();
    });

    let fired = 0;

    await test.step("flag off: the evals pages redirect to /flows and the sidebar has no entry", async () => {
      // The real config, merged rather than replaced, with only the flag under test changed.
      await page.route("**/api/v1/config", async (route) => {
        fired++;
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({ response, json: { ...json, feature_flags: { ...json.feature_flags, evals: false } } });
      });
      await page.goto("/assets/datasets");
      await expect(page).toHaveURL(/\/flows(\?|$)/, { timeout: 30_000 });
      // Anchor on the sidebar first, so the absence below is not read off a page that never rendered.
      await expect(page.getByTestId("project-sidebar")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-evaluations")).toHaveCount(0);
    });

    await test.step("flag off: the same flow page has Publish and no Evaluate", async () => {
      await openFlow(page, flow.id);
      await expect(page.getByTestId("evaluate-btn-flow")).toHaveCount(0);
      expect(fired, "the config mock never fired, so the flag under test was not applied").toBeGreaterThan(0);
    });
  });

  test("a dataset created from a bundled example shows all its rows, and an added row persists", {
    tag: ["@stable", "@mainpage", "@database", "@evals"],
  }, async ({ page, request }) => {
    await echoFlow(request, "dataset");
    // With no dataset the page shows the examples as cards and no menu; every worker
    // shares the superuser, so emptiness is not ours to decide. A seed makes the menu
    // path deterministic.
    await createDataset(request, headers, { name: `evals-ui-seed-${uid()}` }, datasets);
    const examples = await (await request.get(`${DATASETS}/examples`, { headers })).json();
    const example = examples[0] as { key: string; name: string; item_count: number };
    const rows = example.item_count;
    let datasetId = "";
    const grid = page.locator("[role=grid], [role=treegrid]").first();

    await test.step("choosing the example from the menu creates the dataset and opens it", async () => {
      await page.goto("/assets/datasets");
      await expect(page.getByTestId("datasets-title")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("dataset-examples-menu").click();
      await page.getByTestId(`dataset-example-menu-${example.key}`).click();
      await page.waitForURL(new RegExp(`/assets/datasets/(${UUID})$`));
      datasetId = new RegExp(`/assets/datasets/(${UUID})$`).exec(page.url())![1];
      datasets.track(datasetId);
    });

    await test.step("the page shows every row of the example, and the API agrees", async () => {
      await expect(page.getByTestId("dataset-detail-title")).toHaveText(new RegExp(`^${escapeRegExp(example.name)}`));
      await expect(page.getByText(new RegExp(`^${rows} items\\b`))).toBeVisible();
      // The grid virtualises rows, so the DOM holds fewer rows than the dataset: count
      // through aria-rowcount (the header is one of them), never through role=row.
      await expect(grid).toHaveAttribute("aria-rowcount", String(rows + 1));
      expect((await readDataset(request, headers, datasetId)).item_count).toBe(rows);
    });

    const sentinel = { input: `evals-ui input ${uid()}`, expected: `evals-ui expected ${uid()}` };

    await test.step("Add item saves only once an input is typed", async () => {
      await page.getByTestId("add-item-button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("item-save")).toBeDisabled();
      await dialog.getByTestId("item-input").fill(sentinel.input);
      await expect(dialog.getByTestId("item-save")).toBeEnabled();
      await dialog.getByTestId("item-expected").fill(sentinel.expected);
      await dialog.getByTestId("item-save").click();
      await expect(dialog).toBeHidden();
    });

    await test.step("the page counts the new row, and the API holds it as the last manual row", async () => {
      await expect(page.getByText(new RegExp(`^${rows + 1} items\\b`))).toBeVisible();
      await expect(grid).toHaveAttribute("aria-rowcount", String(rows + 2));
      const items = await listAllItems(request, headers, datasetId);
      expect(items).toHaveLength(rows + 1);
      expect(items[items.length - 1]).toMatchObject({
        input: sentinel.input,
        expected_output: sentinel.expected,
        source: "manual",
      });
    });
  });

  test("the Evaluate stepper runs a keyless evaluation and the result view agrees with the API", {
    tag: ["@stable", "@mainpage", "@database", "@evals"],
  }, async ({ page, request }) => {
    const flow = await echoFlow(request, "stepper");
    const dataset = await createDataset(request, headers, { name: `evals-ui-stepper-${uid()}` }, datasets);
    await addItems(request, headers, dataset.id, [
      { input: "alpha", expected_output: "alpha" },
      { input: "beta", expected_output: "nope" },
    ]);
    const dialog = page.getByRole("dialog", { name: "Evaluate flow" });
    let runId = "";

    await test.step("Evaluate opens on Setup, ready to read Chat Output, with Next disabled", async () => {
      await openFlow(page, flow.id);
      await page.getByTestId("evaluate-btn-flow").click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("evaluate-step-setup")).toHaveAttribute("aria-current", "step");
      await expect(dialog.getByTestId("evaluate-ready")).toContainText("Chat Output");
      await expect(dialog.getByTestId("evaluate-next")).toBeDisabled();
    });

    await test.step("picking the dataset previews its rows and enables Next", async () => {
      await dialog.getByTestId("evaluate-dataset").click();
      await page.getByTestId("evaluate-dataset-search").fill(dataset.name);
      await page.getByRole("option", { name: new RegExp(escapeRegExp(dataset.name)) }).click();
      await expect(dialog.getByTestId("evaluate-dataset-preview")).toContainText("alpha");
      await expect(dialog.getByTestId("evaluate-next")).toBeEnabled();
      await dialog.getByTestId("evaluate-next").click();
    });

    await test.step("Scoring defaults to Exact match alone", async () => {
      await expect(dialog.getByTestId("evaluate-step-scoring")).toHaveAttribute("aria-current", "step");
      await expect(dialog.getByTestId("scorer-exact_match")).toHaveAttribute("aria-checked", "true");
      for (const other of ["contains", "similarity", "llm_judge"]) {
        await expect(dialog.getByTestId(`scorer-${other}`)).toHaveAttribute("aria-checked", "false");
      }
      await dialog.getByTestId("evaluate-next").click();
    });

    await test.step("Review estimates no model calls and names the flow and the dataset", async () => {
      await expect(dialog.getByTestId("evaluate-step-review")).toHaveAttribute("aria-current", "step");
      await expect(dialog.getByTestId("evaluate-estimate")).toHaveText(
        "No model calls: 2 rows run without spending tokens.",
      );
      await expect(dialog.getByTestId("evaluate-review")).toContainText(flow.name);
      await expect(dialog.getByTestId("evaluate-review")).toContainText(dataset.name);
    });

    await test.step("Create and run opens the evaluation on its run", async () => {
      await dialog.getByTestId("evaluate-submit").click();
      const landed = new RegExp(`/assets/evaluations/(${UUID})\\?run=(${UUID})`);
      await page.waitForURL(landed, { timeout: 30_000 });
      const [, evaluationId, run] = landed.exec(page.url())!;
      evaluations.track(evaluationId);
      runId = run;
    });

    await test.step("the run completes with 1 of 2 rows passed, in the API and on the page", async () => {
      const finished = await waitForRunEnd(request, headers, runId);
      expect(finished).toMatchObject({ status: "completed", total_items: 2, passed_items: 1, failed_items: 0 });
      expect(finished.summary?.pass_rate).toBe(0.5);

      await expect(page.getByTestId("run-status-completed")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("detail-tab-results").click();
      await expect(page.getByText("1 of 2 rows passed")).toBeVisible();
      await expect(page.getByText("Pass rate").locator("..")).toContainText("50%");
      await expect(page.getByTestId("results-filter-passed")).toContainText("1");
      await expect(page.getByTestId("results-filter-failed")).toContainText("1");
    });
  });
});
