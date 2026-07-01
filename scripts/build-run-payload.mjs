#!/usr/bin/env node
// Build the e2e_automation_runs payload from a Playwright JSON report + env metadata.
// Writes JSON to stdout. Mirrors append-weekly-history.mjs parsing; adds the v2
// coverage block AND a per-test `tests[]` array (every test: name/file/status/
// duration/tags/steps; failures also carry the full error + a base64 screenshot)
// so the QA Platform can render the full run natively — incl. skipped tests —
// instead of only counts. The screenshot rides in the POST as base64; the edge
// function uploads it to Storage and stores only the URL (the DB keeps no base64).
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
if (!existsSync(reportPath)) { console.error(`[payload] no ${reportPath}`); process.exit(1); }
const report = JSON.parse(readFileSync(reportPath, "utf8"));

// Caps keep the POST body bounded — screenshots ride in the payload, and a huge
// report must never break run ingestion. Only the first N failed tests carry a
// screenshot; oversized single shots and over-long error text are dropped/trimmed.
const MAX_SCREENSHOTS = 25;
const MAX_SCREENSHOT_BYTES = 3_000_000;
const MAX_ERROR_CHARS = 8000;
let screenshotCount = 0;

const totals = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
const failures = [], flaky = [], tests = [];

const stripAnsi = (s) => (s || "").replace(/\[[0-9;]*m/g, "");
const firstErr = (r) => {
  const e = r?.error || r?.errors?.[0];
  return e ? stripAnsi(e.message || e.value || "").split("\n")[0].slice(0, 240) : null;
};
const fullErr = (r) => {
  const e = r?.error || r?.errors?.[0];
  if (!e) return null;
  const msg = stripAnsi(e.message || e.value || "");
  const stack = stripAnsi(e.stack || "");
  const combined = stack && !msg.includes(stack) ? `${msg}\n\n${stack}` : (msg || stack);
  return combined.slice(0, MAX_ERROR_CHARS) || null;
};
const relFile = (s) => {
  try { return relative(process.cwd(), resolve(s?.file || s?.location?.file || "")); }
  catch { return s?.file || ""; }
};

// Keep only the human-authored test.step() steps (recursively), dropping the
// noisy built-in pw:api / expect / hook internals — that's what a person wants
// to see when expanding a test, and it keeps the JSONB compact.
function extractSteps(steps) {
  const out = [];
  for (const st of steps || []) {
    if (st?.category === "test.step") {
      const node = { title: st.title, duration_ms: Math.round(st.duration ?? 0) };
      const children = extractSteps(st.steps);
      if (children.length) node.steps = children;
      out.push(node);
    } else if (st?.steps?.length) {
      out.push(...extractSteps(st.steps)); // pull test.step children out of a wrapper
    }
  }
  return out;
}

// Read the failure screenshot for a result: prefer an inline body, else the file
// on disk. Returns { contentType, base64 } or null. Bounded by MAX_SCREENSHOT_BYTES.
function readScreenshot(result) {
  if (!result) return null;
  const att = (result.attachments || []).find(
    (a) => a?.name === "screenshot" || a?.contentType === "image/png",
  );
  if (!att) return null;
  try {
    let buf;
    if (att.body) buf = Buffer.from(att.body, "base64");
    else if (att.path && existsSync(att.path)) buf = readFileSync(att.path);
    else return null;
    if (buf.length > MAX_SCREENSHOT_BYTES) return null;
    return { content_type: att.contentType || "image/png", base64: buf.toString("base64") };
  } catch { return null; }
}

// Playwright test.status → normalized status the QA Platform renders.
const normStatus = (s) => (s === "expected" ? "passed" : s === "unexpected" ? "failed" : s);

function visit(node) {
  for (const spec of node.specs || []) {
    const file = relFile(spec), line = spec?.line || spec?.location?.line || 0;
    for (const t of spec.tests || []) {
      const tags = t.tags || spec.tags || [];
      const attempts = (t.results || []).length;
      const title = spec.title;
      const status = normStatus(t.status);
      const results = t.results || [];
      const last = results[results.length - 1];
      const lastFailed = [...results].reverse().find((r) => r.status !== "passed" && r.status !== "skipped");
      const duration_ms = Math.round(last?.duration ?? 0);

      const entry = { test: title, file, line, status, duration_ms, tags, attempts };
      const steps = extractSteps((last || {}).steps);
      if (steps.length) entry.steps = steps;
      if (status === "failed") {
        entry.error = fullErr(lastFailed || last);
        if (screenshotCount < MAX_SCREENSHOTS) {
          const shot = readScreenshot(lastFailed || last);
          if (shot) { entry.screenshot = shot; screenshotCount++; }
        }
      }
      tests.push(entry);

      // Existing aggregate arrays — unchanged contract (also feed the JSONL script).
      if (t.status === "skipped") { totals.skipped++; continue; }
      if (t.status === "expected") { totals.passed++; continue; }
      if (t.status === "flaky") { totals.flaky++; flaky.push({ test: title, file, line, tags, attempts }); continue; }
      totals.failed++;
      failures.push({ test: title, file, line, tags, attempts, error_signature: firstErr(lastFailed) || "unknown" });
    }
  }
  for (const c of node.suites || []) visit(c);
}
for (const s of report.suites || []) visit(s);

const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const coverage = (process.env.STABLE_COUNT || process.env.TOTAL_COUNT)
  ? { stable_count: num(process.env.STABLE_COUNT), total_count: num(process.env.TOTAL_COUNT) } : undefined;

const now = new Date();
// Stamp date/time in BRT (America/Sao_Paulo), NOT UTC. run_date is what the QA
// Platform's Trend view filters on and the Run Summary labels "BRT"; stamping in
// UTC rolled a run started after 21:00 BRT (00:00 UTC) onto the next calendar
// day, so it fell outside the Trend's default "last N days" window while Run
// Summary (no date filter) still showed it. See qa-platform spec 001.
let runDate, runTime;
try {
  const brtParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const brt = (t) => brtParts.find((p) => p.type === t)?.value ?? "";
  runDate = `${brt("year")}-${brt("month")}-${brt("day")}`;
  runTime = `${brt("hour")}:${brt("minute")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !/^\d{2}:\d{2}$/.test(runTime)) throw new Error("unexpected BRT parts");
} catch (e) {
  // ICU/TZ data missing or malformed — fall back to UTC so the payload step
  // never hard-fails on date formatting (it has no continue-on-error).
  console.error(`[payload] BRT stamp failed (${e?.message || e}); falling back to UTC`);
  runDate = now.toISOString().slice(0, 10);
  runTime = now.toISOString().slice(11, 16);
}
const payload = {
  version: 1,
  date: runDate,
  time: runTime,                                        // HH:MM BRT — real run time, disambiguates same-day runs
  workflow: process.env.WORKFLOW || "weekly-stable",
  run_id: process.env.GITHUB_RUN_ID || "local",
  run_url: process.env.RUN_URL || null,
  langflow_image: process.env.LANGFLOW_IMAGE || null,   // the nightly build (or RC/stable on a manual run)
  langflow_version: process.env.LANGFLOW_VERSION || null, // resolved version from GET /api/v1/version (e.g. 1.11.0.dev25)
  langflow_commit_sha: process.env.LANGFLOW_COMMIT_SHA || null,
  duration_ms: Math.round(report?.stats?.duration ?? 0),
  ...(coverage ? { coverage } : {}),
  ...(process.env.EVIDENCE_URL ? { evidence_artifact_url: process.env.EVIDENCE_URL } : {}),
  ...(process.env.EVIDENCE_EXPIRES_AT ? { evidence_expires_at: process.env.EVIDENCE_EXPIRES_AT } : {}),
  totals, failures, flaky,
  // Optional, backwards-compatible addition (version stays 1): the full per-test
  // list. The currently-deployed edge function ignores unknown fields, so this is
  // a no-op until the QA Platform is updated to persist it.
  tests,
};
process.stdout.write(JSON.stringify(payload));
