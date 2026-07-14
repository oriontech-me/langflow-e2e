import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

const TRACE_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/basic-prompting-trace-fixture.json",
    ),
    "utf8",
  ),
);

// Cheap, fast OpenAI model — enough to emit a real LLM span with token usage.
const MODEL_NAME = "gpt-4o-mini";

type Span = { children?: Span[] } & Record<string, unknown>;

function flattenSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    out.push(span);
    const children = Array.isArray(span.children) ? span.children : [];
    out.push(...flattenSpans(children));
  }
  return out;
}

// Langflow emits TWO spans of type "llm" for a single model call: the
// component-level "Language Model" span (tokenUsage + latencyMs but
// modelName === null) and the inner provider span (e.g. "ChatOpenAI
// gpt-4o-mini") that carries gen_ai.response.model and therefore the only
// populated `modelName`. The fallback to a name match guards against a future
// version that stops tagging the model call with type === "llm".
function findLlmSpans(allSpans: Span[]): Span[] {
  const byType = allSpans.filter((s) => s.type === "llm");
  if (byType.length > 0) return byType;
  return allSpans.filter(
    (s) =>
      typeof s.name === "string" &&
      /(chatopenai|language model)/i.test(s.name),
  );
}

// The LanguageModelComponent node carries a random id suffix that could change
// if the fixture is regenerated — resolve it from the fixture instead of
// hardcoding so the run tweak always targets the right component.
function languageModelNodeId(): string {
  const nodes = TRACE_FIXTURE.data?.nodes ?? [];
  const node = nodes.find(
    (n: { data?: { type?: string } }) =>
      n.data?.type === "LanguageModelComponent",
  );
  if (!node?.id) {
    throw new Error(
      "basic-prompting-trace-fixture.json no longer contains a LanguageModelComponent node",
    );
  }
  return node.id;
}

test.describe("Single trace — populated LLM span (OpenAI)", () => {
  test.describe.configure({ mode: "serial" });

  // A real LLM call is the whole point of this spec — without a key the
  // tokenUsage / modelName / latencyMs values can never populate.
  test.skip(
    !process?.env?.OPENAI_API_KEY,
    "OPENAI_API_KEY required to run this test",
  );

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let traceId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-detail-llm-span-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    const flowRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        ...TRACE_FIXTURE,
        name: `${TRACE_FIXTURE.name} ${Date.now()}`,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;

    // Run the flow with the OpenAI provider injected via tweaks. Unlike the
    // sibling shape spec (traces-detail-single.spec.ts), this run must SUCCEED:
    // get_llm in Langflow only writes gen_ai.usage.* / gen_ai.response.model
    // span attributes on a completed LLM call, and those are the source of
    // tokenUsage and modelName. The model value mirrors the unified ModelInput
    // wire format (a one-element list of {name, provider}); api_key overrides
    // the (absent) global provider key.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "Reply with the single word: pong",
        input_type: "chat",
        output_type: "chat",
        tweaks: {
          [languageModelNodeId()]: {
            model: [{ name: MODEL_NAME, provider: "OpenAI" }],
            api_key: process.env.OPENAI_API_KEY,
          },
        },
      },
    });
    // A populated trace requires a successful run — a 500 here means the LLM
    // call failed and the span attributes would be empty. Fail fast.
    expect(runRes.status()).toBe(200);

    // Trace writes are asynchronous: poll the list endpoint until a trace lands
    // for this flow. Capture the id inside the poll closure to avoid a redundant
    // re-fetch (and the row-shift race that comes with it).
    let polledTraceId: string | null = null;
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return null;
          const body = await res.json();
          polledTraceId = body.traces?.[0]?.id ?? null;
          return polledTraceId;
        },
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .not.toBeNull();

    expect(polledTraceId).not.toBeNull();
    traceId = polledTraceId!;
  });

  test.afterAll(async ({ request }) => {
    // allSettled so a failed flow delete does not skip the key delete (and vice
    // versa). Flow delete uses the bearer token (not the api_key) so the two
    // deletes can run concurrently without racing on auth.
    const cleanups: Promise<unknown>[] = [];
    if (flowId) {
      cleanups.push(
        deleteFlow(request, flowId, {
          headers: { Authorization: bearerToken },
        }),
      );
    }
    if (apiKeyId) {
      cleanups.push(
        request.delete(`/api/v1/api_key/${apiKeyId}`, {
          headers: { Authorization: bearerToken },
        }),
      );
    }
    await Promise.allSettled(cleanups);
  });

  test(
    "GET /api/v1/monitor/traces/{trace_id} returns a populated tokenUsage + modelName on the LLM span",
    { tag: ["@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const res = await request.get(`/api/v1/monitor/traces/${traceId}`, {
        headers: { Authorization: bearerToken },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.spans)).toBe(true);

      // The provider span carries ALL three of the issue-#306 values
      // (tokenUsage, modelName, latencyMs), so it is the one this spec pins.
      const llmSpans = findLlmSpans(flattenSpans(body.spans));
      expect(
        llmSpans.length,
        "no LLM span found in the trace tree",
      ).toBeGreaterThan(0);

      // The provider call span is the one carrying a populated modelName. A
      // regression that dropped gen_ai.response.model from the provider span
      // would leave every llm span with modelName === null and fail here.
      const llmSpan = llmSpans.find(
        (s) => typeof s.modelName === "string" && (s.modelName as string),
      );
      expect(
        llmSpan,
        "no LLM span carries a populated modelName",
      ).toBeTruthy();

      // tokenUsage is a non-null object with three numeric token counts > 0.
      const tokenUsage = llmSpan!.tokenUsage as {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      } | null;
      expect(tokenUsage).not.toBeNull();
      expect(typeof tokenUsage).toBe("object");
      expect(typeof tokenUsage!.promptTokens).toBe("number");
      expect(typeof tokenUsage!.completionTokens).toBe("number");
      expect(typeof tokenUsage!.totalTokens).toBe("number");
      expect(tokenUsage!.promptTokens).toBeGreaterThan(0);
      expect(tokenUsage!.completionTokens).toBeGreaterThan(0);
      expect(tokenUsage!.totalTokens).toBeGreaterThan(0);

      // total is derived as prompt + completion (formatting.py:103) — pin the
      // arithmetic so a regression that drops one component surfaces here.
      expect(tokenUsage!.totalTokens).toBe(
        tokenUsage!.promptTokens + tokenUsage!.completionTokens,
      );

      // modelName is read from the gen_ai.response.model span attribute
      // (formatting.py:124), which Langflow populates from the request's
      // invocation params — so for this flow it is exactly the requested id
      // ("gpt-4o-mini"). Assert containment rather than equality so a future
      // provider that echoes back a resolved id with a suffix (e.g.
      // "gpt-4o-mini-2024-07-18") still passes.
      expect(typeof llmSpan!.modelName).toBe("string");
      expect((llmSpan!.modelName as string).length).toBeGreaterThan(0);
      expect((llmSpan!.modelName as string).toLowerCase()).toContain(
        MODEL_NAME,
      );

      // A real LLM call always takes measurable wall-clock time.
      expect(typeof llmSpan!.latencyMs).toBe("number");
      expect(llmSpan!.latencyMs as number).toBeGreaterThan(0);
    },
  );
});
