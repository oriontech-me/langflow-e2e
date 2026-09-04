// Read daily-stable.yml's Langflow service environment and say, for EVERY variable in
// it, how the VM lane carries that variable to its instance — or why it deliberately
// does not.
//
// WHY THIS EXISTS. #1714 was a single variable: LANGFLOW_DEACTIVATE_TRACING, pinned off
// in the source starter while daily-stable.yml runs it on. It cost a full ~50-minute VM
// run to surface and a PR to fix. It was an instance of a class, and the rest of that
// class was still open when #1717 was filed.
//
// The class has two halves, and only one of them can be found by running the lane:
//
//   - The LOUD half turns the lane red. LANGFLOW_ALLOW_CUSTOM_COMPONENTS looked like
//     this from the outside and turned out not to be: measured on the machine, the
//     custom-component specs pass 8/8 without it, because the workflow sets it to
//     override a default the nightly IMAGE bakes in and a source instance bakes in
//     nothing. So the two lanes agree today for DIFFERENT REASONS — which is the
//     second half wearing the first half's clothes.
//   - The SILENT half produces agreement, not failure. Without
//     LANGFLOW_SQLITE_PRAGMAS' `foreign_keys: ON`, a cascade/orphan defect (the
//     upstream #13955 class) is invisible on the VM and visible on Actions: the raw
//     DELETE "succeeds" leaving orphaned rows and the spec passes for the wrong
//     reason. No amount of running the lane exposes that. This lane exists to COMPARE
//     verdicts with the Actions daily, so a green that should not be green corrupts
//     the exact product stage 1 of the migration was built to deliver.
//
// Hence a fail-closed enumeration rather than three more lines in a script: every
// variable on the workflow's service must either REACH the target or be RECORDED out
// of scope with a reason, and the 11th variable the daily gains forces that decision
// when it is written instead of opening a gap that surfaces whenever someone next
// notices an odd verdict. Same shape watch-upstream-areas.mjs --mode=check uses for the
// `lfx` subtrees (#1581's rule: the reason is what a future reader acts on).
//
// EVERY variable, not every `LANGFLOW_*`. The first version filtered on that prefix
// with no comment, which quietly made `DO_NOT_TRACK`, a `LANGSMITH_*` or a
// `PYTHONUNBUFFERED` on the service read as clean — and a fail-closed promise is what
// makes the next reader stop looking. All ten today happen to carry the prefix; the
// enumeration does not depend on that.
//
// THREE PLACES A VARIABLE CAN GO WRONG, and this file covers the first two:
//
//   1. NOT CARRIED — no file forwards it. The original gap (#1717).
//   2. SHADOWED — the orchestrator forwards it and the STARTER overwrites it. A
//      `VAR=value` prefix on `uv run` does not "add to" the inherited environment for
//      that name; it REPLACES it for that command. The first version of this file said
//      otherwise, and the gap was measured on this branch: one line added to the
//      starter's launch block, in the same shape `LANGFLOW_AUTO_LOGIN=true` is written
//      two lines above it, left every guard green while the server lost
//      `foreign_keys: ON` — the silent half of #1717 reintroduced one layer down. So a
//      variable the orchestrator carries must be ABSENT from that block or written
//      `${NAME:-…}`, which inherits. Shape borrowed from a2a-flag-lanes.test.mjs's
//      "the default is true, not merely present".
//   3. CARRIED WITH THE WRONG VALUE. Split, and the split is worth stating because
//      neither half covers the other:
//        - starter-carried names are compared HERE, textually: the default written in
//          the launch block against the workflow's declared value
//        - orchestrator-carried names are compared in run-e2e.test.mjs, which SOURCES
//          the script and reads the value it would really send, then watches it cross
//          the ssh boundary. Text cannot answer that, and this file does not try
//
// VALUES ARE READ, NEVER RE-PARSED. Both halves go through scripts/lib/gh-expression.mjs
// — #1226's rule. A second unquoter here would be a second answer able to disagree with
// the first.

