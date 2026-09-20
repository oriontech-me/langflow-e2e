import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { APIRequestContext } from "@playwright/test";

import {
  probeProviderComponent,
  undecidedProbeMessage,
  type ComponentProbeVerdict,
} from "./probe-component-available";

/**
 * Unit coverage for the three-state component probe (#1930).
 *
 * The property under test is not "does it find the component" — it is that a
 * probe which never read the registry is reported as `undecided` with its
 * reason, instead of as `absent`, which is what let four call sites state a
 * packaging fact they had not measured (#1012's rule, in the skip reason a
 * lane-coverage reader parses).
 *
 * `getToken` is injected throughout: the real `getAuthToken` carries a ~30 s
 * retry budget (#1077) and the thrown-auth path is one of the branches this
 * file exists to pin.
 */

type GetOptions = { headers?: Record<string, string>; timeout?: number };

/** Minimal `APIRequestContext` stand-in — only `.get()` is reached. */
function fakeRequest(
  get: (url: string, options?: GetOptions) => Promise<unknown>,
): APIRequestContext {
  return { get } as unknown as APIRequestContext;
}

/** A `/api/v1/all` response double. `json` throws when `body` is a function. */
function response(
  status: number,
  body: unknown,
): { ok: () => boolean; status: () => number; json: () => Promise<unknown> } {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => {
      if (typeof body === "function") return (body as () => unknown)();
      return body;
    },
  };
}

const okRegistry = {
  agents: { "ext:openai:OpenAIModelComponent@official": {} },
  // Mixed case ON PURPOSE, and it is the registry side that needs it: with only
  // lowercase keys, dropping `k.toLowerCase()` left the whole file green. For the
  // four live tokens that is forward protection rather than a live bug — measured
  // against the committed catalog baseline, `ollama` matches its `ext:…` keys
  // case-sensitively too, and groq/mistral/composio have no keys at all — but 127
  // of its 175 type keys are bare CamelCase (`CrewAIAgentComponent`,
  // `CustomComponent`), the pre-`ext:` shape a returning family would land in.
  mistral: { MistralAIModelComponent: {} },
  ollama: { "ext:ollama:OllamaModel@official": {} },
  component_display_names: { ollamamodel: "Ollama" },
};

const alwaysAuth = async () => "Bearer t";

function probe(
  body: unknown,
  { status = 200, getToken = alwaysAuth, token = "ollama" } = {},
): Promise<ComponentProbeVerdict> {
  return probeProviderComponent(
    fakeRequest(async () => response(status, body)),
    token,
    { getToken },
  );
}

describe("probeProviderComponent — decided states", () => {
  it("reports `present` when a component type key matches the token", async () => {
    assert.deepEqual(await probe(okRegistry), { state: "present" });
  });

  it("matches case-insensitively, and on a token the caller spelled in caps", async () => {
    assert.deepEqual(await probe(okRegistry, { token: "OLLAMA" }), {
      state: "present",
    });
  });

  it("lowercases the REGISTRY key too — a CamelCase type still matches a lowercase token", async () => {
    assert.deepEqual(await probe(okRegistry, { token: "mistralaimodel" }), {
      state: "present",
    });
  });

  it("reports `absent` when the registry has components but none match", async () => {
    assert.deepEqual(await probe(okRegistry, { token: "groq" }), {
      state: "absent",
    });
  });

  it("matches inside `component_display_names` — a hit there is still a catalog hit", async () => {
    const onlyDisplayNames = {
      agents: { "ext:openai:OpenAIModelComponent@official": {} },
      component_display_names: { composiogmail: "ComposIO Gmail" },
    };
    assert.deepEqual(await probe(onlyDisplayNames, { token: "composio" }), {
      state: "present",
    });
  });

  it("never inspects nested field names — `ollama_base_url` is not the Ollama component", async () => {
    const fieldOnly = {
      models: {
        "ext:langflow:LanguageModel@official": {
          template: { ollama_base_url: { value: "" } },
        },
      },
    };
    assert.deepEqual(await probe(fieldOnly, { token: "ollama" }), {
      state: "absent",
    });
  });
});

