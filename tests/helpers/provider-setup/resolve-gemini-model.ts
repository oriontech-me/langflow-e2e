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
  const google = models.filter((m) => m.provider === "google").map((m) => m.model);
  const bad = /image|tts|audio|preview|embedding|customtools/;
  const prefs = [
    (m: string) => /^gemini-2\.5-flash$/.test(m),
    (m: string) => /^gemini-3\.5-flash$/.test(m),
    (m: string) => /^gemini-flash-latest$/.test(m),
    (m: string) => /gemini.*flash/.test(m) && !bad.test(m),
    (m: string) => /gemini/.test(m) && !bad.test(m),
  ];
  for (const pref of prefs) {
    const hit = google.find(pref);
    if (hit) return hit;
  }
  return google[0];
}