import { readFileSync } from "node:fs";
import { evaluateWorkflowValue } from "./gh-expression.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

export const WORKFLOW_PATH = ".github/workflows/daily-stable.yml";
export const ORCHESTRATOR_PATH = "scripts/run-e2e.sh";
export const STARTER_PATH = "scripts/start-langflow-source.sh";

// Full-line comments only, and never a trailing `#`. The failure this exists for
// (#1300, repeated by #1716's first draft) is a comment line that merely SPELLS a
// variable: it both masks a real setting and fails a CORRECT workflow. Trailing `#`
// is left alone because a value may legitimately contain one, and cutting at the
// first `#` would silently truncate it — the same class of wrong answer one layer down.
export const stripComments = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const indentOf = (line) => line.match(/^\s*/)[0].length;
const isBlank = (line) => /^\s*$/.test(line);

/**
 * The prefix assignments the source starter puts on `uv run`, plus the flags it
 * derives from an environment variable.
 *
 * Read by walking BACK from the `${RUN_CMD}` line rather than forward from a marker,
 * because the block's beginning is a comment and its end is the command — and the end
 * is the only one of the two that cannot move without the launch itself changing.
 *
 * THROWS when it finds no assignments at all: that means the starter's launch no
 * longer has this shape, and the honest answer is to say so rather than to report an
 * empty block as "nothing shadowed" (#1012 — unevaluated is not clean).
 */
export function readStarterLaunchEnv(text) {
  const lines = stripComments(text).split("\n");
  const runAt = lines.findIndex((l) => l.includes("${RUN_CMD}"));
  if (runAt < 0) throw new Error("the starter has no ${RUN_CMD} launch line");

  const assignments = new Map();
  for (let i = runAt - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*\\$/);
    if (!m) break;
    const [, name, rawValue] = m;
    // `NAME="${NAME:-default}"` is the overridable shape: the caller's value wins, so
    // a variable written this way is forwarded, not shadowed. Greedy on purpose —
    // LANGFLOW_DATABASE_URL's default itself contains `${STATE_DIR}`, and the closing
    // brace of the expansion is the LAST one on the line.
    const overridable = rawValue.match(new RegExp(`^"?\\$\\{${name}:-(.*)\\}"?$`));
    assignments.set(name, {
      raw: rawValue,
      overridable: Boolean(overridable),
      value: overridable ? overridable[1] : rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"),
    });
  }
  if (assignments.size === 0) throw new Error("no prefix assignments found before the starter's ${RUN_CMD}");

  // Flags whose value comes from a variable — `--workers "${LANGFLOW_WORKERS:-1}"`.
  // The workflow sets LANGFLOW_WORKERS as an environment variable and the starter
  // spends it on the command line, so a name-only check would call it missing.
  const flags = new Map();
  for (const m of text.matchAll(/--[a-z-]+\s+"?\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}"?/g)) {
    flags.set(m[1], { value: m[2] });
  }
  return { assignments, flags };
}

/**
 * The names the orchestrator actually composes into the remote environment.
 *
 * Read out of `mirrored_target_env`'s BODY, not out of the whole file. "The file names
 * it somewhere" was the first version's test and it is not the property: a variable
 * mentioned in a string, or left behind in a stale branch, would satisfy it while
 * nothing reached the target.
 */
