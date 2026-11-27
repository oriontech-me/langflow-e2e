import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../helpers/auth/throwaway-user";
import { buildCatalogFlow, fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  MOCK_MODEL_ID,
  MOCK_RATE_LIMIT_MESSAGE,
  type MockRequest,
  type RateLimitMock,
  startRateLimitMock,
} from "../../../helpers/mocks/rate-limit-openai-mock";
import { hasProviderEnvKeys, missingProviderEnvKeys } from "../../../helpers/provider-setup";
import { langflowProviderName } from "../../../helpers/provider-setup/provider-config";
import { resolveTestTargets } from "../../../helpers/provider-setup/test-targets";

// Batch Run (`BatchRunComponent`, llm_operations) — one model call per table row, in
// batches, and the rate-limit retry added in 1.14 (#2572, upstream #16024).
// Spec doc: docs/core-components/batch-run-component.md
//
// Test 1 runs on a real provider (the lane's any-completion target): N rows in, N
// outputs in order, none empty. Tests 2–4 point the model at a local OpenAI-compatible
// mock that Langflow calls (tests/helpers/mocks/rate-limit-openai-mock.ts): it echoes
// each row, so the outputs are exact, it records every request with its arrival time,
// so batches and retries are seen rather than guessed, and it answers 429 on demand,
// which no real provider does.
//
// The mock is configured as the "OpenAI Compatible" provider of a throwaway user, never
// of the superuser: provider configuration is per user, and other specs assert that
// provider unconfigured on the superuser.
//
// Measured on 1.14.0.dev39: the OpenAI SDK under the model retries a 429 by itself (3
// attempts per request), so Batch Run only sees a 429 that came back 3 times in a row.
// The mock's 429 count is per row for that reason.

const SOURCE = "CreateList-rows";
const BATCH = "BatchRun-run";
const PROVIDER_NAME = "OpenAI Compatible";
/** Attempts the OpenAI SDK makes for one request before the 429 reaches Batch Run (measured). */
const CLIENT_ATTEMPTS = 3;
const BUILD_TIMEOUT_MS = 240_000;

type ModelOption = { name: string; provider: string; [k: string]: unknown };
type Row = { text: string; model_response: string; batch_index: number; metadata?: Record<string, unknown> };
type BatchOutcome = { valid: boolean; rows: Row[]; error: string };

function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The model options the server offers this user, as the editor's model picker reads them. */
async function modelOptions(
  request: APIRequestContext,
  headers: Record<string, string>,
  catalog: Record<string, unknown>,
): Promise<ModelOption[]> {
  const component = (catalog.llm_operations as Record<string, { template: Record<string, { value?: unknown }> }>)
    .BatchRunComponent;
  const res = await request.post("/api/v1/custom_component/update", {
    headers,
    data: {
      code: component.template.code.value,
      template: component.template,
      field: "model",
      field_value: "",
      tool_mode: false,
    },
  });
  const raw = await res.text();
  expect(res.status(), `POST /api/v1/custom_component/update (model options) — ${raw.slice(0, 300)}`).toBe(200);
  return (JSON.parse(raw).template.model.options ?? []) as ModelOption[];
}

/**
 * Creates Create List → Batch Run with these rows and Batch Run values, builds Batch
 * Run, and returns its outcome: the result rows, or the error it ended with.
 */
