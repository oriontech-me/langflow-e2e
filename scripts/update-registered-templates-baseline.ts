/**
 * Captures the registered starter-template set of a running Langflow into the
 * committed baseline `templates-registration.spec.ts` asserts against (#1862).
 *
 * Run: `npm run templates:baseline` (against whatever `PLAYWRIGHT_BASE_URL`
 * points at — normally `langflowai/langflow-nightly:latest`).
 *
 * ## When to run it
 *
 * When the spec reports drift **and the drift is expected**: upstream added a
 * template, removed one, or renamed one and the specs have been checked against
 * it. Accepting drift is a deliberate act with a reviewable diff, which is the
 * whole reason the baseline is a committed file rather than a snapshot of the
 * previous run. A self-updating baseline would make every registration change
 * invisible exactly once — #1234's failure mode, where a template left the
 * gallery and was noticed only because an unrelated component spec used it as a
 * fixture.
 *
 * ## Why it refuses more than it accepts
 *
 * A wrong baseline is worse than none: it reports drift that is not there
 * (training readers to ignore it) or hides drift that is. So this exits non-zero
 * rather than writing:
 *
 *  - when the instance is unreachable or answers non-2xx;
 *  - when the listing is not a readable array of entries carrying `name_key`;
 *  - when it holds fewer than `--min-templates` (default 20; measured **26** on
 *    `1.13.0.dev12`). A still-starting instance answers a short listing, and
 *    committing it turns every later run's real listing into spurious extras
 *    while hiding every real absence. `--force` overrides it, for the legitimate
 *    case of baselining a deliberately minimal image;
 *  - when a **declared absence is now registered**. Declarations are carried
 *    across a refresh — dropping #1744's justification silently is precisely the
 *    expiry #1084 forbids — so the writer will not emit a file that contradicts
 *    itself. Removing an expired declaration stays a deliberate, reviewed edit;
 *  - when an **active catalog policy is blocking a template**. The listing this
 *    captures is policy-filtered, so a refresh run on an instance a @destructive
 *    governance spec left blocked would commit the block as the expectation and
 *    make the spec report clean about a template that is not in the gallery. The
 *    count floor cannot catch that — six of 26 can vanish and still clear 20.
 *
 * ## Why `Accept-Language: en-US` is pinned
 *
 * `GET /api/v1/flows/basic_examples/` localizes `name` (#1400): under `pt-BR`,
 * *Basic Prompting* answers as *Sugestões básicas* while `name_key` is unchanged.
 * The baseline records the English name, so the capture must pin the header or a
 * translated name would be committed as the expectation.
 */

import { request as playwrightRequest } from "@playwright/test";
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAuthToken } from "../tests/helpers/auth/get-auth-token";
import {
  listedTemplates,
  type DeclaredAbsence,
  type RegisteredTemplatesBaseline,
} from "../tests/helpers/other/registered-templates-drift";
import { parseNumericArg } from "./lib/numeric-arg";

dotenv.config();

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860";
const OUT_PATH = path.join(
  __dirname,
  "../tests/assets/templates/registered-templates-baseline.json",
);

/**
 * The declared absences of the baseline currently on disk.
 *
 * Read back rather than regenerated because they cannot be observed: an absence
 * is invisible in the listing by definition, so only a human can state that one
 * is expected and why. An unreadable or absent file yields `[]`, which is the
 * honest answer for a first capture; the contradiction check below is what stops
 * that from silently dropping a declaration on a refresh.
 */
