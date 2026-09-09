/**
 * Parses a `--name=value` CLI flag into a validated non-negative number,
 * refusing rather than silently no-opping on a malformed value.
 *
 * Extracted (Task 3 review fix, issue #1769) out of
 * `update-component-catalog-baseline.ts`, which still re-exports it so its own
 * test file's import path and `typeof parseNumericArg === "function"`
 * assertion keep working unchanged. Shared by the two baseline writers that
 * gate a write behind a plausibility floor -- that script's `--min-categories`
 * and `update-inherited-backlog-baseline.ts`'s `--min-specs` -- because both
 * read a committed baseline as ground truth for a downstream guard: an
 * implausibly small (or, without this, malformed-and-therefore-unchecked)
 * baseline is permanent and silent rather than a loud, reviewable refusal.
 */
export function parseNumericArg(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const raw = argv.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
  if (raw === undefined) return fallback;
  // `Number("")` and `Number(" ")` are 0, which is finite and non-negative — so
  // an empty value (e.g. `--min-categories=`) used to disable a plausibility
  // floor silently, reaching the same state as an explicit override without the
  // explicit opt-in that makes an override legitimate. Disabling a guard must
  // be asked for.
  if (raw.trim() === "") {
    throw new Error(`${name} was given no value — pass a number, e.g. ${name}=20`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}
