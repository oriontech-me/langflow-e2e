// scripts/backfill-runs.mjs
//
// One-off backfill: replay the historical runs in reports/weekly-history.jsonl
// into the QA Platform so the E2E Automation dashboard starts populated instead
// of empty. Each JSONL line is already a valid v1 payload (run_url,
// langflow_image, duration_ms, totals, failures, flaky); they carry no coverage
// block, so those runs render without the coverage band/chart (documented gap).
//
// Safe to re-run: the endpoint is idempotent by run_id (201 new / 200 existing).
//
// Usage:
//   QA_PLATFORM_ENDPOINT="https://<ref>.supabase.co/functions/v1/e2e-automation-runs-create" \
//   QA_E2E_AUTOMATION_TOKEN="<value>" node scripts/backfill-runs.mjs
import { readFileSync } from "node:fs";
const endpoint = process.env.QA_PLATFORM_ENDPOINT, token = process.env.QA_E2E_AUTOMATION_TOKEN;
for (const line of readFileSync("reports/weekly-history.jsonl","utf8").split("\n").filter(Boolean)) {
  const e = JSON.parse(line);
  const body = { ...e, time: e.time ?? "03:00" };  // keep original workflow (weekly-stable); endpoint accepts the v1 shape
  const r = await fetch(endpoint, { method:"POST",
    headers:{ "Authorization":`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(body) });
  console.log(e.date, e.run_id, "→", r.status);               // 201 new / 200 already existed (idempotent)
}
