// What a local Ollama instance really serves, read from the Ollama API itself (#1810).
//
// `assistant-ollama-provider.spec.ts` checks Langflow's view of Ollama against this
// oracle, so the oracle must not come from Langflow. It reads the same two endpoints
// Langflow's `get_ollama_models` reads — `GET /api/tags`, then `POST /api/show` per tag
// for its `capabilities` — but from the TEST host, through `OLLAMA_BASE_URL` (see
// `ollama-endpoint.ts` for why that is a different address from the one Langflow uses).
//
// Why the classes are shaped the way they are, measured on 1.13.0.dev12:
//
//  - Langflow lists an Ollama tag as an LLM when its capabilities include `completion`
//    (`get_ollama_llm_models`), and `fetch_live_ollama_models` then sets
//    `tool_calling = model_type == "llm"` for every one of them. So the Assistant's
//    "tool-calling models only" filter admits every completion tag, `tools` or not.
//    The spec bounds Langflow's list between `completionWithTools` (lower) and
//    `completion` (upper) instead of pinning either: equality with the upper bound
//    would encode that no-op, and equality with the lower bound would redden today on
//    an instance serving a completion model without `tools`.
//  - A tag whose capabilities could not be read is `unreadable`, and never counted as
//    "no completion". Langflow's own reader refuses to cache an empty capability list
//    for the same reason. An oracle that failed to read is unknown, not a verdict (#1012).

/** One tag and what `/api/show` said it can do; `null` when that could not be read. */
export interface OllamaTagCapabilities {
  name: string;
  capabilities: readonly string[] | null;
}

export interface OllamaCapabilityClasses {
  /** Every tag `/api/tags` reported, in the instance's order. */
  tags: string[];
  /** Tags whose capabilities include `completion` — what Langflow lists as Ollama LLMs. */
  completion: string[];
  /** The subset of `completion` that also declares `tools`. */
  completionWithTools: string[];
  /** Tags declaring `embedding` and not `completion`. */
  embeddingOnly: string[];
  /** Tags whose capabilities could not be read (failed call, missing or empty list). */
  unreadable: string[];
}

export function classifyOllamaCapabilities(
  entries: readonly OllamaTagCapabilities[],
): OllamaCapabilityClasses {
  const classes: OllamaCapabilityClasses = {
    tags: [],
    completion: [],
    completionWithTools: [],
    embeddingOnly: [],
    unreadable: [],
  };
  for (const { name, capabilities } of entries) {
    classes.tags.push(name);
    if (!capabilities || capabilities.length === 0) {
      classes.unreadable.push(name);
      continue;
    }
    if (capabilities.includes("completion")) {
      classes.completion.push(name);
      if (capabilities.includes("tools")) classes.completionWithTools.push(name);
    } else if (capabilities.includes("embedding")) {
      classes.embeddingOnly.push(name);
    }
  }
  return classes;
}

/** How a model list violates the bounds `completionWithTools ⊆ list ⊆ completion`. */
export interface OllamaModelListViolations {
  /** Tool-capable tags the list dropped (lower bound). */
  missing: string[];
  /** Listed names the instance does not serve as completion models (upper bound). */
  notCompletion: string[];
  /** Listed names that are embedding-only tags. */
  embeddingOnly: string[];
}

export function boundOllamaModelList(
  listed: readonly string[],
  classes: OllamaCapabilityClasses,
): OllamaModelListViolations {
  const present = new Set(listed);
  const completion = new Set(classes.completion);
  const embeddingOnly = new Set(classes.embeddingOnly);
  return {
    missing: classes.completionWithTools.filter((tag) => !present.has(tag)),
    notCompletion: listed.filter((name) => !completion.has(name)),
    embeddingOnly: listed.filter((name) => embeddingOnly.has(name)),
  };
}

export type AssistantTestModelResolution = { model: string } | { skipReason: string };

