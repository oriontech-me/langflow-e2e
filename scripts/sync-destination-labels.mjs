#!/usr/bin/env node
// Copies the origin's live labels to the destination, so an issue opened there carries
// the same `area:*` and process labels the QA platform groups by. Run by an operator,
// dry by default:
//
//   node scripts/sync-destination-labels.mjs           prints the plan
//   node scripts/sync-destination-labels.mjs --apply   creates and updates on the destination
//
// The origin is the source of truth for every label it has: a missing one is created and
// one whose color or description drifted is updated. Labels only the destination has
// (the routine labels) are left alone, and so are the origin's dead ones (DEAD), which
// die with it. Running it again after an apply prints an empty plan.
//
// Reads ORIGIN_REPO, DEST_HOST and DEST_REPO (defaults below) and uses `gh`, logged in to
// both hosts.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Labels nothing creates any more: the Actions migration workflows (now a routine on the
// QA VM, labelled routine:migration) and the weekly workflow, disabled since June.
export const DEAD = [/^migration-/, /^provider-credentials-/, /^weekly-failure$/];

export const isDead = (name) => DEAD.some((re) => re.test(name));

const norm = (l) => ({ color: (l.color || "").toLowerCase(), description: l.description || "" });

/**
 * What the destination needs. PURE. Labels are { name, color, description }.
 * Returns { create, update, skipped }: create and update hold the origin's label as it
 * should end up; skipped holds the names of dead origin labels.
 */
export function planLabels(origin, dest) {
  const have = new Map(dest.map((l) => [l.name, norm(l)]));
  const plan = { create: [], update: [], skipped: [] };
  for (const label of origin) {
    if (isDead(label.name)) {
      plan.skipped.push(label.name);
      continue;
    }
    const want = { name: label.name, ...norm(label) };
    const got = have.get(label.name);
    if (!got) plan.create.push(want);
    else if (got.color !== want.color || got.description !== want.description) plan.update.push(want);
  }
  return plan;
}

function listLabels(repo, host) {
  const env = host ? { ...process.env, GH_HOST: host } : process.env;
  const out = execFileSync("gh", ["label", "list", "-R", repo, "-L", "500", "--json", "name,color,description"], {
    env,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

function main(argv) {
  const apply = argv.includes("--apply");
  const originRepo = process.env.ORIGIN_REPO || "oriontech-me/langflow-e2e";
  const destHost = process.env.DEST_HOST || "github.ibm.com";
  const destRepo = process.env.DEST_REPO || "Langflow/e2e-qa";

  const plan = planLabels(listLabels(originRepo), listLabels(destRepo, destHost));
  for (const l of plan.create) console.log(`create  ${l.name}  #${l.color}  ${l.description}`);
  for (const l of plan.update) console.log(`update  ${l.name}  #${l.color}  ${l.description}`);
  console.log(`skip (dead): ${plan.skipped.join(", ") || "none"}`);
  if (!plan.create.length && !plan.update.length) {
    console.log("nothing to do");
    return 0;
  }
  if (!apply) {
    console.log("dry run: pass --apply to write");
    return 0;
  }
  const env = { ...process.env, GH_HOST: destHost };
  for (const l of [...plan.create, ...plan.update]) {
    execFileSync("gh", ["label", "create", l.name, "-R", destRepo, "--color", l.color, "--description", l.description, "--force"], {
      env,
      stdio: "inherit",
    });
  }
  console.log(`applied: ${plan.create.length} created, ${plan.update.length} updated`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
