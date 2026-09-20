import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { readFailureReason } from "../../fixtures/http-error-body";

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

// The reason string comes from `readFailureReason` (`tests/fixtures/http-error-body.ts`,
// #1432) rather than from a second reader written here. The first draft of this file
// did write one, and review measured it doing precisely what #1432 records: `message`
// is TYPED `string` while being a plain own property, so a thrown `Error` carrying a
// `Symbol` there — or a `message` getter that throws — made `raw.split()` throw. That
// turns this probe, whose whole contract is "never throws", into the thing that
// reddens the run: the three skip sites would FAIL instead of skipping, and at ollama
// the failure text would be `raw.split is not a function`, which classifies as nothing
// transport-level and strips `@stable` unreviewed (#1031) — the exact harm this file
// exists to remove. That module is a leaf with no imports of its own, so there is no
// cycle, and one spelling beats two that are supposed to agree.

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
      reason: `the auth token request failed: ${readFailureReason(error)}`,
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
      reason: `GET /api/v1/all did not answer: ${readFailureReason(error)}`,
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
      reason: `GET /api/v1/all returned a body that is not JSON: ${readFailureReason(error)}`,
    };
  }

  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    // An array passes `typeof x === "object"`, so it has to be named here or it
    // falls through to the floor below and is reported as a registry that
    // registered nothing — a true verdict with a false description, which is the
    // class of thing this file exists to stop.
    return {
      state: "undecided",
      reason: "GET /api/v1/all returned a body that is not a registry object",
    };
  }

  // FLOOR, the same one `catalogVerdict` needed (#980/#1012): a 200 that
  // registered nothing is a body this probe could not read as a catalog, not a
  // build without this family. Without it such a body makes every gated spec skip
  // with a packaging reason.
  //
  // What is actually reachable here, stated rather than assumed: a 200 whose body
  // is not a registry (a gateway or auth JSON error — `{"detail": "…"}` — which
  // `snapshotCatalog` already normalises to zero categories), and a catalog left
  // empty by the governance filter. The intuitive case, a registry still building,
  // is NOT demonstrated: `GET /api/v1/all` awaits `get_and_cache_all_types_dict()`
  // and answers 500 on any exception, so it does not appear to serve a partial
  // 200 — the floor is kept for the reachable shapes and this sentence records
  // that the third one is unverified rather than implying it was measured.
  // `component-catalog-drift.ts` reads the opposite as measured ("an empty
  // registry is what an instance whose registry is still building answers, ~11 s
  // after /api/v1/version starts answering"), and the two are not reconciled
  // here: `snapshotCatalog` normalises a non-2xx and an error envelope to zero
  // categories alike, so that observation does not by itself establish a partial
  // 200. Either way this probe answers `undecided`, so nothing turns on which it
  // was — recorded so the next reader does not re-derive it.
  //
  // KNOWN LIMIT of the floor, since it is shape-based rather than value-based: a
  // 200 carrying an object- or array-valued `detail` (a proxy's nested JSON
  // error) counts as a category with components and comes back `absent`, with
  // the packaging sentence. FastAPI emits those shapes at 422, which is already
  // non-ok and therefore `undecided`, so this needs a proxy answering 200 to be
  // reachable at all.
  //
  // `component_display_names` is excluded from the COUNT (it is a metadata map,
  // not a category) and kept in the MATCH, where a hit means the type really is
  // in the catalog — upstream derives that map from the same dict the categories
  // come from, so it is non-empty iff something is registered.
  let componentKeys = 0;
  let categories = 0;
  let matched = false;
  for (const [topLevel, comps] of Object.entries(registry)) {
    if (!comps || typeof comps !== "object") continue;
    const keys = Object.keys(comps as Record<string, unknown>);
    // The metadata map is not a category, so it is excluded from BOTH tallies —
    // otherwise a body carrying nothing but the map reports "registered no
    // components" when what it carried was no category at all.
    if (topLevel !== "component_display_names") {
      categories += 1;
      componentKeys += keys.length;
    }
    if (!matched && keys.some((k) => k.toLowerCase().includes(token))) {
      matched = true;
    }
  }

  // The floor is consulted BEFORE the match, deliberately: a hit found only in the
  // metadata map of a body that registered no component is not a component this
  // build exposes. Upstream cannot produce that state, so this is about the code
  // meaning what its comment says rather than about a reachable bug.
  if (componentKeys === 0) {
    return {
      state: "undecided",
      reason:
        categories === 0
          ? "GET /api/v1/all answered 200 with a body carrying no component categories"
          : "GET /api/v1/all answered 200 but registered no components at all",
    };
  }
  if (matched) return { state: "present" };
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
