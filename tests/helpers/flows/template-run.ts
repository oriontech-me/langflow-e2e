/**
 * Shared helpers for the template-execution specs (`templates-run-*.spec.ts`, #2467).
 *
 * Every spec in that family creates a template's flow from its `basic_examples` entry
 * through the API, pins it, runs it from the Playground, and reads the run back. Until
 * #2467 each spec carried its own copy of these helpers, and the copies had already
 * diverged (`ranFieldValue` in two specs, `ranField` in the third). A fix that reaches one
 * copy and not the others is the failure #1108 recorded, so they live here once.
 *
 * Layering: the graph helpers are pure and covered by `template-run.test.ts`. The two
 * request helpers and the page helpers hold I/O only; the specs hold the assertions.
 */
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { retryOnDroppedConnection } from "../api/retry-on-dropped-connection";

/** A field of a node's `template`. `file_path` is the Read File node's server path. */
export type TemplateField =
  | { value?: unknown; options?: unknown[]; type?: string; file_path?: unknown }
  | undefined;

export interface FlowNode {
  id: string;
  /** `genericNode` for a component; anything else is a note. */
  type?: string;
  data?: {
    type?: string;
    showNode?: boolean;
    node?: { tool_mode?: boolean; template?: Record<string, TemplateField> };
  };
}

export interface FlowEdge {
  source: string;
  target: string;
  data?: { targetHandle?: { fieldName?: string } };
}

export interface FlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  [key: string]: unknown;
}

/** One entry of `GET /api/v1/model_options/language` — the picker's own option shape. */
export interface ModelOption {
  name?: string;
  provider?: string;
  [key: string]: unknown;
}

const BASIC_EXAMPLES_URL = "/api/v1/flows/basic_examples/";
const MODEL_OPTIONS_URL = "/api/v1/model_options/language";

/** The template as the image registers it, deep-copied so the pins never leak. */
export async function readTemplate(
  request: APIRequestContext,
  name: string,
  headers: Record<string, string>,
): Promise<{ data: FlowData; description: string }> {
  // Idempotent reads re-dial once on a dropped pooled socket (the ~2 s keep-alive edge,
  // measured on 1.14.0.dev29); a response is passed through untouched.
  const res = await retryOnDroppedConnection(() => request.get(BASIC_EXAMPLES_URL, { headers }));
  if (res.status() !== 200) {
    throw new Error(
      `GET ${BASIC_EXAMPLES_URL} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`,
    );
  }
  const listing = (await res.json()) as Array<{
    name?: string;
    description?: string;
    data?: FlowData;
  }>;
  const entry = listing.find((f) => f.name === name);
  if (!entry?.data) {
    throw new Error(
      `Template "${name}" is not in ${BASIC_EXAMPLES_URL} (registered: ` +
        `${listing.map((f) => f.name).join(", ")}). templates-registration.spec.ts ` +
        `names a missing template; this spec cannot run one that is not there.`,
    );
  }
  return {
    data: JSON.parse(JSON.stringify(entry.data)) as FlowData,
    description: entry.description ?? "",
  };
}

/**
 * The option the model picker would write for `model`. `model_options/language` lists
 * only the models enabled on the instance, so a model collect-models did not enable is
 * absent here — and the test stops instead of running a model nobody chose. A Language
 * Model node in `basic_examples` ships with empty `options`, so the template cannot
 * supply it (measured on 1.14.0.dev29).
 */
export async function resolveModelOption(
  request: APIRequestContext,
  model: string,
  headers: Record<string, string>,
): Promise<ModelOption> {
  const res = await retryOnDroppedConnection(() => request.get(MODEL_OPTIONS_URL, { headers }));
  if (res.status() !== 200) {
    throw new Error(
      `GET ${MODEL_OPTIONS_URL} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`,
    );
  }
  const options = (await res.json()) as ModelOption[];
  const option = options.find((o) => o.name === model && o.provider === "OpenAI");
  if (!option) {
    throw new Error(
      `${model} / OpenAI is not an enabled language model on this instance ` +
        `(${MODEL_OPTIONS_URL} lists: ` +
        `${options.map((o) => `${o.name} / ${o.provider}`).join(", ")}). Run ` +
        "`npx playwright test tests/collect-models.spec.ts` first.",
    );
  }
  return option;
}

