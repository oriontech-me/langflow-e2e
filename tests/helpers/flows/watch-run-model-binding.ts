import type { Page, Request } from "@playwright/test";

/**
 * What model a Playground run ACTUALLY sends — the only observable that predicts
 * the executed model (#1372, #1678).
 *
 * `POST /api/v2/workflows` carries `data`, which `WorkflowRunRequest` declares as
 * an *"optional live-canvas override of the flow's nodes/edges"* that *"takes
 * priority over the saved flow data"*. The backend therefore builds that payload,
 * not the database row — so `GET /api/v1/flows/{id}` is not a weak observable
 * here, it is the wrong object, and polling it harder cannot close the gap.
 *
 * Measured on 1.13.0.dev19 (#1678): a stale `POST /api/v1/custom_component/update`
 * response blanks the canvas model field after the user's pick, the frontend
 * refills it from `__default_language_model__` or `options[0]`, and the run sends
 * that. With the send delayed 4 s — CI is slower than a dev box — 3 of 3 runs
 * carried `gpt-6-astra` / OpenAI on a flow configured for `gpt-4o-mini` /
 * OpenAI Compatible, and the spec PASSED, because OpenAI answered and echoed the
 * sentinel. Unmodified, it fires in ~9 of 33 runs. That is the #1169
 * silent-substitution class: a green run against a model nobody selected.
 */

/** The unified model selector stores an ARRAY of model objects; a bare string is the legacy shape. */
interface ModelEntry {
  name?: unknown;
  provider?: unknown;
}

export interface RunModelBinding {
  /** Did the run carry the live-canvas override at all? Absent `data` means the row ran. */
  hasData: boolean;
  /** The Language Model node the payload carried, or `null` when it carried none. */
  nodeId: string | null;
  /** Model names the run's node named, in payload order. */
  models: string[];
  /**
   * Providers for those models. A bare-string value yields a name with NO provider
   * rather than a guessed one — the provider is what the runtime derives the key
   * from (`instantiation.py` reads `model.value[0].provider`), so inventing one
   * would be worse than reporting none (#1334).
   */
  providers: string[];
  /** One line naming what the run sent — printed by the caller's failure message. */
  summary: string;
}

/** `pathname`, never the raw URL: the run endpoint already carries a query in the wild (#1644). */
function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

/** The run the Playground issues — NOT the 5 s `/pending` poll that shares the prefix. */
export function isRunRequest(request: Request): boolean {
  return request.method() === "POST" && pathnameOf(request.url()) === "/api/v2/workflows";
}

/**
 * Reads the model binding off a run-request body.
 *
 * Pure and total: every degradation (no body, no `data`, no model node, an emptied
 * value) resolves to a binding the caller can tell apart from a healthy one. It
 * never throws — a parser that throws on a shape the frontend changed would turn a
 * product finding into an unattributed test crash.
 */
export function parseRunModelBinding(body: unknown): RunModelBinding {
  const empty = (summary: string): RunModelBinding => ({
    hasData: false,
    nodeId: null,
    models: [],
    providers: [],
    summary,
  });

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return empty("the run request carried no live-canvas `data` payload (no JSON body read)");
  }

  const data = (body as { data?: { nodes?: unknown } }).data;
  if (data === null || typeof data !== "object") {
    return empty("the run request carried no live-canvas `data` payload — the saved flow ran");
  }

  const nodes = Array.isArray((data as { nodes?: unknown }).nodes)
    ? ((data as { nodes: unknown[] }).nodes as Array<{
        id?: unknown;
        data?: { node?: { template?: Record<string, { value?: unknown } | undefined> } };
      }>)
    : [];

  // Same identification `persistedModelBinding` uses: the unified model node is the
  // one whose template carries `model_name`. Node order follows the canvas.
  const node = nodes.find((n) => n?.data?.node?.template?.model_name !== undefined);
  if (!node) {
    return {
      hasData: true,
      nodeId: null,
      models: [],
      providers: [],
      summary: "the run's live-canvas payload carried no Language Model node",
    };
  }

  const nodeId = typeof node.id === "string" ? node.id : null;
  const rawValue = node.data?.node?.template?.model?.value;
  const entries: unknown[] = Array.isArray(rawValue)
    ? rawValue
    : rawValue === undefined || rawValue === null || rawValue === ""
      ? []
      : [rawValue];

  const models: string[] = [];
  const providers: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      models.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const { name, provider } = entry as ModelEntry;
      if (typeof name === "string") models.push(name);
      if (typeof provider === "string") providers.push(provider);
    }
  }

  const pairs =
    models.length === 0
      ? "no model at all"
      : models
          .map((m, i) => `${m} / ${providers[i] ?? "no provider observed"}`)
          .join(", ");

  return {
    hasData: true,
    nodeId,
    models,
    providers,
    summary: `the run sent ${pairs} on node ${nodeId ?? "(unidentified)"}`,
  };
}

export interface RunModelBindingCapture {
  /**
   * The binding the run carried. Resolves when the run request is issued — arm this
   * BEFORE the click that sends, or the capture races the request it is meant to read.
   */
  read(): Promise<RunModelBinding>;
}

/**
 * Arms a capture of the next Playground run request on this page.
 *
 * `page.waitForRequest` rather than a `page.on` collector on purpose: the caller
 * asserts on ONE run, and a listener left collecting would also pick up a later run
 * from the same page and report the wrong one.
 */
export function armRunModelBinding(
  page: Page,
  options: { timeout?: number } = {},
): RunModelBindingCapture {
  const pending = page.waitForRequest(isRunRequest, { timeout: options.timeout ?? 30000 });
  return {
    async read(): Promise<RunModelBinding> {
      const request = await pending;
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      return parseRunModelBinding(body);
    },
  };
}
