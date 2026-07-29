// Unit tests for the collect-models BUILD axis (issue #900).
// Run with: npm run test:units
//
// What rides on these functions: whether `collect-models` records a provider
// `active` on an image that cannot actually instantiate its component. Getting it
// wrong in either direction is expensive.
//
// - Too permissive (the pre-#900 behavior): a valid key on an image missing the
//   provider's package records `active`, and the real failure surfaces tens of
//   layers downstream as a generic node-build timeout. That cost a full triage
//   cycle twice — #898 (`langchain-google-genai`, LE-1974, ~17 Google @stable
//   specs) and #907 (`langchain-groq` / `langchain-mistralai`, LE-1987).
// - Too strict: a credentials error misread as a packaging failure would record
//   every provider `inactive` and fail the gate on every run, forever. The probe
//   builds with NO key on purpose, so a credentials error is the EXPECTED shape.
//
// Every error string below is verbatim from a build against a live
// 1.12.0.dev8 (`langflowai/langflow-nightly:latest`, image built 2026-07-28).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_COMPONENTS,
  buildAxisReason,
  isBuildAxisReason,
  isPackagingError,
  missingComponentKeys,
} from "./probe-component-buildable";

// ─── Verbatim build errors, 1.12.0.dev8 ───────────────────────────────────────

/**
 * The packaging failure, captured by hiding `site-packages/langchain_anthropic`
 * and restarting the backend. Note it is Langflow's own standardised wording, not
 * the component's ad-hoc `"langchain_anthropic is not installed"` message — the
 * matcher has to accept both, because which one surfaces depends on whether the
 * component guards its import.
 */
const MISSING_MODULE =
  "No module named 'langchain_anthropic'. This flow needs a Python package that " +
  "is not installed in this environment.\n\nInstall it and re-run:";

/** The component's own guarded-import message (`lfx_anthropic/.../anthropic.py`). */
const NOT_INSTALLED =
  "Error building Component Anthropic: \n\nlangchain_anthropic is not installed. " +
  "Please install it with `pip install langchain_anthropic`.";

/** The #898 / LE-1974 shape, as quoted in that issue. */
const COULD_NOT_IMPORT =
  "ImportError: Could not import 'langchain_google_genai.chat_models'. " +
  "Install the missing package.";

/**
 * The four credentials errors the probe actually produces on a healthy image.
 * Each one PROVES the client class was imported and constructed, so each must
 * classify as "not a packaging error".
 */
const CREDENTIALS_ERRORS = [
  "Error building Component OpenAI: \n\nMissing credentials. Please pass an " +
    "`api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` " +
    "or `OPENAI_ADMIN_KEY` environment variable.",
  "Error building Component Anthropic: \n\nError running method \"text_response\": " +
    '"Could not resolve authentication method. Expected one of api_key, auth_token, ' +
    'or credentials to be set."',
  "Error building Component Google Generative AI: \n\n1 validation error for " +
    "ChatGoogleGenerativeAI\n  Value error, API key required for Gemini Developer API.",
  "Error building Component Google Generative AI Embeddings: \n\nAPI Key is required",
];

// ─── missingComponentKeys ─────────────────────────────────────────────────────

test("missingComponentKeys: reports nothing when every declared key is present", () => {
  const registry = {
    openai: { "ext:openai:OpenAIModelComponent@official": {} },
    anthropic: { "ext:anthropic:AnthropicModelComponent@official": {} },
  };
  assert.deepEqual(
    missingComponentKeys(registry, [
      "ext:openai:OpenAIModelComponent@official",
      "ext:anthropic:AnthropicModelComponent@official",
    ]),
    [],
  );
});

test("missingComponentKeys: reports a key whose distribution is not installed", () => {
  const registry = { openai: { "ext:openai:OpenAIModelComponent@official": {} } };
  assert.deepEqual(
    missingComponentKeys(registry, [
      "ext:openai:OpenAIModelComponent@official",
      "ext:groq:GroqModel@official",
    ]),
    ["ext:groq:GroqModel@official"],
  );
});

test("missingComponentKeys: ignores the component_display_names pseudo-category", () => {
  // /api/v1/all carries a lowercased echo of every type under this key. Counting
  // it would report a component as present after its real category is gone.
  const registry = {
    component_display_names: { "ext:anthropic:anthropicmodelcomponent@official": {} },
  };
  assert.deepEqual(
    missingComponentKeys(registry, ["ext:anthropic:AnthropicModelComponent@official"]),
    ["ext:anthropic:AnthropicModelComponent@official"],
  );
});

test("missingComponentKeys: matches exactly, so a neighbouring component cannot satisfy a key", () => {
  // The pre-#900 probe used `componentType.includes(token)`, so the token
  // `openai` was satisfied by `OpenAI Compatible`. Exact keys close that hole.
  const registry = {
    openai_compatible: { "ext:openai_compatible:OpenAICompatibleModel@official": {} },
  };
  assert.deepEqual(
    missingComponentKeys(registry, ["ext:openai:OpenAIModelComponent@official"]),
    ["ext:openai:OpenAIModelComponent@official"],
  );
});

