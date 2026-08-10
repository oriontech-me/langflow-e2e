import {
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { getAuthToken } from "./helpers/auth/get-auth-token";
import {
  degradeProviders,
  providersForEnvKeys,
  readProviderHealth,
  writeProviderHealth,
} from "./helpers/provider-setup/provider-health";
import { preconfigureRoutedProvider } from "./helpers/provider-setup/preconfigure-routed-provider";
import { freezeModelCatalog } from "./helpers/provider-setup/catalog-snapshot";
import {
  catalogVerdict,
  type CatalogSnapshot,
} from "./helpers/other/component-catalog-drift";

dotenv.config();

/**
 * The accepted component catalog, committed so drift shows up as a reviewable
 * diff (#1040). Refresh with `npm run catalog:baseline`.
 *
 * Resolved from `__dirname` rather than the process cwd: `globalSetup` is loaded
 * by Playwright, and a cwd-relative path would break the moment the suite is run
 * from anywhere but the repo root.
 */
const CATALOG_BASELINE_PATH = path.join(
  __dirname,
  "assets/catalog/component-catalog-baseline.json",
);

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

// The backend can still be starting when the suite launches — and, in the
// pr-validation impacted-specs job, the `collect-models` preflight step drives a
// full model-toggle sweep that leaves the single backend process transiently
// wedged (event loop blocked >30s; container alive, just silent) right when this
// step's globalSetup begins. So poll with a SHORT per-request timeout (a wedged
// request fails fast and retries instead of consuming the whole budget on one
// hung GET) over a LONGER overall deadline that rides out the wedge. Capping
// LANGFLOW_WORKERS alone did not fix this (#922 was insufficient — the wedge is
// process-wide, not a worker-count issue). Overridable via env for slow boxes.
const HEALTH_TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 120_000;
const HEALTH_INTERVAL_MS = 2_000;
// Per-request cap so one hung GET can't swallow the whole deadline — the loop
// must be free to retry across the wedge window.
const HEALTH_REQUEST_MS = Number(process.env.PREFLIGHT_REQUEST_MS) || 8_000;

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
      const res = await ctx.get("/api/v1/version", {
        timeout: HEALTH_REQUEST_MS,
      });
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
    // Degrade the affected providers instead of aborting the shard (#1058).
    //
    // This used to `throw`, and that defeated the guarantee #980 exists to give:
    // a red `Collect models` is deliberately non-fatal (`continue-on-error`) so a
    // drained provider key cannot kill a day of testing — but `Collect models` is
    // ALSO what imports the keys as Langflow global variables, so its failure made
    // this gate fire and killed the shard anyway. On run 30444299314 shards 1 and 2
    // died here over google alone, and ~184 tests that never touch google went
    // unexecuted behind a report that read as an ordinary failure day.
    //
    // Recording the providers unusable routes them through the gate the suite
    // already has (`provider-health.ts` → `test.skip` with the reason), so their
    // specs skip and every other spec runs. The run is still marked: the annotation
    // below surfaces in the job log, `Collect models` is already red, and the
    // report's top-level errors no longer hide a whole shard (see the `partial`
    // verdict in `scripts/check-run-integrity.mjs`).
    const affected = providersForEnvKeys(missing);
    const persisted = writeProviderHealth(
      degradeProviders(
        readProviderHealth(),
        affected,
        `${missing.join(", ")} is set in the environment but was never imported as a ` +
          `Langflow global variable — \`Collect models\` did not complete. Specs read ` +
          `credentials from Langflow, so a live call would fail with a misleading ` +
          `node_duration/build timeout (#1058).`,
      ),
    );

    console.error(`::error::${message}`);
    console.error(
      persisted
        ? `[preflight] recorded ${affected.join(", ")} as inactive — their specs will SKIP; ` +
            `the rest of the shard runs.`
        : `[preflight] WARNING: could not persist provider health, so ${affected.join(", ")} ` +
            `specs may attempt a live call against a key Langflow does not have.`,
    );
    return;
  }
  console.warn(`${message}\n(local run — warning only, not blocking.)`);
}

/**
 * Configure the routed keyless provider once, before any worker starts (#1187).
 *
 * A no-op unless `ANY_COMPLETION_PROVIDER` is set. It exists because the UI-driven
 * `setupOllama` races itself across workers on the very first configuration — see the
 * header of `preconfigure-routed-provider.ts` for the measured failure.
 *
 * Never fatal, deliberately. `setupOllama` is still the authority on whether the
 * provider is usable and FAILS with an attributed reason per spec, so aborting the
 * whole run here would replace a precise per-spec verdict with a vague preflight one.
 * But it is never silent either (#1012): a failed pre-configuration is the likely
 * cause of whatever `setupOllama` reports next, so it is printed as a warning that
 * names the gap.
 */
async function preconfigureRouting(ctx: APIRequestContext): Promise<void> {
  const result = await preconfigureRoutedProvider(ctx).catch((e) => ({
    attempted: true,
    configured: false,
    detail: `pre-configuration threw: ${String(e)}`,
  }));
  if (!result.attempted) return;
  if (result.configured) {
    console.log(`[preflight] routed provider ready — ${result.detail}`);
    return;
  }
  console.warn(
    `[preflight] WARNING: could not pre-configure the routed provider — ${result.detail}. ` +
      `Specs will try to configure it themselves, which is what races across workers ` +
      `(#1187); expect OLLAMA_PROVIDER_UNREACHABLE on one of them.`,
  );
}

