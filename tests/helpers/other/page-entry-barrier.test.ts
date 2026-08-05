// Unit tests for the page-entry barrier's attribution message (issue #1262).
// Run with: npm run test:units
//
// What rides on this function: the triage verdict a human reads off a red daily.
//
// On the 2026-08-04 daily (run 30901311395, shard 4), gunicorn logged
// `WORKER TIMEOUT (pid:37)` at 10:46:42 and SIGKILLed the worker; the backend
// was restarting from 10:47:01 to 10:48:33. Two retries of
// `language-model-regression.spec.ts` ran inside that window and both reported
//
//   TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
//     - waiting for locator('[data-testid="mainpage_title"]') to be visible
//
// which reads as "the app's main page never renders". Triage grouped the test
// into an entry-point cluster (#1262) on the strength of that string, away from
// the provider cluster it actually belonged to — and the same string on
// 2026-07-09/07-14 turned out to be a DIFFERENT observable (`text=built
// successfully`), so the "recurrent, same signature" premise was an artifact of
// the shared Playwright prefix.
//
// The barrier can therefore not just time out: it must say WHICH of the two
// states it observed, and it must never claim a clean backend it did not probe
// (#1012's rule — an unevaluated probe is unknown, not healthy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  entryBarrierMessage,
  INFRA_PREFIX,
  PAGE_ENTRY_SURFACE,
  resolveProbeUrl,
} from "./page-entry-barrier";

const CAUSE =
  "TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.\n" +
  "Call log:\n" +
  '  - waiting for locator(\'[data-testid="mainpage_title"]\') to be visible';

const SELECTOR = '[data-testid="mainpage_title"]';

test("an unreachable backend is named as the cause, with the infra prefix", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: CAUSE,
  });

  assert.ok(
    msg.startsWith(INFRA_PREFIX),
    `expected the infra prefix so triage can classify it, got: ${msg}`,
  );
  assert.match(msg, /did not answer GET \/api\/v1\/version/);
  assert.match(msg, /apiRequestContext\.get: Timeout 5000ms exceeded\./);
  // The barrier that failed must still be identifiable, and the original
  // Playwright error must survive — the trace/screenshot is read against it.
  assert.match(msg, /mainpage_title/);
  assert.match(msg, /page\.waitForSelector: Timeout 30000ms exceeded/);
});

test("a non-2xx answer is reported as an application failure, not as the wedge", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "http_error",
      ms: 42,
      status: 502,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.ok(msg.startsWith(INFRA_PREFIX));
  assert.match(msg, /answered GET \/api\/v1\/version with HTTP 502/);
  // 502 is the backend failing to serve, which is still not this spec's fault —
  // but it must not be described as unreachable, because it answered.
  assert.doesNotMatch(msg, /did not answer/);
});

test("a healthy backend keeps the failure attributed to the UI", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "healthy",
      ms: 21,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  // This is the case where the spec IS the right place to look, so the message
  // must NOT carry the infra prefix — otherwise a genuine entry-point
  // regression would be filed as an outage (and, once the prefix reaches
  // `scripts/lib/infra-signatures.ts`, would stop being quarantined at all).
  assert.ok(
    !msg.startsWith(INFRA_PREFIX),
    `a healthy probe must not be labelled infra, got: ${msg}`,
  );
  assert.match(msg, /answered GET \/api\/v1\/version with HTTP 200/);
  assert.match(msg, /product|UI/i);
});

test("a probe that could not run is reported as unknown, never as healthy", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "unknown",
      ms: 0,
      url: "http://localhost:7860/api/v1/version",
      detail: "probe threw: browser closed",
    },
    cause: CAUSE,
  });

  assert.match(msg, /could not be probed/);
  assert.match(msg, /probe threw: browser closed/);
  // Unknown must not be dressed up as either verdict.
  assert.doesNotMatch(msg, /answered GET/);
  assert.ok(
    !msg.startsWith(INFRA_PREFIX),
    "an unproven outage must not claim the infra prefix",
  );
});

