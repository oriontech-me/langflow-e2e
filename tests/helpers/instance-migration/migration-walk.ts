import { execFileSync } from "node:child_process";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import type { InstanceMigrationLane } from "./instance-migration-lane";

/**
 * Instance migration through its API, and the destinations read from the test host
 * (#2353). A spec on the `@instance-migration` lane uses this to reach the step it is
 * about — the steps before it are other specs' subject (#2349–#2352) — and to check
 * what a step left in PostgreSQL, pgvector and the bucket, not only what the page says.
 *
 * Every call asserts its own answer. A walk that went wrong half-way would otherwise
 * surface as a page that "never shows the button", which names nothing.
 *
 * Measured contract: `docs/instance-migration/instance-migration-copy.md`.
 */

const MIGRATION = "/api/v1/migration";
/**
 * Measured ~16–22 s per check idle; a run's first event comes after ~10–12 s of process
 * start. On a loaded machine the same check measured 95 s, and once ran past 120 s (#2354),
 * so the budget is generous: it only costs time on a check that has truly hung.
 */
const CHECK_TIMEOUT_MS = 300_000;
// The database copy takes ~8 s idle, and measured ~6.5 min on a loaded machine (#2354),
// where a 5-minute budget failed a copy that was still working.
const RUN_TIMEOUT_MS = 600_000;

export type StepId =
  | "check_source"
  | "connect_target"
  | "secret_key"
  | "pause"
  | "backup"
  | "copy_database"
  | "copy_knowledge_bases"
  | "copy_files"
  | "check_target"
  | "start_target";

/** The steps that run as processes, followed through their events. */
export type RunStepId = "copy_database" | "copy_knowledge_bases" | "copy_files" | "check_target";

export interface StepState {
  id: StepId;
  state: "current" | "locked" | "blocked" | "done" | "skipped";
  reason: string | null;
}

/** `GET /api/v1/migration`, typed only as far as the specs read it. */
export interface MigrationState {
  instance: {
    version: string;
    database: { type: string; path?: string };
    knowledge_bases?: { folder?: string; local?: boolean };
    /** Where the key lives, never the key or its fingerprint (#2351). */
    secret_key?: { source: "env" | "file"; path?: string };
  };
  steps: StepState[];
  blocking_findings: string[];
  /** The names of the checks an admin may accept, e.g. `source: files` (#2349 asserts a regular user reads none). */
  acceptable_checks?: string[];
  // The record is the server's to shape; specs read the fields they assert on.
  record: Record<string, any>;
  start: { settings: { name: string; value: string; fill: boolean }[] };
}

export interface RunEvent {
  event: string;
  seq?: number;
  [field: string]: unknown;
}

export interface FinishedRun {
  runId: string;
  events: RunEvent[];
  end: RunEvent;
}

export interface MigrationApi {
  request: APIRequestContext;
  headers: Record<string, string>;
}

export async function migrationApi(request: APIRequestContext): Promise<MigrationApi> {
  // getAuthToken answers the whole header value, "Bearer <token>", or "" where auto-login is off.
  const authorization = await getAuthToken(request);
  if (!authorization) throw new Error("the lane's source issued no auto-login token; it runs with LANGFLOW_AUTO_LOGIN=true");
  return { request, headers: { Authorization: authorization } };
}

/**
 * The events of a run, from its NDJSON body. The server separates them with blank
 * lines, which are skipped; any other line that is not JSON throws, because a body
 * this cannot read is not a run that ended well.
 */
export function parseRunEvents(body: string): RunEvent[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RunEvent;
      } catch {
        throw new Error(`a run event is not JSON: ${line.slice(0, 200)}`);
      }
    });
}

/** One step's state, by id. Throws when the server no longer lists it. */
export function stepOf(state: MigrationState, id: StepId): StepState {
  const step = state.steps.find((s) => s.id === id);
  if (!step) throw new Error(`the migration state lists no step '${id}'`);
  return step;
}

/**
 * Throws naming what was expected. A helper throws rather than calling `expect`, whose
 * message is dropped outside the test runner.
 */
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function getMigration(api: MigrationApi): Promise<MigrationState> {
  const response = await api.request.get(MIGRATION, { headers: api.headers });
  await expectStatus(response, 200, `GET ${MIGRATION}`);
  return (await response.json()) as MigrationState;
}