/**
 * Report component-catalog drift against the committed baseline (#1040).
 *
 * Since 1.12 a component family's presence is a **packaging** decision per image,
 * so a family can vanish with no product announcement — and it then surfaces as a
 * generic `waitForSelector` timeout 30 s deep in a spec. That has already been
 * misdiagnosed twice (#898, #907, both attributed to missing `langchain-*` extras;
 * #1039 corrected the record). This is the gate whose whole job is to remove that
 * misclassification tax (#884), so the cause is named before the first spec runs.
 *
 * **Never fatal, on purpose.** Drift is not by itself a failure: a *new* category
 * costs nobody a test, and even a removed one is legitimate when the image simply
 * stopped shipping a distribution we do not test (#1039's Groq/Mistral). Aborting
 * a whole run over a reporting feature would trade real coverage for tidiness —
 * #980's trade. What it must never do is read as clean when it produced no
 * verdict, so every give-up path says so explicitly (#1012's rule).
 *
 * This function is therefore only I/O: read the file, make the request, print. The
 * comparison lives in `catalogVerdict`, which cannot throw and always returns a
 * verdict — a property a unit test pins, rather than a comment here claiming it.
 * The inline version of this was one unguarded `for` away from aborting the whole
 * run on a hand-edited baseline.
 *
 * Costs one `GET /api/v1/all`: measured 70–85 ms and 524 KB compressed on
 * `1.12.0.dev10`, once per suite run.
 */
async function reportCatalogDrift(ctx: APIRequestContext): Promise<void> {
  let baseline: unknown;
  try {
    baseline = JSON.parse(fs.readFileSync(CATALOG_BASELINE_PATH, "utf8"));
  } catch (e) {
    console.warn(
      `[preflight] WARNING: could not read the component-catalog baseline at ${CATALOG_BASELINE_PATH} (${String(e)}). ` +
        `Catalog drift is UNKNOWN for this run, not absent — a vanished component family ` +
        `will surface as a 30s selector timeout instead of being named here (#1040). ` +
        `Regenerate it with: npm run catalog:baseline`,
    );
    return;
  }

  let registry: unknown;
  try {
    // Authenticate EXPLICITLY. `/api/v1/all` answers 403 unauthenticated, and
    // relying on the login `checkProviderCredentials` happens to have performed on
    // this shared context would make the check silently ordering-dependent — and
    // dead on exactly the run that matters least to lose but is easiest to miss:
    // the credential-importing one sets `PREFLIGHT_SKIP_CREDENTIALS`, so that login
    // never happens, and every CI lane's `Collect models` step would have warned
    // "could not read the component catalog" on every run. A warning that always
    // fires is the noise #1084 was raised about.
    const auth = await getAuthToken(ctx).catch(() => "");
    const res = await ctx.get("/api/v1/all", {
      headers: auth ? { Authorization: auth } : undefined,
      timeout: 30000,
    });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    registry = await res.json();
  } catch (e) {
    console.warn(
      `[preflight] WARNING: could not read the component catalog (${String(e)}). ` +
        `Catalog drift is UNKNOWN for this run, not absent (#1040).`,
    );
    return;
  }

  const verdict = catalogVerdict(baseline, registry);
  const version = (baseline as CatalogSnapshot | null)?.version;
  const baselineVersion = version ? ` (baseline: ${version})` : "";
  if (verdict.kind === "unknown") {
    console.warn(
      `[preflight] WARNING: could not compare the component catalog against the baseline — ${verdict.reason}. ` +
        `Catalog drift is UNKNOWN for this run, not absent (#1040). ` +
        `Regenerate the baseline with: npm run catalog:baseline (it is \`category -> [type names]\`, ` +
        `not the raw \`GET /api/v1/all\` body — do not hand-edit it)`,
    );
    return;
  }
  if (verdict.kind === "clean") {
    console.log(
      `[preflight] component catalog matches the baseline${baselineVersion} — ${verdict.categoryCount} categories.`,
    );
    return;
  }
  console.warn(
    `[preflight] WARNING: the component catalog DRIFTED from the baseline${baselineVersion} (#1040):\n` +
      verdict.lines.join("\n") +
      `\n  Since 1.12 this is a packaging decision per image, not a Langflow feature change. ` +
      `If the drift is expected, accept it with: npm run catalog:baseline`,
  );
}

/**
 * Freeze the model catalog for this run (#1386).
 *
 * Runs FIRST and touches no network, because it must hold even on the paths where the
 * rest of this file gives up: it is what keeps the runner's view of `models.json` and
 * every worker's view identical, and 18 specs derive their `test.describe` title from
 * that file. `globalSetup` precedes the load task, so this lands before the first
 * title is computed. See `helpers/provider-setup/catalog-snapshot.ts` for why the
 * catalog is a run-scoped value rather than a file each process re-reads.
 *
 * Never fatal: an unreadable catalog is exactly the state the resolvers already
 * handle, and reporting it here means the cause is named before the specs skip
 * (#1012) rather than aborting a whole shard over a file that is gitignored by design.
 */
function freezeCatalog(): void {
  const verdict = freezeModelCatalog();
  if (verdict.reason) {
    console.warn(`[preflight] WARNING: ${verdict.reason}`);
  }
  if (verdict.kind === "absent") {
    console.log(
      "[preflight] models.json absent — the EMPTY catalog is frozen for this run. " +
        "Provider-parametrized specs will report the fallback target; run " +
        "`npx playwright test tests/collect-models.spec.ts` first to populate it.",
    );
    return;
  }
  console.log(
    `[preflight] model catalog frozen for this run` +
      (verdict.count === undefined ? "" : ` — ${verdict.count} models`) +
      ". A mid-run write to models.json can no longer change a test's title (#1386).",
  );
}

export default async function globalSetup(): Promise<void> {
  freezeCatalog();
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
    await preconfigureRouting(ctx);
    await reportCatalogDrift(ctx);
  } finally {
    await ctx.dispose();
  }
}
