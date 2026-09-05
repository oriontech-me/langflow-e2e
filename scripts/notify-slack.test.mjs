#!/usr/bin/env node
// Guards for `scripts/notify-slack.mjs`.
//
// Two things here can fail SILENTLY, which is why they are pinned:
//
//  1. TRANSPORT SHAPE. A Workflow Builder trigger accepts a Block Kit body with a
//     200 and renders nothing useful, so "wrong shape" looks exactly like "worked"
//     from the caller's side. The mode is derived from the URL's path segment;
//     these tests pin that derivation and the body each mode produces.
//  2. VERDICT SHAPE. The message mirrors the three shapes of the GitHub issue —
//     zero-tests / partial / per-test. Announcing "3 tests failed" on a run that
//     executed ZERO points triage at specs instead of at the backend (#1012), and
//     the Slack message and the issue must never disagree.
//
// Plus the fail-soft contract: a notifier that can fail a run is worse than no
// notifier, so every transport failure has to exit 0.
//
// Run: npm run test:scripts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "node:http";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTIFIER = join(HERE, "notify-slack.mjs");
const REPO = resolve(HERE, "..");

const PAYLOAD = {
  version: 1,
  date: "2026-08-25",
  run_id: "20260825T084100Z",
  langflow_image: "langflowai/langflow-nightly:latest",
  langflow_version: "1.11.0.dev25",
  totals: { passed: 312, failed: 3, flaky: 2, skipped: 20 },
  failures: Array.from({ length: 14 }, (_, i) => ({
    test: `failing test ${i + 1}`,
    file: `tests/tests-automations/regression/area/spec-${i + 1}.spec.ts`,
    line: 10 + i,
    tags: ["@stable"],
    attempts: 3,
    error_signature: `Error: something went wrong ${i + 1}`,
  })),
  flaky: [],
};

const GREEN_PAYLOAD = {
  ...PAYLOAD,
  totals: { passed: 331, failed: 0, flaky: 0, skipped: 20 },
  failures: [],
};

const dir = makeTempDir("notify-slack-");
const payloadPath = join(dir, "payload.json");
writeFileSync(payloadPath, JSON.stringify(PAYLOAD), "utf8");
const greenPayloadPath = join(dir, "payload-green.json");
writeFileSync(greenPayloadPath, JSON.stringify(GREEN_PAYLOAD), "utf8");

/** Run the notifier and return { stdout, stderr, status }. spawnSync, not
 *  execFileSync: the latter surfaces stderr only on a NON-zero exit, and this
 *  script's whole contract is that it exits 0 and reports on stderr. */
