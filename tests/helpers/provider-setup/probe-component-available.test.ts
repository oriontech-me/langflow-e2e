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

  it("floors on a 200 that registered no components at all", async () => {
    const reason = undecided(await probe({}));
    assert.match(reason, /registered no components at all/);
  });

  it("does not let `component_display_names` alone satisfy the floor", async () => {
    // A metadata map with no category registered is a registry still building,
    // not a build without this family — and reporting `absent` there would make
    // every gated spec skip with a packaging reason on a starting instance.
    const metadataOnly = { component_display_names: { somethingelse: "X" } };
    const reason = undecided(await probe(metadataOnly, { token: "groq" }));
    assert.match(reason, /registered no components at all/);
  });

  it("tolerates a non-Error throw rather than failing inside the probe", async () => {
    for (const thrown of ["a bare string", { detail: "an object" }, 7]) {
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
