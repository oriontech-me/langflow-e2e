import { execFileSync } from "node:child_process";
import type { APIRequestContext } from "@playwright/test";
import type { InstanceMigrationLane } from "./instance-migration-lane";

/**
 * The new instance an instance migration moves to (#2354): a second Langflow started on
 * the copy, from the settings *Start the new instance* prints, so a spec can check that
 * it serves what was copied.
 *
 * The page prints each setting with a placeholder where a secret goes (`<password>`,
 * `<secret key>`, …) and `fill: true`. This module fills them from the lane's fixtures
 * and refuses any it cannot fill: a target started with a placeholder still in a value
 * would fail far from the cause. The settings the page does not print — port, workers,
 * the custom-components switch — are the operator's own (`start_settings` in upstream's
 * `migration_target.py` carries only where the data lives, the key, sign-in and the dial
 * policies, on purpose), and an operator setting may never override a printed one.
 *
 * Measured contract: `docs/instance-migration/instance-migration-target-acceptance.md`.
 */

/** One entry of `GET /api/v1/migration` → `start.settings`, in the page's order. */
export interface StartSetting {
  name: string;
  value: string;
  fill: boolean;
}

/** A setting as the new instance receives it. */
export type Setting = [name: string, value: string];

/** Runs `docker` with `args`; `env` is the CLI's own environment. Returns stdout. */
export type DockerRunner = (args: string[], env?: NodeJS.ProcessEnv) => string;

const runDocker: DockerRunner = (args, env) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
    timeout: 5 * 60_000,
  });

/** Every `<…>` token in a value. */
const PLACEHOLDER = /<[^<>]+>/g;

/** What each placeholder the start step prints stands for, from the lane's fixtures. */
export function placeholderValues(lane: InstanceMigrationLane): Record<string, string> {
  const database = new URL(lane.target.databaseUrl);
  return {
    "<user>": decodeURIComponent(database.username),
    "<password>": decodeURIComponent(database.password),
    "<secret key>": lane.secretKey,
    "<access key id>": lane.target.accessKeyId,
    "<secret access key>": lane.target.secretAccessKey,
  };
}

/**
 * The printed settings with every placeholder filled in. Throws when the page printed
 * none (the start step shows them only once *Check the copy* is done) or when a value
 * holds a placeholder the lane has no value for — `<same value as this instance>` is one
 * the page prints for a dial policy it will not show.
 */
export function fillStartSettings(settings: StartSetting[], lane: InstanceMigrationLane): Setting[] {
  if (settings.length === 0) {
    throw new Error("the start step printed no settings — it shows them only once 'Check the copy' is done");
  }
  const values = placeholderValues(lane);
  return settings.map(({ name, value }) => {
    const unknown = (value.match(PLACEHOLDER) ?? []).filter((token) => !(token in values));
    if (unknown.length > 0) {
      throw new Error(`the start setting ${name} holds a placeholder the lane cannot fill: ${unknown.join(", ")}`);
    }
    return [name, value.replace(PLACEHOLDER, (token) => values[token])];
  });
}

/**
 * The `NAME=value` lines of the page's `migration-start-settings`, in order. Lines that
 * are not a setting (a heading, a copy button's label) are skipped.
 */
export function parseSettingsText(text: string): Array<{ name: string; value: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1], value: m[2] }));
}

/**
 * The settings the page does not print and an operator supplies anyway: where the server
 * listens, one worker like the source, tracing off like every lane, and custom components
 * on — the source runs with them on and the credential check runs custom code.
 */
export function operatorSettings(lane: InstanceMigrationLane): Setting[] {
  return [
    ["LANGFLOW_HOST", "0.0.0.0"],
    ["LANGFLOW_PORT", lane.newInstance.port],
    ["LANGFLOW_WORKERS", "1"],
    ["LANGFLOW_ALLOW_CUSTOM_COMPONENTS", "true"],
    ["LANGFLOW_DEACTIVATE_TRACING", "true"],
  ];
}

