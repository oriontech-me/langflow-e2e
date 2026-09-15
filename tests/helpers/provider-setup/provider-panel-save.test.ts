// Unit tests for the provider panel Save reader (issue #1849).
// Run with: npm run test:units
//
// Four provider specs awaited `Promise.all([validate, persist])` and read the
// validate-provider body afterwards. The panel issues no credential write after a
// refusal, so that shape settled only when the persistence waiter timed out, and the
// refusal's reason was discarded. What is pinned here:
//
//  - a refusal fails `validated()` immediately, while the write waiter is still pending;
//  - both waiters are armed before the click, so a write that lands before the caller
//    reads it is not lost by reading in order;
//  - every missing request is named — validate-provider vs the write — instead of a bare
//    `waitForResponse` timeout;
//  - the waiter the caller never reads cannot reject unobserved when the page closes;
//  - the verdict is judged on the body, and an unreadable body is never reported as a
//    refusal (#1012).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { armProviderSave, validateProviderFailure } from "./provider-panel-save";
import { UNREADABLE_VARIABLE_WRITE_BODY } from "./variable-write-refusal";

// ---------------------------------------------------------------------------
// A page that delivers responses on demand
// ---------------------------------------------------------------------------

interface FakeResponse {
  url(): string;
  request(): { method(): string };
  status(): number;
  text(): Promise<string>;
}

function response(method: string, url: string, status: number, body: string): FakeResponse {
  return {
    url: () => url,
    request: () => ({ method: () => method }),
    status: () => status,
    text: async () => body,
  };
}

interface Waiter {
  predicate: (r: FakeResponse) => boolean;
  resolve: (r: FakeResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function fakePage() {
  const waiters: Waiter[] = [];
  const drop = (w: Waiter) => {
    clearTimeout(w.timer);
    waiters.splice(waiters.indexOf(w), 1);
  };
  const page = {
    waitForResponse(predicate: (r: FakeResponse) => boolean, options: { timeout: number }) {
      return new Promise<FakeResponse>((resolve, reject) => {
        const waiter: Waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            drop(waiter);
            reject(
              new Error(
                `page.waitForResponse: Timeout ${options.timeout}ms exceeded while waiting for event "response"`,
              ),
            );
          }, options.timeout),
        };
        waiters.push(waiter);
      });
    },
  };
  return {
    page: page as unknown as Page,
    /** Delivers a response to every armed waiter whose predicate matches it. */
    emit(r: FakeResponse) {
      for (const w of [...waiters]) {
        if (w.predicate(r)) {
          drop(w);
          w.resolve(r);
        }
      }
    },
    /** What Playwright does to pending waiters when the test ends and the page closes. */
    close() {
      for (const w of [...waiters]) {
        drop(w);
        w.reject(new Error("page.waitForResponse: Target page, context or browser has been closed"));
      }
    },
  };
}

const BASE = "http://localhost:7860";
const validateAnswer = (body: object) =>
  response("POST", `${BASE}/api/v1/models/validate-provider`, 200, JSON.stringify(body));
const variableCreate = () =>
  response("POST", `${BASE}/api/v1/variables/`, 201, JSON.stringify({ id: "v1" }));

/** Records unhandled rejections for the duration of `body`. */
async function collectUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    // Node reports an unhandled rejection only after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// armProviderSave
// ---------------------------------------------------------------------------

test("a refusal fails validated() at once, naming the provider's reason, while the write is still pending", async () => {
  const fake = fakePage();
  const unhandled = await collectUnhandledRejections(async () => {
    // A 60 s write budget, as the ollama spec uses: the shape this replaces waited all of it.
    const save = armProviderSave(fake.page, { subject: "key", timeout: 60000 });
    fake.emit(validateAnswer({ valid: false, error: "Invalid API key for OpenAI" }));

    const startedAt = Date.now();
    await assert.rejects(save.validated(), {
      message: "validate-provider rejected the key: Invalid API key for OpenAI",
    });
    assert.ok(Date.now() - startedAt < 1000, "validated() must not wait for the write waiter");

    // The test ends here and the page closes under the write waiter nobody read.
    fake.close();
  });
  assert.deepEqual(unhandled, []);
});

test("an accepted Save reads the verdict first and still returns a write that already landed", async () => {
  const fake = fakePage();
  const save = armProviderSave(fake.page, { subject: "base URL", timeout: 60000 });
  // Both answers arrive before the caller reads either: reading in order must lose neither.
  const verdict = validateAnswer({ valid: true, error: null });
  const write = variableCreate();
  fake.emit(verdict);
  fake.emit(write);

  assert.equal(await save.validated(), verdict);
  assert.equal(await save.persisted(), write);
});

