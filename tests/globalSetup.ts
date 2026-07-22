import {
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import * as dotenv from "dotenv";
import { getAuthToken } from "./helpers/auth/get-auth-token";

dotenv.config();

/**
 * Pre-flight fail-fast gate (issue #884).
 *
 * Runs once before the suite. Its job is NOT to fix environment saturation
 * (that is #833 sharding / #882 lane isolation) but to remove the
 * **misclassification tax**: when the environment is misconfigured, a spec
 * would otherwise fail deep inside with a misleading signature that is
 * indistinguishable from a saturation timeout — costing a whole triage cycle
 * chasing a phantom product regression (the exact trap root-caused in #880,
 * where GOOGLE_API_KEY was set in the env but never imported into Langflow, so
 * KB ingest surfaced only as a 90s node_duration timeout).
 *
 * Checks, in order:
 *  1. Backend reachable + version (hard fail always — nothing can run if the
 *     instance is down; the poll also warms the HTTP path so the first real
 *     spec doesn't eat cold-start latency).
 *  2. Provider credentials actually configured in Langflow, not merely present
 *     in the environment. For each known provider key present in `process.env`,
 *     it must exist as a Langflow global variable. In CI this is a hard fail
 *     (the daily must not run misconfigured); locally it is a warning, so a
 *     partial-key setup that legitimately skips those specs is never blocked.
 *     Skipped entirely when `PREFLIGHT_SKIP_CREDENTIALS` is set — the
 *     collect-models step sets it, because that run is what *imports* the
 *     credentials (chicken-and-egg).
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860";

// Provider keys the suite may depend on. Present-in-env-but-absent-in-Langflow
// is the misconfiguration this gate catches (see #880).
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"];

// The backend can still be starting when the suite launches; poll briefly.
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 2_000;

const truthy = (v: string | undefined): boolean =>
  !!v && v !== "0" && v.toLowerCase() !== "false";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls /api/v1/version until the instance answers or the timeout elapses. */
async function assertBackendHealthy(ctx: APIRequestContext): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";
  for (;;) {
    try {
      const res = await ctx.get("/api/v1/version");
      if (res.ok()) {
        const body = (await res.json()) as {
          version?: string;
          package?: string;
        };
        const version = body.version ?? "unknown";
        console.log(
          `[preflight] backend healthy at ${BASE_URL} — ${body.package ?? "Langflow"} ${version}`,
        );
        const expected = process.env.EXPECTED_LANGFLOW_VERSION;
        if (expected && version !== expected) {
          console.warn(
            `[preflight] WARNING: version ${version} != expected ${expected} — results may not reflect the intended build.`,
          );
        }
        return;
      }
      lastError = `HTTP ${res.status()}`;
    } catch (e) {
      lastError = String(e);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[preflight] Langflow backend at ${BASE_URL} is not reachable ` +
          `after ${HEALTH_TIMEOUT_MS}ms (last: ${lastError}). Start the instance ` +
          `before running the suite (see the langflow-e2e skill: run the nightly image).`,
      );
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
}

/**
 * For every provider key present in the environment, verify it is configured as
 * a Langflow global variable. Hard fail in CI, warn locally.
 */
async function checkProviderCredentials(ctx: APIRequestContext): Promise<void> {
  const envKeys = PROVIDER_KEYS.filter((k) => truthy(process.env[k]));
  if (envKeys.length === 0) return;

  const authHeader = await getAuthToken(ctx);
  if (!authHeader) {
    console.warn(
      "[preflight] could not obtain an auth token — skipping the credential check.",
    );
    return;
  }

  const res = await ctx.get("/api/v1/variables/", {
    headers: { Authorization: authHeader },
  });
  if (!res.ok()) {
    console.warn(
      `[preflight] could not read Langflow variables (HTTP ${res.status()}) — skipping the credential check.`,
    );
    return;
  }

  const variables = (await res.json()) as Array<{ name?: string }>;
  const configured = new Set(variables.map((v) => v.name).filter(Boolean));
  const missing = envKeys.filter((k) => !configured.has(k));
  if (missing.length === 0) {
    console.log(
      `[preflight] provider credentials configured in Langflow: ${envKeys.join(", ")}`,
    );
    return;
  }

  const message =
    `[preflight] provider key(s) set in the environment but NOT configured as a ` +
    `Langflow global variable: ${missing.join(", ")}. Specs resolve credentials ` +
    `from Langflow, not the env var, so they would fail with a misleading ` +
    `error (e.g. a node_duration/build timeout). Run ` +
    `\`npx playwright test tests/collect-models.spec.ts\` first to import them ` +
    `(the daily-stable CI does this automatically).`;

  if (process.env.CI) {
    throw new Error(message);
  }
  console.warn(`${message}\n(local run — warning only, not blocking.)`);
}

export default async function globalSetup(): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    await assertBackendHealthy(ctx);
    if (truthy(process.env.PREFLIGHT_SKIP_CREDENTIALS)) {
      console.log(
        "[preflight] PREFLIGHT_SKIP_CREDENTIALS set — skipping the credential check (credential-importing run).",
      );
    } else {
      await checkProviderCredentials(ctx);
    }
  } finally {
    await ctx.dispose();
  }
}
