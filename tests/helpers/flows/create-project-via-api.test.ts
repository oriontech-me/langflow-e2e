// Unit tests for createProjectViaApi (#1353).
// Run with: npm run test:units
//
// The load-bearing part is the TEARDOWN, not the creation. Langflow mints an API
// key of its own (`MCP Project <name> - default`) whenever a project is created
// with `auth_settings`, and `DELETE /api/v1/projects/{id}` answers 204 while
// leaving that key behind — measured on 1.12.0.dev18. If the sweep regresses, the
// symptom is invisible: every spec using a restricted project keeps passing while
// one orphan key accumulates per run on the shared superuser account.
//
// So these tests pin the sweep's three properties that a reader cannot verify by
// looking at a green spec: it deletes the project's own key, it does NOT touch
// anybody else's, and it runs AFTER the project delete without ever masking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { createProjectViaApi, uniqueProjectName } from "./create-project-via-api";

interface Call {
  method: string;
  url: string;
  data?: unknown;
}

/**
 * A fake APIRequestContext recording every call. `keys` is the account's key list
 * as the sweep will read it; deletions mutate it, so a test can assert on the
 * end state rather than only on the calls made.
 */
function fakeRequest(
  opts: {
    createStatus?: number;
    keys?: Array<{ id: string; name: string }>;
    deleteProjectStatus?: number;
    keyListStatus?: number;
    keyDeleteStatus?: number;
  } = {},
) {
  const {
    createStatus = 201,
    keys = [],
    deleteProjectStatus = 204,
    keyListStatus = 200,
    keyDeleteStatus = 200,
  } = opts;

  const calls: Call[] = [];
  const live = [...keys];
  let createdName = "";

  const res = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const request = {
    post: async (url: string, o: { data?: any } = {}) => {
      calls.push({ method: "POST", url, data: o.data });
      createdName = o.data?.name ?? "";
      return res(createStatus, {
        id: "proj-1",
        name: createdName,
        auth_settings: o.data?.auth_settings,
      });
    },
    get: async (url: string) => {
      calls.push({ method: "GET", url });
      return res(keyListStatus, { api_keys: live });
    },
    delete: async (url: string) => {
      calls.push({ method: "DELETE", url });
      if (url.startsWith("/api/v1/projects/")) {
        return res(deleteProjectStatus, {});
      }
      const id = url.split("/").pop()!;
      const i = live.findIndex((k) => k.id === id);
      if (i >= 0 && keyDeleteStatus < 300) live.splice(i, 1);
      return res(keyDeleteStatus, {});
    },
    patch: async () => res(200, {}),
  } as unknown as APIRequestContext;

  return {
    request,
    calls,
    liveKeys: () => live,
    createdName: () => createdName,
  };
}

const HEADERS = { Authorization: "Bearer t" };

