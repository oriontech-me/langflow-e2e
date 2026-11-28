// The lanes the VM daily schedules beside its @stable shards (#2142), in one place.
//
// Each lane is a lane TAG of tests/fixtures/lane.ts: its tests are excluded from every
// normal run by `grepInvert` and run only under the lane's own flag. Scheduling one
// means the daily runs the tests that carry BOTH `@stable` and the lane tag, under that
// flag, in an environment the lane needs:
//
//   destructive  on shard 1's own backend, after that shard's @stable round, with
//                workers=1: the catalog and provider policy is instance-global and the
//                other destructive specs wipe account-wide state, so nothing else may
//                share the instance while they run (the order pr-validation.yml uses).
//   serving      on a backend of its own, once per configuration variant, in sequence:
//                serving-plane end-user identity is turned on by instance-global
//                environment variables, and each spec asserts exactly one of three
//                configurations (requireServingConfiguration throws on another, so a
//                mis-wired lane fails rather than skipping). The variants are the three
//                scripts/start-langflow-serving-identity.sh starts, applied to the
//                run's own served artifact instead of a Docker image, so the lane tests
//                the same build as the shards.
//
//   background   after the shards, on the same port as serving, once per variant: the
//                database-backed background backend (LANGFLOW_BACKGROUND_BACKEND=scaled,
//                upstream #13508) queues a v2 background run in the database and a
//                separate `langflow worker` runs it. `queued` starts the instance with no
//                worker (a job waits, and can be cancelled while it waits); `worker`
//                starts one worker beside it (scripts/start-langflow-worker.sh, on the
//                same database), so a queued job is picked up and run (#2574).
//
// `@enterprise` and `@instance-migration` stay unscheduled: the first is out of CI scope
// by the 2026-08-26 decision (#1607), the second has its own routine.

/** The header every serving variant names; the specs send it (SERVING_IDENTITY_HEADER). */
export const SERVING_HEADER = "X-End-User-Id";

const serving = (trust, required) => ({
  LANGFLOW_SERVING_END_USER_HEADER: SERVING_HEADER,
  LANGFLOW_SERVING_TRUST_PROXY_HEADERS: trust ? "true" : "false",
  LANGFLOW_SERVING_END_USER_REQUIRED: required ? "true" : "false",
});

export const SCHEDULED_LANES = {
  destructive: {
    tag: "@destructive",
    flag: "PW_DESTRUCTIVE",
    // One run on an existing backend: no instance environment of its own.
    variants: null,
  },
  serving: {
    tag: "@serving",
    flag: "PW_SERVING_IDENTITY",
    // Paths relative to the Playwright rootDir (tests/), as a listing names them. Every
    // spec the lane lists must map to exactly one variant; one that maps to none is
    // reported (`unmapped`) and fails the run, so a new @serving spec cannot be
    // scheduled into the wrong configuration or silently into none.
    variants: [
      {
        name: "trusted",
        worker: false,
        env: serving(true, false),
        specs: [
          "tests-automations/regression/serving/end-user-identity-isolation.spec.ts",
          "tests-automations/regression/serving/end-user-job-lifecycle-gating.spec.ts",
        ],
      },
      {
        name: "untrusted",
        worker: false,
        env: serving(false, false),
        specs: ["tests-automations/regression/serving/end-user-identity-untrusted.spec.ts"],
      },
      {
        name: "required",
        worker: false,
        env: serving(true, true),
        specs: ["tests-automations/regression/serving/end-user-identity-required.spec.ts"],
      },
    ],
  },
};

SCHEDULED_LANES.background = {
  tag: "@background-worker",
  flag: "PW_BACKGROUND_WORKER",
  // No spec carries the tag yet: the lane exists so its specs (#2574's follow-up) have
  // somewhere to run. Each one is mapped here when it is written; an unmapped one fails
  // the run, as for serving.
  variants: [
    { name: "queued", worker: false, env: { LANGFLOW_BACKGROUND_BACKEND: "scaled" }, specs: [] },
    { name: "worker", worker: true, env: { LANGFLOW_BACKGROUND_BACKEND: "scaled" }, specs: [] },
  ],
};

export const LANE_NAMES = Object.keys(SCHEDULED_LANES);