async function runBatch(
  request: APIRequestContext,
  headers: Record<string, string>,
  catalog: Record<string, unknown>,
  rows: string[],
  values: Record<string, unknown>,
  track: (flowId: string) => void,
): Promise<BatchOutcome> {
  const data = buildCatalogFlow(catalog, {
    nodes: [
      { id: SOURCE, type: "CreateList", values: { texts: rows }, selectedOutput: "dataframe" },
      { id: BATCH, type: "BatchRunComponent", values: { column_name: "text", ...values } },
    ],
    edges: [{ source: SOURCE, output: "dataframe", target: BATCH, field: "df" }],
  });
  const created = await request.post("/api/v1/flows/", { headers, data: { name: `E2E batch run ${uid()}`, data } });
  const createdRaw = await created.text();
  expect(created.status(), `POST /api/v1/flows/ — ${createdRaw.slice(0, 300)}`).toBe(201);
  const flowId = JSON.parse(createdRaw).id as string;
  track(flowId);

  const started = await request.post(`/api/v1/build/${flowId}/flow?log_builds=false&stop_component_id=${BATCH}`, {
    headers,
    data: { data },
  });
  const startedRaw = await started.text();
  expect(started.status(), `POST /api/v1/build/{id}/flow — ${startedRaw.slice(0, 300)}`).toBe(200);
  const jobId = JSON.parse(startedRaw).job_id as string;
  const events = await request.get(`/api/v1/build/${jobId}/events`, { headers, timeout: BUILD_TIMEOUT_MS });
  expect(events.status(), "GET /api/v1/build/{job}/events").toBe(200);

  const ends = (await events.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { event?: string; data?: { build_data?: Record<string, any> } })
    .filter((e) => e.event === "end_vertex" && e.data?.build_data?.id === BATCH);
  expect(ends, "Batch Run ended once").toHaveLength(1);
  const build = ends[0].data!.build_data!;
  const message = build.data?.outputs?.batch_results?.message;
  if (build.valid) return { valid: true, rows: message as Row[], error: "" };
  return { valid: false, rows: [], error: String(message?.errorMessage ?? build.params ?? "") };
}

/** Groups requests whose arrival times are within `gapMs` of the previous one. */
function groupsByArrival(requests: MockRequest[], gapMs: number): MockRequest[][] {
  const groups: MockRequest[][] = [];
  for (const r of requests) {
    const last = groups[groups.length - 1];
    if (last && r.at - last[last.length - 1].at < gapMs) last.push(r);
    else groups.push([r]);
  }
  return groups;
}

test.describe("Batch Run — on a real provider", () => {
  for (const { label, options, skipReason } of resolveTestTargets({ tier: "any-completion" })) {
    test(
      `N rows in, N non-empty outputs in order, with metadata (${label})`,
      { tag: ["@stable", "@components", "@model-provider"] },
      async ({ request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        // Same gates as the agent specs: a target with no provider (a MODEL_TEST_ID not in
        // models.json) or no key in the environment is skipped with the reason.
        test.skip(!options.provider, `no provider resolved for ${label}: run the Collect models sweep or set MODEL_TEST_PROVIDER`);
        const provider = options.provider!;
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );
        test.setTimeout(BUILD_TIMEOUT_MS + 60_000);
        const headers = { Authorization: await getAuthToken(request) };
        const catalog = await fetchComponentCatalog(request, headers);
        const flows: string[] = [];
        const providerName = langflowProviderName(provider);
        const rows = ["Reply with one word: red", "Reply with one word: blue", "Reply with one word: green", "Reply with one word: white"];

        try {
          const option = (await modelOptions(request, headers, catalog)).find(
            (o) => o.provider === providerName && o.name === options.model,
          );
          expect(
            option,
            `the model picker offers ${providerName} / ${options.model} (is the provider configured? the Collect models sweep does it)`,
          ).toBeTruthy();

          const outcome = await runBatch(
            request,
            headers,
            catalog,
            rows,
            { model: [option], batch_size: 2, enable_metadata: true },
            (id) => flows.push(id),
          );

          await test.step("the build succeeds with one output row per input row", async () => {
            expect(outcome.error, "Batch Run's error").toBe("");
            expect(outcome.valid).toBe(true);
            expect(outcome.rows).toHaveLength(rows.length);
          });

          await test.step("the rows keep their order, and each has a non-empty response and its metadata", async () => {
            expect(outcome.rows.map((r) => r.text)).toEqual(rows);
            expect(outcome.rows.map((r) => r.batch_index)).toEqual(rows.map((_, i) => i));
            for (const [i, row] of outcome.rows.entries()) {
              expect(typeof row.model_response, `row ${i}'s response`).toBe("string");
              expect(row.model_response.trim().length, `row ${i}'s response is not empty`).toBeGreaterThan(0);
              expect(row.metadata, `row ${i}'s metadata`).toMatchObject({
                processing_status: "success",
                input_format: "column",
                input_length: rows[i].length,
                response_length: row.model_response.length,
                has_system_message: false,
              });
            }
          });
        } finally {
          for (const id of flows) await deleteFlow(request, id, { headers });
        }
      },
    );
  }
});