async function expectStatus(response: APIResponse, status: number, what: string): Promise<void> {
  if (response.status() !== status) {
    throw new Error(`${what} answered ${response.status()}, expected ${status}: ${(await response.text()).slice(0, 400)}`);
  }
}

/** "Check this instance". The answer is a stream; reading it to the end waits for the last check. */
export async function runSourceChecks(api: MigrationApi): Promise<void> {
  const { instance } = await getMigration(api);
  const response = await api.request.post(`${MIGRATION}/checks`, {
    headers: api.headers,
    data: { target_version: instance.version },
    timeout: CHECK_TIMEOUT_MS,
  });
  await expectStatus(response, 200, "POST /checks");
  await response.body();
}

export interface PrepareOptions {
  /**
   * The findings of the first check a test planted on purpose, accepted as an admin
   * would. Any OTHER blocking finding fails the walk, naming it: accepting whatever
   * the check found would walk past the regression the check exists to report.
   */
  acceptFindings?: string[];
}

/**
 * Every step before the pause: the check, the destinations and the secret key. The pause
 * step is then the current one — for a spec about the pause itself (#2352), which asks
 * for it on its own terms.
 */
export async function prepareBeforePause(
  api: MigrationApi,
  lane: InstanceMigrationLane,
  { acceptFindings = [] }: PrepareOptions = {},
): Promise<void> {
  await runSourceChecks(api);
  const checked = await getMigration(api);
  const blocking = [...checked.blocking_findings].sort();
  const planted = [...acceptFindings].sort();
  must(
    JSON.stringify(blocking) === JSON.stringify(planted),
    `the first check blocks on ${JSON.stringify(blocking)}, and the test planted only ${JSON.stringify(planted)}`,
  );
  for (const name of acceptFindings) {
    await expectStatus(
      await api.request.post(`${MIGRATION}/accepted-findings`, { headers: api.headers, data: { name } }),
      200,
      `accepting '${name}'`,
    );
  }

  const destinations = await api.request.put(`${MIGRATION}/destinations`, {
    headers: api.headers,
    data: {
      database_url: lane.target.databaseUrl,
      vectors: { kind: "pgvector" },
      files: {
        bucket: lane.target.bucket,
        prefix: "langflow",
        access_key_id: lane.target.accessKeyId,
        secret_access_key: lane.target.secretAccessKey,
        endpoint_url: lane.target.s3Endpoint,
      },
    },
  });
  await expectStatus(destinations, 200, "PUT /destinations");
  const { results } = (await destinations.json()) as { results: Record<string, { ok: boolean }> };
  for (const part of ["database", "vectors", "files"]) {
    must(results?.[part]?.ok === true, `the ${part} destination does not test ok: ${JSON.stringify(results?.[part])}`);
  }

  await expectStatus(
    await api.request.post(`${MIGRATION}/secret-key/verify`, {
      headers: api.headers,
      data: { fingerprint: lane.secretKeyFingerprint },
    }),
    200,
    "POST /secret-key/verify",
  );
  const pause = stepOf(await getMigration(api), "pause");
  must(pause.state === "current", `the pause step is ${pause.state} (${pause.reason}) after the steps before it, not current`);
}

/** Every step before the backup: check, destinations, secret key, pause, and the check again during it. */
export async function prepareThroughPause(
  api: MigrationApi,
  lane: InstanceMigrationLane,
  options: PrepareOptions = {},
): Promise<void> {
  await prepareBeforePause(api, lane, options);
  await expectStatus(await api.request.post(`${MIGRATION}/pause`, { headers: api.headers, data: {} }), 200, "POST /pause");
  // Measured: the pause step reads `blocked: recheck_pending` until the check runs again during it.
  await runSourceChecks(api);
  const pause = stepOf(await getMigration(api), "pause");
  must(pause.state === "done", `the pause step is ${pause.state} (${pause.reason}) after the second check, not done`);
}

/** "Download the database". Answers the SQLite copy's bytes. */
export async function downloadDatabase(api: MigrationApi): Promise<Buffer> {
  const response = await api.request.post(`${MIGRATION}/backup/database`, { headers: api.headers });
  await expectStatus(response, 200, "POST /backup/database");
  return response.body();
}