export function readMirroredNames(text) {
  const body = stripComments(text).match(/mirrored_target_env\(\)\s*\{([\s\S]*?)\n\}/);
  if (!body) throw new Error("the orchestrator has no mirrored_target_env() function");
  return new Set([...body[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=\$\(shq /g)].map((m) => m[1]));
}

/**
 * The `env:` mapping of one service in a workflow's job, as a Map of name -> raw text.
 *
 * Scoped to the SERVICE BLOCK rather than grepped file-wide, and the difference is not
 * cosmetic: daily-stable.yml also sets LANGFLOW_IMAGE and LANGFLOW_VERSION as step-level
 * env in later jobs, where they name the image to report rather than configure the
 * instance under test. A file-wide grep counts those as gaps in the VM lane forever.
 */
export function readServiceEnv(text, service = "langflow") {
  const lines = stripComments(text).split("\n");

  const enter = (from, indent, pattern, what) => {
    const hits = [];
    for (let i = from; i < lines.length; i += 1) {
      if (isBlank(lines[i])) continue;
      if (indent !== null && indentOf(lines[i]) <= indent) break;
      if (pattern.test(lines[i])) hits.push(i);
    }
    // More than one match means this reader is looking at a file it does not
    // understand, and the honest answer is to say so rather than to pick the first.
    if (hits.length !== 1) throw new Error(`expected exactly one \`${what}\` block, found ${hits.length}`);
    return hits[0];
  };

  const servicesAt = enter(0, null, /^\s*services:\s*$/, "services:");
  const serviceAt = enter(servicesAt + 1, indentOf(lines[servicesAt]), new RegExp(`^\\s*${service}:\\s*$`), `${service}:`);
  const envAt = enter(serviceAt + 1, indentOf(lines[serviceAt]), /^\s*env:\s*$/, `${service}.env:`);

  const envIndent = indentOf(lines[envAt]);
  const out = new Map();
  for (let i = envAt + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= envIndent) break;
    const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) throw new Error(`unreadable line in ${service}.env: ${lines[i]}`);
    if (out.has(m[1])) throw new Error(`${m[1]} is set twice in ${service}.env`);
    out.set(m[1], m[2]);
  }
  if (out.size === 0) throw new Error(`${service}.env is empty, which cannot be right`);
  return out;
}

/**
 * How the VM lane carries each of daily-stable.yml's service variables.
 *
 * `carrier` is the file that must name the variable:
 *   "orchestrator"  scripts/run-e2e.sh — the file whose declared job is mirroring the
 *                   workflow. This is where a variable goes when the starters must NOT
 *                   carry it: their environment blocks are asserted identical to
 *                   start-langflow-pip.sh's precisely so that a spec cannot tell which
 *                   starter brought its instance up (#1716's relocation).
 *   "starter"       scripts/start-langflow-source.sh — where a value is right for any
 *                   local instance, not just for this lane.
 *
 * `carrier: null` is out of scope, and then `reason` is mandatory.
 *
 * `sameValue: false` records a variable the VM lane carries with a DIFFERENT value on
 * purpose; the reason is then the whole content of the decision, because nothing else
 * in the repo will state it.
 */
