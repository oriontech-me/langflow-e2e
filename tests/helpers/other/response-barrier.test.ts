// Unit tests for the response barrier's attribution message (issue #1713).
// Run with: npm run test:units
//
// What rides on this function: whether a red daily gets triaged as an outage or
// as a product regression.
//
// On the 2026-09-04 daily (run 33873006780) two @stable auth tests flaked in
// different shards with a byte-identical signature,
//
//   TimeoutError: page.waitForResponse: Timeout 30000ms exceeded while waiting
//   for event "response"
//
// produced by the same `waitForResponse` in `helpers/auth/sign-in-through-form.ts`.
// That string cannot tell apart the only two states that produce it: a backend
// that accepted `POST /api/v1/login` and never answered, or a login form that
// stopped issuing it — the second being a product regression. Both history rows
// carry `infra_signature: null` for exactly that reason, and the same test had
// already flaked under the same string on 2026-08-26.
//
// Measured on nightly 1.13.0.dev2 by docker-pausing the container (connections
// accepted, never answered — the gunicorn wedge shape): the frontend DID issue
// the POST, it was never aborted (the bundle configures no client-side request
// timeout), no response ever arrived, and a probe taken WHILE still wedged
// returned `apiRequestContext.get: Timeout 5000ms exceeded.` So the two states
// are distinguishable at the call site even though the Playwright string is not,
// which is the same argument `page-entry-barrier.ts` records for
// `locator.waitFor: Timeout`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import { INFRA_PREFIX, PROBE_PATH } from "./page-entry-barrier";
import {
  REQUEST_SURFACE,
  responseBarrierMessage,
  waitForAttributedResponse,
} from "./response-barrier";

const CAUSE =
  'TimeoutError: page.waitForResponse: Timeout 30000ms exceeded while waiting for event "response"';

const OBSERVABLE = "POST /api/v1/login";

const WEDGED = {
  state: "unreachable" as const,
  ms: 5019,
  url: "http://localhost:7860/api/v1/version",
  detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
};

test("a wedged backend is named as the cause, with the infra prefix", () => {
  const msg = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: WEDGED,
    cause: CAUSE,
    surface: "login",
  });

  assert.ok(
    msg.startsWith(INFRA_PREFIX),
    `expected the infra prefix so triage can classify it, got: ${msg}`,
  );
  assert.match(msg, /POST \/api\/v1\/login/);
  assert.match(msg, /did not answer within 30000ms/);
  assert.match(msg, new RegExp(`did not answer GET ${PROBE_PATH.replace(/\//g, "\\/")}`));
  assert.match(msg, /apiRequestContext\.get: Timeout 5000ms exceeded\./);
  // Playwright's transport errors already end in a period; the sentence must not
  // add a second one, which is what the entry barrier's template does today.
  assert.ok(!msg.includes(".."), `double period in: ${msg}`);
  // The surface names WHICH wait failed, so a reader does not have to decode the
  // predicate — #1265's flake was mis-triaged because the message named neither.
  assert.match(msg, /login barrier/);
  assert.ok(msg.includes(CAUSE), "the original Playwright error must survive");
});

test("the wedged message is what the REAL classifier already exempts", () => {
  // The load-bearing claim of this fix: no new entry on
  // scripts/lib/infra-signature-patterns.json. It works because the message
  // embeds the probe's own transport error, which `api-request-timeout` matches.
  const wedged = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: WEDGED,
    cause: CAUSE,
    surface: "login",
  });
  assert.equal(classifyInfraError(wedged)?.id, "api-request-timeout");

  // And the bare string this replaces is unclassifiable — which is the defect,
  // not an omission: a frontend that stops issuing the request emits it too, so
  // it must NEVER be added to the pattern list.
  assert.equal(classifyInfraError(CAUSE), null);
});

test("a backend that is up but failing to serve is still not the app's fault", () => {
  const msg = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: {
      state: "http_error",
      ms: 42,
      url: "http://localhost:7860/api/v1/version",
      status: 502,
    },
    cause: CAUSE,
    surface: "login",
  });
  assert.ok(msg.startsWith(INFRA_PREFIX));
  assert.match(msg, /HTTP 502/);
});

