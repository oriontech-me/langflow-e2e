import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";

/**
 * Authentication for the `@enterprise` lane.
 *
 * The OSS runner boots with `LANGFLOW_AUTO_LOGIN=true`, so the rest of the suite
 * gets a token from `/api/v1/auto_login` (`tests/helpers/auth/get-auth-token.ts`).
 * The EE image cannot: `LANGFLOW_AUTO_LOGIN=false` is baked into its Dockerfile,
 * and that endpoint answers 400 there. Password login is the only path.
 *
 * The second EE-only wrinkle is the forced rotation. EE marks the
 * env-bootstrapped superuser `must_change_password` (`sso_auth_service.py`,
 * reason `bootstrap_superuser`), and until it is done EVERY authenticated
 * endpoint answers 403 `{"detail":"must_change_password"}` — including the ones
 * these specs assert on. `scripts/start-langflow-enterprise.sh` performs the
 * rotation right after the health check, so a lane started through the script is
 * ready; a hand-started container is not, and that must read as a setup problem
 * rather than as a policy failure, which is why this throws naming the fix.
 */
export const EE_USERNAME = process.env.LANGFLOW_SUPERUSER || "langflow";
export const EE_PASSWORD = process.env.LANGFLOW_EE_PASSWORD || "Langflow123!";

/**
 * One login per worker process, cached.
 *
 * EE rate-limits `/api/v1/login` (429 with `retry_after: 60`). Measured on the
 * first run of this lane: eight tests logging in independently across parallel
 * workers exhausted the budget, five of them failed on 429, and the failures
 * read as an authentication problem rather than as what they were — the suite
 * hammering a limiter the OSS runner does not have, because `auto_login` needs
 * no credentials at all.
 *
 * Caching the promise (not the token) means concurrent tests in one worker share
 * a single in-flight request instead of racing to make several.
 */
let cachedToken: Promise<string> | undefined;

/**
 * Cross-PROCESS cache, on top of the per-worker one.
 *
 * The budget is 5 logins per minute for the whole machine, and a local session
 * re-runs the lane far more often than once a minute — a failing spec, a fix, a
 * re-run. Without this, the second run of the minute reports 429 instead of the
 * assertion it was re-run to check, and the third reports it again. The file
 * holds a token, not a credential, in the OS temp dir; it is keyed by base URL
 * so two instances never share one, and it is only reused while the JWT's own
 * `exp` still has a minute of life.
 */
const TOKEN_CACHE_DIR = join(tmpdir(), "langflow-e2e-enterprise");

function tokenCachePath(): string {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7890";
  const key = createHash("sha256").update(`${baseUrl}|${EE_USERNAME}`).digest("hex").slice(0, 16);
  return join(TOKEN_CACHE_DIR, `token-${key}.json`);
}

/** Seconds-since-epoch expiry of a JWT, or 0 when it cannot be read. */
function tokenExpiry(token: string): number {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof decoded.exp === "number" ? decoded.exp : 0;
  } catch {
    return 0;
  }
}

function readCachedToken(): string | undefined {
  try {
    const raw = readFileSync(tokenCachePath(), "utf-8");
    const token = (JSON.parse(raw) as { token?: string }).token;
    if (!token) return undefined;
    return tokenExpiry(token) > Date.now() / 1000 + 60 ? token : undefined;
  } catch {
    // A missing or unreadable cache is a cold start, never a failure.
    return undefined;
  }
}

function writeCachedToken(token: string): void {
  try {
    if (!existsSync(TOKEN_CACHE_DIR)) mkdirSync(TOKEN_CACHE_DIR, { recursive: true });
    writeFileSync(tokenCachePath(), JSON.stringify({ token }), { mode: 0o600 });
  } catch {
    // Best effort: failing to cache costs a login, not a run.
  }
}

export async function getEnterpriseAuthToken(request: APIRequestContext): Promise<string> {
  cachedToken ??= loginOnce(request);
  try {
    return await cachedToken;
  } catch (error) {
    // A failed login must not poison the worker for the rest of the run.
    cachedToken = undefined;
    throw error;
  }
}

/**
 * A cached token can be unexpired and still dead: the lane restarts the
 * container between policy scenarios, and EE stamps the user's password version
 * into the JWT (`lf_pwdv`), so a fresh database rejects yesterday's token.
 * Reusing it blindly would turn every assertion into a 403 that looks like a
 * permission finding. One cheap authenticated call settles it without spending
 * any of the 5-per-minute login budget.
 */
async function tokenStillValid(request: APIRequestContext, token: string): Promise<boolean> {
  try {
    const response = await request.get("/api/v1/users/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok();
  } catch {
    return false;
  }
}

/**
 * A single, UNCACHED password login.
 *
 * Exported because the credential-lifecycle spec has to authenticate as a
 * password the cache knows nothing about — the bootstrap one, before the forced
 * rotation — and has to observe what happens to that exact token afterwards.
 * Caching it would defeat both halves.
 *
 * Every caller spends one unit of the per-IP login budget, so callers state how
 * many they spend in their spec doc rather than discovering it as a 429.
 */
export async function loginWithPassword(
  request: APIRequestContext,
  password: string,
): Promise<string> {
  const response = await request.post("/api/v1/login", {
    form: { username: EE_USERNAME, password },
  });

  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `Enterprise login failed for '${EE_USERNAME}' (${response.status()}): ${body.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Enterprise login returned no access_token");
  }
  return `Bearer ${body.access_token}`;
}

async function loginOnce(request: APIRequestContext): Promise<string> {
  const cached = readCachedToken();
  if (cached && (await tokenStillValid(request, cached))) {
    return `Bearer ${cached}`;
  }

  const response = await request.post("/api/v1/login", {
    form: { username: EE_USERNAME, password: EE_PASSWORD },
  });

  if (!response.ok()) {
    const body = await response.text();
    const hint =
      response.status() === 429
        ? "EE rate-limits login; this lane logs in once per worker, so a 429 means another " +
          "process is authenticating against the same instance. Re-run with --workers=1."
        : "Start the instance with ./scripts/start-langflow-enterprise.sh — it performs the " +
          "forced password rotation EE requires, and prints the credentials it leaves behind.";
    throw new Error(
      `Enterprise login failed for '${EE_USERNAME}' (${response.status()}): ${body.slice(0, 200)}\n${hint}`,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Enterprise login returned no access_token");
  }
  writeCachedToken(body.access_token);
  return `Bearer ${body.access_token}`;
}
