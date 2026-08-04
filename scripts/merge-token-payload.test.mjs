// Unit tests for the token payload merge (issue #1217 §5.2).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import realFs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { MERGE_CODES, mergeTokenPayload, resolveTargetProvider } from "./merge-token-payload.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const daily = () =>
  realFs.readFileSync(path.join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8");

// The POST step's own body, sliced from its `- name:` to the next one. Every
// structural guard below reads THIS and not the whole file: a match anywhere in a
// 1400-line workflow proves nothing about the step that has to carry it.
const postStep = () => {
  const text = daily();
  const at = text.indexOf("- name: POST token consumption to QA Platform");
  assert.ok(at > 0, "the daily no longer has a token POST step");
  const next = text.indexOf("      - name:", at + 10);
  return text.slice(at, next > 0 ? next : text.length);
};

const BLOCK = { traces: 1, total_tokens: 88, span_tokens: 88, mismatch_traces: 0, rows: [] };
const PAYLOAD = {
  version: 1,
  date: "2026-08-03",
  run_id: "42",
  totals: { passed: 1 },
  tokens: { stale: true },
};

const io = ({ files = {}, dir = [] } = {}) => {
  const written = new Map();
  return {
    written,
    logged: [],
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    listDir: () => dir,
    writeFile: (p, body) => written.set(p, body),
  };
};

test("merges the tokens block into the payload and reports written", async () => {
  const t = io({ files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": JSON.stringify(BLOCK) } });
  const res = await mergeTokenPayload({
    env: { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, true);
  const merged = JSON.parse(t.written.get("merged.json"));
  assert.equal(merged.version, 1);
  assert.equal(merged.run_id, "42");
  assert.deepEqual(merged.totals, { passed: 1 });
  // PAYLOAD carries a stale `tokens.stale` key; it must lose to the fresh block
  // — this is what catches a spread-order regression (Step 5 mutation 4).
  assert.equal(merged.tokens.total_tokens, 88);
  assert.deepEqual(merged.tokens.rows, []);
});

test("writes nothing when the tokens block is absent", async () => {
  // G4: no block means the run captured nothing. A payload with an empty tokens
  // block would clamp the run's token columns to zero.
  const t = io({ files: { "payload.json": JSON.stringify(PAYLOAD) } });
  const res = await mergeTokenPayload({
    env: { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, false);
  assert.equal(t.written.size, 0);
  assert.match(res.reason, /tokens block/i);
  assert.ok(t.logged.length > 0, "the skip must be logged, never silent");
});

test("writes nothing when the payload itself is absent", async () => {
  const t = io({ files: { "tokens-block.json": JSON.stringify(BLOCK) } });
  const res = await mergeTokenPayload({
    env: { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, false);
  assert.equal(t.written.size, 0);
  assert.match(res.reason, /payload/i);
});

test("writes nothing when the tokens block is unparseable", async () => {
  const t = io({ files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": "{not json" } });
  const res = await mergeTokenPayload({
    env: { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, false);
  assert.equal(t.written.size, 0);
});

test("carries the resolved provider when every shard agrees", async () => {
  const t = io({
    files: {
      "payload.json": JSON.stringify(PAYLOAD),
      "tokens-block.json": JSON.stringify(BLOCK),
      "all-tokens/token-provider-1.txt": "anthropic\n",
      "all-tokens/token-provider-2.txt": "anthropic",
    },
    dir: ["all-tokens/token-provider-1.txt", "all-tokens/token-provider-2.txt", "all-tokens/token-probes-1.jsonl"],
  });
  const res = await mergeTokenPayload({
    env: {
      TOKENS_SUMMARY_OUT: "tokens-block.json",
      PAYLOAD_IN: "payload.json",
      PAYLOAD_OUT: "merged.json",
      TOKENS_DIR: "all-tokens",
    },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, true);
  assert.equal(JSON.parse(t.written.get("merged.json")).tokens.target_provider, "anthropic");
});

test("omits the provider and says so when shards disagree", async () => {
  // G5: the provider must be reported AS RESOLVED. Picking one of two
  // disagreeing shards would publish a value no shard actually ran.
  const t = io({
    files: {
      "payload.json": JSON.stringify(PAYLOAD),
      "tokens-block.json": JSON.stringify(BLOCK),
      "all-tokens/token-provider-1.txt": "anthropic",
      "all-tokens/token-provider-2.txt": "google",
    },
    dir: ["all-tokens/token-provider-1.txt", "all-tokens/token-provider-2.txt"],
  });
  const res = await mergeTokenPayload({
    env: {
      TOKENS_SUMMARY_OUT: "tokens-block.json",
      PAYLOAD_IN: "payload.json",
      PAYLOAD_OUT: "merged.json",
      TOKENS_DIR: "all-tokens",
    },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, true, "a provider disagreement must not cost the token rows");
  const merged = JSON.parse(t.written.get("merged.json"));
  assert.equal("target_provider" in merged.tokens, false, "omitted, never null and never a guess");
  assert.ok(
    t.logged.some((m) => /anthropic/.test(m) && /google/.test(m)),
    `both values must be named in the warning, got: ${JSON.stringify(t.logged)}`,
  );
});

test("omits the provider when no shard recorded one", async () => {
  const t = io({
    files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": JSON.stringify(BLOCK) },
    dir: ["all-tokens/token-probes-1.jsonl"],
  });
  const res = await mergeTokenPayload({
    env: {
      TOKENS_SUMMARY_OUT: "tokens-block.json",
      PAYLOAD_IN: "payload.json",
      PAYLOAD_OUT: "merged.json",
      TOKENS_DIR: "all-tokens",
    },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal(res.written, true);
  assert.equal("target_provider" in JSON.parse(t.written.get("merged.json")).tokens, false);
});

test("omits target_provider end-to-end when the only recorded file is empty", async () => {
  // The shard writes the file unconditionally, so "the rotation declined to pin"
  // arrives as an empty file, not a missing one.
  //
  // NAMING NOTE (fix round 1): this used to be named "an empty provider file is
  // not a provider", which implied it was pinning down resolveTargetProvider's
  // own filtering. It is not -- resolveTargetProvider already has a dedicated
  // unit test below ("resolveTargetProvider is pure and reports its own
  // verdict") that covers `["", "  "]` directly. This test instead proves the
  // END-TO-END outcome through the full mergeTokenPayload pipeline: today that
  // outcome is guaranteed twice over (resolveTargetProvider's filter AND the
  // merge-site ternary in merge-token-payload.mjs), so this test cannot, by
  // itself, tell you which guard is doing the work -- only that the observable
  // result is still correct. See the comment on the merge-site ternary for why
  // the two guards are intentionally redundant and why a break in exactly one
  // of them, with the other intact, is not expected to turn this test red.
  const t = io({
    files: {
      "payload.json": JSON.stringify(PAYLOAD),
      "tokens-block.json": JSON.stringify(BLOCK),
      "all-tokens/token-provider-1.txt": "\n",
    },
    dir: ["all-tokens/token-provider-1.txt"],
  });
  const res = await mergeTokenPayload({
    env: {
      TOKENS_SUMMARY_OUT: "tokens-block.json",
      PAYLOAD_IN: "payload.json",
      PAYLOAD_OUT: "merged.json",
      TOKENS_DIR: "all-tokens",
    },
    ...t,
    log: (m) => t.logged.push(m),
  });
  assert.equal("target_provider" in JSON.parse(t.written.get("merged.json")).tokens, false);
});

// --- The verdict code, which the workflow branches on ---
//
// `written: false` is three different facts (block absent / block computed then
// lost / payload unusable) and the step's notice used to name only the first, so a
// CORRUPTED block read as "this run captured nothing" — the absent-vs-zero
// conflation this path exists to prevent, one layer up (#1253 review, finding 3).

test("the code separates an ABSENT block from an UNPARSEABLE one", async () => {
  const absent = io({ files: { "payload.json": JSON.stringify(PAYLOAD) } });
  const corrupt = io({ files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": "{not json" } });
  const env = { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" };

  const a = await mergeTokenPayload({ env, ...absent, log: () => {} });
  const c = await mergeTokenPayload({ env, ...corrupt, log: () => {} });

  assert.equal(a.code, "block_missing");
  assert.equal(c.code, "block_unparseable");
  assert.notEqual(a.code, c.code, "the two must be distinguishable — the whole point of the field");
});

test("the code separates an absent payload from an unparseable one", async () => {
  const absent = io({ files: { "tokens-block.json": JSON.stringify(BLOCK) } });
  const corrupt = io({ files: { "tokens-block.json": JSON.stringify(BLOCK), "payload.json": "{nope" } });
  const env = { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" };

  assert.equal((await mergeTokenPayload({ env, ...absent, log: () => {} })).code, "payload_missing");
  assert.equal((await mergeTokenPayload({ env, ...corrupt, log: () => {} })).code, "payload_unparseable");
});

test("a successful merge reports code=merged", async () => {
  const t = io({ files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": JSON.stringify(BLOCK) } });
  const res = await mergeTokenPayload({
    env: { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" },
    ...t,
    log: () => {},
  });
  assert.equal(res.code, "merged");
});

test("MERGE_CODES lists every code the module can actually return", async () => {
  // The workflow's guard below is pinned against MERGE_CODES, so a code the
  // module emits but the list omits would be a silent fallthrough in the YAML.
  const env = { TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json", PAYLOAD_OUT: "merged.json" };
  const cases = [
    { files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": JSON.stringify(BLOCK) } },
    { files: { "payload.json": JSON.stringify(PAYLOAD) } },
    { files: { "payload.json": JSON.stringify(PAYLOAD), "tokens-block.json": "{x" } },
    { files: { "tokens-block.json": JSON.stringify(BLOCK) } },
    { files: { "tokens-block.json": JSON.stringify(BLOCK), "payload.json": "{x" } },
  ];
  const seen = [];
  for (const c of cases) {
    const res = await mergeTokenPayload({ env, ...io(c), log: () => {} });
    seen.push(res.code);
  }
  assert.deepEqual([...seen].sort(), [...MERGE_CODES].sort());
});

// --- Structural guards: is the daily workflow actually wired to this script? ---
//
// Same rationale as watch-tokens.test.mjs's own guards (#1045): a real token POST
// cannot be reproduced in a unit test, but the WIRING can be asserted cheaply.
// These exist because #1217's own PR body named the TOKENS_SUMMARY_OUT seam as the
// place where "a wrong number looks correct" and then verified it BY HAND
// (#1253 review, finding 1) — hand-verification does not survive the next editor.

test("the daily hands the same TOKENS_SUMMARY_OUT to the summarize step and the POST step", () => {
  const text = daily();
  const matches = [...text.matchAll(/TOKENS_SUMMARY_OUT:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(
    matches.length,
    2,
    `expected exactly two TOKENS_SUMMARY_OUT declarations (summarize + POST), got ${matches.length}: ${matches.join(", ")}`,
  );
  assert.equal(
    matches[0],
    matches[1],
    "the summarizer would write one path while the merge looks for another — and the merge's own " +
      '"no tokens block" branch would then report a run that DID capture as one that captured nothing',
  );
});

test("the token POST runs AFTER the summarize that computes the number", () => {
  const text = daily();
  const summarize = text.indexOf("node scripts/watch-tokens.mjs --summarize");
  const post = text.indexOf("node scripts/merge-token-payload.mjs");
  assert.ok(summarize > 0, "the merge job no longer summarizes token consumption");
  assert.ok(post > 0, "the merge job no longer runs the token payload merge");
  assert.ok(post > summarize, "the block does not exist until --summarize has run");
});

test("the token POST step reads the same directory the shard artifacts are downloaded into", () => {
  const text = daily();
  const download = text.indexOf("- name: Download shard token consumption data");
  assert.ok(download > 0, "the merge job no longer downloads the shard token artifacts");
  const downloadPath = /path:\s*(\S+)/.exec(text.slice(download, download + 500))?.[1];
  const stepTokensDir = /TOKENS_DIR:\s*(\S+)/.exec(postStep())?.[1];
  assert.ok(downloadPath, "the download step declares no path:");
  assert.equal(
    stepTokensDir,
    downloadPath,
    "TOKENS_DIR must be the download's own path: — otherwise the provider files are silently never read " +
      "and every run reports target_provider as unreported",
  );
});

test("the shard writes its resolved provider into the directory it uploads", () => {
  const text = daily();
  const stop = text.indexOf("- name: Stop and collect token consumption");
  const upload = text.indexOf("- name: Upload token consumption");
  assert.ok(stop > 0 && upload > 0, "the shard's stop/upload token steps must both exist");
  const stopBody = text.slice(stop, upload);
  assert.match(
    stopBody,
    /token-provider-\$\{\{ matrix\.shard \}\}\.txt/,
    "the provider must be written per-shard — one name for all shards would collide under merge-multiple",
  );
  assert.match(
    stopBody,
    /> "tokens\/token-provider-/,
    "it must land inside tokens/, the directory the upload step actually ships",
  );
  assert.match(
    text.slice(upload, upload + 400),
    /path:\s*tokens\//,
    "the upload step must still ship the tokens/ directory",
  );
});

test("the POST step handles every MERGE_CODES verdict, and has a fallback for none of them", () => {
  const body = postStep();
  for (const code of MERGE_CODES) {
    if (code === "merged") continue; // the merged path is the one that POSTs, not a notice
    assert.ok(
      body.includes(code),
      `the POST step does not branch on "${code}" — that outcome would fall through to the default message`,
    );
  }
  // The unknown-verdict arm: a code this list does not yet contain must be
  // reported as UNKNOWN, never as a run that captured nothing (#1012, #1035).
  assert.match(
    body,
    /UNKNOWN, not zero/,
    "the step must name an unrecognised verdict as unknown rather than defaulting to a plausible zero",
  );
});

// The `code` is only useful if the CLI PRINTS it in the shape the workflow reads.
// Everything above tests the returned value; this runs the real process and then
// applies the workflow's OWN extractor to its real stdout, so the contract is
// pinned from both ends at once. Without it, renaming the printed prefix leaves
// every other test in this file green while the step's verdict goes permanently
// empty — measured: that mutation passed 19/19 before this test existed.
test("the daily's own extractor reads the real CLI's real stdout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-token-payload-"));
  writeFileSync(path.join(dir, "payload.json"), JSON.stringify(PAYLOAD));
  // No tokens block on disk → the CLI must reach `block_missing`, a verdict the
  // step has a distinct branch for.
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts/merge-token-payload.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TOKENS_SUMMARY_OUT: "tokens-block.json", PAYLOAD_IN: "payload.json" },
  });
  assert.equal(run.status, 0, `the CLI must exit 0 on a normal no-block run: ${run.stderr}`);

  // Lifted verbatim from the workflow rather than re-typed here — a re-typed copy
  // would keep agreeing with itself after the YAML changed.
  const extractor = /verdict=\$\(printf '%s\\n' "\$merge_log" \| (sed -n 's[^']*'[^)]*)\)/.exec(postStep());
  assert.ok(extractor, "the POST step no longer extracts a verdict from the merge log");
  const extracted = spawnSync("bash", ["-c", `printf '%s\\n' "$1" | ${extractor[1]}`, "bash", run.stdout], {
    encoding: "utf8",
  });
  assert.equal(
    extracted.stdout.trim(),
    "block_missing",
    `the workflow's extractor read "${extracted.stdout.trim()}" out of the CLI's actual output:\n${run.stdout}`,
  );
});

test("the POST step judges the ingest by its body, not by HTTP 200 alone", () => {
  // #1253 review, finding 2: the platform's token ingest is diagnostic on its own
  // side and never fails the request, so a rejected or partially-lost block comes
  // back inside a 200. The contract is quality-platform's `tokenFields`.
  const body = postStep();
  for (const field of ["tokens_status", "tokens_dropped"]) {
    assert.ok(body.includes(field), `the step must read ${field} from the response body`);
  }
  assert.match(body, /ingested/, "the only success is tokens_status=ingested");
  assert.ok(
    /absent/.test(body),
    "a body with no tokens_status must be reported as unverifiable, not silently accepted",
  );
});

test("resolveTargetProvider is pure and reports its own verdict", () => {
  assert.deepEqual(resolveTargetProvider(["anthropic", "anthropic"]), { provider: "anthropic", conflict: [] });
  assert.deepEqual(resolveTargetProvider([]), { provider: null, conflict: [] });
  assert.deepEqual(resolveTargetProvider(["", "  "]), { provider: null, conflict: [] });
  assert.deepEqual(resolveTargetProvider(["google", "anthropic", "google"]), {
    provider: null,
    conflict: ["anthropic", "google"],
  });
});
