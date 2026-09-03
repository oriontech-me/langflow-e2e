/**
 * Refresh the committed API-surface baseline (#1692).
 *
 *   npm run api:baseline
 *   npm run api:baseline -- --container langflow-1643-113 --base-url http://localhost:7880
 *
 * Writes `tests/assets/api/api-surface-baseline.json`, the denominator of the API
 * coverage gauge. The diff is **committed on purpose**: a self-updating baseline
 * makes every surface change invisible exactly once.
 *
 * Why this needs the container and the gate does not
 * --------------------------------------------------
 * `/openapi.json` is not the API. Measured on `1.13.0.dev0` and `1.13.0.dev1`
 * (byte-identical schemas): 120 operations in the document against **249** in the
 * instance's own router table, 137 of them `include_in_schema=False`. The hidden
 * half includes `POST /api/v1/login`, `GET /api/v1/api_key/`,
 * `GET /api/v1/variables/` and `POST /api/v1/custom_component` — three of which
 * existing specs already drive, so a schema-derived denominator would report
 * 100 % with tests sitting outside the count.
 *
 * That half is only readable from inside the process, so this script asks the
 * container for it. The run-time verdict never needs it: it compares the
 * schema-visible half live and carries the hidden half from this file
 * (`tests/helpers/other/api-surface-drift.ts`).
 *
 * A refresh that cannot reach the container **refuses** rather than writing a
 * schema-only baseline — that would silently shrink the denominator by 90
 * operations, which is the exact shape of failure the gauge exists to prevent.
 */

import { request as playwrightRequest } from "@playwright/test";
import { execFile } from "node:child_process";
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAuthToken } from "../tests/helpers/auth/get-auth-token";
import {
  inScopeOperations,
  normalizeRouteTable,
  opKey,
  schemaOperations,
  type ApiOperation,
  type ApiScopeExclusion,
  type ApiSurfaceBaseline,
} from "../tests/helpers/other/api-surface-drift";

dotenv.config();

const execFileAsync = promisify(execFile);

const DEFAULT_OUT = path.join(
  __dirname,
  "../tests/assets/api/api-surface-baseline.json",
);

/** Prefix of the line carrying the route table, so warnings cannot be mistaken for it. */
export const ROUTE_DUMP_MARKER = "ROUTES_JSON:";

/**
 * Families deliberately outside the denominator, each with the reason it is.
 *
 * Kept as data rather than a filter so the report can print them: an exclusion
 * whose justification expired silently is the failure #1084 was raised about.
 * The same list is documented in `docs/api/api-surface-coverage-gauge.md`, and a
 * unit test pins the two together.
 */
export const API_SCOPE_EXCLUSIONS: ApiScopeExclusion[] = [
  {
    prefix: "/api/v1/authz/",
    reason:
      "OSS authorization is pass-through — enforce() returns True and logs that it did, so an assertion here would assert nothing. The @enterprise lane drives these paths against an instance that enforces.",
  },
  {
    prefix: "/api/v1/store/",
    reason:
      "The Langflow Store is an external service, unreachable in CI and already a documented exemption in tests/fixtures/http-error-policy.ts. Covering it would mean asserting a mock.",
  },
  {
    prefix: "/api/v1/agentic/",
    reason:
      "AI-assist needs a live provider plus its own flag, and every assertion would depend on the model electing to act — the opposite of the any-completion tier (#1187).",
  },
  {
    prefix: "/api/v1/predict/",
    reason:
      "Deprecation stub kept for backwards compatibility; the family answers 400 telling the caller to use /run instead.",
  },
  {
    prefix: "/api/v1/process/",
    reason:
      "Deprecation stub kept for backwards compatibility; the family answers 400 telling the caller to use /run instead.",
  },
  {
    prefix: "/api/v1/task/",
    reason:
      "Deprecation stub: GET /api/v1/task/x answers 400 'The /task endpoint is deprecated and will be removed in a future version. Please use /run instead.'",
  },
  {
    prefix: "/api/v1/upload/",
    reason:
      "Deprecation stub superseded by /api/v1/files/upload/{flow_id} and POST /api/v2/files, both of which are covered.",
  },
  {
    prefix: "/api/v1/voice/",
    reason:
      "A WebSocket / ElevenLabs surface: no HTTP contract to assert, and it needs a third-party credential the suite does not hold.",
  },
  {
    prefix: "/api/v1/extensions/",
    reason:
      "A plugin SSE channel and a bundle-reload hook: both need an installed extension, which the OSS nightly does not ship.",
  },
];

