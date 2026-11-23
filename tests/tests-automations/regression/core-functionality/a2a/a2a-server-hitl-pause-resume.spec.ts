import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import {
  messageSendEnvelope,
  postA2AJsonRpc,
  taskRpcEnvelope,
} from "../../../../helpers/a2a/post-a2a-jsonrpc";
import type { A2aRpcResult } from "../../../../helpers/a2a/post-a2a-jsonrpc";
import {
  buildCatalogFlow,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import type { CatalogFlowSpec } from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Spec doc: docs/core-functionality/a2a/a2a-server-hitl-pause-resume.md
//
// A Human Input node on a published A2A agent parks the run: `message/send` answers
// a task in `input-required`, and a second `message/send` on the SAME task (taskId +
// contextId) resumes it on the branch the answer picks. This is the A2A resume path
// (`_resume_flow` in api/v1/a2a.py, its own checkpoint store keyed by the task id),
// not the Playground's — `playground/human-input-pause-resume.spec.ts` cannot fail
// on anything asserted here.
//
// Every branch ends in a Combine Text that appends a marker of its own, so the
// artifact says which branch ran. The monitor read says the other one did not.
//
// The flows live in projects created with an EXPLICIT auth_type: since
// 1.14.0.dev23 (#16186) every new project defaults to "apikey" under AUTO_LOGIN
// (#2412), and test 4 needs both kinds.

const INPUT_REQUIRED = "input-required";
const COMPLETED = "completed";
const TASK_NOT_FOUND = -32001;
// UnsupportedOperationError, raised by the SDK for a message on a terminal task.
const TASK_TERMINAL = -32004;

const APPROVE_SENDER = "approve-branch";
const REJECT_SENDER = "reject-branch";

interface A2aTask {
  id: string;
  contextId: string;
  status: { state: string; message?: { parts?: Array<{ kind?: string; text?: string }> } };
  artifacts?: Array<{ parts: Array<{ kind?: string; text?: string }> }>;
}

interface MonitorMessage {
  sender: string;
  sender_name: string;
  text: string;
}

/**
 * Chat Input -> Human Input (Approve / Reject) -> Combine Text per branch -> Chat
 * Output per branch. With `secondPause`, a second Human Input offering Ship / Hold
 * sits between the approve branch and its Combine Text.
 */
function hitlGraph({ secondPause = false }: { secondPause?: boolean } = {}): CatalogFlowSpec {
  const nodes: CatalogFlowSpec["nodes"] = [
    { id: "ChatInput-hitl", type: "ChatInput" },
    { id: "HumanInput-hitl", type: "HumanInput" },
    {
      id: "CombineText-approve",
      type: "CombineText",
      values: { text2: secondPause ? "SHIPPED" : "APPROVED", delimiter: " | " },
    },
    { id: "CombineText-reject", type: "CombineText", values: { text2: "REJECTED", delimiter: " | " } },
    { id: "ChatOutput-approve", type: "ChatOutput", values: { sender_name: APPROVE_SENDER } },
    { id: "ChatOutput-reject", type: "ChatOutput", values: { sender_name: REJECT_SENDER } },
  ];
  const edges: CatalogFlowSpec["edges"] = [
    { source: "ChatInput-hitl", output: "message", target: "HumanInput-hitl", field: "prompt" },
    { source: "HumanInput-hitl", output: "branch_reject", target: "CombineText-reject", field: "text1" },
    { source: "CombineText-approve", output: "combined_text", target: "ChatOutput-approve", field: "input_value" },
    { source: "CombineText-reject", output: "combined_text", target: "ChatOutput-reject", field: "input_value" },
  ];
  if (!secondPause) {
    edges.push({ source: "HumanInput-hitl", output: "branch_approve", target: "CombineText-approve", field: "text1" });
    return { nodes, edges };
  }
  nodes.push({
    id: "HumanInput-second",
    type: "HumanInput",
    values: { decisions: ["Ship", "Hold"] },
    // The catalog entry carries the default Approve / Reject outputs, and the canvas
    // rebuilds them from `decisions` only on a field change. The node stops every
    // non-chosen `branch_<action id>` on resume, so the outputs must match the choices.
    configure: (component) => {
      component.outputs = component.outputs.map((output) =>
        output.name === "branch_approve"
          ? { ...output, name: "branch_ship", display_name: "Ship" }
          : { ...output, name: "branch_hold", display_name: "Hold" },
      );
    },
  });
  edges.push(
    { source: "HumanInput-hitl", output: "branch_approve", target: "HumanInput-second", field: "prompt" },
    { source: "HumanInput-second", output: "branch_ship", target: "CombineText-approve", field: "text1" },
  );
  return { nodes, edges };
}

async function moveFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  projectId: string,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data: { folder_id: projectId } });
  expect(res.status(), await res.text()).toBe(200);
  // A move that silently no-ops leaves the auth policy unchanged, and the boundary
  // assertions that follow would then prove nothing.
  expect((await res.json()).folder_id).toBe(projectId);
}

