import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";

// Probe whether a provider's component is actually EXPOSED by the running
// Langflow build — a build-side check, distinct from the provider specs' cloud
// API probe (which only validates the key). A component absent from the build
// makes the provider specs' `waitForSelector('[data-testid="groqGroq"]')`
// hard-fail after 30s; this probe converts that deep, misleading timeout into
// an explicit skip: "component not in this build".
//
// WHY a component can be absent — TWO independent gates, measured on
// 1.12.0.dev8 (#1039):
//
//   1. DISTRIBUTION. 1.12 moved most component families out of
//      `lfx.components.*` into separate per-vendor distributions (`lfx_openai`,
//      `lfx_anthropic`, `lfx_google`, `lfx_ollama`, …) plus an aggregate
//      `lfx-bundles` package. The default nightly installs ~20 vendor
//      distributions and NO `lfx-bundles`, so the whole Groq and Mistral
//      families are absent from the registry. Migration watch: #1040.
//   2. RUNTIME PACKAGE. With the distribution installed, a component is still
//      hidden when its `langchain-*` package is missing — the #907 / LE-1987
//      mechanism, still operative. Installing `lfx-bundles` alone leaves the
//      `mistral` category present but EMPTY; `langchain-mistralai` is what
//      makes `ext:mistral:MistralAIModelComponent@official` appear.
//
// The two gates do not behave identically, and that is the trap: with
// `lfx-bundles` installed but `langchain-groq` missing, the Groq component IS
// exposed in the registry and still fails at run time with
// `ComponentBuildError: Error building Component Groq: langchain-groq is not
// installed`. So a registry hit does NOT prove the component can build — this
// probe answers "is it placeable on the canvas", not "will it run" (#900).
//
// THREE STATES, NOT TWO (#1930). Until this, the probe answered a boolean and
// every failure collapsed into `false`: a thrown `getAuthToken`, a 401, a 500,
// a 15 s timeout and a genuinely absent family were one value. The callers then
// stated a PACKAGING fact on the back of it — "the `lfx-bundles` distribution
// that ships them is not installed" — so a wedged backend (#922/#927) produced
// a byte-identical, and wrong, attribution. That is an unknown recorded as a
// verdict, which is the class #1012 exists to prevent, landing in the one place
// the suite treats as evidence: the skip reason a lane-coverage reader parses.
//
// The cost was not only wording. `ollama-provider.spec.ts` FAILS on a
// not-present verdict (its family ships in the stock image, so absence is a
// packaging regression — #931), and the failure text it raised named the
// distribution. `scripts/lib/infra-signature-patterns.json` classifies the
// error TEXT, so that message matched nothing transport-level: on a wedged
// shard an `@stable` spec would be reported as an attributable hard failure and
// have its tag stripped by the daily's unreviewed auto-removal (#1031). An
// `undecided` verdict now carries the underlying error verbatim, so
// `apiRequestContext.get: Timeout` / `ECONNREFUSED` reach that classifier and
// the exemption works.
//
// Signal: GET /api/v1/all returns the component registry as
// `{ category: { ComponentType: {...template...} } }`. We inspect the
// second-level COMPONENT-TYPE keys only (never nested field names), so a field
// like `ollama_base_url` on the unified Language Model does not false-positive
// the Ollama component. A provider whose distribution is installed exposes a
// matching type (e.g. `ext:openai:OpenAIModelComponent@official`); an absent
// distribution leaves NO matching type key.
//
// KNOWN LIMITATION: the match is a substring, so a short token can hit a
// neighbouring component type (`openai` also matches `OpenAI Compatible`). Fine
// for the current callers, whose tokens (`groq`, `mistral`, `ollama`, `composio`) are
// unambiguous — `composio` measured on 1.13.0.dev15 as 0 hits across all 183 type keys
// and all 183 `component_display_names` keys (#1913).
//
// SCOPE — this probe stays the per-spec gate for providers that are NOT bundled
// in the image (groq, mistral — #1039; composio since #1913/#1916, and ollama, which
// carries the gate as insurance after the family RETURNED to the default image). The providers `collect-models` validates
// go through `probe-component-buildable.ts` instead (#900), which uses exact
// registry keys rather than this substring match AND adds the build layer this
// one cannot supply: a registry hit does not prove the component builds, as the
// trap above describes.

/**
 * What the probe could establish. `undecided` is not a soft `absent`: it means
 * the registry was never read, and no caller may turn it into a statement about
 * packaging (#1930).
 */