function run(env = {}) {
  const r = spawnSync("node", [NOTIFIER], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PAYLOAD_JSON: payloadPath,
      RUN_EMPTY: "false",
      RUN_PARTIAL: "false",
      SLACK_TIMEOUT_MS: "1500",
      ...env,
    },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

/** The body text, whichever transport carried it. The two differ in DECORATION
 *  only, so a property about length or budgeting is asserted through this. */
const bodyText = (b) => (b.body !== undefined ? b.body : b.blocks[1].text.text);

/** Dry-run and parse the rendered request body. */
function render(env = {}) {
  const { stdout } = run({ SLACK_DRY_RUN: "1", ...env });
  const json = stdout.slice(stdout.indexOf("{"));
  return { body: JSON.parse(json), mode: /mode=(\w+)/.exec(stdout)?.[1] };
}

test("the transport is derived from the URL's path segment", () => {
  const wf = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc" });
  assert.equal(wf.mode, "workflow");
  assert.deepEqual(Object.keys(wf.body).sort(), ["body", "headline", "links"]);

  const bk = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T1/B2/xyz" });
  assert.equal(bk.mode, "blockkit");
  assert.deepEqual(Object.keys(bk.body).sort(), ["blocks", "text"]);

  // Host-independent: a relay or a proxy must not silently fall back to Block Kit,
  // which a trigger accepts with a 200 and renders as nothing.
  const proxied = render({ SLACK_WEBHOOK_URL: "http://localhost:8787/triggers/E1/2/abc" });
  assert.equal(proxied.mode, "workflow", "detection must key on the path, not the host");

  const forced = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc", SLACK_MODE: "blockkit" });
  assert.equal(forced.mode, "blockkit", "SLACK_MODE must override the derivation");
});

test("a Workflow Builder message carries no markup, because the step will not render it", () => {
  // Verified against a real trigger on 2026-09-03: the POST returned 200 and the
  // channel showed `*bold*` as asterisks, backticks as backticks and `<url|label>`
  // as itself. That is the same class of silent wrongness the derivation above
  // exists to prevent — accepted, 200, useless — one layer further in.
  const { body } = render({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc",
    ISSUE_URL: "https://example.invalid/issue/1",
    REPORT_URL: "https://example.invalid/report",
  });
  const all = [body.headline, body.body, body.links].join("\n");
  assert.doesNotMatch(all, /\*/, "no bold markers");
  assert.doesNotMatch(all, /`/, "no code spans and no fences");
  assert.doesNotMatch(all, /<https?:[^|>]*\|/, "no mrkdwn links");
  // The destination survives — Slack auto-links a bare URL — and only the label's
  // placement changes. A link whose text renders as `<url|label>` is worse than a
  // bare URL: it looks broken and it is not clickable as the label.
  assert.match(body.links, /Triage issue: https:\/\/example\.invalid\/issue\/1/);
  assert.match(body.links, /Playwright report: https:\/\/example\.invalid\/report/);
});

test("Block Kit keeps the markup, so the transports differ in decoration and not in words", () => {
  const { body } = render({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T1/B2/xyz",
    REPORT_URL: "https://example.invalid/report",
  });
  assert.match(bodyText(body), /\*Langflow\*/);
  assert.match(bodyText(body), /\*3 failed\*/);
  assert.match(JSON.stringify(body), /<https:\/\/example\.invalid\/report\|Playwright report>/);
});

test("the elision notice is plain in a Workflow Builder message too", () => {
  // The one span the mode-aware pass missed, and the reason it needs its own test:
  // the check above bans `*` and backticks, but it CANNOT ban underscores, because
  // underscores are legitimate content here — the spec names carry them. So the
  // notice's own shape is what has to be asserted.
  const wf = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc" });
  assert.match(wf.body.body, /… and \d+ more not listed here — see the report\./);
  assert.doesNotMatch(wf.body.body, /_… and/, "no italic markers around the notice");

  const bk = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T1/B2/xyz" });
  assert.match(bodyText(bk.body), /_… and \d+ more not listed here — see the report\._/);
});

test("a spec name carrying underscores survives both transports intact", () => {
  // The property that rules out stripping the markup after the fact. These names are
  // real — `model_provider_base_url_ssrf.spec.ts` is in the suite — and a regex
  // hunting `_` to undo italics would eat half of them, in the one section where the
  // reader needs the name exact enough to grep for it.
  const underscored = join(dir, "payload-underscores.json");
  const testName = "model_provider_base_url_ssrf › refuses a private address";
  writeFileSync(
    underscored,
    JSON.stringify({
      ...PAYLOAD,
      totals: { passed: 10, failed: 1, flaky: 0, skipped: 0 },
      failures: [
        {
          test: testName,
          file: "tests/tests-automations/regression/security/model_provider_base_url_ssrf.spec.ts",
          error_signature: "Error: expected _all_ resolved addresses to be named",
        },
      ],
    }),
    "utf8",
  );

  for (const url of ["https://hooks.slack.com/triggers/E1/2/abc", "https://hooks.slack.com/services/T1/B2/xyz"]) {
    const { body } = render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: underscored });
    const text = bodyText(body);
    assert.match(text, /model_provider_base_url_ssrf\.spec\.ts/, url);
    assert.ok(text.includes(testName), `the test name survives intact — ${url}`);
    assert.match(text, /expected _all_ resolved addresses to be named/, url);
  }
});

test("a Workflow Builder post always carries all three declared variables", () => {
  // A declared variable the POST omits fails the trigger outright, so an empty
  // run must still send the key — empty, not absent.
  const { body } = render({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc",
    RUN_EMPTY: "true",
    // no ISSUE_URL, no REPORT_URL → links has nothing to say
  });
  assert.deepEqual(Object.keys(body).sort(), ["body", "headline", "links"]);
  assert.equal(typeof body.links, "string");
});

test("a failed MERGE outranks `empty`, so the message never says nothing ran", () => {
  // Same inputs as an empty run, because a failed merge IS one as far as the guards
  // can see: no report to read, so empty and unreadable both true. MERGE_OK is the
  // only thing that tells the two apart, and this message is one of the two surfaces
  // anyone reads at 06:00 — the verdict on stderr is the one nobody opens (#1726).
  const url = "https://hooks.slack.com/triggers/E1/2/abc";
  const merged = render({ SLACK_WEBHOOK_URL: url, RUN_EMPTY: "true", RUN_UNREADABLE: "true", MERGE_OK: "false" });
  assert.match(merged.body.headline, /could not MERGE its shard reports/);
  assert.doesNotMatch(merged.body.headline, /ZERO tests/, "every shard ran");
  assert.match(merged.body.body, /The shards RAN and the merge FAILED/);
  assert.match(merged.body.body, /unread, not zero/);
  assert.doesNotMatch(merged.body.body, /find why nothing ran/);
  assert.match(merged.body.body, /merge\.log/, "the message points at the log that holds the reason");

  // The message and the issue are two views of one verdict: same rank, same claim.
  const stillEmpty = render({ SLACK_WEBHOOK_URL: url, RUN_EMPTY: "true", RUN_UNREADABLE: "true" });
  assert.match(stillEmpty.body.headline, /ZERO tests/, "absent MERGE_OK is a working merge");
});

test("the headline names the right one of the four verdict shapes", () => {
  const url = "https://hooks.slack.com/triggers/E1/2/abc";
  const empty = render({ SLACK_WEBHOOK_URL: url, RUN_EMPTY: "true", RUN_ERRORS: "4" });
  assert.match(empty.body.headline, /ZERO tests/);
  assert.doesNotMatch(empty.body.headline, /\d+ test\(s\)/, "an empty run must never claim tests failed");

  const partial = render({ SLACK_WEBHOOK_URL: url, RUN_PARTIAL: "true", RUN_TESTS: "337", RUN_ERRORS: "2" });
  assert.match(partial.body.headline, /PARTIAL/);
  assert.match(partial.body.body, /UNDER-COUNTED/, "a partial run must say its totals are under-counted");

  const failed = render({ SLACK_WEBHOOK_URL: url });
  assert.match(failed.body.headline, /3 test\(s\)/);
});

test("an elided failure list says how many it left out", () => {
  const { body } = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc" });
  // 14 failures, 10 listed: a list that just stops reads as "10 failures".
  assert.match(body.body, /and 4 more not listed/);
});

test("the backend-outage note is gated on `measured`, not on `wedged` alone", () => {
  const url = "https://hooks.slack.com/triggers/E1/2/abc";
  // `wedged` is also "false" when nothing was probed, so the pair has to be read
  // together — an unmeasured run must not claim the backend stayed up.
  const unmeasured = render({ SLACK_WEBHOOK_URL: url, LIVENESS_MEASURED: "false", LIVENESS_WEDGED: "true" });
  assert.doesNotMatch(unmeasured.body.body, /went down mid-run/);

  const measured = render({
    SLACK_WEBHOOK_URL: url,
    LIVENESS_MEASURED: "true", LIVENESS_WEDGED: "true",
    LIVENESS_OUTAGES: "2", LIVENESS_DOWN_SECONDS: "143",
  });
  assert.match(measured.body.body, /went down mid-run/);
  assert.match(measured.body.body, /2 outage\(s\), 143s/, "the note must carry the numbers, not just the verdict");
});

test("a file:// report is written as a path, not as a dead link", () => {
  const { body } = render({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc",
    REPORT_URL: "file:///root/e2e-qa/runs/X/playwright-report/index.html",
    VM_HOSTNAME: "qa-runner.internal.example",
  });
  assert.doesNotMatch(body.links, /<file:/, "a file:// link is not clickable from Slack");
  assert.match(body.links, /\/root\/e2e-qa\/runs\/X/);
  assert.match(body.links, /qa-runner\.internal\.example/, "say which machine the path is on");
});

/** Async variant. Required whenever the test itself serves the request:
 *  `spawnSync` blocks this process's event loop, so an in-process HTTP server
 *  never accepts the connection and the child waits out its whole timeout. */
function runAsync(env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn("node", [NOTIFIER], {
      cwd: REPO,
      env: {
        ...process.env,
        PAYLOAD_JSON: payloadPath,
        RUN_EMPTY: "false",
        RUN_PARTIAL: "false",
        SLACK_TIMEOUT_MS: "5000",
        ...env,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

test("every transport failure still exits 0", async () => {
  assert.equal(run({ SLACK_WEBHOOK_URL: "" }).status, 0, "no webhook configured");
  assert.equal(
    run({ SLACK_WEBHOOK_URL: "http://127.0.0.1:1/triggers/x" }).status, 0,
    "unreachable Slack",
  );

  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(500);
    res.end("invalid_payload");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const r = await runAsync({ SLACK_WEBHOOK_URL: `http://127.0.0.1:${port}/triggers/x` });
    assert.equal(r.status, 0, "a 500 from Slack must not fail the run");
    assert.match(r.stderr, /post failed \(HTTP 500/);
  } finally {
    server.close();
  }
});

test("a green run is not announced as a red one", () => {
  // The header says this "fires on the SAME condition as the triage issue", but
  // that condition lives in the caller — and the caller is the runner that is still
  // being written. Unguarded, a clean day rendered
  // "🔴 Daily @stable failed — 0 test(s)".
  const url = "https://hooks.slack.com/triggers/E1/2/abc";
  const { stdout } = run({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: greenPayloadPath, SLACK_DRY_RUN: "1" });
  assert.doesNotMatch(stdout, /Daily @stable failed/, "a clean run must not be announced as a failure");
  assert.match(stdout, /nothing to announce/);

  // SLACK_FORCE is the wiring test, and it must still reach a rendered payload.
  const forced = render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: greenPayloadPath, SLACK_FORCE: "1" });
  assert.match(forced.body.headline, /Daily @stable failed/);
});