test("a Save that issues no validate-provider call names that request, not the write", async () => {
  const fake = fakePage();
  const save = armProviderSave(fake.page, { subject: "base URL", timeout: 20, persistTimeout: 60000 });
  await assert.rejects(save.validated(), (error: Error) => {
    assert.match(
      error.message,
      /^the Save issued no POST \/api\/v1\/models\/validate-provider for the base URL within 0\.02 s: page\.waitForResponse: Timeout 20ms exceeded/,
    );
    return true;
  });
  fake.close();
});

test("an accepted Save with no credential write names the missing write", async () => {
  const fake = fakePage();
  const save = armProviderSave(fake.page, { subject: "credentials", timeout: 60000, persistTimeout: 20 });
  fake.emit(validateAnswer({ valid: true }));
  await save.validated();
  await assert.rejects(save.persisted(), (error: Error) => {
    assert.match(
      error.message,
      /^no POST\/PATCH \/api\/v1\/variables\/ followed the Save of the credentials within 0\.02 s: /,
    );
    return true;
  });
  fake.close();
});

test("the verdict is matched on the pathname, so a query string cannot hide it", async () => {
  const fake = fakePage();
  const save = armProviderSave(fake.page, { subject: "key", timeout: 60000 });
  // Neither of these is the verdict: a different endpoint, and a GET.
  fake.emit(response("POST", `${BASE}/api/v1/models/validate-provider-status`, 200, '{"valid":false}'));
  fake.emit(response("GET", `${BASE}/api/v1/models/validate-provider`, 200, '{"valid":false}'));
  const verdict = response(
    "POST",
    `${BASE}/api/v1/models/validate-provider?source=panel`,
    200,
    '{"valid":true,"error":null}',
  );
  fake.emit(verdict);
  assert.equal(await save.validated(), verdict);
  fake.close();
});

test("a click that throws before either request leaves no unhandled rejection behind", async () => {
  const fake = fakePage();
  const unhandled = await collectUnhandledRejections(async () => {
    armProviderSave(fake.page, { subject: "key", timeout: 60000 });
    fake.close();
  });
  assert.deepEqual(unhandled, []);
});

// ---------------------------------------------------------------------------
// validateProviderFailure
// ---------------------------------------------------------------------------

test("a 200 carrying valid: true is the only acceptance", () => {
  assert.equal(validateProviderFailure("key", 200, '{"valid":true,"error":null}'), null);
  assert.equal(validateProviderFailure("key", 200, '{"valid":true}'), null);
});

test("a refusal carries the provider's own reason", () => {
  assert.equal(
    validateProviderFailure(
      "base URL",
      200,
      '{"valid":false,"error":"Access to IP address 169.254.169.254 is blocked by SSRF protection."}',
    ),
    "validate-provider rejected the base URL: Access to IP address 169.254.169.254 is blocked by SSRF protection.",
  );
});

test("a refusal without a reason still says it was a refusal", () => {
  assert.equal(
    validateProviderFailure("key", 200, '{"valid":false,"error":null}'),
    "validate-provider rejected the key: no reason given",
  );
  assert.equal(
    validateProviderFailure("key", 200, '{"valid":false,"error":"  "}'),
    "validate-provider rejected the key: no reason given",
  );
});

test("a non-200 answer is reported with its status and body, never read as a verdict", () => {
  // `{"valid": true}` under a 500 is not an acceptance.
  assert.equal(
    validateProviderFailure("key", 500, '{"valid":true}'),
    'validate-provider answered HTTP 500 for the key: {"valid":true}',
  );
  assert.equal(
    validateProviderFailure("key", 422, ""),
    "validate-provider answered HTTP 422 for the key: <empty body>",
  );
});

test("a body that cannot be judged is reported as such, not as a refusal (#1012)", () => {
  assert.equal(
    validateProviderFailure("key", 200, UNREADABLE_VARIABLE_WRITE_BODY),
    "validate-provider answered HTTP 200 for the key, and its body could not be read",
  );
  assert.equal(
    validateProviderFailure("key", 200, "<html>gateway</html>"),
    "validate-provider answered the key with a body that is not JSON: <html>gateway</html>",
  );
  assert.equal(
    validateProviderFailure("key", 200, '{"valid":"true"}'),
    'validate-provider answered the key with no boolean `valid`: {"valid":"true"}',
  );
  assert.equal(
    validateProviderFailure("key", 200, "null"),
    "validate-provider answered the key with no boolean `valid`: null",
  );
});