describe("probeProviderComponent — undecided states", () => {
  const undecided = (v: ComponentProbeVerdict): string => {
    assert.equal(v.state, "undecided", `expected undecided, got ${v.state}`);
    return (v as { state: "undecided"; reason: string }).reason;
  };

  it("classifies a thrown auth request as undecided, carrying its message", async () => {
    const reason = undecided(
      await probe(okRegistry, {
        getToken: async () => {
          throw new Error("apiRequestContext.get: Timeout 15000ms exceeded");
        },
      }),
    );
    assert.match(reason, /auth token request failed/);
    assert.match(reason, /Timeout 15000ms exceeded/);
  });

  it("classifies a thrown registry request as undecided, carrying its message", async () => {
    const verdict = await probeProviderComponent(
      fakeRequest(async () => {
        throw new Error("apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:7860");
      }),
      "ollama",
      { getToken: alwaysAuth },
    );
    const reason = undecided(verdict);
    assert.match(reason, /GET \/api\/v1\/all did not answer/);
    assert.match(reason, /ECONNREFUSED/);
  });

  it("classifies a non-ok response as undecided and names the status", async () => {
    for (const status of [401, 403, 500, 503]) {
      const reason = undecided(await probe(okRegistry, { status }));
      assert.match(reason, new RegExp(`answered ${status}`));
    }
  });

  it("classifies a body that is not JSON as undecided", async () => {
    const reason = undecided(
      await probe(() => {
        throw new Error("Unexpected token < in JSON at position 0");
      }),
    );
    assert.match(reason, /not JSON/);
  });

  it("classifies a body that is not a registry object as undecided", async () => {
    for (const body of [null, "a string", 42]) {
      const reason = undecided(await probe(body));
      assert.match(reason, /not a registry object/);
    }
  });

  it("floors on a 200 that registered no components, and says which shape it saw", async () => {
    // Two bodies, two sentences: nothing object-valued at all (`{}`, or a JSON
    // error like `{"detail": …}` whose values are strings) against categories
    // that exist but are empty. Same verdict, different observation — reporting
    // the second wording for the first is the misdescription this file is about.
    assert.match(undecided(await probe({})), /no component categories/);
    assert.match(
      undecided(await probe({ detail: "Not authenticated" })),
      /no component categories/,
    );
    assert.match(
      undecided(await probe({ mistral: {}, agents: {} })),
      /registered no components at all/,
    );
  });

  it("names an array body as not-a-registry rather than as an empty one", async () => {
    // `typeof [] === "object"`, so without the explicit check this fell through
    // to the floor and was reported as a registry that registered nothing.
    const reason = undecided(await probe(["OllamaModel"]));
    assert.match(reason, /not a registry object/);
  });

  it("floors ahead of the match — a hit in the metadata map of an empty registry is not `present`", async () => {
    // Unreachable upstream (the map is derived from the same dict the categories
    // come from), and pinned anyway: with the two checks the other way round this
    // body answered `present` while nothing at all was registered, which is the
    // opposite of what the comment above the loop claims.
    const metadataHitOnly = { component_display_names: { ollamamodel: "Ollama" } };
    const reason = undecided(await probe(metadataHitOnly, { token: "ollama" }));
    assert.match(reason, /no component categories/);
  });

  it("does not let `component_display_names` alone satisfy the floor", async () => {
    // A metadata map with no category registered is a body this probe could not
    // read as a catalog, not a build without this family — reporting `absent`
    // there would put a packaging sentence on it. (Deliberately not "a registry
    // still building": that shape is undemonstrated, see the helper's comment.)
    const metadataOnly = { component_display_names: { somethingelse: "X" } };
    const reason = undecided(await probe(metadataOnly, { token: "groq" }));
    assert.match(reason, /no component categories/);
  });

  it("tolerates an Error whose `message` is not a string, and one whose getter throws", async () => {
    // The values the first version of this test picked were all safe. `message`
    // is TYPED `string` and is a plain own property, so these two are what made
    // the probe's own reader throw — at the skip sites that turns a skip into a
    // FAILURE, and at ollama into a failure text that classifies as nothing
    // transport-level (#1031). Delegating to `readFailureReason` (#1432) is what
    // closes it; this pins that it stays delegated.
    const withSymbolMessage = new Error("placeholder");
    Object.defineProperty(withSymbolMessage, "message", { value: Symbol("boom") });
    const withThrowingGetter = new Error("placeholder");
    Object.defineProperty(withThrowingGetter, "message", {
      get() {
        throw new Error("getter boom");
      },
    });

    for (const thrown of [withSymbolMessage, withThrowingGetter]) {
      const reason = undecided(
        await probe(okRegistry, {
          getToken: async () => {
            throw thrown;
          },
        }),
      );
      assert.match(reason, /auth token request failed/);
    }
  });

  it("tolerates a non-Error throw rather than failing inside the probe", async () => {
    for (const thrown of ["a bare string", { detail: "an object" }, 7, undefined]) {
      const reason = undecided(
        await probe(okRegistry, {
          getToken: async () => {
            throw thrown;
          },
        }),
      );
      assert.match(reason, /auth token request failed/);
    }
  });

  it("sends the Authorization header when a token is returned, and omits it when blank", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const capture = (auth: string) =>
      probeProviderComponent(
        fakeRequest(async (_url, options) => {
          seen.push(options?.headers);
          return response(200, okRegistry);
        }),
        "ollama",
        { getToken: async () => auth },
      );
    await capture("Bearer t");
    await capture("");
    assert.deepEqual(seen[0], { Authorization: "Bearer t" });
    assert.equal(seen[1], undefined);
  });

  it("bounds the registry request at 15 s", async () => {
    // Unpinned until review: `timeout: 1` left the whole file green. The bound is
    // what keeps a wedged backend from holding a gate open for the test's own
    // 5-minute budget instead of resolving to `undecided`.
    let seen: number | undefined;
    await probeProviderComponent(
      fakeRequest(async (_url, options) => {
        seen = options?.timeout;
        return response(200, okRegistry);
      }),
      "ollama",
      { getToken: alwaysAuth },
    );
    assert.equal(seen, 15000);
  });
});

