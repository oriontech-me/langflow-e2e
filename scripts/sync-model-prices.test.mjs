// Unit tests for the model-price sync (issue #1217).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPricePayload,
  resolveSyncEndpoint,
  syncModelPrices,
  FLAT_SINCE,
} from "./sync-model-prices.mjs";

const SHA = "abc1234def";
const flat = (over = {}) => ({ provider: "openai", inputPerMillion: 1, outputPerMillion: 2, ...over });

// ── buildPricePayload ────────────────────────────────────────────────────

test("buildPricePayload emits the platform's own field names", () => {
  const { repo_commit_sha, prices } = buildPricePayload({ "gpt-4o": flat() }, { repoCommitSha: SHA });
  assert.equal(repo_commit_sha, SHA);
  assert.deepEqual(prices, [{
    price_key: "gpt-4o",
    since: FLAT_SINCE,
    provider: "openai",
    input_per_million: 1,
    output_per_million: 2,
  }]);
});

test("buildPricePayload skips the file's own top-level _comment", () => {
  const { prices } = buildPricePayload(
    { _comment: "not a model", "gpt-4o": flat() },
    { repoCommitSha: SHA },
  );
  assert.equal(prices.length, 1);
  assert.equal(prices[0].price_key, "gpt-4o");
});

test("buildPricePayload gives a flat entry the floor and a dated band its own since", () => {
  // The one translation this script makes: "always effective" here has no
  // representation in a `since date NOT NULL` column, so it becomes the floor.
  const { prices } = buildPricePayload({
    "gpt-4o": flat(),
    "claude-sonnet-5": [
      { provider: "anthropic", since: "2026-01-01", inputPerMillion: 2, outputPerMillion: 10 },
      { provider: "anthropic", since: "2026-09-01", inputPerMillion: 3, outputPerMillion: 15 },
    ],
  }, { repoCommitSha: SHA });
  assert.deepEqual(
    prices.map(r => `${r.price_key}@${r.since}`),
    ["gpt-4o@2026-08-01", "claude-sonnet-5@2026-01-01", "claude-sonnet-5@2026-09-01"],
  );
});

test("buildPricePayload carries a band's _comment through as note", () => {
  const { prices } = buildPricePayload(
    { "gpt-4o": flat({ _comment: "sourced 2026-07-31" }) },
    { repoCommitSha: SHA },
  );
  assert.equal(prices[0].note, "sourced 2026-07-31");
});

test("buildPricePayload omits note entirely when there is no comment", () => {
  // Not an empty string: the column is nullable and an empty note is a claim
  // that provenance was recorded.
  const { prices } = buildPricePayload({ "gpt-4o": flat() }, { repoCommitSha: SHA });
  assert.equal("note" in prices[0], false);
});

test("buildPricePayload refuses a missing provider, naming the model", () => {
  assert.throws(
    () => buildPricePayload({ "gemini-3.5-flash": { inputPerMillion: 1, outputPerMillion: 2 } }, { repoCommitSha: SHA }),
    /gemini-3\.5-flash: every entry .* needs an explicit "provider"/s,
  );
});

test("buildPricePayload refuses a blank provider", () => {
  assert.throws(
    () => buildPricePayload({ "gpt-4o": flat({ provider: "  " }) }, { repoCommitSha: SHA }),
    /gpt-4o: every entry/,
  );
});

test("buildPricePayload refuses a non-numeric or negative rate", () => {
  assert.throws(
    () => buildPricePayload({ "gpt-4o": flat({ inputPerMillion: "cheap" }) }, { repoCommitSha: SHA }),
    /gpt-4o: inputPerMillion/,
  );
  assert.throws(
    () => buildPricePayload({ "gpt-4o": flat({ outputPerMillion: -1 }) }, { repoCommitSha: SHA }),
    /gpt-4o: inputPerMillion/,
  );
});

test("buildPricePayload refuses a since on a FLAT entry", () => {
  // This repo's reader ignores it (flat means always); the sync would honour it.
  // One field, two readers, two meanings -- exactly the drift this rejects.
  assert.throws(
    () => buildPricePayload({ "gpt-4o": flat({ since: "2026-05-01" }) }, { repoCommitSha: SHA }),
    /gpt-4o: a flat entry must NOT carry "since"/,
  );
});