export function confirmBackup(api: MigrationApi, location: string): Promise<APIResponse> {
  return api.request.post(`${MIGRATION}/steps/backup/confirm`, { headers: api.headers, data: { location } });
}

/** Everything before the copies: the steps up to the pause, then the download and the confirmed backup. */
export async function readyToCopy(
  api: MigrationApi,
  lane: InstanceMigrationLane,
  options: PrepareOptions & { location?: string } = {},
): Promise<void> {
  await prepareThroughPause(api, lane, options);
  await downloadDatabase(api);
  await expectStatus(await confirmBackup(api, options.location ?? "e2e instance-migration walk"), 200, "backup confirm");
  const backup = stepOf(await getMigration(api), "backup");
  must(backup.state === "done", `the backup step is ${backup.state} (${backup.reason}) after its confirmation, not done`);
}

/** Start a run and answer the raw response — for a spec that asserts a refusal. */
export function startRun(api: MigrationApi, step: RunStepId, dryRun = false): Promise<APIResponse> {
  return api.request.post(`${MIGRATION}/steps/${step}/runs`, { headers: api.headers, data: { dry_run: dryRun } });
}

/** Follow a run to its end. The events answer as a stream that closes when the run does. */
export async function followRun(api: MigrationApi, step: RunStepId, runId: string): Promise<FinishedRun> {
  const response = await api.request.get(`${MIGRATION}/steps/${step}/runs/${runId}/events`, {
    headers: api.headers,
    timeout: RUN_TIMEOUT_MS,
  });
  await expectStatus(response, 200, `GET the events of ${step}`);
  const events = parseRunEvents(await response.text());
  const end = events.at(-1);
  if (!end || end.event !== "end") {
    throw new Error(`the events of ${step} ended without an 'end' event: ${JSON.stringify(events.slice(-3))}`);
  }
  return { runId, events, end };
}

/** Start a run, follow it to its end, and require that it ended the way the caller expects. */
export async function runStep(
  api: MigrationApi,
  step: RunStepId,
  { dryRun = false, status = "done" }: { dryRun?: boolean; status?: string } = {},
): Promise<FinishedRun> {
  const started = await startRun(api, step, dryRun);
  await expectStatus(started, 202, `starting ${step}`);
  const { run_id: runId } = (await started.json()) as { run_id: string };
  const run = await followRun(api, step, runId);
  must(run.end.status === status, `${step} ended ${String(run.end.status)}, expected ${status}: ${JSON.stringify(run.events.slice(-3))}`);
  return run;
}

// ---------------------------------------------------------------------------
// The destinations and the source, read from the test host.
// ---------------------------------------------------------------------------

export type Exec = (args: string[], input?: string) => string;

/** `docker <args>`, synchronously. Injected so the unit tests never need a container. */
export const docker: Exec = (args, input) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