describe("undecidedProbeMessage", () => {
  it("refuses the packaging claim and names the component", () => {
    const msg = undecidedProbeMessage("composio", {
      state: "undecided",
      reason: "GET /api/v1/all answered 503",
    });
    assert.match(msg, /`composio`/);
    assert.match(msg, /NOT a statement about packaging/);
    assert.doesNotMatch(msg, /is not installed/);
  });

  it("carries the reason verbatim, so a transport error still classifies as infra", () => {
    // The load-bearing half on `ollama-provider.spec.ts`, which FAILS rather
    // than skipping: `remove-stable-from-failures.ts` classifies the error
    // TEXT, so a message that paraphrased the cause would leave a wedge-caused
    // failure attributable and strip `@stable` unreviewed (#1031).
    const patterns = JSON.parse(
      readFileSync(
        path.join(__dirname, "../../../scripts/lib/infra-signature-patterns.json"),
        "utf8",
      ),
    ) as Array<{ id: string; pattern: string; flags: string }>;

    const classifies = (text: string): string | undefined =>
      patterns.find((p) => new RegExp(p.pattern, p.flags).test(text))?.id;

    const timeout = undecidedProbeMessage("ollama", {
      state: "undecided",
      reason: "GET /api/v1/all did not answer: apiRequestContext.get: Timeout 15000ms exceeded",
    });
    assert.equal(classifies(timeout), "api-request-timeout");

    const refused = undecidedProbeMessage("ollama", {
      state: "undecided",
      reason: "the auth token request failed: connect ECONNREFUSED 127.0.0.1:7860",
    });
    assert.equal(classifies(refused), "connection-refused");

    // The counter-case that makes the two above mean something: the wording the
    // old boolean produced classifies as nothing at all.
    assert.equal(
      classifies(
        "Ollama component not exposed by this Langflow build — the `lfx-ollama` distribution that ships it is not installed (#931)",
      ),
      undefined,
    );
  });
});