test("missingComponentKeys: an empty registry reports every key missing", () => {
  assert.deepEqual(missingComponentKeys({}, ["a", "b"]), ["a", "b"]);
});

// ─── isPackagingError ─────────────────────────────────────────────────────────

test("isPackagingError: recognises Langflow's standardised missing-module message", () => {
  assert.equal(isPackagingError(MISSING_MODULE), true);
});

test("isPackagingError: recognises a component's own guarded-import message", () => {
  assert.equal(isPackagingError(NOT_INSTALLED), true);
});

test("isPackagingError: recognises the #898 Could not import shape", () => {
  assert.equal(isPackagingError(COULD_NOT_IMPORT), true);
});

test("isPackagingError: a credentials error is NOT a packaging error", () => {
  // This is the load-bearing negative: the probe builds with no key ON PURPOSE,
  // so these are the expected errors on a perfectly healthy image. Matching them
  // would fail the gate on every run.
  for (const message of CREDENTIALS_ERRORS) {
    assert.equal(isPackagingError(message), false, `should not match: ${message}`);
  }
});

test("isPackagingError: an empty or absent message is NOT a packaging error", () => {
  assert.equal(isPackagingError(""), false);
  assert.equal(isPackagingError(undefined), false);
});

// ─── buildAxisReason ──────────────────────────────────────────────────────────

test("buildAxisReason: a distribution failure names the layer and the missing keys", () => {
  const reason = buildAxisReason({
    layer: "distribution",
    missing: ["ext:google:GoogleGenerativeAIComponent@official"],
  });
  // The operator fix differs per layer, so the layer must be named explicitly.
  assert.match(reason, /distribution/i);
  assert.match(reason, /ext:google:GoogleGenerativeAIComponent@official/);
});

test("buildAxisReason: a runtime-package failure names the layer and quotes Langflow's error", () => {
  const reason = buildAxisReason({
    layer: "runtime-package",
    component: "ext:anthropic:AnthropicModelComponent@official",
    message: MISSING_MODULE,
  });
  assert.match(reason, /runtime package/i);
  assert.match(reason, /ext:anthropic:AnthropicModelComponent@official/);
  assert.match(reason, /No module named 'langchain_anthropic'/);
});

test("buildAxisReason: the reason never matches the billing/quota downgrade", () => {
  // collect-models.spec.ts downgrades a BILLING_OR_QUOTA inactive to a warning.
  // A packaging failure must NOT be downgraded — it has to fail the gate loud,
  // which is the whole point of #900. Kept in sync with that spec by hand.
  const BILLING_OR_QUOTA =
    /credit balance is too low|insufficient[_ ]?quota|exceeded your current quota|\bquota\b|resource[_ ]?exhausted|billing|spend(?:ing)?[ _-]?cap|payment required|\b402\b|\b429\b/i;
  const reasons = [
    buildAxisReason({ layer: "distribution", missing: ["ext:groq:GroqModel@official"] }),
    buildAxisReason({
      layer: "runtime-package",
      component: "ext:anthropic:AnthropicModelComponent@official",
      message: MISSING_MODULE,
    }),
  ];
  for (const reason of reasons) {
    assert.equal(BILLING_OR_QUOTA.test(reason), false, `must fail loud, not warn: ${reason}`);
  }
});

// ─── isBuildAxisReason ────────────────────────────────────────────────────────

test("isBuildAxisReason: recognises both layers' reasons", () => {
  // The spec asserts on this predicate to cover providers the `hardFailures`
  // check cannot see (see the next test), so it has to recognise every reason
  // buildAxisReason can emit.
  assert.equal(
    isBuildAxisReason(buildAxisReason({ layer: "distribution", missing: ["x"] })),
    true,
  );
  assert.equal(
    isBuildAxisReason(
      buildAxisReason({ layer: "runtime-package", component: "x", message: MISSING_MODULE }),
    ),
    true,
  );
});

test("isBuildAxisReason: a key-axis error is not a build-axis reason", () => {
  // Verbatim from a real providers.json — a drained Anthropic balance. Claiming
  // this as a build failure would blame the image for an ops state.
  assert.equal(
    isBuildAxisReason(
      "3 of 13 candidate model(s) failed validation with the SAME model-independent " +
        "error; last error: Your credit balance is too low to access the Anthropic API.",
    ),
    false,
  );
  assert.equal(isBuildAxisReason("OPENAI_API_KEY not set"), false);
  assert.equal(isBuildAxisReason(null), false);
});

// ─── PROVIDER_COMPONENTS ──────────────────────────────────────────────────────

test("PROVIDER_COMPONENTS: every provider collect-models validates declares at least one component", () => {
  // A provider with an empty list would pass the build axis vacuously — the exact
  // false `active` #900 exists to remove.
  for (const provider of ["openai", "anthropic", "google"] as const) {
    assert.ok(
      PROVIDER_COMPONENTS[provider]?.length > 0,
      `provider "${provider}" declares no component key`,
    );
  }
});
