// Unit tests for the "is this provider already configured?" predicate (#1262).
// Run with: npm run test:units
//
// What rides on it: whether `setup-google.ts` writes the API key field. Writing
// it over a provider that already holds a credential stores an unusable key, and
// the failure surfaces two steps later as a build that never completes — which
// is how it stayed unattributed across four dailies.
//
// Measured on 1.12.0.dev15: 1 failure in 7 runs of
// `language-model-regression.spec.ts:135`, the failing one calling Google with a
// key it rejected (`API_KEY_INVALID`), the 6 clean ones observing the field
// masked as `AIza•••••••••••••••••••••••••••••••••••`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerAlreadyConfigured } from "./provider-config-state";

/** Verbatim from the panel on a configured Google provider. */
const MASKED = "AIza•••••••••••••••••••••••••••••••••••";

test("Disconnect visible ⇒ configured", () => {
  assert.equal(
    providerAlreadyConfigured({ disconnectVisible: true, keyFieldValue: "" }),
    true,
  );
});

test("a masked key counts as configured even before Disconnect paints", () => {
  // This is the case the old 1s isVisible probe got wrong: the panel's fetch was
  // still in flight, Disconnect had not rendered, and the helper re-filled.
  assert.equal(
    providerAlreadyConfigured({
      disconnectVisible: false,
      keyFieldValue: MASKED,
    }),
    true,
  );
});

test("an empty field with no Disconnect ⇒ NOT configured (setup must still run)", () => {
  // The inverse must keep working, or a fresh CI container never gets a key.
  assert.equal(
    providerAlreadyConfigured({ disconnectVisible: false, keyFieldValue: "" }),
    false,
  );
  assert.equal(
    providerAlreadyConfigured({
      disconnectVisible: false,
      keyFieldValue: "   ",
    }),
    false,
  );
});
