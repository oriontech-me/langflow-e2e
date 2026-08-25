/**
 * Mutually exclusive run lanes (`@destructive`, `@enterprise`, `@serving`).
 *
 * Three tags in this suite are LANE SELECTORS, not severities: a test carrying
 * one of them must not run in a normal invocation, because the environment it
 * needs is not the environment a normal run has.
 *
 *  - `@destructive` mutates account-wide state (see the note in
 *    `playwright.config.ts`).
 *  - `@enterprise` targets a Langflow ENTERPRISE instance, whose surface the OSS
 *    nightly does not serve. Running such a spec against the OSS runner does not
 *    produce a meaningful failure — it produces a permanent red that says
 *    nothing about the product.
 *  - `@serving` targets the SAME OSS image under a different configuration: the
 *    serving-plane end-user identity feature (upstream #14443/#14550) is off by
 *    default and turned on only by instance-global environment variables, so the
 *    cross-user memory boundary it provides is unreachable from any other lane.
 *    A spec that gated on the settings and skipped would skip everywhere, which
 *    is the green all-skip #1010 exists to prevent. Start the variant with
 *    `scripts/start-langflow-serving-identity.sh`.
 *
 * The exclusion uses `grepInvert` for the reason the destructive lane already
 * documents: a CLI `--grep` overrides `config.grep` but leaves `config.grepInvert`
 * in place, so no caller can widen the lane by passing a filter of its own.
 *
 * Two of the three run serially, for different reasons: `@destructive` because
 * two account wipers would erase each other, `@enterprise` because the instance
 * rate-limits login and every worker has to authenticate. Same knob, different
 * cause — stated here so neither is "cleaned up" as redundant.
 *
 * `@serving` runs PARALLEL, and that is a decision rather than an omission:
 * neither cause above applies. The variant keeps `auto_login`, so there is no
 * login budget to exhaust, and the isolation under test is keyed per
 * `session_id`, so every test owns its own bucket and none mutates account-wide
 * state. `lane.test.ts` asserts `serial === false` for this lane, so flipping it
 * to match its neighbours fails a test instead of silently costing ~4x wall
 * clock.
 *
 * The lanes are mutually exclusive on purpose. There is no combined lane, and
 * any PAIR of these tags on one test is unrunnable in every lane — which is why
 * `lane.test.ts` pins that a test can only ever be selected by exactly one.
 */

export interface LaneResolution {
  /** Value for `config.grepInvert`; `undefined` means "exclude nothing". */
  grepInvert: RegExp | undefined;
  /** Lines to print (stderr) so an exclusion is never a silent cap. */
  notices: string[];
  /** True when the lane must serialise (destructive tests wipe each other). */
  serial: boolean;
}

export interface LaneEnv {
  PW_DESTRUCTIVE?: string;
  PW_ENTERPRISE?: string;
  PW_SERVING_IDENTITY?: string;
}

const DESTRUCTIVE_HINT =
  "[lane] @destructive tests are excluded from this run — run them with: PW_DESTRUCTIVE=1 npx playwright test --grep @destructive";
const ENTERPRISE_HINT =
  "[lane] @enterprise tests are excluded from this run — point PLAYWRIGHT_BASE_URL at an Enterprise instance and run: PW_ENTERPRISE=1 npx playwright test --grep @enterprise";
const SERVING_HINT =
  "[lane] @serving tests are excluded from this run — start the variant with ./scripts/start-langflow-serving-identity.sh, then: PW_SERVING_IDENTITY=1 npx playwright test --grep @serving";

/**
 * Resolve the lane from the environment.
 *
 * More than one flag set is not an error the config can usefully refuse — the
 * lanes need different instances — so one wins by a FIXED precedence and the
 * caller is told, rather than silently getting one of them. The order is
 * `@enterprise` > `@serving` > `@destructive`, by how specialised an instance
 * each demands: Enterprise needs a separate build, serving-identity needs the
 * same image under different configuration, destructive needs only isolation.
 */
export function resolveLane(env: LaneEnv = process.env as LaneEnv): LaneResolution {
  const enterprise = !!env.PW_ENTERPRISE;
  const destructive = !!env.PW_DESTRUCTIVE;
  const serving = !!env.PW_SERVING_IDENTITY;

  const requested = [
    enterprise ? "PW_ENTERPRISE" : null,
    serving ? "PW_SERVING_IDENTITY" : null,
    destructive ? "PW_DESTRUCTIVE" : null,
  ].filter((flag): flag is string => flag !== null);

  // Winner first in `requested` — the array is built in precedence order.
  const ambiguity =
    requested.length > 1
      ? [
          `[lane] ${requested.join(" and ")} are both set; the ${
            enterprise ? "enterprise" : "serving-identity"
          } lane wins and the others stay excluded.`,
        ]
      : [];

  if (enterprise) {
    // Serial for a measured reason, not for isolation. An Enterprise instance
    // runs password-first — there is no `auto_login` for the suite to use — so
    // every worker has to authenticate, and Langflow rate-limits `/api/v1/login`
    // per IP. Parallel workers exhaust that budget, which is how the first run
    // of this lane reported product assertions as 429s.
    return {
      grepInvert: /@destructive|@serving/,
      notices: ambiguity.length ? ambiguity : [DESTRUCTIVE_HINT, SERVING_HINT],
      serial: true,
    };
  }

  if (serving) {
    // PARALLEL on purpose — see the header. Pinned by `lane.test.ts`.
    return {
      grepInvert: /@destructive|@enterprise/,
      notices: ambiguity.length ? ambiguity : [DESTRUCTIVE_HINT, ENTERPRISE_HINT],
      serial: false,
    };
  }

  if (destructive) {
    return {
      grepInvert: /@enterprise|@serving/,
      notices: [ENTERPRISE_HINT, SERVING_HINT],
      serial: true,
    };
  }

  return {
    grepInvert: /@destructive|@enterprise|@serving/,
    notices: [DESTRUCTIVE_HINT, ENTERPRISE_HINT, SERVING_HINT],
    serial: false,
  };
}
