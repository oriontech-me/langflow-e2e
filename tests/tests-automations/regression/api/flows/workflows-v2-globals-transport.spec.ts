import { readFileSync } from "fs";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Workflows v2 — the request-level variable transport (#2570, upstream #16350).
 * See docs/api/flows/workflows-v2-globals-transport.md.
 *
 * The flow is Chat Input -> Chat Output (the echo fixture), with the Chat Input's
 * `input_value` bound to a stored global variable (`load_from_db`). No request sends
 * `input_value`, so a run's output is exactly what the variable resolved to: the
 * stored value, or a request-level override.
 */

const FIXTURE = "tests/assets/flows/chat-io-ok-trace-fixture.json";
const CHAT_INPUT_NODE_ID = "ChatInput-b6UCc";
const CHAT_OUTPUT_NODE_ID = "ChatOutput-yK0AU";

const LEGACY_HEADER_DETAIL = {
  error: "Legacy header transport not supported",
  code: "LEGACY_GLOBAL_VAR_HEADER",
  message:
    "The X-LANGFLOW-GLOBAL-VAR-* header transport is no longer supported on the v2 workflow API. " +
    'Pass request-level variables in the JSON body under "globals" (applied in sync mode only) instead.',
};

type Mode = "sync" | "stream" | "background";

/** How long the refused sessions are watched for a message (see Test 1's last step). */
const NOTHING_RAN_WINDOW_MS = 3_000;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Workflows v2 — the request-level variable transport", () => {
  // Per-run values: no other worker's variable or flow can satisfy an assertion.
  // The name must stay upper-case: v1 maps a header name to a variable by
  // upper-casing what follows the prefix, so a mixed-case name breaks Test 4.
  const variableName = `E2E_GV_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const storedValue = unique("stored");
  const sentinel = unique("sentinel");

  let bearer: string;
  let flowId: string | undefined;
  let variableId: string | undefined;
  let apiKeyId: string | undefined;
  let apiKey: string;

  test.beforeAll(async ({ request }) => {
    bearer = await getAuthToken(request);
    const auth = { Authorization: bearer };

    // v1 answers 403 to a bearer token under AUTO_LOGIN; it needs an API key.
    const key = await createApiKey(request, auth, { namePrefix: "e2e-globals-transport" });
    apiKeyId = key.id;
    apiKey = key.key;

    const varRes = await request.post("/api/v1/variables/", {
      headers: auth,
      data: { name: variableName, value: storedValue, type: "Generic", default_fields: [] },
    });
    expect(varRes.status(), `POST /api/v1/variables/ — ${await varRes.text()}`).toBe(201);
    variableId = (await varRes.json()).id;
    expect(variableId, "the variable creation returns its id").toBeTruthy();

    const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    const chatInput = fixture.data.nodes.find((n: { id: string }) => n.id === CHAT_INPUT_NODE_ID);
    expect(chatInput, `the fixture still has ${CHAT_INPUT_NODE_ID}`).toBeTruthy();
    chatInput.data.node.template.input_value.value = variableName;
    chatInput.data.node.template.input_value.load_from_db = true;
    flowId = await createFlow(
      request,
      { name: unique("Globals Transport"), data: fixture.data, is_component: false },
      { headers: auth },
    );
  });

  test.afterAll(async ({ request }) => {
    // Each deletion is independent: one failure must not strand the others.
    const auth = { Authorization: bearer };
    const failures: string[] = [];
    if (flowId) await deleteFlow(request, flowId, { headers: auth }).catch((e) => failures.push(String(e)));
    if (variableId) {
      const res = await request.delete(`/api/v1/variables/${variableId}`, { headers: auth });
      if (!res.ok() && res.status() !== 404) failures.push(`variable cleanup: ${res.status()}`);
    }
    if (apiKeyId) await deleteApiKey(request, apiKeyId, auth).catch((e) => failures.push(String(e)));
    expect(failures, "teardown must delete everything this file created").toEqual([]);
  });

  function postV2(
    request: APIRequestContext,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<APIResponse> {
    return request.post("/api/v2/workflows", {
      headers: { Authorization: bearer, ...extraHeaders },
      data: { flow_id: flowId, ...body },
    });
  }

  async function syncOutput(res: APIResponse): Promise<unknown> {
    const body = await res.json();
    return body?.outputs?.[CHAT_OUTPUT_NODE_ID]?.content;
  }

  async function messagesForSession(request: APIRequestContext, sessionId: string): Promise<unknown[]> {
    const res = await request.get(`/api/v1/monitor/messages?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: bearer },
    });
    expect(res.status(), `GET /api/v1/monitor/messages — ${await res.text()}`).toBe(200);
    return (await res.json()) as unknown[];
  }

  test(
    "the legacy global-variable header is refused in every mode, before the body is validated",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const refusedSessions: string[] = [];
      const header = { [`X-LANGFLOW-GLOBAL-VAR-${variableName}`]: sentinel };

      for (const mode of ["sync", "stream", "background"] as Mode[]) {
        await test.step(`mode=${mode}: the header answers 400 LEGACY_GLOBAL_VAR_HEADER`, async () => {
          const sessionId = unique(`refused-${mode}`);
          refusedSessions.push(sessionId);
          const res = await postV2(request, { mode, session_id: sessionId }, header);
          const raw = await res.text();
          expect(res.status(), `mode=${mode} with the legacy header — ${raw}`).toBe(400);
          expect(JSON.parse(raw).detail).toEqual(LEGACY_HEADER_DETAIL);
        });
      }

      // Not a case-sensitivity check: HTTP header names are case-insensitive and the
      // server sees them lower-cased whatever the client sends. It pins that the
      // wire spelling a migrating caller may use does not slip past the guard.
      await test.step("the header's wire spelling does not matter", async () => {
        const sessionId = unique("refused-lowercase");
        refusedSessions.push(sessionId);
        const res = await postV2(
          request,
          { mode: "sync", session_id: sessionId },
          { [`x-langflow-global-var-${variableName.toLowerCase()}`]: sentinel },
        );
        const raw = await res.text();
        expect(res.status(), `lower-case legacy header — ${raw}`).toBe(400);
        expect(JSON.parse(raw).detail?.code).toBe("LEGACY_GLOBAL_VAR_HEADER");
      });

      await test.step("the guard runs before body validation: 422 without the header, 400 with it", async () => {
        // This session can never run (422 or 400), so it is not added to the
        // "nothing ran" check below.
        const invalidBody = { mode: "sync", session_id: unique("refused-invalid"), unknown_field_e2e: 1 };

        const withoutHeader = await postV2(request, invalidBody);
        const rawWithout = await withoutHeader.text();
        expect(withoutHeader.status(), `invalid body, no header — ${rawWithout}`).toBe(422);
        expect(rawWithout).toContain("extra_forbidden");

        const withHeader = await postV2(request, invalidBody, header);
        const rawWith = await withHeader.text();
        expect(withHeader.status(), `invalid body with the header — ${rawWith}`).toBe(400);
        expect(JSON.parse(rawWith).detail?.code).toBe("LEGACY_GLOBAL_VAR_HEADER");
      });

      await test.step("nothing ran for any refused request", async () => {
        // Read repeatedly over a window, not once: a background job writes its
        // messages asynchronously after the submit returns (about 0.1 s on
        // 1.14.0.dev39), so a single early read could miss a job a 400 still queued.
        const deadline = Date.now() + NOTHING_RAN_WINDOW_MS;
        do {
          for (const sessionId of refusedSessions) {
            expect(
              await messagesForSession(request, sessionId),
              `messages for refused session ${sessionId}`,
            ).toEqual([]);
          }
          await new Promise((r) => setTimeout(r, 500));
        } while (Date.now() < deadline);
      });
    },
  );

  test(
    "body globals replace the stored variable in sync mode",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      await test.step("control: without globals, the run resolves the stored value", async () => {
        const res = await postV2(request, { mode: "sync", session_id: unique("sync-control") });
        expect(res.status(), `sync without globals — ${await res.text()}`).toBe(200);
        expect(await syncOutput(res), "the flow must read the stored variable").toBe(storedValue);
      });

      await test.step("with globals, the run resolves the request's sentinel", async () => {
        const res = await postV2(request, {
          mode: "sync",
          session_id: unique("sync-globals"),
          globals: { [variableName]: sentinel },
        });
        expect(res.status(), `sync with globals — ${await res.text()}`).toBe(200);
        expect(await syncOutput(res), "body globals must override the stored value").toBe(sentinel);
      });
    },
  );

  test(
    "stream and background refuse body globals with MODE_UNSUPPORTED_FIELDS",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      for (const mode of ["stream", "background"] as Mode[]) {
        await test.step(`mode=${mode}: globals answer 422 MODE_UNSUPPORTED_FIELDS`, async () => {
          const res = await postV2(request, {
            mode,
            session_id: unique(`${mode}-globals`),
            globals: { [variableName]: sentinel },
          });
          const raw = await res.text();
          expect(res.status(), `mode=${mode} with globals — ${raw}`).toBe(422);
          const detail = JSON.parse(raw).detail;
          expect(detail?.code).toBe("MODE_UNSUPPORTED_FIELDS");
          expect(detail?.fields).toEqual(["globals"]);
        });
      }

      await test.step("control: stream without globals is accepted", async () => {
        const res = await postV2(request, { mode: "stream", session_id: unique("stream-control") });
        const raw = await res.text();
        expect(res.status(), `mode=stream without globals — ${raw.slice(0, 300)}`).toBe(200);
      });

      await test.step("control: background without globals is accepted with a job id", async () => {
        const res = await postV2(request, { mode: "background", session_id: unique("background-control") });
        const raw = await res.text();
        expect(res.ok(), `mode=background without globals — ${res.status()} ${raw.slice(0, 300)}`).toBe(true);
        const jobId = JSON.parse(raw).job_id;
        expect(jobId, "a background submit returns its job id").toBeTruthy();
        // Awaited so teardown never deletes the flow under a queued or running job.
        await expect
          .poll(
            async () => {
              const status = await request.get(`/api/v2/workflows?job_id=${jobId}`, {
                headers: { Authorization: bearer },
              });
              return (await status.json())?.status;
            },
            { timeout: 30_000, intervals: [250, 500, 1000] },
          )
          .toBe("completed");
      });
    },
  );

  test(
    "v1 run still honours the legacy global-variable header",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      async function v1Text(extraHeaders: Record<string, string>): Promise<unknown> {
        const res = await request.post(`/api/v1/run/${flowId}`, {
          headers: { "x-api-key": apiKey, ...extraHeaders },
          data: {},
        });
        const raw = await res.text();
        expect(res.status(), `POST /api/v1/run — ${raw.slice(0, 300)}`).toBe(200);
        return JSON.parse(raw)?.outputs?.[0]?.outputs?.[0]?.results?.message?.text;
      }

      await test.step("with the header, the run resolves the header's sentinel", async () => {
        expect(await v1Text({ [`X-LANGFLOW-GLOBAL-VAR-${variableName}`]: sentinel })).toBe(sentinel);
      });

      await test.step("without the header, the run resolves the stored value", async () => {
        expect(await v1Text({})).toBe(storedValue);
      });
    },
  );
});