test("buildPricePayload refuses a dated band with a malformed since", () => {
  assert.throws(
    () => buildPricePayload(
      { "claude-sonnet-5": [{ provider: "anthropic", since: "Jan 2026", inputPerMillion: 2, outputPerMillion: 10 }] },
      { repoCommitSha: SHA },
    ),
    /claude-sonnet-5: a dated band needs since as YYYY-MM-DD/,
  );
  // And never silently falls back to the floor, which would move a corrected
  // rate back over runs it never priced.
  assert.throws(
    () => buildPricePayload(
      { "claude-sonnet-5": [{ provider: "anthropic", inputPerMillion: 2, outputPerMillion: 10 }] },
      { repoCommitSha: SHA },
    ),
    /a dated band needs since/,
  );
});

test("buildPricePayload refuses two bands sharing a since", () => {
  // (price_key, since) is the platform table's PRIMARY KEY.
  assert.throws(
    () => buildPricePayload({
      "claude-sonnet-5": [
        { provider: "anthropic", since: "2026-01-01", inputPerMillion: 2, outputPerMillion: 10 },
        { provider: "anthropic", since: "2026-01-01", inputPerMillion: 3, outputPerMillion: 15 },
      ],
    }, { repoCommitSha: SHA }),
    /two bands share since=2026-01-01/,
  );
});

test("buildPricePayload refuses a zero-row payload", () => {
  // Replacing the dimension with nothing makes every model unpriced and every
  // run read as costing nothing. A dashboard of zeros looks like good news.
  assert.throws(() => buildPricePayload({ _comment: "only a comment" }, { repoCommitSha: SHA }),
    /refusing to build a zero-row payload/);
  assert.throws(() => buildPricePayload({}, { repoCommitSha: SHA }), /zero-row/);
});

test("buildPricePayload requires a commit sha and a well-formed floor", () => {
  assert.throws(() => buildPricePayload({ "gpt-4o": flat() }, {}), /repoCommitSha is required/);
  assert.throws(() => buildPricePayload({ "gpt-4o": flat() }, { repoCommitSha: "  " }), /repoCommitSha is required/);
  assert.throws(
    () => buildPricePayload({ "gpt-4o": flat() }, { repoCommitSha: SHA, flatSince: "August" }),
    /flatSince must be YYYY-MM-DD/,
  );
});

// ── the committed price file ─────────────────────────────────────────────

test("the real model-prices.json is syncable", () => {
  // THE TEST THAT MATTERS. The gap this whole script exists to close was not a
  // bug in code -- it was a model priced here and absent there. This asserts the
  // committed file can actually be projected, so an entry added without a
  // provider fails here instead of on the platform, months later, as a floor.
  const raw = JSON.parse(readFileSync("scripts/lib/model-prices.json", "utf8"));
  const { prices } = buildPricePayload(raw, { repoCommitSha: SHA });
  assert.ok(prices.length >= 12, `expected every model to project, got ${prices.length}`);

  const haiku = prices.filter(r => r.price_key === "claude-haiku-4-5");
  assert.equal(haiku.length, 1, "claude-haiku-4-5 must project — its absence is the gap that started this");
  assert.equal(haiku[0].provider, "anthropic");

  for (const r of prices) {
    assert.match(r.since, /^\d{4}-\d{2}-\d{2}$/, `${r.price_key}: since`);
    assert.ok(["openai", "anthropic", "google"].includes(r.provider), `${r.price_key}: provider ${r.provider}`);
  }
});

test("FLAT_SINCE predates the first run that ever reported tokens", () => {
  // 2026-08-03 is the earliest line in reports/token-history.jsonl. A floor later
  // than that would UNPRICE a run the platform already holds, while this repo
  // kept pricing it -- two dollar figures for one run, the platform's a floor.
  assert.ok(FLAT_SINCE < "2026-08-03", `FLAT_SINCE ${FLAT_SINCE} must be before 2026-08-03`);
});

// ── resolveSyncEndpoint ──────────────────────────────────────────────────

