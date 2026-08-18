/**
 * Mutually exclusive run lanes (#destructive, #enterprise).
 *
 * Two tags in this suite are LANE SELECTORS, not severities: a test carrying
 * one of them must not run in a normal invocation, because the environment it
 * needs is not the environment a normal run has.
 *
 *  - `@destructive` mutates account-wide state (see the note in
 *    `playwright.config.ts`).
 *  - `@enterprise` targets a Langflow ENTERPRISE instance, whose surface the OSS
 *    nightly does not serve. Running such a spec against the OSS runner does not
 *    produce a meaningful failure — it produces a permanent red that says
 *    nothing about the product.
 *
 * The exclusion uses `grepInvert` for the reason the destructive lane already
 * documents: a CLI `--grep` overrides `config.grep` but leaves `config.grepInvert`
 * in place, so no caller can widen the lane by passing a filter of its own.
 *
 * Both opt-in lanes run serially, for different reasons: `@destructive` because
 * two account wipers would erase each other, `@enterprise` because the instance
 * rate-limits login and every worker has to authenticate. Same knob, different
 * cause — stated here so neither is "cleaned up" as redundant.
 *
 * The lanes are mutually exclusive on purpose. There is no combined lane, and
 * `@destructive @enterprise` on the same test would be unrunnable in every
 * lane — which is why `lane.test.ts` pins that a test can only ever be selected
 * by exactly one of them.
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
}

const DESTRUCTIVE_HINT =
  "[lane] @destructive tests are excluded from this run — run them with: PW_DESTRUCTIVE=1 npx playwright test --grep @destructive";
const ENTERPRISE_HINT =
  "[lane] @enterprise tests are excluded from this run — point PLAYWRIGHT_BASE_URL at an Enterprise instance and run: PW_ENTERPRISE=1 npx playwright test --grep @enterprise";

/**
 * Resolve the lane from the environment.
 *
 * Both flags set is not an error the config can usefully refuse — the two
 * lanes need different instances — so `PW_ENTERPRISE` wins and the caller is
 * told, rather than silently getting one of the two.
 */
export function resolveLane(env: LaneEnv = process.env as LaneEnv): LaneResolution {
  const enterprise = !!env.PW_ENTERPRISE;
  const destructive = !!env.PW_DESTRUCTIVE;

  if (enterprise && destructive) {
    return {
      grepInvert: /@destructive/,
      notices: [
        "[lane] PW_ENTERPRISE and PW_DESTRUCTIVE are both set; the enterprise lane wins and @destructive stays excluded.",
      ],
      serial: true,
    };
  }

  if (enterprise) {
    // Serial for a measured reason, not for isolation. An Enterprise instance
    // runs password-first — there is no `auto_login` for the suite to use — so
    // every worker has to authenticate, and Langflow rate-limits `/api/v1/login`
    // per IP. Parallel workers exhaust that budget, which is how the first run
    // of this lane reported product assertions as 429s.
    return { grepInvert: /@destructive/, notices: [DESTRUCTIVE_HINT], serial: true };
  }

  if (destructive) {
    return { grepInvert: /@enterprise/, notices: [ENTERPRISE_HINT], serial: true };
  }

  return {
    grepInvert: /@destructive|@enterprise/,
    notices: [DESTRUCTIVE_HINT, ENTERPRISE_HINT],
    serial: false,
  };
}
