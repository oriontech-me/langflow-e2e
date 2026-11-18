// The Actions half of #2486: every upload that can carry a provider key runs only after
// a scrub step that saw the secrets, and only when that step succeeded.
// Run with: npm run test:scripts
//
// The `if:` of each upload is EVALUATED (scripts/lib/gh-expression.mjs), not matched:
// a guard that only checks the text mentions the scrub step passes `|| steps.scrub…`
// and `!= 'success'`, which are the edits that would publish an unscrubbed report
// (#1226's rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWorkflowValue } from "./lib/gh-expression.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// What a report-bearing upload looks like: these paths hold the HTML report, its
// traces, the blob reports, the JSON report and the per-test results.
const CARRIES_KEYS = /^(playwright-report|blob-report|results\.json|test-results)/;

/** The steps of a workflow or composite action, as text blocks with a few fields read. */
function steps(file) {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let indent = -1;
  for (const line of lines) {
    const m = /^(\s*)- (name|uses|id|if|run):/.exec(line);
    if (m && (current === null || m[1].length <= indent)) {
      if (current) blocks.push(current);
      current = [line];
      indent = m[1].length;
    } else if (current) {
      if (line.trim() && /^\s*/.exec(line)[0].length <= indent && !/^\s*#/.test(line)) {
        blocks.push(current);
        current = null;
        indent = -1;
      } else {
        current.push(line);
      }
    }
  }
  if (current) blocks.push(current);
  return blocks.map((b) => {
    const body = b.join("\n");
    const field = (name) => {
      const m = new RegExp(`^\\s*-?\\s*${name}:\\s*(.*)$`, "m").exec(body);
      return m ? m[1].trim() : null;
    };
    const paths = [];
    const pm = /^\s*path:\s*(\|)?\s*(.*)$/m.exec(body);
    if (pm) {
      if (pm[1]) {
        const after = body.slice(pm.index + pm[0].length).split("\n").slice(1);
        for (const l of after) {
          if (!l.trim() || /^\s*[a-z-]+:/.test(l)) break;
          paths.push(l.trim());
        }
      } else {
        paths.push(pm[2]);
      }
    }
    return { body, name: field("name"), id: field("id"), if: field("if"), uses: field("uses"), paths };
  });
}

function isScrub(step) {
  return /node scripts\/scrub-secrets\.mjs/.test(step.body);
}

/** The scrub steps an upload's `if:` depends on, by evaluating it with each outcome. */
function gatingScrubs(upload, scrubs) {
  assert.ok(upload.if, `${upload.name}: an upload of a report needs an if: that reads the scrub`);
  // always()/failure() are status functions the evaluator does not model; on the paths
  // that matter (a red run) both are true, so they are fixed to true here.
  const expr = upload.if.replace(/\balways\(\)/g, "true").replace(/\bfailure\(\)/g, "true");
  const gating = [];
  for (const s of scrubs) {
    // The evaluator takes dotted paths as flat keys.
    const ctx = (outcome) =>
      Object.fromEntries(scrubs.map((o) => [`steps.${o.id}.outcome`, o === s ? outcome : "success"]));
    const ok = evaluateWorkflowValue(`\${{ ${expr} }}`, ctx("success"));
    const failed = evaluateWorkflowValue(`\${{ ${expr} }}`, ctx("failure"));
    const skipped = evaluateWorkflowValue(`\${{ ${expr} }}`, ctx("skipped"));
    if (String(ok) === "true" && String(failed) === "false" && String(skipped) === "false") gating.push(s);
  }
  return gating;
}

const LANES = [
  { file: ".github/workflows/pr-validation.yml", secrets: /\$\{\{\s*toJSON\(secrets\)\s*\}\}/ },
  { file: ".github/workflows/daily-stable.yml", secrets: /\$\{\{\s*toJSON\(secrets\)\s*\}\}/ },
  { file: ".github/actions/run-e2e/action.yml", secrets: /\$\{\{\s*inputs\.secrets_json\s*\}\}/ },
];

for (const { file, secrets } of LANES) {
  test(`${file}: every report-bearing upload runs only after a scrub that covered it succeeded`, () => {
    const all = steps(file);
    const uploads = all.filter((s) => /actions\/upload-artifact/.test(s.uses ?? "") && s.paths.some((p) => CARRIES_KEYS.test(p)));
    assert.ok(uploads.length > 0, `${file}: found no report upload, so the parser is out of step with the file`);
    for (const upload of uploads) {
      const before = all.slice(0, all.indexOf(upload)).filter(isScrub);
      assert.ok(before.length > 0, `${upload.name}: no scrub step runs before it`);
      for (const s of before) assert.ok(s.id, `${s.name}: a scrub step needs an id for the uploads to read`);
      const gating = gatingScrubs(upload, before);
      assert.ok(gating.length > 0, `${upload.name}: its if: does not depend on a scrub step succeeding (${upload.if})`);
      for (const p of upload.paths) {
        const top = p.split("/")[0];
        const covered = gating.some((s) => new RegExp(`--secrets-json-env SCRUB_SECRETS_JSON[^\\n]*\\b${top.replace(".", "\\.")}\\b`).test(s.body));
        assert.ok(covered, `${upload.name}: uploads ${p}, which the scrub it waits on does not read`);
      }
      for (const s of gating) {
        assert.match(s.body, secrets, `${s.name}: SCRUB_SECRETS_JSON must carry the secrets`);
        assert.match(s.body, /--require-secrets/, `${s.name}: without --require-secrets an empty secret set passes`);
        assert.match(s.if ?? "", /always\(\)/, `${s.name}: must run on a red run, which is when there is a report to upload`);
      }
    }
  });
}

test("manual.yml hands its secrets to the run-e2e action, which cannot read them itself", () => {
  const text = readFileSync(join(REPO_ROOT, ".github/workflows/manual.yml"), "utf8");
  const calls = text.split("uses: ./.github/actions/run-e2e").slice(1);
  assert.ok(calls.length >= 1, "manual.yml no longer calls the run-e2e action");
  for (const call of calls) {
    const withBlock = call.split(/\n\s*- (name|uses):/)[0];
    assert.match(withBlock, /secrets_json:\s*\$\{\{\s*toJSON\(secrets\)\s*\}\}/, "a run-e2e call without secrets_json fails its scrub and uploads nothing");
  }
});

test("results.json is scrubbed before the report and on its own, where both are scrubbed together", () => {
  for (const { file } of LANES) {
    for (const s of steps(file).filter(isScrub)) {
      const runs = s.body.split("\n").filter((l) => /scrub-secrets\.mjs/.test(l));
      const res = runs.findIndex((l) => /results\.json/.test(l));
      const rep = runs.findIndex((l) => /playwright-report/.test(l));
      if (res === -1 || rep === -1) continue;
      assert.notEqual(res, rep, `${file} ${s.name}: results.json and the report in one run`);
      assert.ok(res < rep, `${file} ${s.name}: results.json must go first`);
    }
  }
});
