// Unit tests for the token payload merge (issue #1217 §5.2).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTokenPayload, resolveTargetProvider } from "./merge-token-payload.mjs";

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

test("resolveTargetProvider is pure and reports its own verdict", () => {
  assert.deepEqual(resolveTargetProvider(["anthropic", "anthropic"]), { provider: "anthropic", conflict: [] });
  assert.deepEqual(resolveTargetProvider([]), { provider: null, conflict: [] });
  assert.deepEqual(resolveTargetProvider(["", "  "]), { provider: null, conflict: [] });
  assert.deepEqual(resolveTargetProvider(["google", "anthropic", "google"]), {
    provider: null,
    conflict: ["anthropic", "google"],
  });
});
