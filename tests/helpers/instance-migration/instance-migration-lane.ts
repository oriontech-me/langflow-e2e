import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The `@instance-migration` lane, as a spec sees it (#2347): where the source and its
 * two destinations are, the fixture credentials planted in them, the seeded data, and
 * the reset that puts the lane back to the first step between tests.
 *
 * The lane is started by `scripts/start-langflow-instance-migration.sh`, whose names,
 * ports and credentials live in `scripts/lib/instance-migration-lane.sh`. The defaults
 * below are THAT file's, pinned by `instance-migration-lane.test.ts` — so a spec run
 * right after the start script finds the lane with no export step, and a default
 * changed on one side fails the unit lane instead of pointing the specs at a container
 * that does not exist. Every value is overridable under the same environment name the
 * shell file reads.
 *
 * Measured contract and decisions: `docs/instance-migration/instance-migration-lane.md`.
 */

/** The shell defaults, by the environment name that overrides each one. */
export const LANE_DEFAULTS = {
  IM_SOURCE_CONTAINER: "langflow-instance-migration",
  IM_PG_CONTAINER: "langflow-instance-migration-pg",
  IM_S3_CONTAINER: "langflow-instance-migration-s3",
  IM_NETWORK: "langflow-instance-migration-net",
  IM_PORT: "7895",
  IM_PG_HOST_PORT: "55895",
  IM_S3_HOST_PORT: "58895",
  IM_TARGET_CONTAINER: "langflow-instance-migration-target",
  IM_TARGET_PORT: "7896",
  IM_DERIVED_IMAGE: "langflow-instance-migration:local",
  IM_PG_IMAGE: "pgvector/pgvector:0.8.6-pg16",
  IM_S3_IMAGE: "chrislusf/seaweedfs:4.47",
  IM_PG_DATABASE: "langflow_target",
  IM_PG_USER: "langflow",
  IM_PG_PASSWORD: "e2e-im-sentinel-pg-password",
  IM_S3_BUCKET: "langflow-migration",
  IM_S3_ACCESS_KEY_ID: "e2e-im-sentinel-s3-access-key",
  IM_S3_SECRET_ACCESS_KEY: "e2e-im-sentinel-s3-secret-key",
  IM_SECRET_KEY: "ZTJlLWltLXNlbnRpbmVsLXNlY3JldC1rZXktZmFrZSE=",
  IM_CONFIG_DIR: "/app/data/.cache/langflow",
  IM_SEED_FLOW_NAME: "instance-migration-seed-flow",
  IM_SEED_FILE_NAME: "instance-migration-seed-file",
  IM_SEED_KB_NAME: "instance-migration-seed-kb",
  IM_SEED_KB_CHUNKS: "3",
} as const;

export type LaneVariable = keyof typeof LANE_DEFAULTS;

export interface InstanceMigrationLane {
  /** The source Langflow, as this host reaches it. */
  sourceUrl: string;
  /** Container names, for the rare spec that must look inside one. */
  containers: { source: string; database: string; bucket: string };
  /**
   * The new instance a spec starts on the copy (#2354): not started by the start script,
   * but named here so the reset, start and stop scripts can remove one a test left behind.
   */
  newInstance: {
    container: string;
    /** As this host reaches it. */
    url: string;
    /** The port it listens on inside the container and is published on, on loopback. */
    port: string;
    /** The source's image: the nightly plus the pgvector package. */
    image: string;
    /** The network the source, the database and the bucket share. */
    network: string;
  };
  /**
   * The destinations as the SOURCE reaches them — what a spec types into the page.
   * Container names on the lane's network, never `localhost`: inside the source
   * container `localhost` is the source itself.
   */
  target: {
    databaseUrl: string;
    bucket: string;
    s3Endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  /** The same destinations as THIS host reaches them, for assertions on what landed. */
  fromHost: { databaseUrl: string; s3Endpoint: string };
  /** The source's LANGFLOW_SECRET_KEY and the fingerprint the secret-key step asks for. */
  secretKey: string;
  secretKeyFingerprint: string;
  /**
   * Every fixture secret, for asserting a boundary by ABSENCE on raw text (a page, a
   * response, the migration record, the downloaded support record).
   */
  sentinels: string[];
  /** What the start script seeded into the source. */
  seed: { flowName: string; fileName: string; knowledgeBaseName: string; knowledgeBaseChunks: number };
}

/**
 * The first 12 hex characters of the key's SHA-256 — what the "Hand over the secret
 * key" step compares with, and what `printf '%s' "$KEY" | sha256sum | cut -c1-12`
 * prints on the new instance.
 */
export function secretKeyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

/** The lane's coordinates, from the environment, falling back to the start script's defaults. */
export function instanceMigrationLane(env: NodeJS.ProcessEnv = process.env): InstanceMigrationLane {
  const v = (name: LaneVariable): string => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : LANE_DEFAULTS[name];
  };
  const chunks = Number(v("IM_SEED_KB_CHUNKS"));
  if (!Number.isInteger(chunks) || chunks < 0) {
    throw new Error(`IM_SEED_KB_CHUNKS must be a non-negative integer, got '${v("IM_SEED_KB_CHUNKS")}'`);
  }
  const user = v("IM_PG_USER");
  const password = v("IM_PG_PASSWORD");
  const database = v("IM_PG_DATABASE");
  const secretKey = v("IM_SECRET_KEY");
  return {
    sourceUrl: `http://127.0.0.1:${v("IM_PORT")}`,
    containers: { source: v("IM_SOURCE_CONTAINER"), database: v("IM_PG_CONTAINER"), bucket: v("IM_S3_CONTAINER") },
    newInstance: {
      container: v("IM_TARGET_CONTAINER"),
      url: `http://127.0.0.1:${v("IM_TARGET_PORT")}`,
      port: v("IM_TARGET_PORT"),
      image: v("IM_DERIVED_IMAGE"),
      network: v("IM_NETWORK"),
    },
    target: {
      databaseUrl: `postgresql://${user}:${password}@${v("IM_PG_CONTAINER")}:5432/${database}`,
      bucket: v("IM_S3_BUCKET"),
      s3Endpoint: `http://${v("IM_S3_CONTAINER")}:8333`,
      accessKeyId: v("IM_S3_ACCESS_KEY_ID"),
      secretAccessKey: v("IM_S3_SECRET_ACCESS_KEY"),
    },
    fromHost: {
      databaseUrl: `postgresql://${user}:${password}@127.0.0.1:${v("IM_PG_HOST_PORT")}/${database}`,
      s3Endpoint: `http://127.0.0.1:${v("IM_S3_HOST_PORT")}`,
    },
    secretKey,
    secretKeyFingerprint: secretKeyFingerprint(secretKey),
    sentinels: [password, v("IM_S3_ACCESS_KEY_ID"), v("IM_S3_SECRET_ACCESS_KEY"), secretKey],
    seed: {
      flowName: v("IM_SEED_FLOW_NAME"),
      fileName: v("IM_SEED_FILE_NAME"),
      knowledgeBaseName: v("IM_SEED_KB_NAME"),
      knowledgeBaseChunks: chunks,
    },
  };
}

/** The reset script, resolved from this file so a spec's working directory does not matter. */
export const RESET_SCRIPT = join(__dirname, "..", "..", "..", "scripts", "reset-langflow-instance-migration.sh");

type Runner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => string;

const runScript: Runner = (file, args, options) =>
  execFileSync(file, args, { env: options.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Put the lane back to the first step: the migration record and its runs removed (which
 * also lifts a pause), any copy still running stopped, the target database emptied and
 * its vector extension recreated, and the bucket emptied. ~2-4 s measured, against ~45 s
 * for recreating the source — see the lane doc for that decision.
 *
 * Synchronous on purpose: it belongs in a `beforeEach`, and nothing a test does may
 * overlap it. The script verifies each part and exits non-zero naming the one that did
 * not reset; that failure is re-thrown with the script's own words, never swallowed,
 * because a half-reset lane is exactly the cross-test leak this exists to prevent.
 *
 * It does NOT forget the destination secrets the source's worker holds in memory, and
 * does not touch the source's own data — the lane doc says why, and what a spec that
 * depends on either has to do itself.
 */
export function resetInstanceMigration(
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = runScript,
): string {
  try {
    return run("bash", [RESET_SCRIPT], { env });
  } catch (error) {
    const e = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const said = [e.stderr, e.stdout]
      .map((part) => (part === undefined ? "" : String(part).trim()))
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `the instance migration lane did not reset: ${said || e.message || String(error)}\n` +
        "Start it with ./scripts/start-langflow-instance-migration.sh if it is not running.",
    );
  }
}