/** The target database's user and name, from the address the source is given. */
export function targetDatabase(lane: InstanceMigrationLane): { user: string; database: string } {
  const url = new URL(lane.target.databaseUrl);
  return { user: decodeURIComponent(url.username), database: url.pathname.replace(/^\//, "") };
}

/**
 * One SQL statement against the target, through `psql` inside its container — no
 * client library is added for this. Answers psql's unaligned, tuples-only output.
 */
export function targetSql(lane: InstanceMigrationLane, sql: string, exec: Exec = docker): string {
  const { user, database } = targetDatabase(lane);
  return exec(["exec", lane.containers.database, "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-tAc", sql]).trim();
}

/** A table's row count in the target, 0 when the table does not exist (a copy stopped before the schema). */
export function targetRowCount(lane: InstanceMigrationLane, table: string, exec: Exec = docker): number {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`not a plain table name: ${table}`);
  const exists = targetSql(lane, `select to_regclass('public."${table}"') is not null`, exec);
  if (exists !== "t") return 0;
  return Number(targetSql(lane, `select count(*) from public."${table}"`, exec));
}

/** The pgvector tables the knowledge base copy creates, `lf_<hex>`. */
export function targetVectorTables(lane: InstanceMigrationLane, exec: Exec = docker): string[] {
  const out = targetSql(
    lane,
    "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'lf\\_%' order by 1",
    exec,
  );
  return out ? out.split("\n").map((line) => line.trim()) : [];
}

const SOURCE_QUERY = [
  "import json, sqlite3, sys",
  "c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
  "print(json.dumps(c.execute(sys.argv[2]).fetchall()))",
].join("\n");

/**
 * One read-only SQL query against the SOURCE's SQLite database, inside its container.
 * `dbPath` is what `GET /api/v1/migration` reports as `instance.database.path`.
 */
export function sourceSql(lane: InstanceMigrationLane, dbPath: string, sql: string, exec: Exec = docker): unknown[][] {
  const out = exec(["exec", lane.containers.source, "python", "-c", SOURCE_QUERY, dbPath, sql]);
  return JSON.parse(out.trim().split("\n").at(-1) ?? "[]") as unknown[][];
}

/** One route of the migration router, as the running source declares it (#2349). */
export interface MigrationRoute {
  /** Without the `/api/v1` prefix, with its path parameters as declared: `/migration/steps/{step_id}/runs`. */
  path: string;
  methods: string[];
  /** Some dependency of the route, at any depth, is `get_current_active_superuser`. */
  superuser: boolean;
  /** Some dependency of the route, at any depth, is `get_current_active_user`. */
  signedIn: boolean;
}

const ROUTE_INVENTORY = [
  "import json",
  "from langflow.api.v1.migration import router",
  "def names(dependant):",
  "    for dep in dependant.dependencies:",
  "        yield getattr(dep.call, '__name__', repr(dep.call))",
  "        yield from names(dep)",
  "rows = []",
  "for route in router.routes:",
  "    called = set(names(route.dependant))",
  "    rows.append({'path': route.path, 'methods': sorted(route.methods),",
  "                 'superuser': 'get_current_active_superuser' in called,",
  "                 'signed_in': 'get_current_active_user' in called})",
  "print(json.dumps(rows))",
].join("\n");

/**
 * Every route of the instance migration router, read from the router the SOURCE is
 * running. The router is `include_in_schema=False`, so `/openapi.json` does not list it,
 * and a hand-written list would miss the route upstream adds next — the one an
 * authorization test exists to catch.
 *
 * Throws on an empty or malformed answer: an inventory that read nothing would make
 * "every superuser route refuses" true of no route at all.
 */
export function migrationRouteInventory(lane: InstanceMigrationLane, exec: Exec = docker): MigrationRoute[] {
  const out = exec(["exec", lane.containers.source, "python", "-c", ROUTE_INVENTORY]);
  const last = out.trim().split("\n").at(-1) ?? "";
  let rows: unknown;
  try {
    rows = JSON.parse(last);
  } catch {
    throw new Error(`the route inventory did not answer JSON: ${last.slice(0, 200)}`);
  }
  must(Array.isArray(rows) && rows.length > 0, `the route inventory listed no route: ${last.slice(0, 200)}`);
  return rows.map((row) => {
    const { path, methods, superuser, signed_in: signedIn } = (row ?? {}) as Record<string, unknown>;
    must(
      typeof path === "string" &&
        path.startsWith("/migration") &&
        Array.isArray(methods) &&
        methods.length > 0 &&
        methods.every((m) => typeof m === "string") &&
        typeof superuser === "boolean" &&
        typeof signedIn === "boolean",
      `the route inventory listed a row it cannot read: ${JSON.stringify(row)}`,
    );
    return { path, methods: methods as string[], superuser, signedIn };
  });
}

export interface BucketObject {
  key: string;
  size: number;
}

/**
 * The objects of a ListObjectsV2 answer. Throws on a truncated listing: a test that
 * counts objects must see all of them.
 */
export function parseListObjects(xml: string): BucketObject[] {
  if (!xml.includes("<ListBucketResult")) throw new Error(`not a ListObjectsV2 answer: ${xml.slice(0, 200)}`);
  if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new Error("the bucket listing is truncated");
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, body]) => {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key === undefined || size === undefined) throw new Error(`a listed object has no key or size: ${body}`);
    return { key, size: Number(size) };
  });
}

/**
 * Every object in the lane's bucket. SeaweedFS answers an unsigned listing (measured),
 * so this needs no S3 client and no credentials.
 */
export async function bucketObjects(request: APIRequestContext, lane: InstanceMigrationLane): Promise<BucketObject[]> {
  const response = await request.get(`${lane.fromHost.s3Endpoint}/${lane.target.bucket}?list-type=2`);
  await expectStatus(response, 200, "listing the bucket");
  return parseListObjects(await response.text());
}
