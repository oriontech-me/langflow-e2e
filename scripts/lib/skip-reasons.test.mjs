import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_REASON_MAX, classifySkipAnnotations, collectSkips } from "./skip-reasons.mjs";
import { formatProviderInactiveReason, formatProviderStaleReason } from "./provider-health-reason.mjs";

const FILE = "tests-automations/regression/core-functionality/model-provider/anthropic-provider.spec.ts";

const passed = () => ({ status: "expected", annotations: [], results: [{ status: "passed", duration: 900 }] });
const failed = () => ({ status: "unexpected", annotations: [], results: [{ status: "failed", duration: 900 }] });
// The shape run 36730351768 recorded for anthropic-provider.spec.ts:301 — skipped on
// every attempt, no annotation anywhere, 0 ms.
const cascaded = () => ({
  status: "skipped",
  annotations: [],
  results: [0, 1, 2].map((retry) => ({ status: "skipped", retry, annotations: [], duration: 0 })),
});
const skippedWith = (...annotations) => ({ status: "skipped", annotations, results: [{ status: "skipped", duration: 0 }] });

const spec = (line, title, t) => ({ title, file: FILE, line, tests: [t] });

function report(...suites) {
  return { suites: [{ title: FILE, file: FILE, specs: [], suites }] };
}

test("a serial cascade is attributed to the nearest EARLIER failure of its own group (#2125)", () => {
  const rep = report({
    title: "Anthropic Provider",
    file: FILE,
    specs: [
      spec(150, "is configured via Settings", passed()),
      spec(200, "an earlier failure that is not the nearest", failed()),
      spec(267, "configured Anthropic selects a Claude model in the Agent and executes the flow", failed()),
      spec(301, "switches between Claude model families (Haiku → Sonnet → Opus)", cascaded()),
      spec(340, "a LATER failure cannot have caused it", failed()),
    ],
  });
  assert.deepEqual(collectSkips(rep), [{
    file: FILE,
    line: 301,
    test: "switches between Claude model families (Haiku → Sonnet → Opus)",
    kind: "serial-cascade",
    caused_by: { line: 267, test: "configured Anthropic selects a Claude model in the Agent and executes the flow" },
  }]);
});

test("a cascade never crosses into another describe — e.g. another provider variant", () => {
  const rep = report(
    { title: "Agent max_tokens [openai / gpt-4o-mini]", file: FILE, specs: [spec(290, "caps", failed())] },
    { title: "Agent max_tokens [google / gemini-3.5-flash]", file: FILE, specs: [spec(290, "caps", passed()), spec(318, "causal control", cascaded())] },
  );
  const [skip] = collectSkips(rep);
  assert.equal(skip.param, "google / gemini-3.5-flash");
  assert.equal(skip.kind, "unannotated", "the openai variant's failure is not this group's cause");
  assert.equal(skip.reason, null);
  assert.equal(skip.caused_by, undefined);
});

test("a provider-health skip records provider, stale flag and the reason, through the shared parser", () => {
  const stale = formatProviderStaleReason("openai", "2026-09-28T19:08:57.313Z", 12);
  const inactive = formatProviderInactiveReason("anthropic", "credit balance is too low");
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "skip", description: stale })),
    { kind: "provider-health", reason: stale, provider: "openai", stale: true });
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "skip", description: inactive })),
    { kind: "provider-health", reason: inactive, provider: "anthropic", stale: false });
});

test("provider health wins over an earlier, ordinary annotation on the same test", () => {
  const t = skippedWith(
    { type: "skip", description: "MODEL_NOT_AVAILABLE" },
    { type: "skip", description: formatProviderInactiveReason("google", "quota") },
  );
  assert.equal(classifySkipAnnotations(t).kind, "provider-health");
});

test("annotated, fixme and bare skips each keep their own kind", () => {
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "skip", description: "pin resolves OpenAI models only" })),
    { kind: "annotated", reason: "pin resolves OpenAI models only" });
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "fixme", description: "LE-1234" })),
    { kind: "fixme", reason: "LE-1234" });
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "fixme" })), { kind: "fixme", reason: null });
  assert.deepEqual(classifySkipAnnotations(skippedWith({ type: "skip" })), { kind: "unannotated", reason: null },
    "a bare test.skip() has an annotation but no reason — not an empty-string reason");
  assert.equal(classifySkipAnnotations(cascaded()), null, "no annotation at all is the cascade candidate");
});

test("an annotated skip is never re-labelled a cascade, even after a failure in its group", () => {
  const rep = report({
    title: "G", file: FILE,
    specs: [spec(10, "fails", failed()), spec(20, "gated", skippedWith({ type: "skip", description: "needs a key" }))],
  });
  assert.equal(collectSkips(rep)[0].kind, "annotated");
});

test("a long reason is capped, and only skipped tests are listed", () => {
  const long = "x".repeat(SKIP_REASON_MAX + 50);
  const rep = report({
    title: "G", file: FILE,
    specs: [spec(10, "runs", passed()), spec(20, "gated", skippedWith({ type: "skip", description: long }))],
  });
  const skips = collectSkips(rep);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason.length, SKIP_REASON_MAX);
  assert.ok(skips[0].reason.endsWith("…"));
});

test("a report with nothing skipped yields an empty list, and a malformed one does not throw", () => {
  assert.deepEqual(collectSkips(report({ title: "G", file: FILE, specs: [spec(10, "runs", passed())] })), []);
  assert.deepEqual(collectSkips({}), []);
  assert.deepEqual(collectSkips(null), []);
  assert.deepEqual(collectSkips({ suites: [{ specs: [{ title: "t", tests: [null] }] }] }), []);
});