test("a HEALTHY probe deliberately gets no infra prefix", () => {
  // The half that keeps the fix honest. A backend that answers while the request
  // goes unanswered is the product-regression shape the issue directive named
  // first — a login form that stopped sending the POST. Prefixing it would
  // exempt a real regression from @stable auto-removal.
  const msg = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: {
      state: "healthy",
      ms: 31,
      url: "http://localhost:7860/api/v1/version",
      status: 200,
    },
    cause: CAUSE,
    surface: "login",
  });
  assert.ok(
    !msg.startsWith(INFRA_PREFIX),
    `a healthy backend must NOT be reported as unreachable, got: ${msg}`,
  );
  assert.match(msg, /IS a product\/UI failure/);
  assert.equal(classifyInfraError(msg), null);
});

test("a probe that could not run reads UNKNOWN, never healthy", () => {
  const msg = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: {
      state: "unknown",
      ms: 3,
      url: "http://localhost:7860/api/v1/version",
      detail: "probe could not run: Target page, context or browser has been closed",
    },
    cause: CAUSE,
  });
  assert.ok(!msg.startsWith(INFRA_PREFIX));
  assert.match(msg, /UNKNOWN/);
  assert.match(msg, /Do not read this as a healthy backend/);
  assert.equal(classifyInfraError(msg), null);
});

test("the default surface is generic, so a caller that names none still reads", () => {
  const msg = responseBarrierMessage({
    observable: OBSERVABLE,
    timeoutMs: 30000,
    probe: WEDGED,
    cause: CAUSE,
  });
  assert.match(msg, new RegExp(`${REQUEST_SURFACE} barrier`));
});

// --- the wrapper -----------------------------------------------------------

function fakePage(waitForResponse: () => Promise<any>, probeResult?: () => Promise<any>) {
  return {
    url: () => "http://localhost:7860/flows",
    waitForResponse,
    request: {
      get: probeResult ?? (async () => ({ ok: () => true, status: () => 200 })),
    },
  } as any;
}

test("the wait is REGISTERED synchronously, before the caller acts", async () => {
  // Load-bearing: the helper registers the wait and only then clicks Sign In, so
  // the status read cannot race the navigation a 200 triggers. A wrapper that
  // deferred registration to the first await would reopen that race silently.
  let registered = false;
  const page = fakePage(() => {
    registered = true;
    return Promise.resolve("response-object");
  });

  const pending = waitForAttributedResponse(page, () => true, {
    observable: OBSERVABLE,
    timeoutMs: 30000,
  });
  assert.equal(registered, true, "waitForResponse must be called synchronously");
  assert.equal(await pending, "response-object");
});

test("a successful wait resolves untouched and never probes", async () => {
  let probed = 0;
  const page = fakePage(
    () => Promise.resolve("response-object"),
    async () => {
      probed += 1;
      return { ok: () => true, status: () => 200 };
    },
  );
  assert.equal(
    await waitForAttributedResponse(page, () => true, {
      observable: OBSERVABLE,
      timeoutMs: 30000,
    }),
    "response-object",
  );
  assert.equal(probed, 0, "a green wait must not pay for a liveness probe");
});

test("the timeout is passed through unchanged — attribution never widens the budget", async () => {
  let seen: number | undefined;
  const page = fakePage((..._args: any[]) => Promise.resolve("ok"));
  const spy = (predicate: any, options: any) => {
    seen = options?.timeout;
    return Promise.resolve("ok");
  };
  (page as any).waitForResponse = spy;
  await waitForAttributedResponse(page, () => true, {
    observable: OBSERVABLE,
    timeoutMs: 30000,
  });
  assert.equal(seen, 30000);
});

test("a timed-out wait rejects with the ATTRIBUTED message, not the bare one", async () => {
  const page = fakePage(
    () => Promise.reject(new Error(CAUSE)),
    async () => {
      throw new Error("apiRequestContext.get: Timeout 5000ms exceeded.");
    },
  );

  await assert.rejects(
    waitForAttributedResponse(page, () => true, {
      observable: OBSERVABLE,
      timeoutMs: 30000,
      surface: "login",
    }),
    (error: Error) => {
      assert.ok(
        error.message.startsWith(INFRA_PREFIX),
        `expected an attributed failure, got: ${error.message}`,
      );
      assert.equal(classifyInfraError(error.message)?.id, "api-request-timeout");
      assert.ok(error.message.includes(CAUSE));
      return true;
    },
  );
});