test.describe("Batch Run — batches and the rate-limit retry, against a local mock", () => {
  // One mock and one user for the block: the mock's record is reset per test.
  test.describe.configure({ mode: "serial" });

  let mock: RateLimitMock;
  let superHeaders: Record<string, string>;
  let user: ThrowawayUser;
  let catalog: Record<string, unknown>;
  let option: ModelOption;
  const users: ThrowawayUser[] = [];

  test.beforeAll(async ({ request, playwright, baseURL }) => {
    mock = await startRateLimitMock();
    superHeaders = { Authorization: await getAuthToken(request) };
    user = await createThrowawayUser(request, {
      superHeaders,
      newContext: () => playwright.request.newContext({ baseURL }),
      prefix: "batchrun",
      track: (u) => users.push(u),
    });
    // The provider's base URL, then its key: the key write is the one the server
    // validates, against the base URL already stored (openai-compatible-provider-setup.spec.ts).
    for (const variable of [
      { name: "OPENAI_COMPATIBLE_BASE_URL", value: mock.baseUrlForLangflow, type: "Global" },
      { name: "OPENAI_COMPATIBLE_API_KEY", value: "e2e-mock-key", type: "Credential" },
    ]) {
      const res = await user.request.post("/api/v1/variables/", {
        headers: user.headers,
        data: { ...variable, default_fields: [], category: "Global" },
      });
      expect(res.status(), `POST /api/v1/variables/ ${variable.name} — ${(await res.text()).slice(0, 300)}`).toBe(201);
    }
    catalog = await fetchComponentCatalog(user.request, user.headers);
    const offered = await modelOptions(user.request, user.headers, catalog);
    const found = offered.find((o) => o.provider === PROVIDER_NAME && o.name === MOCK_MODEL_ID);
    expect(
      found,
      `the mock's model is offered: Langflow reached ${mock.baseUrlForLangflow} (offered: ${offered
        .map((o) => `${o.provider}/${o.name}`)
        .join(", ")})`,
    ).toBeTruthy();
    option = found!;
  });

  test.afterAll(async ({ request }) => {
    const failures: string[] = [];
    // The user's flows and variables go with the user.
    for (const u of users.splice(0)) {
      await deleteThrowawayUser(request, superHeaders, u).catch((e: unknown) => failures.push(String(e)));
    }
    await mock?.close();
    expect(failures, "teardown leaves nothing behind").toEqual([]);
  });

  const run = (rows: string[], values: Record<string, unknown>) =>
    runBatch(user.request, user.headers, catalog, rows, { model: [option], ...values }, () => undefined);

  test(
    "rows run in batches of batch_size with the delay between them, in order, with and without metadata",
    { tag: ["@stable", "@components", "@model-provider"] },
    async () => {
      test.setTimeout(BUILD_TIMEOUT_MS);
      const rows = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`, `d-${uid()}`, `e-${uid()}`];

      await test.step("5 rows, batch_size 2, 1 s between batches: every row echoed, in order", async () => {
        mock.reset({ responseDelayMs: 300 });
        const outcome = await run(rows, { batch_size: 2, delay_between_batches: 1.0, enable_metadata: true });
        expect(outcome.error).toBe("");
        expect(outcome.rows.map((r) => [r.text, r.model_response, r.batch_index])).toEqual(
          rows.map((text, i) => [text, `ECHO:${text}`, i]),
        );
        for (const row of outcome.rows) {
          expect(row.metadata).toEqual({
            has_system_message: false,
            input_length: row.text.length,
            input_format: "column",
            response_length: row.model_response.length,
            processing_status: "success",
          });
        }
      });

      await test.step("the mock saw three batches of 2, 2 and 1, at least the delay apart", async () => {
        const requests = mock.completions();
        expect(requests.every((r) => r.status === 200)).toBe(true);
        // Requests of one batch are sent together; the next batch waits for the slowest
        // response (300 ms) plus the delay (1 s), so ≥ 1 300 ms. A 1 s window tolerates a
        // backend stall between two sends of one batch and still separates the batches.
        const groups = groupsByArrival(requests, 1_000);
        expect(groups.map((g) => g.map((r) => r.user).sort())).toEqual([
          [rows[0], rows[1]].sort(),
          [rows[2], rows[3]].sort(),
          [rows[4]],
        ]);
        for (let i = 1; i < groups.length; i++) {
          expect(groups[i][0].at - groups[i - 1][0].at, `batch ${i + 1} starts after the delay`).toBeGreaterThanOrEqual(1_250);
        }
      });

      await test.step("with metadata off, no row carries it", async () => {
        mock.reset();
        const outcome = await run(rows.slice(0, 2), { enable_metadata: false });
        expect(outcome.error).toBe("");
        expect(outcome.rows).toHaveLength(2);
        for (const row of outcome.rows) expect(row).not.toHaveProperty("metadata");
      });
    },
  );

  test(
    "a 429 the client gives up on is retried by Batch Run, one request at a time, and every row still comes back in order",
    { tag: ["@stable", "@components", "@model-provider"] },
    async () => {
      test.setTimeout(BUILD_TIMEOUT_MS);
      const rows = [`p-${uid()}`, `q-${uid()}`, `r-${uid()}`];
      mock.reset({ rateLimitFirstPerMessage: CLIENT_ATTEMPTS, retryAfterSeconds: 0, responseDelayMs: 300 });

      const outcome = await run(rows, { batch_size: 3, max_rate_limit_retries: 1 });

      await test.step("the build succeeds with every row echoed, in order", async () => {
        expect(outcome.error).toBe("");
        expect(outcome.rows.map((r) => [r.text, r.model_response])).toEqual(rows.map((t) => [t, `ECHO:${t}`]));
      });

      await test.step("each row was refused by every client attempt, then sent once more by Batch Run", async () => {
        const requests = mock.completions();
        for (const row of rows) {
          expect(
            requests.filter((r) => r.user === row).map((r) => r.status),
            `requests for ${row}`,
          ).toEqual([...Array(CLIENT_ATTEMPTS).fill(429), 200]);
        }
      });

      await test.step("the retry came from Batch Run, not from the client: no row succeeded before every row's last 429", async () => {
        // The client retries each row on its own schedule; Batch Run retries only once the
        // whole batch has settled. A fourth client attempt would interleave with the 429s.
        const requests = mock.completions();
        const lastRefusal = Math.max(...requests.filter((r) => r.status === 429).map((r) => r.at));
        const firstSuccess = Math.min(...requests.filter((r) => r.status === 200).map((r) => r.at));
        expect(firstSuccess, "the first 200 comes after the last 429").toBeGreaterThan(lastRefusal);
      });

      await test.step("after the 429s the batch size dropped from 3 to 1: the retries ran one after another", async () => {
        const successes = mock.completions().filter((r) => r.status === 200);
        expect(successes).toHaveLength(rows.length);
        for (let i = 1; i < successes.length; i++) {
          expect(
            successes[i].at - successes[i - 1].at,
            "each retry waits for the previous response (300 ms): one request per batch",
          ).toBeGreaterThanOrEqual(250);
        }
      });
    },
  );

  test(
    "with no retries left, the rate limit fails the build with the provider's 429",
    { tag: ["@stable", "@components", "@model-provider"] },
    async () => {
      test.setTimeout(BUILD_TIMEOUT_MS);
      const row = `x-${uid()}`;
      mock.reset({ rateLimitFirstPerMessage: CLIENT_ATTEMPTS, retryAfterSeconds: 0 });

      const outcome = await run([row], { max_rate_limit_retries: 0 });

      expect(outcome.valid, "Batch Run failed").toBe(false);
      expect(outcome.error).toContain("Error code: 429");
      expect(outcome.error).toContain(MOCK_RATE_LIMIT_MESSAGE);
      expect(
        mock.completions().map((r) => r.status),
        "only the client's own attempts: Batch Run did not retry",
      ).toEqual(Array(CLIENT_ATTEMPTS).fill(429));
    },
  );
});
