import path from "path";
import fs from "fs";

const ASSET_SUBDIRS = ["media", "files", "flows"] as const;

/**
 * Resolve a test fixture by bare filename against `tests/assets/{media,files,flows}`.
 *
 * The 1fdc703 restructure moved all fixtures under those subdirectories, but
 * several specs/helpers kept pre-restructure relative paths and failed with a
 * cryptic ENOENT (#613). Resolving by probe keeps callers independent of which
 * subdirectory a fixture lives in, and a missing fixture fails with a clear
 * message instead.
 */
export function resolveAssetPath(fileName: string): string {
  for (const sub of ASSET_SUBDIRS) {
    const candidate = path.join(__dirname, `../../assets/${sub}/${fileName}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `asset "${fileName}" not found under tests/assets/{${ASSET_SUBDIRS.join(",")}} (#613)`,
  );
}
