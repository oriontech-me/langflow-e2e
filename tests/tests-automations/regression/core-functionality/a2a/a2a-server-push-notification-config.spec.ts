import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowInPublicProject } from "../../../../helpers/a2a/create-public-runnable-flow";
import type { PublicRunnableChatFlow } from "../../../../helpers/a2a/create-public-runnable-flow";
import { messageSendEnvelope, postA2AJsonRpc } from "../../../../helpers/a2a/post-a2a-jsonrpc";
import type { A2aRpcResult } from "../../../../helpers/a2a/post-a2a-jsonrpc";

// Spec doc: docs/core-functionality/a2a/a2a-server-push-notification-config.md
//
// The registration half of A2A push notifications: tasks/pushNotificationConfig/
// {set,get,list,delete}. Delivery is out of reach (the doc says why).
//
// Test 2 is a guard test. The endpoint is public and the webhook URL is the caller's,
// so registering one is a server-side request on someone else's behalf. The server
// resolves the host and refuses it if ANY resolved address is non-public. Each row
// asserts the RESOLVED address the error names: the decimal, hex, ::ffff: and
// userinfo spellings of loopback only resolve to 127.0.0.1 if the guard resolved them,
// so a guard that compared the literal string would fail those rows.
//
// No call here makes the server POST anywhere. Every config is set on a task that has
// already completed, so no event follows, and the accepted URLs are public IP
// literals, which the guard checks without a DNS lookup.

const TASK_NOT_FOUND = -32001;
const INVALID_PARAMS = -32602;

const ACCEPTED_URL = "https://1.1.1.1/e2e-a2a-push";
const ACCEPTED_URL_2 = "https://1.0.0.1/e2e-a2a-push-2";
const ACCEPTED_URL_3 = "https://1.0.0.1/e2e-a2a-push-3";

const BLOCKED = "webhook url resolves to a blocked address: ";

// [label, url, exact error message]. Measured on 1.14.0.dev35.
const REFUSED: Array<[string, string, string]> = [
  ["loopback", "http://127.0.0.1/e2e-a2a-push", `${BLOCKED}127.0.0.1`],
  ["IPv6 loopback", "http://[::1]/e2e-a2a-push", `${BLOCKED}::1`],
  ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/e2e-a2a-push", `${BLOCKED}::ffff:127.0.0.1`],
  ["decimal loopback", "http://2130706433/e2e-a2a-push", `${BLOCKED}127.0.0.1`],
  ["hex loopback", "http://0x7f.0.0.1/e2e-a2a-push", `${BLOCKED}127.0.0.1`],
  ["userinfo in front of loopback", "http://1.1.1.1@127.0.0.1/e2e-a2a-push", `${BLOCKED}127.0.0.1`],
  ["unspecified", "http://0.0.0.0/e2e-a2a-push", `${BLOCKED}0.0.0.0`],
  ["private 10/8", "http://10.0.0.1/e2e-a2a-push", `${BLOCKED}10.0.0.1`],
  ["private 172.16/12", "http://172.16.0.1/e2e-a2a-push", `${BLOCKED}172.16.0.1`],
  ["private 192.168/16", "http://192.168.1.10/e2e-a2a-push", `${BLOCKED}192.168.1.10`],
  ["CGNAT 100.64/10", "http://100.64.0.1/e2e-a2a-push", `${BLOCKED}100.64.0.1`],
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/", `${BLOCKED}169.254.169.254`],
  ["IPv6 link-local", "http://[fe80::1]/e2e-a2a-push", `${BLOCKED}fe80::1`],
  ["IPv6 unique local", "http://[fd00::1]/e2e-a2a-push", `${BLOCKED}fd00::1`],
  ["TEST-NET-1", "https://192.0.2.10/e2e-a2a-push", `${BLOCKED}192.0.2.10`],
  ["non-http scheme", "ftp://1.1.1.1/e2e-a2a-push", "webhook url must be http or https"],
  ["no host", "http:///e2e-a2a-push", "webhook url has no host"],
];

interface PushConfig {
  id: string;
  url: string;
  token?: string;
}

interface TaskPushConfig {
  taskId: string;
  pushNotificationConfig: PushConfig;
}

let rpcSeq = 0;

