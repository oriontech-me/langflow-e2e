// Unit tests for tests/helpers/instance-migration/target-instance.ts (#2354).
// Run with: npm run test:units
//
// The new instance is started from the settings the start step prints, with their
// placeholders filled from the lane's fixtures. What these protect is what would fail
// SILENTLY or far from its cause: a placeholder left in a value, an operator setting
// quietly replacing a printed one, a secret on the docker command line, and a wait that
// times out without saying why.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { instanceMigrationLane } from "./instance-migration-lane";
import {
  type DockerRunner,
  fillStartSettings,
  newInstanceRun,
  operatorSettings,
  parseSettingsText,
  removeNewInstance,
  type StartSetting,
  startNewInstance,
  waitForNewInstance,
} from "./target-instance";

const lane = instanceMigrationLane({});

/** `start.settings` as GET /api/v1/migration answered it on 1.14.0.dev14, after "Check the copy". */
const PRINTED: StartSetting[] = [
  {
    name: "LANGFLOW_DATABASE_URL",
    value: "postgresql://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target",
    fill: true,
  },
  { name: "LANGFLOW_SECRET_KEY", value: "<secret key>", fill: true },
  { name: "LANGFLOW_STORAGE_TYPE", value: "s3", fill: false },
  { name: "LANGFLOW_OBJECT_STORAGE_BUCKET_NAME", value: "langflow-migration", fill: false },
  { name: "LANGFLOW_OBJECT_STORAGE_PREFIX", value: "langflow", fill: false },
  { name: "AWS_ACCESS_KEY_ID", value: "<access key id>", fill: true },
  { name: "AWS_SECRET_ACCESS_KEY", value: "<secret access key>", fill: true },
  { name: "AWS_ENDPOINT_URL", value: "http://langflow-instance-migration-s3:8333", fill: false },
  {
    name: "PGVECTOR_CONNECTION_STRING",
    value: "postgresql+psycopg://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target",
    fill: true,
  },
  { name: "LANGFLOW_AUTO_LOGIN", value: "true", fill: false },
  { name: "LANGFLOW_SSRF_ALLOWED_HOSTS", value: "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,lf-self.localhost", fill: false },
];

/** A docker that records each call and answers from a function. */
function fakeDocker(answer: (args: string[]) => string): { docker: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const docker: DockerRunner = (args) => {
    calls.push(args);
    return answer(args);
  };
  return { docker, calls };
}

test("fillStartSettings fills the five measured placeholders from the lane's fixtures, in the page's order", () => {
  const filled = new Map(fillStartSettings(PRINTED, lane));
  assert.deepEqual(
    [...filled.keys()],
    PRINTED.map((s) => s.name),
  );
  assert.equal(filled.get("LANGFLOW_DATABASE_URL"), lane.target.databaseUrl);
  assert.equal(
    filled.get("PGVECTOR_CONNECTION_STRING"),
    "postgresql+psycopg://langflow:e2e-im-sentinel-pg-password@langflow-instance-migration-pg:5432/langflow_target",
  );
  assert.equal(filled.get("LANGFLOW_SECRET_KEY"), lane.secretKey);
  assert.equal(filled.get("AWS_ACCESS_KEY_ID"), lane.target.accessKeyId);
  assert.equal(filled.get("AWS_SECRET_ACCESS_KEY"), lane.target.secretAccessKey);
  // A setting with nothing to fill is passed through as printed.
  assert.equal(filled.get("AWS_ENDPOINT_URL"), "http://langflow-instance-migration-s3:8333");
  for (const value of filled.values()) assert.doesNotMatch(value, /<[^<>]+>/);
});

test("fillStartSettings refuses a placeholder it has no value for, naming the setting", () => {
  // What the page prints for a dial policy it will not show (code: migration_target._SAME).
  const policy = { name: "LANGFLOW_KB_ALLOWED_HOSTS", value: "<same value as this instance>", fill: true };
  assert.throws(
    () => fillStartSettings([...PRINTED, policy], lane),
    /LANGFLOW_KB_ALLOWED_HOSTS holds a placeholder the lane cannot fill: <same value as this instance>/,
  );
});

test("fillStartSettings refuses an empty list instead of starting an instance on nothing", () => {
  assert.throws(() => fillStartSettings([], lane), /printed no settings/);
});

