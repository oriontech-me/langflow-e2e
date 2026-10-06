import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import {
  messageSendEnvelope,
  postA2AJsonRpc,
  taskRpcEnvelope,
} from "../../../../helpers/a2a/post-a2a-jsonrpc";
import { startA2aStream } from "../../../../helpers/a2a/start-a2a-stream";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { createCatalogFlow } from "../../../../helpers/flows/build-catalog-flow";
import {
  CUSTOM_COMPONENT_TYPE,
  applyNodeSpec,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-custom-component-graph";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Spec doc: docs/core-functionality/a2a/a2a-server-tasks-lifecycle.md
//
// The error CODES are the point. `_SpecErrorAdapter` (langflow/api/v1/a2a.py) exists
// only to stop the SDK's catch-all from wrapping every failure in InternalError
// (-32603), which would make "no such task" indistinguishable from "the agent broke".
// A test that accepted "an error" would stay green the day that shim regresses, so
// every assertion below pins the exact code.
//
// Two of them are safety properties, not conveniences: cancelling a finished task is
// REFUSED rather than absorbed (it must not clobber a real COMPLETED), and a task id
// is invisible to another flow (the registry is keyed by task id alone, so the
// handler gates on a flow-scoped store first).

const TASK_NOT_FOUND = -32001;
const TASK_NOT_CANCELABLE = -32002;
const UNKNOWN_TASK_ID = "00000000-0000-4000-8000-000000000000";

// How long the cancel test's run waits inside its node. The cancel is answered in
// ~100-500 ms (measured, #2196), so 10 s is margin a loaded lane cannot eat — and,
// because sleeping is not CPU, a faster machine does not shrink it either.
const RUN_WAITS_S = 10;

interface A2aTask {
  id: string;
  contextId: string;
  status: { state: string; timestamp: string };
  artifacts?: Array<{ artifactId: string; parts: Array<{ text: string }> }>;
}

async function publish(request: APIRequestContext, headers: Record<string, string>) {
  const flow = await createRunnableChatFlowViaApi(request, headers);
  const res = await request.patch(`/api/v1/flows/${flow.flowId}`, {
    headers,
    data: { flow_type: "agent", a2a_enabled: true },
  });
  expect(res.status(), await res.text()).toBe(200);
  return flow;
}

async function sendAndGetTask(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  text: string,
): Promise<A2aTask> {
  const res = await postA2AJsonRpc(
    request,
    flowId,
    messageSendEnvelope(text, { id: `send-${text}`, messageId: `msg-${text}` }),
    headers,
  );
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
  return res.body!.result as A2aTask;
}

async function taskRpc(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  method: "tasks/get" | "tasks/cancel",
  taskId: string,
) {
  const res = await postA2AJsonRpc(
    request,
    flowId,
    taskRpcEnvelope(method, taskId, { id: `${method}-${taskId}` }),
    headers,
  );
  // Protocol errors ride HTTP 200 on this endpoint — the same contract #1243 pinned
  // for -32601/-32600. A non-200 here is a different defect entirely.
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  return res;
}

test.describe("A2A Server — task lifecycle", () => {
  test("a task can be read back and refuses a cancel it cannot honour", { tag: ["@stable", "@api", "@regression", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await publish(request, headers);
    const sentinel = `a2a-task-readback-${Date.now()}`;

    try {
      const task = await sendAndGetTask(request, headers, flow.flowId, sentinel);
      expect(task.status.state).toBe("completed");

      await test.step("tasks/get returns the same task, not a fresh run", async () => {
        const res = await taskRpc(request, headers, flow.flowId, "tasks/get", task.id);
        const read = res.body!.result as A2aTask;

        expect(read.id).toBe(task.id);
        expect(read.contextId).toBe(task.contextId);
        expect(read.status.state).toBe("completed");
        // Artifact id and timestamp identity are what separate a READ-BACK from a
        // silent re-execution: a re-run would mint both afresh.
        expect(read.artifacts?.[0].artifactId).toBe(task.artifacts?.[0].artifactId);
        expect(read.status.timestamp).toBe(task.status.timestamp);
        expect(read.artifacts?.[0].parts[0].text).toBe(sentinel);
      });

      await test.step("an unknown id is -32001, not a 500 and not -32603", async () => {
        const res = await taskRpc(request, headers, flow.flowId, "tasks/get", UNKNOWN_TASK_ID);
        expect(res.body?.error?.code).toBe(TASK_NOT_FOUND);
        expect(res.body?.error?.message).toBe("Task not found");
      });

      await test.step("cancelling a finished task is refused and changes nothing", async () => {
        const cancel = await taskRpc(request, headers, flow.flowId, "tasks/cancel", task.id);
        expect(cancel.body?.error?.code).toBe(TASK_NOT_CANCELABLE);
        expect(cancel.body?.error?.message).toBe("Task cannot be canceled");

        // The refusal must not corrupt stored state — the handler declines precisely
        // so a real COMPLETED is never clobbered with CANCELED.
        const after = await taskRpc(request, headers, flow.flowId, "tasks/get", task.id);
        const read = after.body!.result as A2aTask;
        expect(read.status.state).toBe("completed");
        expect(read.status.timestamp).toBe(task.status.timestamp);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("a task id is invisible to another flow", { tag: ["@stable", "@api", "@regression", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const owner = await publish(request, headers);
    const other = await publish(request, headers);
    const sentinel = `a2a-task-crossflow-${Date.now()}`;

    try {
      const task = await sendAndGetTask(request, headers, owner.flowId, sentinel);

      await test.step("the other flow is told the task does not exist", async () => {
        const res = await taskRpc(request, headers, other.flowId, "tasks/cancel", task.id);
        // -32001 and NOT -32002: flow B must not be able to tell that the task exists
        // at all. -32002 would confirm it, which is the leak the flow-scoped gate closes.
        expect(res.body?.error?.code).toBe(TASK_NOT_FOUND);
      });

      await test.step("while its owner still reads it", async () => {
        // Positive control in the same test: a blanket "everything is -32001" bug
        // cannot pass this pair.
        const res = await taskRpc(request, headers, owner.flowId, "tasks/get", task.id);
        expect((res.body!.result as A2aTask).status.state).toBe("completed");
      });
    } finally {
      await owner.deleteFlow();
      await other.deleteFlow();
    }
  });

  test("cancelling a running task moves it to canceled", { tag: ["@stable", "@api", "@regression", "@a2a"] }, async ({
    request,
    baseURL,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    // #2196: the first version kept the run in flight with a ~2 MB payload. That run
    // was CPU-bound, so the cancel request queued behind it and the real window was
    // ~100 ms — refused (-32002, correctly) once the run won the race, 3/3 on the VM
    // lane. A run that WAITS keeps the task working without starving the cancel.
    //
    // Behind an API key on purpose: a public agent (auth_type none) runs under the
    // public code policy, which swaps a CustomComponent's code for the server's stock
    // copy — measured, this flow then answered in ~20 ms without sleeping at all.
    let flowId: string | undefined;
    let apiKey: Awaited<ReturnType<typeof createApiKey>> | undefined;
    let stream: Awaited<ReturnType<typeof startA2aStream>> | undefined;
    // Undone in reverse, by id: the flow, then the key, then the project.
    const cleanups: Array<() => Promise<void>> = [];

    try {
      await test.step(`publish an agent whose run waits ${RUN_WAITS_S} s, behind an API key`, async () => {
        const project = await createProjectViaApi(request, headers, {
          namePrefix: "a2a-cancel",
          description: "API-key project for the A2A running-task cancel spec",
          authSettings: { auth_type: "apikey" },
        });
        cleanups.push(() => project.deleteProject());
        const key = await createApiKey(request, headers, { namePrefix: "a2a-cancel" });
        cleanups.push(() => deleteApiKey(request, key.id, headers));
        apiKey = key;

        const catalog = await fetchComponentCatalog(request, headers);
        flowId = await createCatalogFlow(
          request,
          catalog,
          {
            nodes: [
              { id: "ChatInput-cancel", type: "ChatInput" },
              {
                id: "CustomComponent-wait",
                type: CUSTOM_COMPONENT_TYPE,
                configure: (component) => {
                  applyNodeSpec(component, { id: "Waits", kind: "echo", fields: ["in_text"], delayS: RUN_WAITS_S });
                },
              },
              { id: "ChatOutput-cancel", type: "ChatOutput" },
            ],
            edges: [
              { source: "ChatInput-cancel", output: "message", target: "CustomComponent-wait", field: "in_text" },
              { source: "CustomComponent-wait", output: "output", target: "ChatOutput-cancel", field: "input_value" },
            ],
          },
          { name: `a2a-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, headers },
        );
        const createdFlowId = flowId;
        cleanups.push(() => deleteFlow(request, createdFlowId, { headers }));

        const res = await request.patch(`/api/v1/flows/${flowId}`, {
          headers,
          data: { folder_id: project.projectId, flow_type: "agent", a2a_enabled: true },
        });
        expect(res.status(), await res.text()).toBe(200);
        // Asserted rather than assumed: a move that silently no-ops leaves the flow
        // public, where its code is replaced and the run never waits.
        expect((await res.json()).folder_id).toBe(project.projectId);
      });

      const a2aHeaders = { "x-api-key": apiKey!.key };
      const sentinel = `a2a-task-cancel-${Date.now()}`;

      await test.step("start a run and see it in flight", async () => {
        stream = await startA2aStream(
          baseURL!,
          flowId!,
          {
            jsonrpc: "2.0",
            id: `stream-${sentinel}`,
            method: "message/stream",
            params: {
              message: {
                role: "user",
                messageId: `msg-${sentinel}`,
                kind: "message",
                parts: [{ kind: "text", text: sentinel }],
              },
            },
          },
          a2aHeaders,
        );

        // The precondition the old design never checked: the cancel targets a live task.
        // It does not replace the wait — force-failed with a 0 s node, this read still
        // said `working` and the run ended in the milliseconds before the cancel, which
        // then got -32002: the VM lane's exact symptom, reproduced by a short run.
        const res = await taskRpc(request, a2aHeaders, flowId!, "tasks/get", stream.taskId);
        expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
        expect(
          (res.body!.result as A2aTask).status.state,
          "the run must still be in flight when the cancel is sent",
        ).toBe("working");
      });

      await test.step("cancelling it returns a canceled task", async () => {
        const res = await taskRpc(request, a2aHeaders, flowId!, "tasks/cancel", stream!.taskId);
        expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
        expect((res.body!.result as A2aTask).status.state).toBe("canceled");
      });

      await test.step("the stream ends on canceled, never on completed", async () => {
        // Measured: the stream closes within a few ms of the cancel. Left alone it runs
        // RUN_WAITS_S and ends completed with an artifact — so a cancel that only
        // relabelled the stored task would show here, where tasks/get cannot see it.
        const frames = await stream!.drain({ timeoutMs: (RUN_WAITS_S + 20) * 1000 });
        const states = frames.map((f) => f.state ?? f.kind);
        expect(frames.filter((f) => f.state !== undefined).at(-1)?.state, `frames: ${states.join(" -> ")}`).toBe(
          "canceled",
        );
        expect(states, "the run must not have finished").not.toContain("completed");
        expect(frames.some((f) => f.hasArtifact), `frames: ${states.join(" -> ")}`).toBe(false);
      });

      await test.step("and the stored task is terminal, not still working", async () => {
        const res = await taskRpc(request, a2aHeaders, flowId!, "tasks/get", stream!.taskId);
        expect((res.body!.result as A2aTask).status.state).toBe("canceled");
      });
    } finally {
      await stream?.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});