/** The walker, run inside the instance's own interpreter. */
const ROUTE_WALKER = `
import json
from fastapi.routing import _IncludedRouter, APIRoute
from langflow.api.router import router
from langflow.api.health_check_router import health_check_router
from langflow.api.log_router import log_router

# FastAPI defers included routers: router.routes holds _IncludedRouter wrappers
# with methods=None, so a plain loop reports zero operations. Recurse through
# original_router, accumulating the prefix each include contributed.
def walk(r, prefix=""):
    out = []
    for rt in getattr(r, "routes", []):
        if isinstance(rt, _IncludedRouter):
            ctx = getattr(rt, "include_context", None)
            out += walk(rt.original_router, prefix + (getattr(ctx, "prefix", "") or ""))
            continue
        methods = sorted(getattr(rt, "methods", None) or [])
        path = prefix + (getattr(rt, "path", "") or "")
        in_schema = bool(getattr(rt, "include_in_schema", True))
        for m in methods:
            if m in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                out.append([m, path, in_schema])
    return out

# The health and log routers are mounted on the APP, not inside \`router\`, so a
# walk of \`router\` alone misses /health, /health_check, /healthz, /logs and
# /logs-stream — five operations /openapi.json does expose, which the drift gate
# then reported as phantom additions on every run.
table = walk(router) + walk(health_check_router) + walk(log_router)
print("${ROUTE_DUMP_MARKER}" + json.dumps(table))
`;

/** The argv handed to `docker`, with the walker passed as an argument. */
export function dockerExecArgv(container: string): string[] {
  // Never through a shell: the walker is multi-line Python and would need
  // quoting that a container name from the environment could break out of.
  return ["exec", container, "python", "-c", ROUTE_WALKER];
}