test("parseSettingsText reads the NAME=value lines of the page and skips the rest", () => {
  const text = [
    "Settings for the new instance",
    "LANGFLOW_DATABASE_URL=postgresql://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target",
    "  LANGFLOW_SECRET_KEY=<secret key>  ",
    "Copy",
    "LANGFLOW_SSRF_ALLOWED_HOSTS=172.16.0.0/12,10.0.0.0/8",
  ].join("\n");
  assert.deepEqual(parseSettingsText(text), [
    {
      name: "LANGFLOW_DATABASE_URL",
      value: "postgresql://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target",
    },
    { name: "LANGFLOW_SECRET_KEY", value: "<secret key>" },
    { name: "LANGFLOW_SSRF_ALLOWED_HOSTS", value: "172.16.0.0/12,10.0.0.0/8" },
  ]);
});

test("the docker run carries every setting by NAME only; the values, secrets included, travel in its environment", () => {
  const printed = fillStartSettings(PRINTED, lane);
  const { args, env } = newInstanceRun(lane, printed, operatorSettings(lane), { PATH: "/usr/bin" });
  const line = args.join(" ");
  for (const sentinel of lane.sentinels) assert.ok(!line.includes(sentinel), `a secret on the command line: ${sentinel}`);
  assert.deepEqual(args.slice(0, 8), [
    "run",
    "-d",
    "--name",
    "langflow-instance-migration-target",
    "--network",
    "langflow-instance-migration-net",
    "-p",
    "127.0.0.1:7896:7896",
  ]);
  assert.equal(args.at(-1), "langflow-instance-migration:local");
  const named = args.filter((_, i) => args[i - 1] === "-e");
  assert.deepEqual(named, [...printed, ...operatorSettings(lane)].map(([name]) => name));
  for (const [name, value] of [...printed, ...operatorSettings(lane)]) assert.equal(env[name], value, name);
  assert.equal(env.PATH, "/usr/bin");
});

test("an operator setting may not override what the page printed", () => {
  const printed = fillStartSettings(PRINTED, lane);
  assert.throws(
    () => newInstanceRun(lane, printed, [...operatorSettings(lane), ["LANGFLOW_AUTO_LOGIN", "false"]]),
    /would override what the page printed: LANGFLOW_AUTO_LOGIN/,
  );
});

test("startNewInstance hands docker the run and returns the container id", () => {
  const { docker, calls } = fakeDocker(() => "abc123\n");
  assert.equal(startNewInstance(lane, fillStartSettings(PRINTED, lane), operatorSettings(lane), docker), "abc123");
  assert.equal(calls[0][0], "run");
});

test("removeNewInstance removes it only when it is there, and says which", () => {
  const present = fakeDocker(() => "");
  assert.equal(removeNewInstance(lane, present.docker), true);
  assert.deepEqual(present.calls.at(-1), ["rm", "-f", "langflow-instance-migration-target"]);

  const absent = fakeDocker((args) => {
    if (args[0] === "container") throw new Error("No such container");
    return "";
  });
  assert.equal(removeNewInstance(lane, absent.docker), false);
  assert.ok(!absent.calls.some((c) => c[0] === "rm"), "removed a container that was not there");
});

/** A request context whose GET answers from a queue of statuses. */
function fakeRequest(...statuses: Array<number | Error>): APIRequestContext {
  return {
    get: async () => {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (next instanceof Error) throw next;
      return { status: () => next, json: async () => ({ version: "1.14.0.dev14", package: "Langflow Nightly" }) };
    },
  } as unknown as APIRequestContext;
}

test("waitForNewInstance returns the version once the instance answers 200", async () => {
  const { docker } = fakeDocker(() => "true");
  const version = await waitForNewInstance(fakeRequest(new Error("ECONNREFUSED"), 503, 200), lane, {
    timeoutMs: 5_000,
    intervalMs: 1,
    docker,
  });
  assert.equal(version.version, "1.14.0.dev14");
});

test("waitForNewInstance fails at once when the container stops, with its last log lines", async () => {
  const { docker } = fakeDocker((args) => (args[0] === "inspect" ? "false" : "sqlalchemy.exc.OperationalError: boom"));
  await assert.rejects(
    waitForNewInstance(fakeRequest(200), lane, { timeoutMs: 60_000, intervalMs: 1, docker }),
    /is not running\. Its last log lines:\nsqlalchemy\.exc\.OperationalError: boom/,
  );
});

test("waitForNewInstance gives up at its budget naming the last answer and the log", async () => {
  const { docker } = fakeDocker((args) => (args[0] === "inspect" ? "true" : "still migrating"));
  await assert.rejects(
    waitForNewInstance(fakeRequest(503), lane, { timeoutMs: 30, intervalMs: 5, docker }),
    /did not answer .*\(last: answered 503\)\. Its last log lines:\nstill migrating/,
  );
});