test("the gate is narrow: an UNKNOWN verdict is still announced, and named as unknown", () => {
  const url = "https://hooks.slack.com/triggers/E1/2/abc";

  // No payload at all: `totals.failed` is undefined, which is unknown, not zero.
  // Staying silent there is #1012 from the other side — a run whose verdict nobody
  // could read must not pass for a clean one. But announcing it as
  // "🔴 Daily @stable failed — 0 test(s)" is the SAME false verdict from the third
  // side: that sentence is read as "zero tests failed", i.e. as a clean day. So the
  // unknown case is its own shape, and it has to say the word.
  const noPayload = render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: join(dir, "does-not-exist.json") });
  assert.match(noPayload.body.headline, /verdict UNKNOWN/);
  assert.doesNotMatch(noPayload.body.headline, /failed — 0 test\(s\)/, "unknown is not zero");
  assert.match(noPayload.body.body, /not a clean day, it is an unread one/);

  // A payload that parses but carries no totals is the same verdict by another
  // route, and must not be reported as a clean day either.
  const noTotals = join(dir, "payload-no-totals.json");
  writeFileSync(noTotals, JSON.stringify({ version: 1, date: "2026-08-25", failures: [] }), "utf8");
  assert.match(render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: noTotals }).body.headline, /verdict UNKNOWN/);

  // Zero failures but an EMPTY or PARTIAL verdict is the whole point of those two
  // shapes: nothing failed precisely because nothing ran.
  const empty = render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: greenPayloadPath, RUN_EMPTY: "true" });
  assert.match(empty.body.headline, /ZERO tests/);

  const partial = render({ SLACK_WEBHOOK_URL: url, PAYLOAD_JSON: greenPayloadPath, RUN_PARTIAL: "true" });
  assert.match(partial.body.headline, /PARTIAL/);
});