/**
 * The model the spec drives: the lane's pin when it set one, else the first
 * tool-capable completion tag, else the first completion tag, in the instance's order.
 *
 * Tool-capable first because such a tag is listed by the Assistant whether or not
 * upstream ever makes its tool-calling filter real for Ollama, while a plain completion
 * tag is listed only because that filter is a no-op today. A pin is never substituted —
 * a drifted image skips naming what IS available, so the skip reason says what to fix.
 */
export function resolveAssistantTestModel(
  classes: OllamaCapabilityClasses,
  pinned: string | undefined,
): AssistantTestModelResolution {
  const available = classes.tags.join(", ") || "none";
  if (pinned) {
    if (!classes.tags.includes(pinned)) {
      return {
        skipReason: `OLLAMA_TEST_MODEL "${pinned}" is not served by the local Ollama (has: ${available})`,
      };
    }
    if (!classes.completion.includes(pinned)) {
      return {
        skipReason: `OLLAMA_TEST_MODEL "${pinned}" is not a completion model on the local Ollama, so the Assistant cannot list it`,
      };
    }
    return { model: pinned };
  }
  const first = classes.completionWithTools[0] ?? classes.completion[0];
  if (!first) {
    return {
      skipReason: `the local Ollama serves no completion-capable model (has: ${available}) — pull one (e.g. \`ollama pull llama3.2:1b\`) or set OLLAMA_TEST_MODEL`,
    };
  }
  return { model: first };
}

/**
 * The parameter count a tag declares, in billions — `llama3.2:1b` → 1,
 * `qwen2.5:0.5b` → 0.5 — or `undefined` when it declares none that can be read
 * without guessing (`llama3.2:latest`, `mixtral:8x7b`, `gemma3:270m`).
 *
 * Only a digit run that starts a name segment and ends in `b` counts, so family
 * versions (`3.2`, `2.5`) are never mistaken for a size.
 */
export function declaredParameterCountB(tag: string): number | undefined {
  const match = /(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?=$|[-_:.])/i.exec(tag);
  return match ? Number(match[1]) : undefined;
}

/** The HTTP surface the reader needs. Narrow, so the unit lane can drive it with a fake. */
export interface OllamaHttp {
  get(
    url: string,
    options?: { timeout?: number },
  ): Promise<{ status(): number; json(): Promise<unknown> }>;
  post(
    url: string,
    options?: { data?: unknown; timeout?: number },
  ): Promise<{ status(): number; json(): Promise<unknown> }>;
}

export type OllamaOracle =
  | { reachable: true; classes: OllamaCapabilityClasses }
  | { reachable: false; reason: string };

const OLLAMA_READ_TIMEOUT_MS = 10000;

/** Read `/api/tags` and every tag's `/api/show` from the test host, then classify. */
export async function readOllamaCapabilities(
  http: OllamaHttp,
  baseUrl: string,
): Promise<OllamaOracle> {
  const root = baseUrl.replace(/\/+$/, "");
  let tags: string[];
  try {
    const res = await http.get(`${root}/api/tags`, { timeout: OLLAMA_READ_TIMEOUT_MS });
    if (res.status() !== 200) {
      return { reachable: false, reason: `local Ollama at ${root} answered ${res.status()} on /api/tags` };
    }
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> } | null;
    tags = (body?.models ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : ""))
      .filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { reachable: false, reason: `local Ollama not reachable at ${root} (${detail})` };
  }

  const entries = await Promise.all(
    tags.map(async (name): Promise<OllamaTagCapabilities> => {
      try {
        const res = await http.post(`${root}/api/show`, {
          data: { model: name },
          timeout: OLLAMA_READ_TIMEOUT_MS,
        });
        if (res.status() !== 200) return { name, capabilities: null };
        const body = (await res.json()) as { capabilities?: unknown } | null;
        const capabilities = Array.isArray(body?.capabilities)
          ? body.capabilities.filter((c): c is string => typeof c === "string")
          : null;
        return { name, capabilities };
      } catch {
        return { name, capabilities: null };
      }
    }),
  );
  return { reachable: true, classes: classifyOllamaCapabilities(entries) };
}
