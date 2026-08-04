// Unit tests for the assistant-onboarding suppression (issues #1214, #1220).
// Run with: npm run test:units
//
// Moved here with the seed itself, from `helpers/flows/open-flow-by-id.test.ts`,
// when #1220 gave it callers that never enter the editor by id.
//
// What rides on this module: ten specs now depend on it, and its failure mode is
// invisible. A seed that does not register is not an error — it is an onboarding
// tooltip appearing 10 s later, over whatever the spec is clicking, in a different
// assertion. Nothing in a Playwright run would name it, which is precisely how the
// mechanism this replaced went four call sites and 82 executions without ever doing
// anything (see the module header for the measurement).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_DISCOVERED_STORAGE_KEY,
  assertAssistantOnboardingSeeded,
  seedAssistantDiscovered,
  type SeedablePage,
} from "./assistant-onboarding";

/**
 * A page that records the init scripts registered on it.
 *
 * Deliberately not a mock framework: the assertions below are about COUNT and
 * ARGUMENTS, and a plain array is the most direct way to state them.
 */
function fakePage(): SeedablePage & {
  initScripts: Array<{ script: (key: string) => void; arg: string }>;
} {
  const initScripts: Array<{ script: (key: string) => void; arg: string }> = [];
  return {
    initScripts,
    async addInitScript(script, arg) {
      initScripts.push({ script, arg });
    },
  };
}

test("seedAssistantDiscovered reports whether it registered", async () => {
  const page = fakePage();
  assert.equal(await seedAssistantDiscovered(page), true, "first call registers");
  assert.equal(
    await seedAssistantDiscovered(page),
    false,
    "second call is a no-op",
  );
  assert.equal(page.initScripts.length, 1, "one registration, not two");
});

test("a different page gets its own seed", async () => {
  const first = fakePage();
  const second = fakePage();
  await seedAssistantDiscovered(first);
  await seedAssistantDiscovered(second);
  assert.equal(first.initScripts.length, 1);
  assert.equal(second.initScripts.length, 1);
});

test("a rejecting addInitScript leaves the page unseeded, so a later call retries", async () => {
  // The `seededPages` bookkeeping happens AFTER the registration lands. Marking
  // before would leave a page permanently flagged as seeded after one transient
  // failure — and the consequence is the overlay coming back with nothing saying so.
  let fail = true;
  const page: SeedablePage = {
    async addInitScript() {
      if (fail) throw new Error("transport");
      return undefined;
    },
  };
  await assert.rejects(() => seedAssistantDiscovered(page));
  fail = false;
  assert.equal(
    await seedAssistantDiscovered(page),
    true,
    "the retry must register, not report an already-seeded page",
  );
});

test("the seeded key is the flag upstream reads", () => {
  // `readAssistantDiscovered()` in
  // `components/core/assistantPanel/hooks/assistant-discovery-storage.ts` reads
  // exactly this key and compares against the string "true".
  //
  // This asserts a literal against a literal, and it cannot detect an upstream
  // rename — nothing in this lane reads the Langflow source, and adding that
  // dependency would make the unit lane require a checkout it does not have in CI.
  // What it does buy: the key is the one thing here whose value is dictated by
  // another codebase, so pinning it turns "someone tidied a constant" into a failing
  // test that names where the real definition lives.
  assert.equal(ASSISTANT_DISCOVERED_STORAGE_KEY, "langflow-assistant-discovered");
});

/**
 * Run `body` with `globalThis.localStorage` replaced by `stub`, then restore.
 *
 * Via `defineProperty` against the saved descriptor, not `globals.localStorage =`.
 * Node exposes `localStorage` as a getter-only global from v22.4 (unflagged in v24),
 * and a plain assignment to an accessor with no setter THROWS under the
 * `"use strict"` these modules compile to — so the direct form would fail both tests
 * below on a newer runtime, for a reason having nothing to do with what they assert.
 * Restoring the descriptor rather than the value keeps that global a getter
 * afterwards instead of flattening it into a data property.
 */
function withLocalStorage(stub: unknown, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("the init script writes the upstream key with the upstream value", async () => {
  const page = fakePage();
  await seedAssistantDiscovered(page);
  const { script, arg } = page.initScripts[0];
  const written: Record<string, string> = {};
  withLocalStorage(
    {
      setItem: (key: string, value: string) => {
        written[key] = value;
      },
    },
    () => script(arg),
  );
  assert.deepEqual(written, { "langflow-assistant-discovered": "true" });
});

test("a localStorage that throws does not reject the seed", async () => {
  const page = fakePage();
  await seedAssistantDiscovered(page);
  const { script, arg } = page.initScripts[0];
  withLocalStorage(
    {
      setItem: () => {
        throw new Error("private browsing");
      },
    },
    () => {
      // Upstream treats its own write as best-effort for the same reason; the
      // consequence of swallowing it is a visible overlay and a loud spec failure,
      // never a silent pass.
      assert.doesNotThrow(() => script(arg));
    },
  );
});

/** A `Page`-shaped stub whose `evaluate` returns (or throws) what a test dictates. */
function pageWhoseFlagIs(value: string | null | (() => never)) {
  return {
    async evaluate() {
      if (typeof value === "function") value();
      return value;
    },
  } as unknown as Parameters<typeof assertAssistantOnboardingSeeded>[0];
}

test("the guard passes when the flag carries the value upstream compares against", async () => {
  await assertAssistantOnboardingSeeded(pageWhoseFlagIs("true"), "caller");
});

test("the guard fails, naming the fix, when the page was never seeded", async () => {
  // The whole point of replacing the probe with an assertion: a missing seed must be
  // loud. A probe could not tell "nothing to dismiss" from "too early to tell", and
  // that ambiguity is what let the mechanism read as protection for four call sites.
  await assert.rejects(
    () => assertAssistantOnboardingSeeded(pageWhoseFlagIs(null), "expandFocusedNode"),
    (err: Error) => {
      assert.match(err.message, /expandFocusedNode/);
      assert.match(err.message, /seedAssistantDiscovered/);
      assert.match(err.message, /BEFORE its first navigation/);
      return true;
    },
  );
});

test("a flag with any other value is not a seed", async () => {
  // Upstream compares against the STRING "true". A truthy-looking "1" would pass a
  // sloppy check here and fail upstream, which is the same silent exposure again.
  await assert.rejects(() =>
    assertAssistantOnboardingSeeded(pageWhoseFlagIs("1"), "caller"),
  );
});

test("an unreadable localStorage is UNKNOWN, not a failure", async () => {
  // Fail-open, mirroring the seed's own best-effort write: this guard exists to
  // catch a missing seed, and a verdict it cannot produce must not redden a run on
  // its own. It is printed rather than swallowed (#1012's rule).
  const printed: string[] = [];
  const log = console.log;
  console.log = (msg?: unknown) => {
    printed.push(String(msg));
  };
  try {
    await assertAssistantOnboardingSeeded(
      pageWhoseFlagIs(() => {
        throw new Error("no document");
      }),
      "caller",
    );
  } finally {
    console.log = log;
  }
  assert.equal(printed.length, 1, "the give-up path says so out loud");
  assert.match(printed[0], /UNKNOWN/);
});