export function readExistingDeclarations(outPath: string): DeclaredAbsence[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const declared = (parsed as RegisteredTemplatesBaseline)?.declaredAbsences;
    return Array.isArray(declared) ? declared : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  let minTemplates: number;
  try {
    minTemplates = parseNumericArg(process.argv, "--min-templates", 20);
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const force = process.argv.includes("--force");

  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const auth = await getAuthToken(ctx).catch(() => "");
    const headers: Record<string, string> = { "Accept-Language": "en-US" };
    if (auth) headers.Authorization = auth;

    const versionRes = await ctx.get("/api/v1/version", { headers, timeout: 30000 });
    if (!versionRes.ok()) {
      console.error(
        `✖ ${BASE_URL} answered ${versionRes.status()} for /api/v1/version — is Langflow up?`,
      );
      process.exit(1);
    }
    const version = (await versionRes.json())?.version as string | undefined;

    const res = await ctx.get("/api/v1/flows/basic_examples/", { headers, timeout: 60000 });
    if (!res.ok()) {
      console.error(
        `✖ GET /api/v1/flows/basic_examples/ answered ${res.status()} — refusing to write a baseline.`,
      );
      process.exit(1);
    }

    const listed = listedTemplates(await res.json());
    if (listed === null) {
      console.error(
        "✖ GET /api/v1/flows/basic_examples/ carried no readable template list (not an array, empty,\n" +
          "  or an entry with no name_key) — refusing to write a baseline from it.",
      );
      process.exit(1);
    }

    if (listed.length < minTemplates && !force) {
      console.error(
        `✖ only ${listed.length} template(s) registered (expected at least ${minTemplates}).\n` +
          `  An instance still starting up answers a short listing, and committing it would turn every\n` +
          `  later run's real listing into spurious extras while hiding every real absence.\n` +
          `  Wait for the backend to settle and retry, or pass --force to baseline a deliberately minimal\n` +
          `  image (or lower the bar with --min-templates=N).`,
      );
      process.exit(1);
    }

    // The listing this captured is POLICY-FILTERED: `_filter_basic_examples_by_catalog_policy`
    // strips blocked name_keys from it for superuser and anonymous alike, and only
    // `?include_blocked=true` bypasses it. Refreshing on an instance where a
    // @destructive governance spec left a block would therefore COMMIT the block as
    // the expectation, after which the spec reports clean forever about a template
    // that is not in the gallery — #1234's failure mode, arriving through the
    // refresh path. The `--min-templates` floor cannot catch it: up to six of the 26
    // can vanish and still clear a floor of 20.
    const blockedRes = await ctx.get("/api/v1/flows/basic_examples/?include_blocked=true", {
      headers,
      timeout: 60000,
    });
    if (blockedRes.ok()) {
      const withBlocked = listedTemplates(await blockedRes.json());
      const visible = new Set(listed.map((t) => t.nameKey));
      const blocked = (withBlocked ?? []).filter((t) => !visible.has(t.nameKey));
      if (blocked.length > 0 && !force) {
        console.error(
          `✖ a catalog policy is blocking ${blocked.length} template(s) on this instance:\n` +
            blocked.map((t) => `    • ${t.nameKey} ("${t.name}")`).join("\n") +
            `\n  They are absent from the listing this would capture, so committing it would bake the\n` +
            `  block in as the expectation and make the spec report clean about a template that is not\n` +
            `  in the gallery. Clear the policy (the @destructive governance specs restore it themselves)\n` +
            `  and re-run, or pass --force if you really mean to baseline a blocked instance.`,
        );
        process.exit(1);
      }
    } else {
      // Superuser-only (403 otherwise). Not being able to ask is not evidence
      // that nothing is blocked, so it is said rather than assumed (#1012).
      console.warn(
        `⚠ could not probe ?include_blocked=true (${blockedRes.status()}) — an active catalog-policy\n` +
          `  template block could not be ruled out. The captured listing is policy-filtered, so review\n` +
          `  the diff for a template that vanished without an upstream change.`,
      );
    }

    const declaredAbsences = readExistingDeclarations(OUT_PATH);
    const liveKeys = new Set(listed.map((t) => t.nameKey));
    const contradicted = declaredAbsences.filter((d) => liveKeys.has(d.nameKey));
    if (contradicted.length > 0) {
      console.error(
        `✖ ${contradicted.length} declared absence(s) are registered by this image:\n` +
          contradicted
            .map((d) => `    • ${d.nameKey} ("${d.name}") — declared by ${d.issue}: ${d.reason}`)
            .join("\n") +
          `\n  Refusing to write a baseline that contradicts itself. Close the issue and delete the\n` +
          `  declaration by hand, then re-run — removing an exemption is a reviewed edit, not a side\n` +
          `  effect of a refresh (#1084).`,
      );
      process.exit(1);
    }

    const snapshot: RegisteredTemplatesBaseline = {
      version,
      // Sorted: the file is reviewed as a diff, and the listing's order is the
      // backend's, which no contract pins.
      templates: [...listed]
        .map((t) => ({ nameKey: t.nameKey, name: t.name }))
        .sort((a, b) => a.nameKey.localeCompare(b.nameKey)),
      declaredAbsences,
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    // Trailing newline and 2-space indent: this file is reviewed as a diff.
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `✓ wrote ${path.relative(process.cwd(), OUT_PATH)} — ${snapshot.templates.length} registered ` +
        `template(s) and ${declaredAbsences.length} declared absence(s), from Langflow ${version ?? "(version unknown)"}.`,
    );
    console.log(
      "  Review the diff before committing: a template that left the listing is a coverage change, not a formality.",
    );
  } finally {
    await ctx.dispose();
  }
}

// Only run when invoked as a script — keeps the module importable from tests.
if (require.main === module) {
  main().catch((e) => {
    console.error(`✖ could not write the registered-templates baseline: ${String(e)}`);
    process.exit(1);
  });
}