test("a long quoted cause is truncated inside its fence, not across it", () => {
  // The body as a whole is capped at SECTION_MAX. A cut landing inside the code
  // fence leaves it unclosed and elides the diagnosis silently — the one thing this
  // script refuses to do for the failure list.
  const huge = "Error: worker process exited unexpectedly\n    at a stack frame that is long\n".repeat(60);
  const bad = { RUN_PARTIAL: "true", RUN_TESTS: "180", RUN_ERRORS: "2", RUN_FIRST_ERROR: huge };

  // Asserted on Block Kit, because a fence is Block Kit's: a Workflow Builder step
  // inserts variables as plain text, so there the fence would be three literal
  // backticks in the channel rather than a quoted block.
  const bk = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T1/B2/xyz", ...bad });
  const fences = (bodyText(bk.body).match(/```/g) || []).length;
  assert.equal(fences % 2, 0, "the code fence must be closed");
  assert.equal(fences, 2);
  assert.ok(bodyText(bk.body).length <= 2900, "and the body still fits Slack's section cap");

  // The cap is the transport-independent half, and the plain form must carry no
  // fence at all — an unclosed fence cannot be the failure if there is no fence.
  const wf = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc", ...bad });
  assert.ok(bodyText(wf.body).length <= 2900);
  assert.doesNotMatch(bodyText(wf.body), /```/);
});

test("the elision notice survives the section cap — the list is budgeted, not appended", () => {
  // The 10-item cap already NAMED what it left out. The character cap underneath it
  // did not: the notice is the last line, so a body truncated at SECTION_MAX cut the
  // notice off first and the message ended mid-entry with a bare ellipsis — the same
  // silent cut, one layer down. Measured before the fix: this payload rendered a
  // 2900-char body ending inside the 9th entry, with no count anywhere in it.
  const long = join(dir, "payload-long-entries.json");
  writeFileSync(
    long,
    JSON.stringify({
      ...PAYLOAD,
      totals: { passed: 300, failed: 22, flaky: 1, skipped: 20 },
      failures: Array.from({ length: 22 }, (_, i) => ({
        test: "very long descriptive test title ".repeat(6) + i,
        file: `tests/tests-automations/regression/core-functionality/llm-agents/some-quite-long-agent-spec-name-${i + 1}.spec.ts`,
        error_signature: "Error: timeout exceeded waiting for a locator that never appeared ".repeat(4) + i,
      })),
    }),
    "utf8",
  );

  const { body } = render({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc", PAYLOAD_JSON: long });
  assert.ok(body.body.length <= 2900, "the body still fits Slack's section cap");
  const notice = /and (\d+) more not listed here/.exec(body.body);
  assert.ok(notice, "the count of what was elided must survive the cap, not be cut by it");
  // And it must be the TRUTH: shown + elided is every failure there was.
  const shown = (body.body.match(/^• /gm) || []).length;
  assert.equal(shown + Number(notice[1]), 22, "shown + elided must account for every failure");
});

test("an unrecognised SLACK_MODE keeps the derived mode and says so", () => {
  // `mode === "workflow" ? … : blockkit` reads every other value as Block Kit, so a
  // typo silently posted Block Kit to a trigger — accepted with a 200, rendered as
  // nothing. That is the exact failure the URL derivation exists to avoid.
  const { stdout, stderr, status } = run({
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/E1/2/abc",
    SLACK_MODE: "workflows",
    SLACK_DRY_RUN: "1",
  });
  assert.equal(status, 0, "a bad knob must not fail the run — the fail-soft contract outranks it");
  assert.match(stderr, /SLACK_MODE="workflows" is not one of/);
  assert.match(stdout, /mode=workflow\b/, "it falls back to what the URL says, not to blockkit");
});