export const CLASSIFICATION = {
  LANGFLOW_AUTO_LOGIN: {
    carrier: "starter",
    reason: "every starter runs auto-login; the suite authenticates through /api/v1/auto_login",
  },
  LANGFLOW_SUPERUSER: {
    carrier: "starter",
    reason: "the credentials the suite logs in with, identical in all three starters",
  },
  LANGFLOW_SUPERUSER_PASSWORD: {
    carrier: "starter",
    reason:
      "the other half of those credentials; the starter defaults both so a local instance and this lane authenticate identically",
  },
  LANGFLOW_WORKERS: {
    carrier: "starter",
    reason:
      "carried as the `--workers` flag rather than the variable: `langflow run` takes it on the command line, and the starter has defaulted it to 1 since #888",
  },
  LANGFLOW_WORKER_TIMEOUT: {
    carrier: "orchestrator",
    reason:
      "caps what one wedge costs (#1048). Not a starter default: 120 is chosen for THIS lane's load, and a developer's own instance has no reason to inherit it",
  },
  LANGFLOW_ALLOW_CUSTOM_COMPONENTS: {
    carrier: "orchestrator",
    reason:
      "the workflow sets it to override a default the nightly IMAGE bakes in (`false`); a source instance bakes in nothing, so today the two lanes agree for different reasons. Mirrored so the day the product default moves, both lanes move with it — measured: the custom-component specs already pass 8/8 on the VM without it, so this is latent agreement, not a red lane (#1717)",
  },
  LANGFLOW_A2A_ENABLED: {
    carrier: "starter",
    reason:
      "product default is OFF and its router is ALWAYS mounted, so with the flag off the three /api/v1/a2a/* routes answer 404 and every A2A spec passes while testing nothing (#1240, #1195). Right for any instance, so the starter carries it",
  },
  LANGFLOW_DEACTIVATE_TRACING: {
    carrier: "orchestrator",
    reason:
      "both starters default it OFF — right for a developer's instance, wrong for the lane that must match CI. Relocated here by #1716 rather than changed in the starter",
  },
  LANGFLOW_SQLITE_PRAGMAS: {
    carrier: "orchestrator",
    reason:
      "`foreign_keys: ON`. The silent half of #1717: with SQLite foreign keys off, a cascade/orphan defect (upstream #13955) is invisible on the VM and visible on Actions, so the lane agrees for the wrong reason and no run can refute it",
  },
  LANGFLOW_SSRF_ALLOWED_HOSTS: {
    carrier: "starter",
    sameValue: false,
    reason:
      "the CIDRs match; the workflow's extra `ollama` entry is a DOCKER SERVICE NAME that resolves only inside the Actions job network. On the VM the Ollama starter reports an RFC-1918 address and the run targets it by IP, which the shared CIDRs already authorise — so mirroring the literal string would add a hostname that resolves to nothing. Loopback stays out of both, because security/ssrf-url-validation.spec.ts asserts the refusal",
  },
};

/**
 * Compare the workflow's service env against the classification and the files that
 * are supposed to carry it.
 *
 * Returns findings rather than throwing, so a caller can report all of them at once —
 * an enumeration guard that stops at the first gap makes the reader run it N times.
 */