/**
 * Creates the HITL flow already inside `projectId` and already published, in one
 * `POST`. Returns its id.
 *
 * One write instead of create + move-and-publish `PATCH`: four of these tests in
 * parallel against SQLite made that `PATCH` answer `503 "The database is busy"` in
 * 2 of 20 runs, twice (measured on `1.14.0.dev35`). The server had already retried
 * it (`run_with_lock_retry`, 8 attempts). `createFlow` retries a 5xx itself.
 */
async function createHitlAgent(
  request: APIRequestContext,
  headers: Record<string, string>,
  projectId: string,
  graph: CatalogFlowSpec,
  track: (flowId: string) => void,
): Promise<string> {
  const catalog = await fetchComponentCatalog(request, headers);
  const flowId = await createFlow(
    request,
    {
      name: `a2a-hitl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      data: buildCatalogFlow(catalog, graph),
      is_component: false,
      folder_id: projectId,
      flow_type: "agent",
      a2a_enabled: true,
    },
    { headers },
  );
  track(flowId);
  // The POST answers only the id. Read the row back: a create that dropped the folder
  // would land in the default project, which is "apikey" since 1.14.0.dev23, and the
  // first keyless call would then fail with a 401 that names nothing.
  const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ folder_id: projectId, flow_type: "agent", a2a_enabled: true });
  return flowId;
}

let rpcSeq = 0;
const nextId = (label: string) => `${label}-${Date.now()}-${++rpcSeq}`;

/** `message/send`. With `task`, a reply on that task; without, a new task. */
async function send(
  request: APIRequestContext,
  flowId: string,
  text: string,
  { task, headers = {} }: { task?: A2aTask; headers?: Record<string, string> } = {},
): Promise<A2aRpcResult> {
  const res = await postA2AJsonRpc(
    request,
    flowId,
    messageSendEnvelope(text, {
      id: nextId("send"),
      messageId: nextId("msg"),
      ...(task ? { taskId: task.id, contextId: task.contextId } : {}),
    }),
    headers,
  );
  // JSON-RPC errors ride HTTP 200 on this endpoint; anything else is a different defect.
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  return res;
}

async function getTask(
  request: APIRequestContext,
  flowId: string,
  taskId: string,
  headers: Record<string, string> = {},
): Promise<A2aRpcResult> {
  const res = await postA2AJsonRpc(request, flowId, taskRpcEnvelope("tasks/get", taskId, { id: nextId("get") }), headers);
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  return res;
}

function taskOf(res: A2aRpcResult): A2aTask {
  expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
  return res.body!.result as A2aTask;
}

function expectErrorCode(res: A2aRpcResult, code: number) {
  expect(res.body?.result, res.raw.slice(0, 400)).toBeUndefined();
  expect(res.body?.error?.code, res.raw.slice(0, 400)).toBe(code);
}

/** The task is parked: `input-required`, the node's prompt as its message, no artifact. */
function expectParked(task: A2aTask, prompt: string) {
  expect(task.status.state).toBe(INPUT_REQUIRED);
  expect(task.status.message?.parts).toEqual([expect.objectContaining({ kind: "text", text: prompt })]);
  expect(task.artifacts ?? []).toHaveLength(0);
}

/** The task completed with exactly one artifact carrying exactly `text`. */
function expectCompletedWith(task: A2aTask, text: string) {
  expect(task.status.state).toBe(COMPLETED);
  expect(task.artifacts, JSON.stringify(task.artifacts)).toHaveLength(1);
  expect(task.artifacts![0].parts).toEqual([expect.objectContaining({ kind: "text", text })]);
}

async function machineRows(request: APIRequestContext, headers: Record<string, string>, flowId: string) {
  const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as MonitorMessage[]).filter((row) => row.sender === "Machine");
}

/** Exactly one Machine row, from `sender`, carrying `text`; none from `other`. */
async function expectOnlyBranchStored(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  { sender, other, text }: { sender: string; other: string; text: string },
) {
  await expect
    .poll(async () => (await machineRows(request, headers, flowId)).filter((r) => r.sender_name === sender).length, {
      message: `one Machine row from ${sender}`,
      timeout: 10_000,
    })
    .toBe(1);
  // The other branch is stopped by the node, never emptied, so it does not show up
  // later either: reading it once, after the chosen branch is stored, is enough.
  const rows = await machineRows(request, headers, flowId);
  expect(rows.map((r) => `${r.sender_name}: ${r.text}`)).toEqual([`${sender}: ${text}`]);
  expect(rows.filter((r) => r.sender_name === other)).toHaveLength(0);
}

/** Undoes in reverse, by id. Every step runs; the first failure is rethrown, so a leak is reported. */
async function runCleanups(cleanups: Array<() => Promise<void>>) {
  let firstError: unknown;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

test.describe("A2A Server — Human Input pause and resume", () => {
  test("a paused task resumes on the approved branch only", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const cleanups: Array<() => Promise<void>> = [];
    const sentinel = `a2a-hitl-approve-${Date.now()}`;

    try {
      const project = await createProjectViaApi(request, headers, {
        namePrefix: "a2a-hitl",
        description: "Public project for the A2A Human Input spec",
        authSettings: { auth_type: "none" },
      });
      cleanups.push(() => project.deleteProject());
      const flowId = await createHitlAgent(request, headers, project.projectId, hitlGraph(), (id) =>
        cleanups.push(() => deleteFlow(request, id, { headers })),
      );

      let task: A2aTask;

      await test.step("message/send parks the run on the Human Input node", async () => {
        task = taskOf(await send(request, flowId, sentinel));
        expectParked(task, sentinel);
        const read = taskOf(await getTask(request, flowId, task.id));
        expect(read.id).toBe(task.id);
        expectParked(read, sentinel);
      });

      await test.step("an answer the node does not offer re-parks the same task", async () => {
        const reparked = taskOf(await send(request, flowId, "maybe", { task }));
        expect(reparked.id).toBe(task.id);
        expectParked(reparked, sentinel);
      });

      await test.step("Approve resumes it on the approve branch only", async () => {
        const done = taskOf(await send(request, flowId, "Approve", { task }));
        expect(done.id).toBe(task.id);
        expectCompletedWith(done, `${sentinel} | APPROVED`);
        await expectOnlyBranchStored(request, headers, flowId, {
          sender: APPROVE_SENDER,
          other: REJECT_SENDER,
          text: `${sentinel} | APPROVED`,
        });
      });

      await test.step("a reply on the completed task is refused and changes nothing", async () => {
        expectErrorCode(await send(request, flowId, "Reject", { task }), TASK_TERMINAL);
        expectCompletedWith(taskOf(await getTask(request, flowId, task.id)), `${sentinel} | APPROVED`);
      });
    } finally {
      await runCleanups(cleanups);
    }
  });

  test("a paused task resumes on the rejected branch only", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    // The mirror of test 1. A spec that only ever approves cannot tell exclusive
    // routing from "the approve branch is the only one that works".
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const cleanups: Array<() => Promise<void>> = [];
    const sentinel = `a2a-hitl-reject-${Date.now()}`;

    try {
      const project = await createProjectViaApi(request, headers, {
        namePrefix: "a2a-hitl",
        description: "Public project for the A2A Human Input spec",
        authSettings: { auth_type: "none" },
      });
      cleanups.push(() => project.deleteProject());
      const flowId = await createHitlAgent(request, headers, project.projectId, hitlGraph(), (id) =>
        cleanups.push(() => deleteFlow(request, id, { headers })),
      );

      let task: A2aTask;

      await test.step("message/send parks the run on the Human Input node", async () => {
        task = taskOf(await send(request, flowId, sentinel));
        expectParked(task, sentinel);
      });

      await test.step("the action id `reject` resumes it on the reject branch only", async () => {
        const done = taskOf(await send(request, flowId, "reject", { task }));
        expect(done.id).toBe(task.id);
        expectCompletedWith(done, `${sentinel} | REJECTED`);
        await expectOnlyBranchStored(request, headers, flowId, {
          sender: REJECT_SENDER,
          other: APPROVE_SENDER,
          text: `${sentinel} | REJECTED`,
        });
      });
    } finally {
      await runCleanups(cleanups);
    }
  });

  test("a second Human Input pauses the same task again", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const cleanups: Array<() => Promise<void>> = [];
    const sentinel = `a2a-hitl-second-${Date.now()}`;

    try {
      const project = await createProjectViaApi(request, headers, {
        namePrefix: "a2a-hitl",
        description: "Public project for the A2A Human Input spec",
        authSettings: { auth_type: "none" },
      });
      cleanups.push(() => project.deleteProject());
      const flowId = await createHitlAgent(
        request,
        headers,
        project.projectId,
        hitlGraph({ secondPause: true }),
        (id) => cleanups.push(() => deleteFlow(request, id, { headers })),
      );

      let task: A2aTask;

      await test.step("message/send parks the run on the first node", async () => {
        task = taskOf(await send(request, flowId, sentinel));
        expectParked(task, sentinel);
      });

      await test.step("Approve moves it to the second node, which parks it again", async () => {
        const parked = taskOf(await send(request, flowId, "Approve", { task }));
        expect(parked.id).toBe(task.id);
        expectParked(parked, sentinel);
      });

      await test.step("Approve again is not an answer the second node offers", async () => {
        // The first node offers Approve, the second only Ship / Hold. A task still
        // parked here is held by the second node.
        const parked = taskOf(await send(request, flowId, "Approve", { task }));
        expect(parked.id).toBe(task.id);
        expectParked(parked, sentinel);
      });

      await test.step("Ship completes it", async () => {
        const done = taskOf(await send(request, flowId, "Ship", { task }));
        expect(done.id).toBe(task.id);
        expectCompletedWith(done, `${sentinel} | SHIPPED`);
      });
    } finally {
      await runCleanups(cleanups);
    }
  });

  test("a paused task can only be resumed by the principal that started it", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    // The auth type belongs to the project, so the policy changes by moving the flow
    // between two projects of the test's own — flipping the shared default project
    // would change every flow of the superuser under parallel specs (#1010).
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const cleanups: Array<() => Promise<void>> = [];
    const run = Date.now();
    const sentinelA = `a2a-hitl-anon-${run}`;
    const sentinelB = `a2a-hitl-owner-${run}`;

    try {
      const publicProject = await createProjectViaApi(request, headers, {
        namePrefix: "a2a-hitl-pub",
        description: "Public project for the A2A Human Input principal spec",
        authSettings: { auth_type: "none" },
      });
      cleanups.push(() => publicProject.deleteProject());
      const keyProject = await createProjectViaApi(request, headers, {
        namePrefix: "a2a-hitl-key",
        description: "API-key project for the A2A Human Input principal spec",
        authSettings: { auth_type: "apikey" },
      });
      cleanups.push(() => keyProject.deleteProject());
      const apiKey = await createApiKey(request, headers, { namePrefix: "a2a-hitl" });
      cleanups.push(() => deleteApiKey(request, apiKey.id, headers));
      const withKey = { "x-api-key": apiKey.key };
      const flowId = await createHitlAgent(request, headers, publicProject.projectId, hitlGraph(), (id) =>
        cleanups.push(() => deleteFlow(request, id, { headers })),
      );

      let taskA: A2aTask;
      let taskB: A2aTask;

      await test.step("public: an anonymous caller parks task A", async () => {
        taskA = taskOf(await send(request, flowId, sentinelA));
        expectParked(taskA, sentinelA);
      });

      await test.step("restricted: task A is invisible to the owner's key; the owner parks task B", async () => {
        await moveFlow(request, headers, flowId, keyProject.projectId);

        const noKey = await postA2AJsonRpc(
          request,
          flowId,
          messageSendEnvelope("Approve", {
            id: nextId("send"),
            messageId: nextId("msg"),
            taskId: taskA.id,
            contextId: taskA.contextId,
          }),
        );
        expect(noKey.status, noKey.raw.slice(0, 400)).toBe(401);

        expectErrorCode(await getTask(request, flowId, taskA.id, withKey), TASK_NOT_FOUND);
        expectErrorCode(await send(request, flowId, "Approve", { task: taskA, headers: withKey }), TASK_NOT_FOUND);

        taskB = taskOf(await send(request, flowId, sentinelB, { headers: withKey }));
        expectParked(taskB, sentinelB);
      });

      await test.step("public again: task B is invisible, task A is still parked and completes", async () => {
        await moveFlow(request, headers, flowId, publicProject.projectId);

        expectErrorCode(await getTask(request, flowId, taskB.id), TASK_NOT_FOUND);
        expectErrorCode(await send(request, flowId, "Approve", { task: taskB }), TASK_NOT_FOUND);

        expectParked(taskOf(await getTask(request, flowId, taskA.id)), sentinelA);
        expectCompletedWith(taskOf(await send(request, flowId, "Approve", { task: taskA })), `${sentinelA} | APPROVED`);
      });

      await test.step("restricted again: the owner completes task B", async () => {
        await moveFlow(request, headers, flowId, keyProject.projectId);
        expectCompletedWith(
          taskOf(await send(request, flowId, "Approve", { task: taskB, headers: withKey })),
          `${sentinelB} | APPROVED`,
        );
      });
    } finally {
      await runCleanups(cleanups);
    }
  });
});
