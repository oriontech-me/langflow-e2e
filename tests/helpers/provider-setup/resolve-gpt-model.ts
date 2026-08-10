import { readCatalogText } from "./catalog-snapshot";

// Resolve a GPT chat model from models.json, preferring small general-purpose
// (vision-capable) ones. Returns undefined if none/absent — setup-openai then
// falls back to its UI preference-ranking over the live dropdown.
// Extracted verbatim from openai-provider.spec.ts (§7.2) for reuse by
// initialGPTsetup (#606): consumers must pin a deterministic GPT model instead
// of depending on catalog/dropdown ordering (same move as resolveGeminiModel
// for #596).
export function resolveGptModel(): string | undefined {
  // The run's FROZEN catalog when there is one (#1386) — the sibling of
  // `resolveGeminiModel`, kept on the same source so a run resolves ONE catalog. No
  // title depends on this one today, but a consumer that starts interpolating it
  // would otherwise silently reintroduce the identity race.
  const raw = readCatalogText();
  if (raw === undefined) return undefined;
  const models = JSON.parse(raw) as Array<{
    provider: string;
    model: string;
  }>;
  const openai = models.filter((m) => m.provider === "openai").map((m) => m.model);
  const prefs = [/^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-4\.1(-mini|-nano)?$/, /^gpt-4/];
  for (const pref of prefs) {
    const hit = openai.find((m) => pref.test(m));
    if (hit) return hit;
  }
  return openai[0];
}