async function rpc(
  request: APIRequestContext,
  flowId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<A2aRpcResult> {
  const res = await postA2AJsonRpc(request, flowId, {
    jsonrpc: "2.0",
    id: `${method}-${Date.now()}-${++rpcSeq}`,
    method,
    params,
  });
  // JSON-RPC errors ride HTTP 200 on this endpoint; anything else is a different defect.
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  return res;
}

function resultOf<T>(res: A2aRpcResult): T {
  expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
  return res.body!.result as T;
}

function expectError(res: A2aRpcResult, code: number) {
  expect(res.body?.result, res.raw.slice(0, 400)).toBeUndefined();
  expect(res.body?.error?.code, res.raw.slice(0, 400)).toBe(code);
}

const setConfig = (request: APIRequestContext, flowId: string, taskId: string, config: Partial<PushConfig>) =>
  rpc(request, flowId, "tasks/pushNotificationConfig/set", { taskId, pushNotificationConfig: config });

const listConfigs = (request: APIRequestContext, flowId: string, taskId: string) =>
  rpc(request, flowId, "tasks/pushNotificationConfig/list", { id: taskId });

const getConfig = (request: APIRequestContext, flowId: string, taskId: string, configId: string) =>
  rpc(request, flowId, "tasks/pushNotificationConfig/get", { id: taskId, pushNotificationConfigId: configId });

/** The configs `list` returns for the task, as `id -> config`. */
async function storedConfigs(request: APIRequestContext, flowId: string, taskId: string) {
  const rows = resultOf<TaskPushConfig[]>(await listConfigs(request, flowId, taskId));
  for (const row of rows) expect(row.taskId).toBe(taskId);
  return new Map(rows.map((row) => [row.pushNotificationConfig.id, row.pushNotificationConfig]));
}

/** A published public agent, plus its cleanup. */
async function publicAgent(request: APIRequestContext, headers: Record<string, string>, namePrefix: string) {
  const flow = await createRunnableChatFlowInPublicProject(request, headers, { namePrefix });
  const res = await request.patch(`/api/v1/flows/${flow.flowId}`, {
    headers,
    data: { flow_type: "agent", a2a_enabled: true },
  });
  expect(res.status(), await res.text()).toBe(200);
  return flow;
}

/** A completed task on `flowId`. Configs set on it can never be dispatched. */
async function completedTask(request: APIRequestContext, flowId: string, sentinel: string): Promise<string> {
  const res = await postA2AJsonRpc(
    request,
    flowId,
    messageSendEnvelope(sentinel, { id: `send-${sentinel}`, messageId: `msg-${sentinel}` }),
  );
  expect(res.status, res.raw.slice(0, 400)).toBe(200);
  const task = resultOf<{ id: string; status: { state: string } }>(res);
  expect(task.status.state).toBe("completed");
  return task.id;
}

/** Deletes every flow (and its project); the first failure is rethrown. */
async function cleanupAll(flows: PublicRunnableChatFlow[]) {
  let firstError: unknown;
  for (const flow of flows) {
    try {
      await flow.cleanup();
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

test.describe("A2A Server — push-notification config", () => {
  test("push notification configs round-trip on a task, through its own flow only", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const flows: PublicRunnableChatFlow[] = [];

    try {
      const agentA = await publicAgent(request, headers, "a2a-push-a");
      flows.push(agentA);
      const agentB = await publicAgent(request, headers, "a2a-push-b");
      flows.push(agentB);
      const taskId = await completedTask(request, agentA.flowId, `a2a-push-roundtrip-${Date.now()}`);

      await test.step("a task starts with no config", async () => {
        expect(resultOf<TaskPushConfig[]>(await listConfigs(request, agentA.flowId, taskId))).toEqual([]);
      });

      await test.step("set echoes what it stored; a config with no id is stored under the task id", async () => {
        const first = resultOf<TaskPushConfig>(
          await setConfig(request, agentA.flowId, taskId, { id: "cfg-1", url: ACCEPTED_URL, token: "e2e-token-1" }),
        );
        expect(first).toEqual({ taskId, pushNotificationConfig: { id: "cfg-1", url: ACCEPTED_URL, token: "e2e-token-1" } });

        const second = resultOf<TaskPushConfig>(
          await setConfig(request, agentA.flowId, taskId, { id: "cfg-2", url: ACCEPTED_URL_2 }),
        );
        expect(second.pushNotificationConfig).toMatchObject({ id: "cfg-2", url: ACCEPTED_URL_2 });

        const unnamed = resultOf<TaskPushConfig>(await setConfig(request, agentA.flowId, taskId, { url: ACCEPTED_URL_3 }));
        expect(unnamed.pushNotificationConfig).toMatchObject({ id: taskId, url: ACCEPTED_URL_3 });
      });

      await test.step("get reads one back and list returns all three", async () => {
        const read = resultOf<TaskPushConfig>(await getConfig(request, agentA.flowId, taskId, "cfg-1"));
        expect(read).toEqual({ taskId, pushNotificationConfig: { id: "cfg-1", url: ACCEPTED_URL, token: "e2e-token-1" } });

        const stored = await storedConfigs(request, agentA.flowId, taskId);
        expect([...stored.keys()].sort()).toEqual(["cfg-1", "cfg-2", taskId].sort());
        expect(stored.get("cfg-2")?.url).toBe(ACCEPTED_URL_2);
        expect(stored.get(taskId)?.url).toBe(ACCEPTED_URL_3);
      });

      await test.step("another flow's endpoint cannot see the task's configs", async () => {
        expectError(await listConfigs(request, agentB.flowId, taskId), TASK_NOT_FOUND);
        expectError(await getConfig(request, agentB.flowId, taskId, "cfg-1"), TASK_NOT_FOUND);
        // Positive control: the owning flow still sees all three.
        expect((await storedConfigs(request, agentA.flowId, taskId)).size).toBe(3);
      });

      await test.step("delete removes exactly one config", async () => {
        const deleted = await rpc(request, agentA.flowId, "tasks/pushNotificationConfig/delete", {
          id: taskId,
          pushNotificationConfigId: "cfg-1",
        });
        expect(deleted.body?.error, deleted.raw.slice(0, 400)).toBeUndefined();

        const stored = await storedConfigs(request, agentA.flowId, taskId);
        expect([...stored.keys()].sort()).toEqual(["cfg-2", taskId].sort());
        // The error a deleted config reads back with is not asserted: it is
        // "Task not found" today, for a task that exists (see the spec doc).
        const gone = await getConfig(request, agentA.flowId, taskId, "cfg-1");
        expect(gone.body?.result, gone.raw.slice(0, 400)).toBeUndefined();
        expect(gone.body?.error, gone.raw.slice(0, 400)).toBeDefined();
      });
    } finally {
      await cleanupAll(flows);
    }
  });

  test("a webhook that resolves to a non-public address is refused and nothing is stored", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);
    const flows: PublicRunnableChatFlow[] = [];

    try {
      const agent = await publicAgent(request, headers, "a2a-push-guard");
      flows.push(agent);
      const taskId = await completedTask(request, agent.flowId, `a2a-push-guard-${Date.now()}`);

      await test.step("a public webhook is accepted", async () => {
        // Without this, a guard that refused every URL would pass the rows below.
        resultOf<TaskPushConfig>(await setConfig(request, agent.flowId, taskId, { id: "accepted", url: ACCEPTED_URL }));
      });

      await test.step(`${REFUSED.length} non-public or malformed webhooks are refused, naming the resolved address`, async () => {
        for (const [label, url, message] of REFUSED) {
          const res = await setConfig(request, agent.flowId, taskId, { id: `refused-${label}`, url });
          // Soft: one run names every row that regressed, not only the first.
          expect.soft(res.body?.result, `${label} (${url}) was accepted: ${res.raw.slice(0, 300)}`).toBeUndefined();
          expect.soft(res.body?.error?.code, `${label} (${url}): ${res.raw.slice(0, 300)}`).toBe(INVALID_PARAMS);
          expect.soft(res.body?.error?.message, `${label} (${url})`).toBe(message);
        }
      });

      await test.step("only the accepted webhook is stored", async () => {
        const stored = await storedConfigs(request, agent.flowId, taskId);
        expect([...stored.keys()]).toEqual(["accepted"]);
        expect(stored.get("accepted")?.url).toBe(ACCEPTED_URL);
      });
    } finally {
      await cleanupAll(flows);
    }
  });
});
