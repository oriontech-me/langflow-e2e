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
// LANGFLOW_* on the workflow's service must either REACH the target or be RECORDED out
// of scope with a reason, and the 11th variable the daily gains forces that decision
// when it is written instead of opening a gap that surfaces whenever someone next
// notices an odd verdict. Same shape watch-upstream-areas.mjs --mode=check uses for the
// `lfx` subtrees (#1581's rule: the reason is what a future reader acts on).
//
// WHAT THIS FILE DOES NOT DECIDE. It matches NAMES against the files that carry them.
// Whether run-e2e.sh's default for a variable equals the workflow's declared VALUE is
// asserted by run-e2e.test.mjs, which sources the script and reads the value it would
// actually send — text here, behaviour there. Both are needed: a name present with the
// wrong value passes this file, and a value that never crosses the ssh boundary passes
// that one.

import { readFileSync } from "node:fs";
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
 * The VALUES are read by scripts/lib/gh-expression.mjs, not here and not by a regex —
 * #1226's rule. That module already unquotes both YAML scalar forms, evaluates a
 * `${{ … }}` expression against a supplied context, and THROWS on a shape it cannot
 * read rather than returning the raw text as if it were a value. This file returns
 * raw text and leaves the reading to it; a second unquoter here would be a second
 * answer that can disagree with the first.
 */

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

  const sources = {
    orchestrator: { text: stripComments(orchestrator), path: ORCHESTRATOR_PATH },
    starter: { text: stripComments(starter), path: STARTER_PATH },
  };

  const wanted = [...env.keys()].filter((name) => name.startsWith("LANGFLOW_"));

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
    const source = sources[entry.carrier];
    if (!source) {
      findings.push({ kind: "bad-carrier", name, message: `${name} names an unknown carrier: ${entry.carrier}` });
      continue;
    }
    // The name, anywhere in the carrier — including as `--workers`' source variable,
    // which is why this is a name search and not an assignment match. What the value
    // becomes is run-e2e.test.mjs's question.
    if (!source.text.includes(name)) {
      findings.push({
        kind: "not-carried",
        name,
        message: `${name} is classified as reaching the target through ${source.path}, and that file never names it`,
      });
      continue;
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
