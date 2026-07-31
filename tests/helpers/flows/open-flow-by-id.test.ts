// Unit tests for the id-addressed flow entry (issue #1214).
// Run with: npm run test:units
//
// What rides on this module: the three specs that enter the editor by id all now
// depend on it, and two of its behaviours are invisible when they break — which
// is exactly how the divergence it replaces survived.
//
// Three invariants these tests exist to protect:
//
//  1. **The seed is registered BEFORE the navigation.** `addInitScript` applies
//     to the loads that follow it, so registering it after the `goto` leaves the
//     one load the caller cares about unseeded — and the failure is not an error,
//     it is an onboarding overlay appearing 10 s later, over a dialog, in a
//     different assertion. Nothing in a Playwright run would name this.
//  2. **The seed is registered once per page.** A spec that enters three times
//     would otherwise stack three identical init scripts on the same page, which
//     is harmless today and exactly the kind of quiet growth nobody notices.
//  3. **The storage key and the deadlines cannot drift unnoticed.** Stated
//     honestly, because it is easy to oversell: nothing here reads the upstream
//     source, so these are CHANGE-DETECTORS, not proof that the suite still
//     matches Langflow. What they buy is that changing the key or inverting the
//     two budgets requires editing an assertion that says why — instead of being
//     a one-character edit whose consequence surfaces months later as a spec
//     flaking behind an overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_DISCOVERED_STORAGE_KEY,
  CANVAS_TIMEOUT_MS,
  WRITABLE_TIMEOUT_MS,
  navigateToFlow,
  seedAssistantDiscovered,
  type NavigablePage,
} from "./open-flow-by-id";

/**
 * A page that records what was called on it, in order.
 *
 * Deliberately not a mock framework: the assertions below are about ORDER and
 * COUNT, and a plain array of call names is the most direct way to state them.
 */
function fakePage(): NavigablePage & {
  calls: string[];
  initScripts: Array<{ script: (key: string) => void; arg: string }>;
  gotos: string[];
} {
  const calls: string[] = [];
  const initScripts: Array<{ script: (key: string) => void; arg: string }> = [];
  const gotos: string[] = [];
  return {
    calls,
    initScripts,
    gotos,
    async addInitScript(script, arg) {
      calls.push("addInitScript");
      initScripts.push({ script, arg });
    },
    async goto(url) {
      calls.push(`goto:${url}`);
      gotos.push(url);
    },
  };
}

test("the seed is registered before the navigation it must apply to", async () => {
  const page = fakePage();
  await navigateToFlow(page, "flow-123");
  assert.deepEqual(page.calls, ["addInitScript", "goto:/flow/flow-123"]);
});

test("the flow is addressed by id, on the editor route", async () => {
  const page = fakePage();
  await navigateToFlow(page, "abc-def");
  assert.deepEqual(page.gotos, ["/flow/abc-def"]);
});

test("re-entering the same page does not stack a second init script", async () => {
  const page = fakePage();
  await navigateToFlow(page, "flow-1");
  await navigateToFlow(page, "flow-1");
  await navigateToFlow(page, "flow-1");
  assert.equal(page.initScripts.length, 1, "one registration for three entries");
  assert.deepEqual(page.gotos, ["/flow/flow-1", "/flow/flow-1", "/flow/flow-1"]);
});

test("a different page gets its own seed", async () => {
  const first = fakePage();
  const second = fakePage();
  await navigateToFlow(first, "flow-1");
  await navigateToFlow(second, "flow-2");
  assert.equal(first.initScripts.length, 1);
  assert.equal(second.initScripts.length, 1);
});

test("seedAssistantDiscovered reports whether it registered", async () => {
  const page = fakePage();
  assert.equal(await seedAssistantDiscovered(page), true, "first call registers");
  assert.equal(
    await seedAssistantDiscovered(page),
    false,
    "second call is a no-op",
  );
});

