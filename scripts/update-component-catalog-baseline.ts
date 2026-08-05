/**
 * Captures the component catalog of a running Langflow into the committed
 * baseline the pre-flight drift check compares against (#1040).
 *
 * Run: `npm run catalog:baseline` (against whatever `PLAYWRIGHT_BASE_URL` points
 * at — normally `langflowai/langflow-nightly:latest`).
 *
 * ## When to run it
 *
 * When the pre-flight reports drift **and the drift is expected**: the image
 * legitimately stopped shipping a distribution, or a component was renamed or
 * reparented upstream and the specs have been checked against it. Accepting drift
 * is a deliberate act with a reviewable diff, which is the whole reason the
 * baseline is a committed file rather than a snapshot of the previous run: a
 * self-updating baseline would make every catalog change invisible exactly once,
 * which is the failure mode #1040 was raised about.
 *
 * ## Why it refuses more than it accepts
 *
 * A baseline is only useful if it is right, and a wrong one is worse than none —
 * it reports drift that is not there (training readers to ignore the warning) or,
 * worse, hides drift that is. So this exits non-zero rather than writing:
 *
 *  - when the instance is unreachable or answers non-2xx;
 *  - when the catalog has no categories at all, which is what an instance still
 *    starting up returns and would otherwise be committed as "the catalog is
 *    empty", turning every subsequent run's real catalog into 36 spurious
 *    additions;
 *  - when the catalog is suspiciously small (`--min-categories`, default 20).
 *    Measured on `1.12.0.dev10`: 36 categories with the default nightly image,
 *    104 with `lfx-bundles` installed. A handful means a half-initialised
 *    registry or an image with almost no bundles, neither of which is a baseline.
 *
 * Pass `--force` to write anyway — for the legitimate case of deliberately
 * baselining a deliberately minimal image.
 */

import { request as playwrightRequest } from "@playwright/test";
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAuthToken } from "../tests/helpers/auth/get-auth-token";
import { snapshotCatalog } from "../tests/helpers/other/component-catalog-drift";

dotenv.config();

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860";
const OUT_PATH = path.join(
  __dirname,
  "../tests/assets/catalog/component-catalog-baseline.json",
);

export function parseNumericArg(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const raw = argv.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
  if (raw === undefined) return fallback;
  // `Number("")` and `Number(" ")` are 0, which is finite and non-negative — so
  // an empty value (`--min-categories=`) used to disable the plausibility floor
  // silently, reaching the same state as `--force` without the explicit opt-in
  // that makes `--force` legitimate. Disabling a guard must be asked for.
  if (raw.trim() === "") {
    throw new Error(`${name} was given no value — pass a number, e.g. ${name}=20`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

function numericArg(name: string, fallback: number): number {
  try {
    return parseNumericArg(process.argv, name, fallback);
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const minCategories = numericArg("--min-categories", 20);
  const force = process.argv.includes("--force");

  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const auth = await getAuthToken(ctx).catch(() => "");
    const headers = auth ? { Authorization: auth } : undefined;

    const versionRes = await ctx.get("/api/v1/version", { headers, timeout: 30000 });
    if (!versionRes.ok()) {
      console.error(
        `✖ ${BASE_URL} answered ${versionRes.status()} for /api/v1/version — is Langflow up?`,
      );
      process.exit(1);
    }
    const version = (await versionRes.json())?.version as string | undefined;

    const res = await ctx.get("/api/v1/all", { headers, timeout: 60000 });
    if (!res.ok()) {
      console.error(`✖ GET /api/v1/all answered ${res.status()} — refusing to write a baseline.`);
      process.exit(1);
    }

    const snapshot = snapshotCatalog(await res.json(), version);
    const categoryCount = Object.keys(snapshot.categories).length;
    const componentCount = Object.values(snapshot.categories).reduce(
      (n, types) => n + types.length,
      0,
    );

    if (categoryCount < minCategories && !force) {
      console.error(
        `✖ only ${categoryCount} categor(ies) in the catalog (expected at least ${minCategories}).\n` +
          `  An instance that is still starting up returns a near-empty registry, and committing that\n` +
          `  would turn every later run's real catalog into ${minCategories}+ spurious additions.\n` +
          `  Wait for the backend to settle and retry, or pass --force to baseline a deliberately\n` +
          `  minimal image (or lower the bar with --min-categories=N).`,
      );
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    // Trailing newline and 2-space indent: this file is reviewed as a diff.
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `✓ wrote ${path.relative(process.cwd(), OUT_PATH)} — ${categoryCount} categories, ` +
        `${componentCount} component types, from Langflow ${version ?? "(version unknown)"}.`,
    );
    console.log(
      "  Review the diff before committing: a removed category or component is a coverage change, not a formality.",
    );
  } finally {
    await ctx.dispose();
  }
}

// Only run when invoked as a script — keeps the module importable from tests.
if (require.main === module) {
  main().catch((e) => {
    console.error(`✖ could not write the catalog baseline: ${String(e)}`);
    process.exit(1);
  });
}