test("the message names the barrier's own budget so a raised timeout is visible", () => {
  const msg = entryBarrierMessage({
    selector: '[id="new-project-btn"]',
    timeoutMs: 15000,
    probe: {
      state: "healthy",
      ms: 8,
      status: 200,
      url: "http://langflow:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.match(msg, /15000ms/);
  assert.match(msg, /new-project-btn/);
  assert.match(msg, /http:\/\/langflow:7860/);
});

// --- the `surface` label (#1265) --------------------------------------------
//
// The barrier stopped being home-page-only when the SAME ambiguity cost the same
// mis-triage one navigation later: `modelInputComponent.spec.ts` waited 30s for
// the component sidebar's `sidebar-search-input` with a bare `locator.waitFor`,
// timed out inside two measured shard-2 outages on the 2026-08-04 daily, and was
// filed as a test-local flake about the model selector — the surface the message
// named was neither the sidebar nor the backend.

test("the surface defaults to page-entry, so #1262's callers read identically", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "healthy",
      ms: 9,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.match(msg, new RegExp(`^${PAGE_ENTRY_SURFACE} barrier `));
  // A blank label must not degrade into `" barrier"` — that is worse than the
  // default, because it names nothing while looking deliberate.
  const blank = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    surface: "   ",
    probe: {
      state: "healthy",
      ms: 9,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });
  assert.match(blank, new RegExp(`^${PAGE_ENTRY_SURFACE} barrier `));
});

test("a named surface appears in the barrier line AND in the product verdict", () => {
  const msg = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "healthy",
      ms: 12,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause:
      "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n" +
      "  - waiting for getByTestId('sidebar-search-input') to be visible",
  });

  assert.match(msg, /^component-sidebar barrier "\[data-testid="sidebar-search-input"\]"/);
  // The verdict sentence is the one a reader acts on, so it must name the same
  // surface — "a product/UI failure at the page entry point" is what sent #1265
  // to the wrong cluster.
  assert.match(msg, /failure at the component-sidebar entry point/);
  assert.doesNotMatch(msg, new RegExp(`${PAGE_ENTRY_SURFACE} entry point`));
});

test("attribution is surface-independent: a wedge behind any barrier is infra", () => {
  const msg = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.",
  });

  // This is the whole point of #1265: `locator.waitFor: Timeout` can never join
  // `scripts/lib/infra-signatures.ts` (a real UI regression emits it too), so the
  // prefix is the only route by which a sidebar wait killed by a wedge becomes
  // classifiable — and it must not depend on which barrier reported it.
  assert.ok(
    msg.startsWith(INFRA_PREFIX),
    `a wedge behind a non-page-entry barrier must still be infra, got: ${msg}`,
  );
  assert.match(msg, /component-sidebar barrier/);
});

test("under a wedge the attributed message is classified by the EXISTING infra list", () => {
  // The payoff, asserted against the real classifier rather than described in a
  // comment. `locator.waitFor: Timeout` is not (and must not be) an infra
  // signature, so today's bare message is unclassifiable — the barrier embeds the
  // probe's own transport error, and THAT is what `infra-signatures.ts` already
  // matches. No entry has to be added there for a wedge-killed sidebar wait to
  // stop reading like a broken spec.
  const bare =
    "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.\n" +
    "Call log:\n  - waiting for getByTestId('sidebar-search-input') to be visible";

  assert.equal(
    classifyInfraError(bare),
    null,
    "the bare Playwright message must stay unclassifiable — that is the problem",
  );

  const wedged = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      // What a wedged backend actually produces: it accepts the connection and
      // never answers, so the probe times out (#922/#927).
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: bare,
  });
  assert.equal(classifyInfraError(wedged)?.id, "api-request-timeout");

  // And the healthy case must NOT become classifiable, or a real entry-point
  // regression would be exempted as an outage.
  const healthy = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "healthy",
      ms: 21,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: bare,
  });
  assert.equal(classifyInfraError(healthy), null);
});

test("the probed URL comes from the page's own origin, not from the environment", () => {
  const onLangflow = { url: () => "http://127.0.0.1:7861/flow/abc" } as any;
  const blank = { url: () => "about:blank" } as any;
  const previous = process.env.PLAYWRIGHT_BASE_URL;
  process.env.PLAYWRIGHT_BASE_URL = "http://localhost:7860";
  try {
    // The page IS the authority: a spec driving a Langflow on another port must
    // not be told the one named in the environment answered for it.
    assert.equal(
      resolveProbeUrl(onLangflow),
      "http://127.0.0.1:7861/api/v1/version",
    );
    // No page origin to read (about:blank) ⇒ fall back to the environment.
    assert.equal(resolveProbeUrl(blank), "http://localhost:7860/api/v1/version");
    // An explicit override wins over both (used by the force-fail harness).
    assert.equal(
      resolveProbeUrl(onLangflow, "http://127.0.0.1:9"),
      "http://127.0.0.1:9/api/v1/version",
    );
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
    else process.env.PLAYWRIGHT_BASE_URL = previous;
  }
});
