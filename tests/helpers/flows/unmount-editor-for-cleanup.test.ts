// Unit tests for the teardown's editor-unmount navigation (issue #1288).
// Run with: npm run test:units
//
// What rides on this helper: it is the last thing that runs before a teardown
// deletes its flow, and BOTH of its guarantees are invisible when broken. If it
// rethrows, the caller's deletes never run and the flow leaks silently (measured:
// dropping the catch from one spec's `afterEach` left 3 leaked flows). If it stays
// quiet, the 404 burst the failed navigation causes cannot be attributed to
// anything, and an advisory log nobody can read is worth nothing (#1084's rule).
//
// The console assertion is the point, not ceremony. `unmountError` is returned to
// callers but no production caller inspects it, so the WARNING is this helper's
// only human-visible effect — a review of #1289 deleted the `console.warn` and the
// whole unit lane stayed green, which is how this file came to exist. The capture
// pattern is `delete-flow.test.ts`'s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unmountEditorForCleanup } from "./unmount-editor-for-cleanup";

/** Run `fn` with `console.warn` captured, restoring it even on failure. */
async function withWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    await fn();
  } finally {
    console.warn = realWarn;
  }
  return warnings;
}

test("navigates to about:blank by default, silently, and reports nothing", async () => {
  const visited: string[] = [];
  const page = {
    goto: async (url: string) => {
      visited.push(url);
      return null;
    },
  };

  let error: string | undefined = "unset";
  const warnings = await withWarnings(async () => {
    error = await unmountEditorForCleanup(page);
  });

  assert.deepEqual(visited, ["about:blank"]);
  assert.equal(error, undefined, "a successful unmount reports nothing");
  assert.deepEqual(warnings, [], "and says nothing");
});

test("a spec can send it to the flows list instead", async () => {
  const visited: string[] = [];
  const page = { goto: async (url: string) => { visited.push(url); return null; } };
  await unmountEditorForCleanup(page, "/");
  assert.deepEqual(visited, ["/"]);
});

test("a rejected navigation is WARNED about and returned, never thrown", async () => {
  const page = {
    goto: async () => {
      throw new Error("page.goto: Timeout 1ms exceeded.\nCall log:\n  - navigating");
    },
  };

  let error: string | undefined;
  const warnings = await withWarnings(async () => {
    // Not wrapped in assert.rejects: the whole contract is that it resolves, so a
    // throw here fails the test by escaping it.
    error = await unmountEditorForCleanup(page);
  });

  assert.equal(error, "page.goto: Timeout 1ms exceeded.", "first line only");
  assert.equal(warnings.length, 1, `exactly one warning; got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /could not leave the flow editor/);
  assert.match(warnings[0], /Timeout 1ms exceeded/);
  assert.match(warnings[0], /#1288/, "the warning names the issue that explains it");
  assert.ok(
    !warnings[0].includes("Call log"),
    `the warning stays one line; got ${JSON.stringify(warnings[0])}`,
  );
});

test("a SYNCHRONOUS throw is caught too, so the caller's deletes still run", async () => {
  // `.catch()` attaches to the returned promise, so this shape escaped the version
  // this helper replaces — and escaping it skips the deletes, which is the leak the
  // helper exists to prevent. Real Playwright's `goto` is async, but this repo
  // proxies it in its own tests and a fake that throws is normal to write.
  const page = {
    goto: (() => {
      throw new Error("goto is not a function");
    }) as unknown as (url: string) => Promise<unknown>,
  };

  let error: string | undefined;
  const warnings = await withWarnings(async () => {
    error = await unmountEditorForCleanup(page);
  });

  assert.equal(error, "goto is not a function");
  assert.equal(warnings.length, 1);
});

test("a rejection that is not an Error, or whose message is not a string, is still one line", async () => {
  // The `?.message?.split(…) ?? String(error)` idiom this replaces breaks on both:
  // it leaves the `String(error)` fallback untruncated (a bare string rejection with
  // a newline), and it THROWS on `{ message: 42 }` (`.split is not a function`) —
  // the very shape its fallback was written for.
  for (const [label, thrown, expected] of [
    ["bare string", "boom\nsecond line", "boom"],
    ["non-string message", { message: 42 }, "42"],
    ["empty message", new Error(""), "Error"],
  ] as Array<[string, unknown, string]>) {
    const page = {
      goto: async () => {
        throw thrown;
      },
    };
    let error: string | undefined;
    await withWarnings(async () => {
      error = await unmountEditorForCleanup(page);
    });
    assert.equal(error, expected, `${label}: expected ${expected}, got ${error}`);
  }
});