/** The route table the extractor printed, or a throw naming what arrived instead. */
export function parseRouteDump(stdout: string): ApiOperation[] {
  const line = stdout
    .split("\n")
    .find((l) => l.trimStart().startsWith(ROUTE_DUMP_MARKER));
  if (!line) {
    const head = stdout.trim().split("\n").slice(0, 3).join(" / ") || "(nothing)";
    throw new Error(
      `the extractor printed no ${ROUTE_DUMP_MARKER} marker — got: ${head}`,
    );
  }
  const payload = line.trimStart().slice(ROUTE_DUMP_MARKER.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (e) {
    throw new Error(
      `the ${ROUTE_DUMP_MARKER} payload could not be parsed as JSON — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `the ${ROUTE_DUMP_MARKER} payload is not an array (got ${typeof parsed})`,
    );
  }
  if (parsed.length === 0) {
    // The measured trap: a naive read of `router.routes` yields two
    // `_IncludedRouter` wrappers with `methods=None` and walks to nothing. An
    // empty baseline would shrink the denominator to zero and read as a clean
    // 0/0 forever.
    throw new Error(
      "the extractor found no routes at all — the router walk did not resolve the lazy includes; refusing to write an empty baseline",
    );
  }
  return parsed.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error(
        `route entry ${i} is not a [method, path, inSchema] triple: ${JSON.stringify(entry)}`,
      );
    }
    return {
      method: String(entry[0]),
      path: String(entry[1]),
      inSchema: entry[2] === true,
    };
  });
}

export interface LivenessProbe {
  probed: number;
  /** Operations the router registers that the build does not serve. */
  dead: string[];
}

export interface BuildBaselineInput {
  version: string;
  routes: ApiOperation[];
  liveness?: LivenessProbe;
}

/**
 * The committed file, with the liveness probe attached.
 *
 * Deliberately carries **no timestamp**: the committed diff is the review, and a
 * field that changes on every refresh makes every refresh a diff of nothing —
 * which trains the reader to skip it. When the baseline was last refreshed is a
 * question git history answers better than the artifact does.
 */
export function buildBaseline(
  input: BuildBaselineInput,
): ApiSurfaceBaseline & { liveness?: LivenessProbe } {
  const operations = normalizeRouteTable(input.routes);
  if (!operations.some((op) => op.inSchema)) {
    // A run where the router walk succeeded but /openapi.json did not would mark
    // all 249 operations hidden, leaving the gate comparing nothing while
    // reporting `clean`.
    throw new Error(
      "no operation is marked as present in the schema — /openapi.json was probably not read; refusing to write a baseline the gate cannot compare",
    );
  }
  return {
    version: input.version,
    exclusions: API_SCOPE_EXCLUSIONS,
    operations,
    ...(input.liveness ? { liveness: input.liveness } : {}),
  };
}

export interface Args {
  container: string;
  baseUrl: string;
  out: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    container: process.env.LANGFLOW_CONTAINER || "langflow-e2e-runner",
    baseUrl: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860",
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const take = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case "--container":
        args.container = take();
        break;
      case "--base-url":
        args.baseUrl = take();
        break;
      case "--out":
        args.out = take();
        break;
      default:
        // Never ignored: a typo'd flag silently baselining the default container
        // is how a baseline of the wrong image gets committed.
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

/**
 * Probe the operations that can be probed without inventing an id: the
 * parameter-free in-scope `GET`s.
 *
 * This is what separates a route the *package* registers from one the *build*
 * actually serves. `403`, `200`, `307` and `422` all prove the route exists; a
 * `404` on GET is the SPA catch-all, i.e. nothing is mounted there. Measured on
 * `1.13.0.dev0`: 50 probed, 0 dead.
 */
async function probeLiveness(
  ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  operations: ApiOperation[],
  headers: Record<string, string> | undefined,
): Promise<LivenessProbe> {
  const probable = operations.filter(
    (op) => op.method === "GET" && !op.path.includes("{"),
  );
  const dead: string[] = [];
  for (const op of probable) {
    try {
      const res = await ctx.get(op.path, {
        headers,
        timeout: 10_000,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      if (res.status() === 404) dead.push(opKey(op.method, op.path));
    } catch {
      // A transport failure is not evidence that the route is absent, so it is
      // not recorded as dead — `probed` still counts it, and the count/dead pair
      // is what the diff shows.
      continue;
    }
  }
  return { probed: probable.length, dead };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
    return;
  }

  let dump: string;
  try {
    const { stdout } = await execFileAsync("docker", dockerExecArgv(args.container), {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    });
    dump = stdout;
  } catch (e) {
    console.error(
      `✖ could not read the route table out of container "${args.container}" — ${e instanceof Error ? e.message : String(e)}\n` +
        `  The hidden half of the surface (137 of 249 operations on 1.13.0.dev0) is not readable over HTTP,\n` +
        `  so a schema-only baseline would silently shrink the denominator by ~90 operations. Refusing.\n` +
        `  Pass --container <name> if the instance runs under a different name.`,
    );
    process.exit(1);
    return;
  }

  let routes: ApiOperation[];
  try {
    routes = parseRouteDump(dump);
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }

  const ctx = await playwrightRequest.newContext({ baseURL: args.baseUrl });
  try {
    const auth = await getAuthToken(ctx).catch(() => "");
    const headers = auth ? { Authorization: auth } : undefined;

    const versionRes = await ctx.get("/api/v1/version", { headers, timeout: 30_000 });
    if (!versionRes.ok()) {
      console.error(
        `✖ ${args.baseUrl} answered ${versionRes.status()} for /api/v1/version — is Langflow up?`,
      );
      process.exit(1);
      return;
    }
    const version = String((await versionRes.json())?.version ?? "unknown");

    const schemaRes = await ctx.get("/openapi.json", { headers, timeout: 60_000 });
    if (!schemaRes.ok()) {
      console.error(
        `✖ GET /openapi.json answered ${schemaRes.status()} — refusing to write a baseline whose schema half is unknown.`,
      );
      process.exit(1);
      return;
    }
    const exposed = schemaOperations(await schemaRes.json());
    if (!exposed || exposed.length === 0) {
      console.error(
        "✖ GET /openapi.json carried no operations — the instance is probably still assembling its routers. Retry.",
      );
      process.exit(1);
      return;
    }
    const exposedKeys = new Set(exposed.map((op) => opKey(op.method, op.path)));

    // The walk knows `include_in_schema`, but the document is the authority on
    // what is actually exposed: the two disagree the moment a route is excluded
    // at app level rather than at route level.
    const withSchemaFlag = routes.map((op) => ({
      ...op,
      inSchema: op.inSchema || exposedKeys.has(opKey(op.method, op.path)),
    }));

    let baseline: ApiSurfaceBaseline & { liveness?: LivenessProbe };
    try {
      baseline = buildBaseline({ version, routes: withSchemaFlag });
    } catch (e) {
      console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
      return;
    }

    const inScope = inScopeOperations(baseline);
    baseline.liveness = await probeLiveness(ctx, inScope, headers);

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(baseline, null, 2)}\n`);

    const hidden = baseline.operations.filter((op) => !op.inSchema).length;
    console.log(
      `✔ wrote ${path.relative(process.cwd(), args.out)} — Langflow ${version}\n` +
        `  ${baseline.operations.length} operations (${baseline.operations.length - hidden} in /openapi.json, ${hidden} hidden)\n` +
        `  ${inScope.length} in scope after ${API_SCOPE_EXCLUSIONS.length} exclusion(s)\n` +
        `  liveness: ${baseline.liveness.probed} parameter-free in-scope GET(s) probed, ${baseline.liveness.dead.length} answering 404`,
    );
    if (baseline.liveness.dead.length > 0) {
      console.warn(
        `⚠ the router registers these but the build does not serve them:\n` +
          baseline.liveness.dead.map((k) => `    ${k}`).join("\n") +
          `\n  They stay in the baseline, so the report counts them as uncovered rather than hiding them.`,
      );
    }
  } finally {
    await ctx.dispose();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`✖ ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
  });
}
