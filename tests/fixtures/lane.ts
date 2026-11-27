/**
 * Mutually exclusive run lanes (`@destructive`, `@enterprise`, `@serving`,
 * `@instance-migration`, `@background-worker`).
 *
 * Five tags in this suite are LANE SELECTORS, not severities: a test carrying
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
 *  - `@instance-migration` targets a SOURCE Langflow with instance migration
 *    (Settings > Migration) turned on, plus the two destinations it copies into
 *    — PostgreSQL with pgvector, and an S3-compatible bucket (#2347). The routes
 *    are mounted only when `LANGFLOW_FEATURE_INSTANCE_MIGRATION=true` at process
 *    start, and nothing else in the suite starts those destinations. Start it with
 *    `scripts/start-langflow-instance-migration.sh`.
 *  - `@background-worker` targets the SAME OSS image with the database-backed
 *    background backend (`LANGFLOW_BACKGROUND_BACKEND=scaled`, upstream #13508):
 *    a v2 background run is only QUEUED by the API and executed by a separate
 *    `langflow worker` process on the same database. The default in-process
 *    backend starts a job the moment its 202 returns, so nothing ever waits in a
 *    queue there, and a job held while no worker runs, cancelled while queued, or
 *    refused at start once its API key is gone is unreachable from every other
 *    lane (#2574, #2573). The VM daily starts it (`E2E_LANES`); by hand, start a
 *    source instance with the variable and `scripts/start-langflow-worker.sh`.
 *
 * The exclusion uses `grepInvert` for the reason the destructive lane already
 * documents: a CLI `--grep` overrides `config.grep` but leaves `config.grepInvert`
 * in place, so no caller can widen the lane by passing a filter of its own.
 *
 * Four of the five run serially, for different reasons: `@destructive` because
 * two account wipers would erase each other, `@enterprise` because the instance
 * rate-limits login and every worker has to authenticate, `@instance-migration`
 * because the migration is ONE record per instance and its pause is
 * instance-global — while it is on, every write outside the migration routes
 * answers 503, so a second worker's test fails mid-flight, and two tests walking
 * the steps would overwrite each other's record, `@background-worker` because the
 * worker is ONE process the instance shares and its tests assert what happens to
 * the queue around it. Same knob, four causes — stated here so none is "cleaned up"
 * as redundant.
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
  PW_INSTANCE_MIGRATION?: string;
  PW_BACKGROUND_WORKER?: string;
}

const DESTRUCTIVE_HINT =
  "[lane] @destructive tests are excluded from this run — run them with: PW_DESTRUCTIVE=1 npx playwright test --grep @destructive";
const ENTERPRISE_HINT =
  "[lane] @enterprise tests are excluded from this run — point PLAYWRIGHT_BASE_URL at an Enterprise instance and run: PW_ENTERPRISE=1 npx playwright test --grep @enterprise";
const SERVING_HINT =
  "[lane] @serving tests are excluded from this run — start the variant with ./scripts/start-langflow-serving-identity.sh, then: PW_SERVING_IDENTITY=1 npx playwright test --grep @serving";
const INSTANCE_MIGRATION_HINT =
  "[lane] @instance-migration tests are excluded from this run — start the lane with ./scripts/start-langflow-instance-migration.sh, then: PW_INSTANCE_MIGRATION=1 npx playwright test --grep @instance-migration";
const BACKGROUND_WORKER_HINT =
  "[lane] @background-worker tests are excluded from this run — start an instance with LANGFLOW_BACKGROUND_BACKEND=scaled (scripts/start-langflow-source.sh) and, for the worker variant, ./scripts/start-langflow-worker.sh beside it, then: PW_BACKGROUND_WORKER=1 npx playwright test --grep @background-worker";

/**
 * Every lane selector, in PRECEDENCE order (see resolveLane). One row per lane, so a
 * new lane is one row here rather than an edit to every other lane's exclusion.
 *
 * `serial` is each lane's own decision, pinned by `lane.test.ts`:
 *  - enterprise: login is rate-limited per IP and there is no auto_login.
 *  - instance-migration: one migration record per instance, and its pause answers
 *    503 to every write outside the migration routes.
 *  - background-worker: the worker is ONE process the instance shares, and the
 *    lane's tests assert what happens to the queue around it (a job held while no
 *    worker runs, a job a worker picks up); two at once would race for the same
 *    queue and read each other's jobs as their own (#2574).
 *  - serving: PARALLEL — the variant keeps auto_login and the isolation under test
 *    is keyed per session_id, so every test owns its own bucket.
 *  - destructive: tests wipe account-wide state.
 */
const LANE_TABLE: Array<{ flag: keyof LaneEnv; tag: string; name: string; hint: string; serial: boolean }> = [
  { flag: "PW_ENTERPRISE", tag: "@enterprise", name: "enterprise", hint: ENTERPRISE_HINT, serial: true },
  { flag: "PW_INSTANCE_MIGRATION", tag: "@instance-migration", name: "instance-migration", hint: INSTANCE_MIGRATION_HINT, serial: true },
  { flag: "PW_BACKGROUND_WORKER", tag: "@background-worker", name: "background-worker", hint: BACKGROUND_WORKER_HINT, serial: true },
  { flag: "PW_SERVING_IDENTITY", tag: "@serving", name: "serving-identity", hint: SERVING_HINT, serial: false },
  { flag: "PW_DESTRUCTIVE", tag: "@destructive", name: "destructive", hint: DESTRUCTIVE_HINT, serial: true },
];

/** A regex matching any of `tags`, which carry no regex metacharacters. */
const anyOf = (tags: string[]): RegExp | undefined => (tags.length ? new RegExp(tags.join("|")) : undefined);

/**
 * Resolve the lane from the environment.
 *
 * More than one flag set is not an error the config can usefully refuse — the
 * lanes need different instances — so one wins by a FIXED precedence and the
 * caller is told, rather than silently getting one of them. The order is
 * `@enterprise` > `@instance-migration` > `@background-worker` > `@serving` >
 * `@destructive`, by how specialised an instance each demands: Enterprise needs a
 * separate build, instance migration needs the image plus one package and two
 * companion services (a database and a bucket), background-worker needs the same
 * image under different configuration PLUS a second process on its database,
 * serving-identity needs the same image under different configuration, destructive
 * needs only isolation.
 */
export function resolveLane(env: LaneEnv = process.env as LaneEnv): LaneResolution {
  const requested = LANE_TABLE.filter((lane) => !!env[lane.flag]);
  const winner = requested[0];

  if (!winner) {
    return {
      grepInvert: anyOf(LANE_TABLE.map((l) => l.tag)),
      // In the order the notices have always been printed.
      notices: [DESTRUCTIVE_HINT, ENTERPRISE_HINT, SERVING_HINT, INSTANCE_MIGRATION_HINT, BACKGROUND_WORKER_HINT],
      serial: false,
    };
  }

  const others = LANE_TABLE.filter((lane) => lane !== winner);
  // Winner first in `requested` — the table is in precedence order.
  const ambiguity =
    requested.length > 1
      ? [
          `[lane] ${requested.map((l) => l.flag).join(" and ")} are both set; the ${winner.name} lane wins and the others stay excluded.`,
        ]
      : [];
  return {
    grepInvert: anyOf(others.map((l) => l.tag)),
    notices: ambiguity.length ? ambiguity : others.map((l) => l.hint),
    serial: winner.serial,
  };
}