/** The component nodes of a graph — every node that is not a note. */
export function componentNodes(data: FlowData): FlowNode[] {
  return data.nodes.filter((n) => n.type === "genericNode");
}

export function nodesOfType(data: FlowData, type: string): FlowNode[] {
  return componentNodes(data).filter((n) => n.data?.type === type);
}

/**
 * The one component node of `type` in the template. Exactly one, because the pins and the
 * locators keyed on it would otherwise pick a node at random — a template that gained a
 * second one must be re-read by a human.
 */
export function onlyNode(data: FlowData, type: string, template: string): FlowNode {
  const matches = nodesOfType(data, type);
  if (matches.length !== 1) {
    throw new Error(
      `Template "${template}" has ${matches.length} "${type}" component(s); this spec ` +
        `expects exactly one. The template changed upstream — re-read it before pinning.`,
    );
  }
  return matches[0];
}

/** A node's template field, or a throw — a pin on a missing field would silently do nothing. */
export function field(node: FlowNode, name: string, template: string): NonNullable<TemplateField> {
  const f = node.data?.node?.template?.[name];
  if (!f) {
    throw new Error(
      `Template "${template}": node ${node.id} (${node.data?.type}) has no ` +
        `template.${name} field — the pin would silently leave it unset.`,
    );
  }
  return f;
}

/**
 * The component nodes whose output-inspection control a run must turn disabled → enabled.
 * A tool-mode node builds only when the model calls it, and a `showNode: false` node
 * renders no control, so both are left out.
 */
export function buildableNodes(data: FlowData): Array<{ id: string; type: string }> {
  return componentNodes(data)
    .filter((n) => n.data?.node?.tool_mode !== true && n.data?.showNode !== false)
    .map((n) => ({ id: n.id, type: n.data?.type ?? "" }));
}

/**
 * A node field as the run carried it, read off the object the run builds from: the
 * request's live-canvas `data` (which takes priority over the saved flow, #1372), or —
 * when the request carried none — the saved flow itself. `savedFlow` is called only then.
 */
export async function ranField(
  runBody: unknown,
  savedFlow: () => Promise<FlowData>,
  nodeId: string,
  fieldName: string,
): Promise<TemplateField> {
  const live = (runBody as { data?: { nodes?: unknown } } | null)?.data?.nodes;
  const nodes = Array.isArray(live) ? (live as FlowNode[]) : (await savedFlow()).nodes;
  return nodes.find((n) => n?.id === nodeId)?.data?.node?.template?.[fieldName];
}

/** `name / provider` for each entry of a unified model selector value. */
export function modelPairs(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map((e) =>
    e !== null && typeof e === "object"
      ? `${(e as { name?: unknown }).name} / ${(e as { provider?: unknown }).provider}`
      : String(e),
  );
}

/** The node's output-inspection control: disabled until the node has an output. */
export function inspectionControl(page: Page, nodeId: string): Locator {
  return page.locator(`[data-id="${nodeId}"] [data-testid^="output-inspection-"]`);
}

/** The output-inspection dialog (it is the only dialog carrying the copy button). */
export function outputDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByTestId("copy-output-button") });
}

/**
 * Closes the output dialog through its own button and proves it closed. Escape does not
 * close it reliably — not at all while focus is inside a results grid (measured on
 * 1.13.0.dev25) — and a dialog left open intercepts every later click on the canvas.
 */
export async function closeOutputDialog(page: Page): Promise<void> {
  const dialog = outputDialog(page);
  await dialog.getByTestId("btn-close-modal").click();
  await expect(dialog).toBeHidden({ timeout: 5000 });
}

/**
 * Opens a node's text output through the control `testId`, returns the text it shows, and
 * closes the dialog again. The caller asserts on the returned text.
 */
export async function readNodeOutput(page: Page, nodeId: string, testId: string): Promise<string> {
  await page.locator(`[data-id="${nodeId}"]`).getByTestId(testId).click();
  const text = outputDialog(page).locator("textarea");
  await expect(text).toBeVisible({ timeout: 15000 });
  const value = await text.inputValue();
  await closeOutputDialog(page);
  return value;
}