test("the seeded key is the flag upstream reads", () => {
  // `readAssistantDiscovered()` in
  // `components/core/assistantPanel/hooks/assistant-discovery-storage.ts` reads
  // exactly this key and compares against the string "true".
  //
  // This asserts a literal against a literal, and it cannot detect an upstream
  // rename — nothing in this lane reads the Langflow source, and adding that
  // dependency would make the unit lane require a checkout it does not have in
  // CI. What it does buy: the key is the one thing here whose value is dictated
  // by another codebase, so pinning it turns "someone tidied a constant" into a
  // failing test that names where the real definition lives.
  assert.equal(ASSISTANT_DISCOVERED_STORAGE_KEY, "langflow-assistant-discovered");
});

test("the init script writes the upstream key with the upstream value", () => {
  const page = fakePage();
  return seedAssistantDiscovered(page).then(() => {
    const { script, arg } = page.initScripts[0];
    const written: Record<string, string> = {};
    const globals = globalThis as { localStorage?: unknown };
    const original = globals.localStorage;
    globals.localStorage = {
      setItem: (key: string, value: string) => {
        written[key] = value;
      },
    };
    try {
      script(arg);
    } finally {
      if (original === undefined) delete globals.localStorage;
      else globals.localStorage = original;
    }
    assert.deepEqual(written, { "langflow-assistant-discovered": "true" });
  });
});

test("a localStorage that throws does not reject the seed", () => {
  const page = fakePage();
  return seedAssistantDiscovered(page).then(() => {
    const { script, arg } = page.initScripts[0];
    const globals = globalThis as { localStorage?: unknown };
    const original = globals.localStorage;
    globals.localStorage = {
      setItem: () => {
        throw new Error("private browsing");
      },
    };
    try {
      // Upstream treats its own write as best-effort for the same reason; the
      // consequence of swallowing it is a visible overlay and a loud spec
      // failure, never a silent pass.
      assert.doesNotThrow(() => script(arg));
    } finally {
      if (original === undefined) delete globals.localStorage;
      else globals.localStorage = original;
    }
  });
});

test("the canvas budget is separate from, and longer than, the writable budget", () => {
  // A RELATION between two independently-editable constants, not a restatement of
  // either. They answer different questions: "nothing is on screen yet" (document
  // load + flow fetch + first render) versus "the editor is up and the permission
  // query has not answered". Inverting them would hide a permission map that
  // genuinely denies `write` behind the longer wait, and the migration this helper
  // performed is exactly the moment someone edits one budget and not the other.
  assert.ok(
    CANVAS_TIMEOUT_MS > WRITABLE_TIMEOUT_MS,
    `canvas ${CANVAS_TIMEOUT_MS}ms must exceed writable ${WRITABLE_TIMEOUT_MS}ms`,
  );
  // The floor is the largest budget any of the three migrated copies carried: the
  // helper unified them by taking the MAX, because none was ever measured and
  // shrinking one on an argument buys a red on a saturated daily. Lowering this
  // should require replacing the floor with a measurement.
  assert.equal(
    CANVAS_TIMEOUT_MS,
    100000,
    "canvas budget is the max of the three migrated copies (100 s), not a middle",
  );
});

test("the entry cannot navigate without seeding first", () => {
  // The ordering invariant is what makes the seed work at all, and the tests above
  // can only pin it for `navigateToFlow`. A `page.goto` added straight into
  // `openFlowById` — the obvious refactor — would satisfy every other test here
  // while silently leaving the load it performs unseeded.
  //
  // Structural guard, in the spirit of the workflow-shape guard in
  // `scripts/wait-for-backend.test.mjs`: the module must contain exactly one
  // navigation, and it must be the one `seedAssistantDiscovered` precedes.
  const source = readFileSync(
    join(__dirname, "open-flow-by-id.ts"),
    "utf8",
  );
  // Comments mention `page.goto('/flow/{id}')` when explaining the entry, so the
  // count has to be over CODE. Strip block and line comments first, or the guard
  // fails on its own documentation.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const navigations = code.match(/\.goto\(/g) ?? [];
  assert.equal(
    navigations.length,
    1,
    "exactly one .goto( in the module — add navigations to navigateToFlow, not around it",
  );
  const seedAt = code.indexOf("await seedAssistantDiscovered(page)");
  const gotoAt = code.indexOf(".goto(");
  assert.ok(seedAt > 0 && gotoAt > seedAt, "the seed must precede the navigation");
});