export function checkVmEnvParity({
  workflow = readFileSync(join(REPO_ROOT, WORKFLOW_PATH), "utf8"),
  orchestrator = readFileSync(join(REPO_ROOT, ORCHESTRATOR_PATH), "utf8"),
  starter = readFileSync(join(REPO_ROOT, STARTER_PATH), "utf8"),
  classification = CLASSIFICATION,
} = {}) {
  const findings = [];
  const carried = [];

  let env;
  try {
    env = readServiceEnv(workflow);
  } catch (err) {
    return {
      ok: false,
      carried,
      findings: [{ kind: "unreadable", name: null, message: `cannot read the workflow's service env: ${err.message}` }],
    };
  }

  let launch;
  let mirrored;
  try {
    launch = readStarterLaunchEnv(starter);
    mirrored = readMirroredNames(orchestrator);
  } catch (err) {
    return {
      ok: false,
      carried,
      findings: [{ kind: "unreadable", name: null, message: `cannot read the VM lane's carriers: ${err.message}` }],
    };
  }

  /** What the workflow declares, or null when it is a shape gh-expression refuses. */
  const declaredValue = (name) => {
    try {
      return { value: evaluateWorkflowValue(env.get(name), {}) };
    } catch (err) {
      return { error: err.message };
    }
  };

  const wanted = [...env.keys()];

  for (const name of wanted) {
    const entry = classification[name];
    if (!entry) {
      findings.push({
        kind: "unclassified",
        name,
        message:
          `${name} is set on daily-stable.yml's Langflow service and the VM lane says nothing about it. ` +
          `Either carry it (scripts/run-e2e.sh for a value chosen FOR this lane, the starter for one right ` +
          `for any local instance) or record it out of scope with a reason in CLASSIFICATION.`,
      });
      continue;
    }
    if (entry.carrier === null) {
      if (!entry.reason) {
        findings.push({ kind: "no-reason", name, message: `${name} is out of scope with no reason recorded` });
        continue;
      }
      carried.push({ name, carrier: null, reason: entry.reason });
      continue;
    }
    if (!["orchestrator", "starter"].includes(entry.carrier)) {
      findings.push({ kind: "bad-carrier", name, message: `${name} names an unknown carrier: ${entry.carrier}` });
      continue;
    }

    const shadow = launch.assignments.get(name);

    if (entry.carrier === "orchestrator") {
      // Composed into the remote environment — read out of the function, not out of
      // the file, so a stale mention cannot answer for a live one.
      if (!mirrored.has(name)) {
        findings.push({
          kind: "not-carried",
          name,
          message: `${name} is classified as reaching the target through ${ORCHESTRATOR_PATH}, and mirrored_target_env() does not compose it`,
        });
        continue;
      }
      // …and NOT overwritten on arrival. This is the door #1716 walked through, one
      // layer down: a prefix assignment on `uv run` replaces the inherited value for
      // that name, so the orchestrator's value never reaches the server and every
      // other check here still passes.
      if (shadow && !shadow.overridable) {
        findings.push({
          kind: "shadowed",
          name,
          message:
            `${name} is carried by ${ORCHESTRATOR_PATH} and then OVERWRITTEN by ${STARTER_PATH}'s launch block ` +
            `(\`${name}=${shadow.raw}\`). A prefix assignment on \`uv run\` replaces the inherited value for that ` +
            `name, so the value this lane sends never reaches the server — and nothing goes red. Write it ` +
            `\`${name}="\${${name}:-…}"\` so the caller's value wins, or drop the line.`,
        });
        continue;
      }
      carried.push({ name, carrier: entry.carrier, reason: entry.reason, sameValue: entry.sameValue !== false });
      continue;
    }

    // carrier === "starter": it must be in the launch block, or spent on a flag the
    // way `--workers "${LANGFLOW_WORKERS:-1}"` spends LANGFLOW_WORKERS.
    const flag = launch.flags.get(name);
    if (!shadow && !flag) {
      findings.push({
        kind: "not-carried",
        name,
        message: `${name} is classified as reaching the target through ${STARTER_PATH}, and its launch block neither sets it nor spends it on a flag`,
      });
      continue;
    }

    // The starter's own default against the workflow's declared value. Nothing else in
    // the repo compares these six: run-e2e.test.mjs measures the orchestrator's four by
    // sourcing the script, and a2a-flag-lanes.test.mjs pins the A2A shape in the docker
    // and pip starters — not in this one, which is the starter this lane actually uses.
    if (entry.sameValue !== false) {
      const declared = declaredValue(name);
      if (declared.error) {
        findings.push({
          kind: "unreadable-value",
          name,
          message: `${name}'s value in the workflow cannot be read, so parity is unverified — ${declared.error}`,
        });
        continue;
      }
      const mine = (shadow ?? flag).value;
      if (mine !== declared.value) {
        findings.push({
          kind: "value-drift",
          name,
          message:
            `${name}: daily-stable.yml declares ${JSON.stringify(declared.value)} and ${STARTER_PATH} uses ` +
            `${JSON.stringify(mine)}. Match it, or record the difference with \`sameValue: false\` and the reason.`,
        });
        continue;
      }
    }
    carried.push({ name, carrier: entry.carrier, reason: entry.reason, sameValue: entry.sameValue !== false });
  }

  // A classification entry for a variable the workflow no longer sets is not harmless:
  // it is a reason a future reader will trust about a decision that no longer exists.
  for (const name of Object.keys(classification)) {
    if (!wanted.includes(name)) {
      findings.push({
        kind: "stale",
        name,
        message: `${name} is classified here but daily-stable.yml's service no longer sets it — drop the entry`,
      });
    }
  }

  return { ok: findings.length === 0, findings, carried, declared: env };
}