/**
 * The `docker run` for the new instance, and the environment its CLI runs with. Every
 * setting is passed as `-e NAME` and its value through that environment, so no password
 * or key ever sits on a command line another process could read.
 */
export function newInstanceRun(
  lane: InstanceMigrationLane,
  printed: Setting[],
  operator: Setting[] = operatorSettings(lane),
  base: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const printedNames = new Set(printed.map(([name]) => name));
  const overlap = operator.filter(([name]) => printedNames.has(name)).map(([name]) => name);
  if (overlap.length > 0) {
    throw new Error(`an operator setting would override what the page printed: ${overlap.join(", ")}`);
  }
  const all = [...printed, ...operator];
  const { container, network, port, image } = lane.newInstance;
  const args = ["run", "-d", "--name", container, "--network", network, "-p", `127.0.0.1:${port}:${port}`];
  for (const [name] of all) args.push("-e", name);
  args.push(image);
  return { args, env: { ...base, ...Object.fromEntries(all) } };
}

/** Starts the new instance. Returns the container id. */
export function startNewInstance(
  lane: InstanceMigrationLane,
  printed: Setting[],
  operator: Setting[] = operatorSettings(lane),
  docker: DockerRunner = runDocker,
): string {
  const { args, env } = newInstanceRun(lane, printed, operator);
  return docker(args, env).trim();
}

/** True when the new instance's container exists, running or not. */
export function newInstanceExists(lane: InstanceMigrationLane, docker: DockerRunner = runDocker): boolean {
  try {
    docker(["container", "inspect", lane.newInstance.container]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the new instance when it is there. `docker rm -f` exits 0 for a container
 * that is not (#2090), so the inspect decides, and the answer says which it was.
 */
export function removeNewInstance(lane: InstanceMigrationLane, docker: DockerRunner = runDocker): boolean {
  if (!newInstanceExists(lane, docker)) return false;
  docker(["rm", "-f", lane.newInstance.container]);
  return true;
}

function lastLogLines(lane: InstanceMigrationLane, docker: DockerRunner): string {
  try {
    // docker logs writes the server's own output to stderr as well; both are wanted.
    return docker(["logs", "--tail", "30", lane.newInstance.container]).trim() || "(no output)";
  } catch (error) {
    return `(could not read its log: ${String(error).split("\n")[0]})`;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  docker?: DockerRunner;
}

/**
 * Waits until the new instance answers `GET /api/v1/version` with 200, and returns that
 * answer. Fails as soon as its container stops, or when the budget runs out — either
 * way naming the container's last log lines, because "it never answered" alone says
 * nothing about why.
 */
export async function waitForNewInstance(
  request: APIRequestContext,
  lane: InstanceMigrationLane,
  { timeoutMs, intervalMs = 3_000, docker = runDocker }: WaitOptions,
): Promise<{ version: string; package?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer yet";
  while (Date.now() < deadline) {
    let running = "";
    try {
      running = docker(["inspect", "-f", "{{.State.Running}}", lane.newInstance.container]).trim();
    } catch {
      running = "absent";
    }
    if (running !== "true") {
      throw new Error(
        `the new instance ${lane.newInstance.container} is ${running === "absent" ? "gone" : "not running"}. ` +
          `Its last log lines:\n${lastLogLines(lane, docker)}`,
      );
    }
    try {
      const response = await request.get(`${lane.newInstance.url}/api/v1/version`, { timeout: 5_000 });
      if (response.status() === 200) return (await response.json()) as { version: string; package?: string };
      last = `answered ${response.status()}`;
    } catch (error) {
      last = String(error).split("\n")[0];
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `the new instance did not answer ${lane.newInstance.url}/api/v1/version within ${Math.round(timeoutMs / 1000)} s ` +
      `(last: ${last}). Its last log lines:\n${lastLogLines(lane, docker)}`,
  );
}
