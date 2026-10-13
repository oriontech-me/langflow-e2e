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
// Reads ORIGIN_HOST, ORIGIN_REPO, DEST_HOST and DEST_REPO (defaults below) and uses `gh`,
// logged in to both hosts.
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
 * should end up; skipped holds the names of dead origin labels. Names match without case,
 * as GitHub matches them: `Bug` and `bug` are one label, and a case-only difference is an
 * update (renaming it), never a create that would collide.
 */
export function planLabels(origin, dest) {
  const have = new Map(dest.map((l) => [l.name.toLowerCase(), { name: l.name, ...norm(l) }]));
  const plan = { create: [], update: [], skipped: [] };
  for (const label of origin) {
    if (isDead(label.name)) {
      plan.skipped.push(label.name);
      continue;
    }
    const want = { name: label.name, ...norm(label) };
    const got = have.get(label.name.toLowerCase());
    if (!got) plan.create.push(want);
    else if (got.name !== want.name || got.color !== want.color || got.description !== want.description) {
      plan.update.push({ ...want, current: got.name });
    }
  }
  return plan;
}

// GH_HOST is always set, so an operator shell that exports one cannot point a call at the
// other host.
const ghEnv = (host) => ({ ...process.env, GH_HOST: host });

function listLabels(repo, host) {
  const out = execFileSync("gh", ["label", "list", "-R", repo, "-L", "500", "--json", "name,color,description"], {
    env: ghEnv(host),
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// The REST calls, not `gh label create --force`: its update path sends a description only
// when it is non-empty, so a description the origin cleared would never clear here and the
// next run would plan the same update again.
function writeLabel(host, repo, label) {
  const args = label.current
    ? ["api", "-X", "PATCH", `repos/${repo}/labels/${encodeURIComponent(label.current)}`, "-f", `new_name=${label.name}`]
    : ["api", "-X", "POST", `repos/${repo}/labels`, "-f", `name=${label.name}`];
  args.push("-f", `color=${label.color}`, "-f", `description=${label.description}`, "--silent");
  execFileSync("gh", args, { env: ghEnv(host), stdio: "inherit" });
}

function main(argv) {
  const apply = argv.includes("--apply");
  const originHost = process.env.ORIGIN_HOST || "github.com";
  const originRepo = process.env.ORIGIN_REPO || "oriontech-me/langflow-e2e";
  const destHost = process.env.DEST_HOST || "github.ibm.com";
  const destRepo = process.env.DEST_REPO || "Langflow/e2e-qa";

  const plan = planLabels(listLabels(originRepo, originHost), listLabels(destRepo, destHost));
  for (const l of plan.create) console.log(`create  ${l.name}  #${l.color}  ${l.description}`);
  for (const l of plan.update) {
    const rename = l.current !== l.name ? ` (renamed from ${l.current})` : "";
    console.log(`update  ${l.name}${rename}  #${l.color}  ${l.description}`);
  }
  console.log(`skip (dead): ${plan.skipped.join(", ") || "none"}`);
  if (!plan.create.length && !plan.update.length) {
    console.log("nothing to do");
    return 0;
  }
  if (!apply) {
    console.log("dry run: pass --apply to write");
    return 0;
  }
  for (const l of [...plan.create, ...plan.update]) writeLabel(destHost, destRepo, l);
  console.log(`applied: ${plan.create.length} created, ${plan.update.length} updated`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
