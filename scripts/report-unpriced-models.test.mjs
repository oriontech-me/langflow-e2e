import test from "node:test";
import assert from "node:assert/strict";

import {
  reportUnpricedModels,
  extractUnpriced,
  renderBody,
  VERDICTS,
} from "./report-unpriced-models.mjs";

/** In-memory io. `appendFile` really appends — GITHUB_OUTPUT is append-only, and
 *  a fake that assigned would hide a step that clobbers an earlier step's
 *  outputs. (The inverse mistake — a fake that appends where the real code
 *  assigns — is what hid a corrupted tokens block for a whole review round.) */
function fakeIo({ files = {} } = {}) {
  const out = { ...files };
  const logs = [];
  return {
    io: {
      readFile: (p) => {
        if (!(p in out)) throw new Error(`ENOENT ${p}`);
        return out[p];
      },
      appendFile: (p, text) => {
        out[p] = (out[p] || "") + text;
      },
      log: (m) => logs.push(String(m)),
    },
    out,
    logs,
  };
}

const BLOCK = "tokens-block.json";
const OUT = "gh-output";

// ── extractUnpriced ──────────────────────────────────────────────────────────

test("extractUnpriced reads the field", () => {
  assert.deepEqual(extractUnpriced({ unpriced_models: ["b", "a"] }),
    { models: ["a", "b"], dropped: 0 });
});

test("extractUnpriced sorts and de-duplicates, so a stable list does not look new each run", () => {
  const { models } = extractUnpriced({ unpriced_models: ["z", "a", "z"] });
  assert.deepEqual(models, ["a", "z"]);
});

test("a block from an older watch-tokens has no field at all — absent is not malformed", () => {
  assert.deepEqual(extractUnpriced({ traces: 3 }), { models: [], dropped: 0 });
});

test("a non-array field is counted as dropped, never silently read as empty", () => {
  // The point of `dropped`: without it a malformed field would report the same
  // as "all priced", which is the absent-vs-zero conflation this whole pipeline
  // exists to refuse.
  assert.deepEqual(extractUnpriced({ unpriced_models: "gpt-5-mini" }),
    { models: [], dropped: 1 });
});

test("junk entries are dropped individually and counted", () => {
  const { models, dropped } = extractUnpriced({ unpriced_models: ["ok", "", null, 7, "  "] });
  assert.deepEqual(models, ["ok"]);
  assert.equal(dropped, 4);
});

// ── renderBody ───────────────────────────────────────────────────────────────

test("the body names the repo-local fix, not just the symptom", () => {
  const body = renderBody(["gpt-5-mini"]);
  assert.match(body, /scripts\/lib\/model-prices\.json/);
  assert.match(body, /sync-model-prices\.yml/);
  // The trap that cost four files across two repositories: a reader must not be
  // sent to hand-insert into the platform's table.
  assert.match(body, /next sync deletes/);
  // And it must say why waiting is expensive, or it reads as cosmetic.
  assert.match(body, /cannot|never/i);
});

test("the body carries the run it was first seen on when the env has it", () => {
  const body = renderBody(["m"], {
    runId: "30920300880",
    runUrl: "https://example.test/run",
    workflow: "daily-stable-manual",
    runDate: "2026-08-04",
  });
  assert.match(body, /30920300880/);
  assert.match(body, /daily-stable-manual/);
  assert.match(body, /2026-08-04/);
});

// ── reportUnpricedModels ─────────────────────────────────────────────────────

test("an unpriced model is reported, annotated, and emitted", () => {
  const { io, out, logs } = fakeIo({
    files: { [BLOCK]: JSON.stringify({ traces: 1, unpriced_models: ["gpt-5-mini"] }) },
  });
  const r = reportUnpricedModels({
    env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT, WORKFLOW: "daily-stable-manual" },
    ...io,
  });
  assert.equal(r.verdict, VERDICTS.UNPRICED);
  assert.deepEqual(r.models, ["gpt-5-mini"]);
  assert.equal(out[OUT].includes("count=1"), true);
  assert.equal(out[OUT].includes("models=gpt-5-mini"), true);
  // The annotation is the floor of the feature: it must exist even if no issue
  // is ever opened.
  assert.ok(logs.some(l => l.startsWith("::warning::") && l.includes("gpt-5-mini")),
    "an unpriced model must produce a ::warning:: annotation");
});