test("sends auth_settings when given, and omits the field entirely when not", async () => {
  const withAuth = fakeRequest();
  await createProjectViaApi(withAuth.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  const a = withAuth.calls.find((c) => c.method === "POST")!.data as any;
  assert.deepEqual(a.auth_settings, { auth_type: "apikey" });

  const withoutAuth = fakeRequest();
  await createProjectViaApi(withoutAuth.request, HEADERS);
  const b = withoutAuth.calls.find((c) => c.method === "POST")!.data as any;
  // Absent, not null: an explicit null is a different request to the API.
  assert.equal("auth_settings" in b, false);
});

test("the generated name is unique per call, so the sweep cannot collide", async () => {
  const one = fakeRequest();
  const two = fakeRequest();
  await createProjectViaApi(one.request, HEADERS, { namePrefix: "p" });
  await createProjectViaApi(two.request, HEADERS, { namePrefix: "p" });
  assert.notEqual(one.createdName(), two.createdName());
});

test("teardown deletes the project's auto-created key and leaves other keys alone", async () => {
  const f = fakeRequest({ keys: [] });
  const project = await createProjectViaApi(f.request, HEADERS, {
    namePrefix: "authgate",
    authSettings: { auth_type: "apikey" },
  });

  // Langflow mints the key at creation time; model that after the fact so the
  // name matches the one the helper actually generated.
  const name = f.createdName();
  f.liveKeys().push(
    { id: "k-own", name: `MCP Project ${name} - default` },
    { id: "k-other", name: "MCP Project someone-elses-project - default" },
    { id: "k-user", name: "a key a human made" },
  );

  await project.deleteProject();

  assert.deepEqual(
    f.liveKeys().map((k) => k.id),
    ["k-other", "k-user"],
    "only the project's own key is swept",
  );
});

test("the sweep runs AFTER the project delete", async () => {
  const f = fakeRequest();
  const project = await createProjectViaApi(f.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  f.liveKeys().push({ id: "k1", name: `MCP Project ${f.createdName()} - default` });

  await project.deleteProject();

  const projectDelete = f.calls.findIndex(
    (c) => c.method === "DELETE" && c.url.startsWith("/api/v1/projects/"),
  );
  const keyList = f.calls.findIndex(
    (c) => c.method === "GET" && c.url === "/api/v1/api_key/",
  );
  assert.ok(projectDelete >= 0 && keyList > projectDelete, "project first, sweep second");
});

test("a failing sweep never masks a successful project delete", async () => {
  const f = fakeRequest({ keyListStatus: 500 });
  const project = await createProjectViaApi(f.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  // Must not throw: the project IS gone, and turning cleanup noise into a test
  // failure would redden a spec whose subject passed.
  await project.deleteProject();
});

test("a failed key delete is reported, not swallowed into a false clean", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const f = fakeRequest({ keyDeleteStatus: 500 });
    const project = await createProjectViaApi(f.request, HEADERS, {
      authSettings: { auth_type: "apikey" },
    });
    f.liveKeys().push({ id: "k1", name: `MCP Project ${f.createdName()} - default` });
    await project.deleteProject();
    assert.ok(
      warnings.some((w) => w.includes("auto-created API key")),
      "the orphan is named in the log",
    );
  } finally {
    console.warn = original;
  }
});

test("a non-201 creation throws instead of returning an unusable project", async () => {
  const f = fakeRequest({ createStatus: 500 });
  await assert.rejects(() => createProjectViaApi(f.request, HEADERS));
});

// ─── Name truncation (#1883) ─────────────────────────────────────────────────
//
// Langflow auto-registers one MCP server per project under a name derived from
// the project's and cut to 26 characters, and refuses the SECOND project whose
// name collides on that derivation with a 409 naming a server the caller never
// created (#1409). The generated name therefore has to stay unique THROUGH that
// truncation, not just as a whole string.
//
// `sanitizeMcpName` below replicates
// `src/lfx/src/lfx/base/mcp/util.py::sanitize_mcp_name` over the ASCII subset
// these names live in. It is replicated rather than imported because the rule
// lives in the product, not in this repo.
//
// Be clear about what that does NOT buy, because an earlier version of this
// comment claimed it: the cut is hardcoded on BOTH sides — `MCP_CUT` here,
// `MCP_DERIVED_NAME_BUDGET` in the helper — and nothing reads the product. What
// these tests pin is the helper against a second copy of 26, so an edit to the
// helper's constant fails here (measured: 26 -> 27 is caught) while a change to
// Langflow's `MAX_MCP_SERVER_NAME_LENGTH` is caught by nothing and comes back as
// a 409 in the daily. The only mechanism that would watch `base/mcp` is
// `file-watcher.yml`, which is disabled and has no run history.
//
// Two divergences, both unreachable for a generated name, and the SECOND one is
// worth knowing because it decides what these tests can prove:
//
//   * The emoji strip is omitted. Benign by accident rather than by design —
//     Python's emoji class spans `\U000024c2-\U0001f251`, which swallows Hangul
//     and CJK, and the ASCII `\w` below strips those too. The divergences cancel.
//   * JS `\w` is `[A-Za-z0-9_]` where Python's is unicode-aware, so for scripts
//     BELOW U+24C2 (Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai) Python
//     KEEPS letters this replica strips — i.e. the replica is more permissive
//     there, not stricter. So `discriminatorSurvives` cannot pin the removal of
//     `normalizePrefix`.
//
//     Plain Cyrillic is NOT the escape, and the first version of this comment
//     cited it as one. Do the arithmetic before quoting a case: the budget slice
//     is 11 code units, so with `normalizePrefix` mutated away
//     `uniqueProjectName("проектпроект")` is still a 26-character name, which
//     real Python sanitizes to 26 and this replica to 14 — both inside the cut,
//     both `true`. An escape needs a transform that LENGTHENS, i.e. a leading
//     NON-ASCII digit: `uniqueProjectName("٣проектпрое")` sanitizes to 27 under
//     real Python, because `str.isdigit()` is true for `٣` and prepends `_`
//     where the helper's `/^[0-9]/` does not pay for it, and the discriminator
//     loses its last character. Measured against a faithful replica of
//     `sanitize_mcp_name`, not derived.
//
//     That mutation is caught by the RECOGNISABILITY test, and only by it —
//     also measured: the separator test PASSES against it, because for `"   "`,
//     `"---"` and `"***"` the mutant still produces no leading, trailing or
//     doubled hyphen. The separator test pins a different mutation, the dropped
//     `.replace(/-+$/, "")`. Crediting it here would make a later edit that
//     weakens the recognisability test look safe.

const MCP_CUT = 26;
/** `${ts base36}-${rand}` — 8 + 1 + 5. */
const DISCRIMINATOR_LENGTH = 14;

function sanitizeMcpName(name: string, maxLength = 46): string {
  // Python bails before every other transform, and answers "" rather than the
  // "unnamed" default below — measured: sanitize_mcp_name("   ") is `''`, so the
  // server is a bare `lf-`. Unreachable for a generated name (the discriminator
  // is never blank), replicated so the helper stays correct if it is reused.
  if (!name || !name.trim()) return "";
  let n = name.normalize("NFD").replace(/\p{Mn}/gu, "");
  n = n.replace(/[^\w\s-]/g, "");
  n = n.replace(/[-\s]+/g, "_");
  n = n.replace(/_+/g, "_");
  n = n.replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  n = n.toLowerCase();
  if (n.length > maxLength) n = n.slice(0, maxLength).replace(/_+$/, "");
  return n || "unnamed";
}

/** What Langflow registers for a project of this name. */
function derivedServerName(projectName: string): string {
  return `lf-${sanitizeMcpName(projectName).slice(0, MCP_CUT)}`;
}

/**
 * The property the fix has to hold, asserted DETERMINISTICALLY rather than by
 * counting collisions over a sample.
 *
 * Collision counting was the first formulation and it is too weak: losing the
 * last character of the random component still leaves 36^4 values, so a 200-draw
 * sample collides about 1% of the time and the assertion passes against a broken
 * budget. What must be true is structural — the whole discriminator survives the
 * cut — so that is what is asserted.
 */
function discriminatorSurvives(name: string): boolean {
  const full = sanitizeMcpName(name);
  return full
    .slice(0, MCP_CUT)
    .endsWith(full.slice(-DISCRIMINATOR_LENGTH));
}

/** The construction this fix replaced, kept so the tests below are shown to discriminate. */
function legacyProjectName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Every prefix the suite passes to createProjectViaApi today, plus the default,
// plus the shapes a caller could pass tomorrow.
const PREFIXES = [
  "api-flows-export-upsert", // 23 — the case that collides ALWAYS
  "api-monitor-lifecycle",
  "authz-reconcile",
  "authz-inherited",
  "a2a-authgate",
  "a2a-external",
  "ac-ui-scope",
  "e2e-project", // the helper's own default
  "e2ecf",
  "pdl",
  "an-extremely-long-and-descriptive-spec-prefix-nobody-should-write",
  "2fa-login-regression-probe", // starts with a digit AND outruns the budget
  "7", // a digit that does not outrun it
  "", // no prefix at all
  "   ",
  "---",
  "***",
  "Mixed Case With Spaces",
  "abcdefghij-klmn", // the character at the budget boundary is a separator
];

test("the discriminator survives Langflow's 26-character cut, for every prefix shape", () => {
  for (const prefix of PREFIXES) {
    for (let i = 0; i < 50; i++) {
      const name = uniqueProjectName(prefix);
      assert.ok(
        discriminatorSurvives(name),
        `prefix ${JSON.stringify(prefix)} produced "${name}", which derives ` +
          `"${derivedServerName(name)}" — the discriminator does not survive`,
      );
    }
  }
});

test("the property fails under the construction this replaced", () => {
  // Not a test of the old code — a test that the assertion above can fail. The
  // 23-character prefix leaves 2 digits of the timestamp, so every name derives
  // the same server; without this, a no-op "fix" would pass the suite.
  const name = legacyProjectName("api-flows-export-upsert");
  assert.equal(discriminatorSurvives(name), false);
  const derived = new Set(
    Array.from({ length: 50 }, () =>
      derivedServerName(legacyProjectName("api-flows-export-upsert")),
    ),
  );
  assert.equal(derived.size, 1, "the legacy construction collapses to one derived name");
});

test("no generated name starts or ends with a separator", () => {
  for (const prefix of PREFIXES) {
    const name = uniqueProjectName(prefix);
    assert.ok(!name.startsWith("-"), `leading separator: ${name}`);
    assert.ok(!name.endsWith("-"), `trailing separator: ${name}`);
    assert.ok(!name.includes("--"), `doubled separator: ${name}`);
  }
});

test("the prefix stays recognisable in the generated name", () => {
  // The prefix exists to say whose orphan a leftover project is. A fix that made
  // names unique by dropping it would pass every assertion above.
  assert.ok(uniqueProjectName("a2a-authgate").startsWith("a2a-authgat"));
  assert.ok(uniqueProjectName("api-flows-export-upsert").startsWith("api-flows-e"));
  assert.ok(uniqueProjectName("pdl").startsWith("pdl-"));
  assert.ok(uniqueProjectName("Mixed Case With Spaces").startsWith("mixed-case-"));
});

test("the name the helper sends is the one uniqueProjectName builds", () => {
  // Guards the wiring: the rule is worth nothing if createProjectViaApi stops
  // using it.
  const f = fakeRequest();
  return createProjectViaApi(f.request, HEADERS, {
    namePrefix: "api-flows-export-upsert",
  }).then((project) => {
    assert.equal(project.name, f.createdName());
    assert.ok(
      project.name.startsWith("api-flows-e-"),
      `unexpected generated name: ${project.name}`,
    );
    assert.ok(discriminatorSurvives(project.name));
  });
});
