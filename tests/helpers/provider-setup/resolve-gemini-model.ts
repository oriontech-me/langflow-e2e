import path from "path";
import fs from "fs";

// Resolve a Gemini flash chat model from models.json, preferring fast, cheap,
// non-image/non-tts/non-preview ones. Returns undefined if none/absent — then
// setup-google picks its default (first gemini option in the dropdown).
// Extracted verbatim from google-provider.spec.ts (§7.4) for reuse by
// language-model-regression.spec.ts (#596): tests must pin a deterministic
// Gemini model instead of depending on catalog/dropdown ordering.
export function resolveGeminiModel(): string | undefined {
  const jsonPath = path.resolve(__dirname, "data/models.json");
  if (!fs.existsSync(jsonPath)) return undefined;
  const models = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Array<{
    provider: string;
    model: string;
  }>;
  const google = models
    .filter((m) => m.provider === "google")
    .map((m) => m.model)
    // Google retired `gemini-2.5-flash` for new users — it 404s ("no longer
    // available to new users") at call time, so the Agent build fails and the
    // spec times out waiting for a reply. Exclude the exact retired id from
    // every preference below so it can never be selected, even as a fallback
    // (same model-lifecycle trap as the RAG answer model in #880).
    .filter((m) => m !== "gemini-2.5-flash");
  const bad = /image|tts|audio|preview|embedding|customtools/;
  const prefs = [
    // Prefer the floating alias first: it always resolves to Google's current
    // flash model, so the resolver tracks the provider's lifecycle instead of
    // pinning a dated id that gets retired (the #880 lesson). Then the live
    // dated flash models, then any non-excluded gemini flash / gemini.
    (m: string) => /^gemini-flash-latest$/.test(m),
    (m: string) => /^gemini-3\.\d+-flash$/.test(m),
    (m: string) => /gemini.*flash/.test(m) && !bad.test(m),
    (m: string) => /gemini/.test(m) && !bad.test(m),
  ];
  for (const pref of prefs) {
    const hit = google.find(pref);
    if (hit) return hit;
  }
  return google[0];
}
