// Behavioural gate for the component probe's UNDECIDED branch, on the real
// transport (issue #1934).
//
// The pure classification lives next door in `probe-component-available.test.ts`,
// where `npm run test:units` covers it against a hand-written `request` double.
// What THIS pins is the half that double cannot reach by construction, and it is
// the half a silent failure would cost the most:
//
//   `probeProviderComponent()`'s `undecided` verdict carries the underlying error
//   verbatim, and on `ollama-provider.spec.ts` — the one call site that FAILS
//   rather than skipping — that is what lets `remove-stable-from-failures.ts`
//   recognise a wedged backend as transport-level and exempt an `@stable` test
//   from the daily's unreviewed auto-removal (#1031).
//
// The unit test asserts the two ends of that chain SEPARATELY: that the message
// carries the reason, and that a hand-typed `apiRequestContext.get: Timeout …`
// classifies. Nothing pinned the bridge — that a REAL `APIRequestContext`
// failure still produces that wording. The double's `get` throws an `Error` the
// test itself constructed, so the day Playwright rephrases a timeout or a
// connection refusal, the exemption stops applying and all 21 unit tests stay
// green. A guard going quiet with no symptom is the class this repo keeps
// re-learning (#1084, #1226, #1252).
//
// Classification is asserted through `classifyInfraError` — the module the
// auto-removal path actually calls — never against a copy of the pattern. So
// widening or narrowing `scripts/lib/infra-signature-patterns.json` cannot
// silently unpin this either.
//
// WHY THIS FILE IS HERE and not in `tests/fixtures/` beside the other
// `*-gate.spec.ts`: those gate a fixture and live with the fixture. This gates a
// helper, so it lives with the helper, next to the unit test it completes.
//
// THE POSITIVE CONTROL IS LOAD-BEARING. Without it every transport test below
// passes against a probe that returns `undecided` unconditionally — the file
// would be green and vacuous. Hence one test that drives a real socket serving a
// real registry shape and asserts `present` AND `absent`.
//
// A tiny local server stands in for Langflow: no container, no provider key, no
// flow. Measured on this file: three tests under 1 s each, plus the timeout test,
// which costs the probe's own 15 s bound and is the point of it — see there.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { APIRequestContext, expect, request, test } from "@playwright/test";

import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  probeProviderComponent,
  undecidedProbeMessage,
  type ComponentProbeVerdict,
} from "./probe-component-available";

/** Paths the stand-in server answers. The probe only ever asks for two of them. */
const AUTH_PATH = "/api/v1/auto_login";
const REGISTRY_PATH = "/api/v1/all";

/** How the server should treat `GET /api/v1/all` for the context under test. */
type RegistryMode = "serve" | "drop" | "hang";

let server: http.Server;
let origin: string;
let mode: RegistryMode = "serve";

/**
 * A registry with one Ollama component and no Groq one — the shape the positive
 * control needs, and the smallest body that is a catalog rather than a stub.
 */