export type ComponentProbeVerdict =
  | { state: "present" }
  | { state: "absent" }
  | { state: "undecided"; reason: string };

export interface ProbeComponentOptions {
  /**
   * Override how the auth token is obtained. **Unit tests only** — a spec must
   * not pass it. `getAuthToken` carries a ~30 s retry budget by design (#1077),
   * which a unit test cannot wait out, and the thrown-auth path is exactly the
   * branch this helper exists to classify. Same convention as that helper's own
   * injected `sleep` (#1454).
   */
  getToken?: (request: APIRequestContext) => Promise<string>;
}

/** First non-blank line of a thrown value, capped — tolerant of a non-`Error` throw. */
function reasonFrom(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const line = raw.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 300) : fallback;
}

/**
 * Ask the running build whether a component matching `providerToken` is exposed.
 *
 * Never throws: every failure is an `undecided` verdict carrying its reason, so
 * the caller decides between skip and fail while the reason stays readable
 * (#1012). Callers must not describe an `undecided` as a packaging fact —
 * `undecidedProbeMessage()` is the one spelling for that case.
 */
export async function probeProviderComponent(
  request: APIRequestContext,
  providerToken: string,
  { getToken = getAuthToken }: ProbeComponentOptions = {},
): Promise<ComponentProbeVerdict> {
  const token = providerToken.toLowerCase();

  let auth: string;
  try {
    auth = await getToken(request);
  } catch (error) {
    return {
      state: "undecided",
      reason: `the auth token request failed: ${reasonFrom(error, "unknown error")}`,
    };
  }

  let res: Awaited<ReturnType<APIRequestContext["get"]>>;
  try {
    res = await request.get("/api/v1/all", {
      headers: auth ? { Authorization: auth } : undefined,
      timeout: 15000,
    });
  } catch (error) {
    return {
      state: "undecided",
      reason: `GET /api/v1/all did not answer: ${reasonFrom(error, "unknown error")}`,
    };
  }

  if (!res.ok()) {
    return {
      state: "undecided",
      reason: `GET /api/v1/all answered ${res.status()}`,
    };
  }

  let registry: Record<string, unknown>;
  try {
    registry = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    return {
      state: "undecided",
      reason: `GET /api/v1/all returned a body that is not JSON: ${reasonFrom(error, "unknown error")}`,
    };
  }

  if (!registry || typeof registry !== "object") {
    return {
      state: "undecided",
      reason: "GET /api/v1/all returned a body that is not a registry object",
    };
  }

  // FLOOR, the same one `catalogVerdict` needed (#980/#1012): a 200 carrying no
  // components at all is a registry that has not finished building, not a build
  // without this family. Without it, every family would read as `absent` and
  // every gated spec would skip with a packaging reason on a still-starting
  // instance. `component_display_names` is excluded from the count because it is
  // a metadata map rather than a category, and on its own it would satisfy the
  // floor while no component is registered; it stays IN the match below, where a
  // hit means the type really is in the catalog.
  let componentKeys = 0;
  let matched = false;
  for (const [topLevel, comps] of Object.entries(registry)) {
    if (!comps || typeof comps !== "object") continue;
    const keys = Object.keys(comps as Record<string, unknown>);
    if (topLevel !== "component_display_names") componentKeys += keys.length;
    if (!matched && keys.some((k) => k.toLowerCase().includes(token))) {
      matched = true;
    }
  }

  if (matched) return { state: "present" };
  if (componentKeys === 0) {
    return {
      state: "undecided",
      reason: "GET /api/v1/all answered 200 but registered no components at all",
    };
  }
  return { state: "absent" };
}

/**
 * The one spelling for what a caller says when the probe could not decide.
 *
 * Deliberately says what it is NOT: the sentence it replaces claimed a
 * distribution was missing, which is the misattribution #1930 was filed about.
 * The underlying `reason` is carried verbatim so that, on the caller that fails
 * rather than skips, `scripts/lib/infra-signature-patterns.json` can still
 * recognise a transport-level error and exempt the test from `@stable`
 * auto-removal (#1031).
 */
export function undecidedProbeMessage(
  providerToken: string,
  verdict: { state: "undecided"; reason: string },
): string {
  return (
    `Could not determine whether the \`${providerToken}\` component is exposed by this ` +
    `Langflow build — ${verdict.reason}. This is NOT a statement about packaging (#1930).`
  );
}
