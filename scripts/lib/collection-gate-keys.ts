/**
 * The env keys that gate COLLECTION, and whether a process would resolve them.
 *
 * WHAT A COLLECTION GATE IS, AND WHY IT IS NOT AN EXECUTION GATE
 *
 * Most provider-parametrized specs declare their tests unconditionally and skip at RUN
 * time with a reason, so a missing key costs a skip that every report shows. A few
 * generate their tests while the suite is being LISTED — `provider-invalid-auth-error`
 * iterates `keyedProviders` filtered by `hasProviderEnvKeys` — and there a missing key
 * costs the whole file: it collects zero tests, never enters the file-level partition,
 * and is handed to no shard. Not skipped, not red: absent (#1764).
 *
 * WHY THIS MODULE EXISTS SEPARATELY FROM THE SUITE
 *
 * The Actions lane's silent input was an empty `env:` block (#1764). #1796 proposes a
 * structural guard over it — `scripts/daily-matrix-provider-keys.test.mjs`, which does
 * NOT exist in this tree and lands only if that PR does, so nothing guards the Actions
 * side today. The VM twin's silent input is
 * `.env` — `playwright.config.ts` calls `dotenv.config()` unconditionally, so
 * `scripts/run-e2e.sh` lists whatever the operator's working copy happens to carry,
 * and names none of the three keys anywhere (#1813). A run cannot state which suite it
 * partitioned without asking this question BEFORE it lists, which is what this answers.
 *
 * DERIVED, never re-listed. `providerConfigMap` is the single source of per-provider
 * configuration, and a provider added there with `credential: "api-key"` becomes a
 * collection gate the moment a spec iterates it. Importing the map rather than parsing
 * it for names means the compiler, not a regex, decides what this set contains — and a
 * keyless provider (`ollama`, whose gate is a base URL) cannot drift into it.
 */
import {
  keyedProviders,
  type KeyedProvider,
} from "../../tests/helpers/provider-setup/provider-config";

/**
 * The shape both exported functions read — `keyedProviders`, injectable for tests.
 *
 * Widened to `readonly` on both axes so a literal fixture needs no cast: a cast is how
 * a fixture stops matching the real list without the compiler saying so.
 */
export type KeyedProviderList = ReadonlyArray<
  readonly [KeyedProvider, { readonly envKeys: readonly string[] }]
>;

export interface CollectionGate {
  /** Every env key that gates collection, in `providerConfigMap` order. */
  keys: string[];
  /** The subset this environment resolves. */
  present: string[];
  /** The subset it does not. */
  absent: string[];
  /** Providers whose tests WOULD be generated during a listing. */
  providersListed: KeyedProvider[];
  /** Providers whose tests would not — each one a file that can leave the matrix. */
  providersAbsent: KeyedProvider[];
  /** Whether every collection-gating key resolved. */
  complete: boolean;
  /** One line naming the suite this environment would list. Never carries a value. */
  summary: string;
}

/**
 * Every collection-gating key, derived from the provider config.
 *
 * Throws rather than returning `[]` when the derivation comes back empty. An empty set
 * is satisfied by every environment, including one that lost all three keys — the
 * vacuity #1796's guard had to add its own test for, arriving here as a report that
 * cheerfully says nothing is missing.
 */
export function collectionGateKeys(providers: KeyedProviderList = keyedProviders): string[] {
  const keys = providers.flatMap(([, config]) => [...config.envKeys]);
  if (keys.length === 0) {
    throw new Error(
      "no collection-gating key could be derived from providerConfigMap — the " +
        "derivation, not the environment, is what changed. A report built from an " +
        "empty set says every key is present.",
    );
  }
  return keys;
}

/**
 * Which of them `env` resolves.
 *
 * The per-provider verdict is `every(...)`, exactly as `hasProviderEnvKeys` computes it
 * — and "resolved" means truthy, so the EMPTY STRING is absent. That is not pedantry:
 * Actions renders an unknown secret as `""` and a `.env` line with nothing after the
 * `=` reads the same way, so both of the silent inputs this exists to expose arrive as
 * a declared-but-empty variable rather than as a missing one.
 *
 * `providers` is injected the way `defaultHistorySources` injects its filesystem
 * probe: every call site passes the real list, and the unit lane can exercise the
 * `every(...)` rule on a two-key provider, which the config does not have today and
 * which no test could otherwise reach without copying the rule it is checking.
 */
export function resolveCollectionGate(
  env: NodeJS.ProcessEnv = process.env,
  providers: KeyedProviderList = keyedProviders,
): CollectionGate {
  const keys = collectionGateKeys(providers);
  const resolved = (key: string) => !!env[key];

  const present = keys.filter(resolved);
  const absent = keys.filter((key) => !resolved(key));

  const providersListed: KeyedProvider[] = [];
  const providersAbsent: KeyedProvider[] = [];
  for (const [provider, config] of providers) {
    (config.envKeys.every(resolved) ? providersListed : providersAbsent).push(provider);
  }

  const complete = absent.length === 0;
  const listing = providersListed.length
    ? `listing with ${providersListed.join(", ")}`
    : "listing with no keyed provider";
  const summary = complete
    ? `${listing} — every collection-gating key resolved`
    : `${listing}; ${absent.join(", ")} absent`;

  return { keys, present, absent, providersListed, providersAbsent, complete, summary };
}

/**
 * The report as `key=value` lines — the shape both callers already parse.
 *
 * `scripts/run-e2e.sh` reads the same `key=value` block out of
 * `prepare-target-source.sh` with `sed`, and `$GITHUB_OUTPUT` is that format by
 * definition, so the listing step can append a line of this straight into it. Lists are
 * space-separated because no value here can contain a space: they are env var names and
 * provider ids, both of which the type system constrains.
 *
 * NAMES ONLY, never a value — the whole point is a report that is safe to print in a
 * log that gets pasted into an issue. `summary` is last because it is the one line with
 * spaces in its value, so a `sed -n 's/^summary=//p'` takes the rest of the line.
 */
export function renderGateLines(gate: CollectionGate): string[] {
  return [
    `keys=${gate.keys.join(" ")}`,
    `present=${gate.present.join(" ")}`,
    `absent=${gate.absent.join(" ")}`,
    `providers_listed=${gate.providersListed.join(" ")}`,
    `providers_absent=${gate.providersAbsent.join(" ")}`,
    `complete=${gate.complete}`,
    `summary=${gate.summary}`,
  ];
}