test("the emitted body survives GITHUB_OUTPUT's line-based format", () => {
  const { io, out } = fakeIo({
    files: { [BLOCK]: JSON.stringify({ unpriced_models: ["a", "b"] }) },
  });
  reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT }, ...io });
  // A bare `summary_md=<multiline>` truncates at the first newline; the heredoc
  // form is what keeps the body whole.
  assert.match(out[OUT], /summary_md<<UNPRICED_MD_EOF\n[\s\S]*\nUNPRICED_MD_EOF\n/);
  const body = out[OUT].split("summary_md<<UNPRICED_MD_EOF\n")[1].split("\nUNPRICED_MD_EOF")[0];
  assert.ok(body.split("\n").length > 5, "the body must reach the workflow with its lines intact");
});

test("all models priced emits count=0 and no annotation", () => {
  const { io, out, logs } = fakeIo({
    files: { [BLOCK]: JSON.stringify({ traces: 5, unpriced_models: [] }) },
  });
  const r = reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT }, ...io });
  assert.equal(r.verdict, VERDICTS.ALL_PRICED);
  assert.equal(out[OUT].includes("count=0"), true);
  assert.equal(logs.some(l => l.startsWith("::warning::")), false,
    "a fully priced run must not warn");
});

test("no block at all is NOT an all-clear, and does not warn either", () => {
  // A run that captured nothing has no unpriced models because it has no models.
  // Warning here would cry wolf on every zero-capture run; reporting it as
  // ALL_PRICED in the log would claim something that was never checked.
  const { io, out, logs } = fakeIo();
  const r = reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT }, ...io });
  assert.equal(r.verdict, VERDICTS.NO_BLOCK);
  assert.equal(out[OUT].includes("count=0"), true);
  assert.equal(logs.some(l => l.startsWith("::warning::")), false);
  assert.ok(logs.some(l => l.includes("captured nothing to price")));
});

test("an unparseable block warns that the list is UNKNOWN, not empty", () => {
  const { io, logs } = fakeIo({ files: { [BLOCK]: "{{{" } });
  const r = reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT }, ...io });
  assert.equal(r.verdict, VERDICTS.UNPARSEABLE);
  assert.ok(logs.some(l => l.startsWith("::warning::") && /UNKNOWN, not empty/.test(l)),
    "a lost block must not read as a clean run");
});

test("a malformed field warns that the list is INCOMPLETE", () => {
  const { io, logs } = fakeIo({
    files: { [BLOCK]: JSON.stringify({ unpriced_models: ["real", 42] }) },
  });
  const r = reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK, GITHUB_OUTPUT: OUT }, ...io });
  assert.deepEqual(r.models, ["real"]);
  assert.ok(logs.some(l => l.includes("INCOMPLETE")));
});

test("without GITHUB_OUTPUT it still annotates and does not throw", () => {
  // pr-validation and local runs have no GITHUB_OUTPUT.
  const { io, logs } = fakeIo({
    files: { [BLOCK]: JSON.stringify({ unpriced_models: ["x"] }) },
  });
  const r = reportUnpricedModels({ env: { TOKENS_SUMMARY_OUT: BLOCK }, ...io });
  assert.equal(r.verdict, VERDICTS.UNPRICED);
  assert.ok(logs.some(l => l.startsWith("::warning::")));
});

test("the default block path matches the workflow's TOKENS_SUMMARY_OUT", () => {
  // daily-stable.yml sets TOKENS_SUMMARY_OUT: tokens-block.json on both the
  // summarize step and the POST step. If this default drifts from that name, the
  // reporter reads nothing and reports every run as capturing nothing.
  const { io } = fakeIo({ files: { "tokens-block.json": JSON.stringify({ unpriced_models: ["y"] }) } });
  const r = reportUnpricedModels({ env: { GITHUB_OUTPUT: OUT }, ...io });
  assert.deepEqual(r.models, ["y"]);
});
