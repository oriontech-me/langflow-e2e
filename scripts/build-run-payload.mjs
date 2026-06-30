#!/usr/bin/env node
// Build the e2e_automation_runs payload from a Playwright JSON report + env metadata.
// Writes JSON to stdout. Mirrors append-weekly-history.mjs parsing; adds v2 fields.
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
if (!existsSync(reportPath)) { console.error(`[payload] no ${reportPath}`); process.exit(1); }
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const totals = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
const failures = [], flaky = [];
const firstErr = r => { const e = r?.error || r?.errors?.[0]; return e ? (e.message||e.value||"").split("\n")[0].slice(0,240) : null; };
const relFile = s => { try { return relative(process.cwd(), resolve(s?.file||s?.location?.file||"")); } catch { return s?.file||""; } };
function visit(node){
  for (const spec of node.specs||[]) {
    const file = relFile(spec), line = spec?.line||spec?.location?.line||0;
    for (const t of spec.tests||[]) {
      const tags = t.tags||spec.tags||[], attempts=(t.results||[]).length, title=spec.title;
      if (t.status==="skipped"){totals.skipped++;continue;}
      if (t.status==="expected"){totals.passed++;continue;}
      if (t.status==="flaky"){totals.flaky++;flaky.push({test:title,file,line,tags,attempts});continue;}
      totals.failed++;
      const last=[...(t.results||[])].reverse().find(r=>r.status!=="passed");
      failures.push({test:title,file,line,tags,attempts,error_signature:firstErr(last)||"unknown"});
    }
  }
  for (const c of node.suites||[]) visit(c);
}
for (const s of report.suites||[]) visit(s);

const num = v => { const n = parseInt(v,10); return Number.isFinite(n) ? n : null; };
const coverage = (process.env.STABLE_COUNT || process.env.TOTAL_COUNT)
  ? { stable_count: num(process.env.STABLE_COUNT), total_count: num(process.env.TOTAL_COUNT) } : undefined;

const now = new Date();
const payload = {
  version: 1,
  date: now.toISOString().slice(0,10),
  time: now.toISOString().slice(11,16),                 // HH:MM UTC — real run time, disambiguates same-day runs
  workflow: process.env.WORKFLOW || "weekly-stable",
  run_id: process.env.GITHUB_RUN_ID || "local",
  run_url: process.env.RUN_URL || null,
  langflow_image: process.env.LANGFLOW_IMAGE || null,   // the nightly build (or RC/stable on a manual run)
  langflow_commit_sha: process.env.LANGFLOW_COMMIT_SHA || null,
  duration_ms: Math.round(report?.stats?.duration ?? 0),
  ...(coverage ? { coverage } : {}),
  ...(process.env.EVIDENCE_URL ? { evidence_artifact_url: process.env.EVIDENCE_URL } : {}),
  ...(process.env.EVIDENCE_EXPIRES_AT ? { evidence_expires_at: process.env.EVIDENCE_EXPIRES_AT } : {}),
  totals, failures, flaky,
};
process.stdout.write(JSON.stringify(payload));