const REGISTRY_BODY = {
  agents: { "ext:openai:OpenAIModelComponent@official": {} },
  ollama: { "ext:ollama:OllamaModel@official": {} },
  component_display_names: { ollamamodel: "Ollama" },
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (path === AUTH_PATH) {
      // Always healthy: the auth call is `get-auth-token`'s contract, covered by
      // its own tests, and it retries a THROW for ~30 s (#1077). Letting it fail
      // here would measure that budget instead of this probe.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "gate-token" }));
      return;
    }

    if (path === REGISTRY_PATH) {
      if (mode === "drop") {
        // Accepted, then the socket dies under the response: `socket hang up`.
        req.socket.destroy();
        return;
      }
      if (mode === "hang") return; // never answers — the probe's own bound decides
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(REGISTRY_BODY));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "not a path this gate serves" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A context against the stand-in server, disposed by the caller. */
const contextForGate = (): Promise<APIRequestContext> =>
  request.newContext({ baseURL: origin });

/** Narrows and returns the reason, failing with the verdict when it is not undecided. */
function reasonOf(verdict: ComponentProbeVerdict): string {
  expect(
    verdict.state,
    `expected an undecided verdict, got ${JSON.stringify(verdict)}`,
  ).toBe("undecided");
  return (verdict as { state: "undecided"; reason: string }).reason;
}

test.describe("component probe — real transport", () => {
  test(
    "answers present and absent against a real socket serving a registry",
    { tag: ["@stable", "@regression", "@components"] },
    async () => {
      // The positive control. Every transport assertion below is satisfied by a
      // probe that only ever says `undecided`; this is what makes them mean
      // something.
      mode = "serve";
      const ctx = await contextForGate();
      try {
        expect(await probeProviderComponent(ctx, "ollama")).toEqual({
          state: "present",
        });
        expect(await probeProviderComponent(ctx, "groq")).toEqual({
          state: "absent",
        });
      } finally {
        await ctx.dispose();
      }
    },
  );

  test(
    "a dropped connection is undecided, and its reason still classifies as infra",
    { tag: ["@stable", "@regression", "@components"] },
    async () => {
      // The whole path is real here — real auth round trip, real socket, real
      // Playwright error — which is what the unit test's double cannot be.
      mode = "drop";
      const ctx = await contextForGate();
      try {
        const reason = reasonOf(await probeProviderComponent(ctx, "ollama"));
        expect(reason).toContain("GET /api/v1/all did not answer");

        const message = undecidedProbeMessage("ollama", {
          state: "undecided",
          reason,
        });
        expect(
          classifyInfraError(message)?.id,
          `the auto-removal path must see this as transport-level, or a wedged ` +
            `shard strips @stable from ollama-provider.spec.ts (#1031). Message: ${message}`,
        ).toBe("connection-dropped");
      } finally {
        await ctx.dispose();
      }
    },
  );

  test(
    "a refused connection is undecided, and its reason still classifies as infra",
    { tag: ["@stable", "@regression", "@components"] },
    async () => {
      // Port 9 (discard) with nothing bound: the whole origin is dead, so the
      // auth call would throw too and burn `get-auth-token`'s ~30 s retry budget
      // (#1077) before the call under test ever runs. `getToken` is injected to
      // skip it — the registry request is still a real socket failure, which is
      // the string this test exists to pin.
      const ctx = await request.newContext({ baseURL: "http://127.0.0.1:9" });
      try {
        const verdict = await probeProviderComponent(ctx, "ollama", {
          getToken: async () => "",
        });
        const reason = reasonOf(verdict);
        expect(reason).toContain("GET /api/v1/all did not answer");

        const message = undecidedProbeMessage("ollama", {
          state: "undecided",
          reason,
        });
        expect(classifyInfraError(message)?.id, `Message: ${message}`).toBe(
          "connection-refused",
        );
      } finally {
        await ctx.dispose();
      }
    },
  );

  test(
    "a hung registry times out at the probe's own bound, undecided and classified",
    { tag: ["@stable", "@regression", "@components"] },
    async () => {
      // This test costs ~15 s, and that IS the assertion. The unit test can pin
      // that `timeout: 15000` is PASSED; only a real socket pins that it is
      // HONOURED — a bound silently dropped would hold this gate open for the
      // spec's own 5-minute budget on a wedged backend instead of resolving to
      // `undecided`, which is the state every caller's decision is built on.
      test.setTimeout(60_000);
      mode = "hang";
      const ctx = await contextForGate();
      try {
        const started = Date.now();
        const verdict = await probeProviderComponent(ctx, "ollama");
        const elapsed = Date.now() - started;

        const reason = reasonOf(verdict);
        expect(reason).toContain("GET /api/v1/all did not answer");

        const message = undecidedProbeMessage("ollama", {
          state: "undecided",
          reason,
        });
        expect(classifyInfraError(message)?.id, `Message: ${message}`).toBe(
          "api-request-timeout",
        );

        // A window, not an equality: the bound is 15 s and the machine adds its
        // own noise. The floor is what matters — a probe that gave up early would
        // mean the bound is not the one the callers were told about.
        expect(
          elapsed,
          `the probe returned after ${elapsed} ms; its bound is 15 s`,
        ).toBeGreaterThanOrEqual(14_000);
        expect(elapsed).toBeLessThan(30_000);
      } finally {
        await ctx.dispose();
      }
    },
  );
});