test("resolveSyncEndpoint derives the sync URL from the run-ingest one", () => {
  assert.equal(
    resolveSyncEndpoint({ QA_PLATFORM_ENDPOINT: "https://kong.example/functions/v1/e2e-automation-runs-create" }),
    "https://kong.example/functions/v1/e2e-model-prices-sync",
  );
});

test("resolveSyncEndpoint prefers an explicit override", () => {
  assert.equal(
    resolveSyncEndpoint({
      QA_MODEL_PRICES_ENDPOINT: "https://other.example/hook",
      QA_PLATFORM_ENDPOINT: "https://kong.example/functions/v1/e2e-automation-runs-create",
    }),
    "https://other.example/hook",
  );
});

test("resolveSyncEndpoint is null when neither is set", () => {
  assert.equal(resolveSyncEndpoint({}), null);
});

// ── syncModelPrices ─────────────────────────────────────────────────────

const FILE = JSON.stringify({ "gpt-4o": { provider: "openai", inputPerMillion: 1, outputPerMillion: 2 } });
const okFetch = () => ({ ok: true, status: 200, text: async () => '{"installed":1}' });

test("syncModelPrices skips when it cannot say which commit it reflects", async () => {
  let fetched = false;
  const res = await syncModelPrices({
    env: {}, readFile: () => FILE, fetchImpl: () => { fetched = true; return okFetch(); }, log: () => {},
  });
  assert.deepEqual(res, { posted: false, reason: "no commit sha" });
  assert.equal(fetched, false);
});

test("syncModelPrices validates the file even with no credentials configured", async () => {
  // Deliberate: a malformed price file must fail on every lane, not only the one
  // that can post. This is the lane a PR runs on.
  const logged = [];
  await assert.rejects(
    () => syncModelPrices({
      env: { GITHUB_SHA: SHA },
      readFile: () => JSON.stringify({ "gpt-4o": { inputPerMillion: 1, outputPerMillion: 2 } }),
      fetchImpl: okFetch,
      log: (m) => logged.push(m),
    }),
    /needs an explicit "provider"/,
  );
});

test("syncModelPrices builds but does not post when unconfigured", async () => {
  let fetched = false;
  const logged = [];
  const res = await syncModelPrices({
    env: { GITHUB_SHA: SHA },
    readFile: () => FILE,
    fetchImpl: () => { fetched = true; return okFetch(); },
    log: (m) => logged.push(m),
  });
  assert.equal(res.posted, false);
  assert.equal(res.reason, "not configured");
  assert.equal(res.payload.prices.length, 1);
  assert.equal(fetched, false, "must not post without a token");
  assert.ok(logged.some(m => /not configured/.test(m)), "the skip must be logged, never silent");
});

test("syncModelPrices posts the payload with a bearer token", async () => {
  let seen = null;
  const res = await syncModelPrices({
    env: {
      GITHUB_SHA: SHA,
      QA_MODEL_PRICES_ENDPOINT: "https://x.example/sync",
      QA_E2E_MODEL_PRICES_TOKEN: "s3cret",
    },
    readFile: () => FILE,
    fetchImpl: (url, init) => { seen = { url, init }; return okFetch(); },
    log: () => {},
  });
  assert.equal(res.posted, true);
  assert.equal(seen.url, "https://x.example/sync");
  assert.equal(seen.init.headers.Authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(seen.init.body).prices[0].price_key, "gpt-4o");
});

test("a rejected sync warns and never throws", async () => {
  // Telemetry plumbing: a platform outage must not turn into a red suite. The
  // ::warning:: is the signal, and the price table stays as it was.
  const logged = [];
  const res = await syncModelPrices({
    env: {
      GITHUB_SHA: SHA,
      QA_MODEL_PRICES_ENDPOINT: "https://x.example/sync",
      QA_E2E_MODEL_PRICES_TOKEN: "s3cret",
    },
    readFile: () => FILE,
    fetchImpl: () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
    log: (m) => logged.push(m),
  });
  assert.equal(res.posted, false);
  assert.equal(res.reason, "http 401");
  assert.ok(logged.some(m => /::warning::/.test(m) && /401/.test(m)));
});
