/**
 * Is a provider ALREADY configured in the model-provider panel?
 *
 * Split out of `setup-google.ts` (#1262) because this one boolean decides
 * whether the helper writes the API key field, and writing it over a provider
 * that already holds a credential stores a key Langflow cannot use — the next
 * build then fails with
 *
 *   Error calling model 'gemini-flash-latest' (INVALID_ARGUMENT): 400 …
 *   'API key not valid. Please pass a valid API key.' … API_KEY_INVALID
 *
 * and the spec times out on its build observable with no hint of why. That is
 * the recurrent shape of `language-model-regression.spec.ts` on the 2026-07-09 /
 * 07-14 / 07-15 dailies (`text=built successfully`) and of the first attempt on
 * 2026-08-04 (`node_duration_chat output`).
 *
 * Two signals, because neither alone is reliable at the moment the panel opens:
 *
 *  - the **Disconnect** button is the panel's explicit "configured" affordance,
 *    but it paints only after the panel's backend fetch resolves — the previous
 *    1s `isVisible` probe decided "not configured" while that fetch was still in
 *    flight;
 *  - a **non-empty key field** is decisive on its own: Langflow renders a stored
 *    credential masked (`AIza••••…`), and an unconfigured provider renders the
 *    field empty with a placeholder. A masked value can never be a value this
 *    helper typed, so treating it as "configured" cannot skip a setup that was
 *    genuinely needed.
 */
export interface ProviderPanelState {
  /** Whether the panel's Disconnect button is visible right now. */
  disconnectVisible: boolean;
  /**
   * Current value of the API key input — `""` when absent or empty. The masked
   * form Langflow renders (bullets) counts as a value.
   */
  keyFieldValue: string;
}

export function providerAlreadyConfigured(state: ProviderPanelState): boolean {
  if (state.disconnectVisible) return true;
  return state.keyFieldValue.trim().length > 0;
}
