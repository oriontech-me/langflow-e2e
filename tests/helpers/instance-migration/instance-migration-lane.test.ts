// Unit tests for tests/helpers/instance-migration/instance-migration-lane.ts (#2347).
// Run with: npm run test:units
//
// What these protect is the one thing a spec cannot see for itself: that the lane it
// reads is the lane the start script started. Every default lives twice — in
// scripts/lib/instance-migration-lane.sh, which the three shell scripts source, and in
// LANE_DEFAULTS, which the specs read — and a drift between them is silent: the spec
// types a database name or a container name that does not exist, and the failure names
// the product. So the shell file is PARSED here, both ways.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LANE_DEFAULTS,
  RESET_SCRIPT,
  instanceMigrationLane,
  resetInstanceMigration,
  secretKeyFingerprint,
} from "./instance-migration-lane";

const REPO = join(__dirname, "..", "..", "..");
const SHELL_LIB = join(REPO, "scripts", "lib", "instance-migration-lane.sh");

/** Every `NAME="${NAME:-value}"` default in the shell file, which is the shape it promises to keep. */
function shellDefaults(): Map<string, string> {
  const text = readFileSync(SHELL_LIB, "utf8");
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(IM_[A-Z0-9_]+)="\$\{(IM_[A-Z0-9_]+):-(.*)\}"$/.exec(line);
    if (!m) continue;
    assert.equal(m[1], m[2], `${m[1]} defaults from a different variable (${m[2]})`);
    out.set(m[1], m[3]);
  }
  return out;
}

test("every default matches the shell file the scripts source, in both directions", () => {
  const shell = shellDefaults();
  // A parser that matched nothing would make the comparison below vacuous.
  assert.ok(shell.size >= 20, `parsed only ${shell.size} default(s) out of ${SHELL_LIB}`);
  for (const [name, value] of shell) {
    assert.ok(name in LANE_DEFAULTS, `${name} is set by the shell file but unknown to the specs`);
    assert.equal(LANE_DEFAULTS[name as keyof typeof LANE_DEFAULTS], value, `${name} drifted`);
  }
  for (const name of Object.keys(LANE_DEFAULTS)) {
    assert.ok(shell.has(name), `${name} is read by the specs but the shell file does not set it`);
  }
});

test("the secret key is a valid Fernet key, and the fingerprint is what the docs' command prints", () => {
  // Langflow encrypts credentials with it at startup; any 32-character string that is
  // not 32 url-safe base64 BYTES raises there, far from this file.
  const raw = Buffer.from(LANE_DEFAULTS.IM_SECRET_KEY, "base64url");
  assert.equal(raw.length, 32);
  // `printf '%s' "$KEY" | shasum -a 256 | cut -c1-12`, computed outside this helper.
  assert.equal(secretKeyFingerprint(LANE_DEFAULTS.IM_SECRET_KEY), "e4a7b5ecdd4f");
});

test("the destinations a spec types into the page are addressed by container name, never localhost", () => {
  // Inside the source container `localhost` is the source itself, so a localhost
  // address would test the source's own port and fail with a message about a database.
  const lane = instanceMigrationLane({});
  assert.equal(
    lane.target.databaseUrl,
    "postgresql://langflow:e2e-im-sentinel-pg-password@langflow-instance-migration-pg:5432/langflow_target",
  );
  assert.equal(lane.target.s3Endpoint, "http://langflow-instance-migration-s3:8333");
  assert.doesNotMatch(lane.target.databaseUrl, /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(lane.target.s3Endpoint, /localhost|127\.0\.0\.1/);
  // ...while the host-side addresses are the loopback ports the script publishes.
  assert.equal(lane.fromHost.databaseUrl, "postgresql://langflow:e2e-im-sentinel-pg-password@127.0.0.1:55895/langflow_target");
  assert.equal(lane.fromHost.s3Endpoint, "http://127.0.0.1:58895");
});

test("every fixture secret is a sentinel a spec can search raw text for", () => {
  const lane = instanceMigrationLane({});
  assert.deepEqual(lane.sentinels, [
    LANE_DEFAULTS.IM_PG_PASSWORD,
    LANE_DEFAULTS.IM_S3_ACCESS_KEY_ID,
    LANE_DEFAULTS.IM_S3_SECRET_ACCESS_KEY,
    LANE_DEFAULTS.IM_SECRET_KEY,
  ]);
  for (const s of lane.sentinels) assert.ok(s.length >= 16, `sentinel '${s}' is too short to be unambiguous`);
});

test("an override wins, and an EMPTY value falls back instead of producing a broken address", () => {
  const lane = instanceMigrationLane({ IM_PG_CONTAINER: "other-pg", IM_PG_HOST_PORT: "", IM_SEED_KB_CHUNKS: "5" });
  assert.match(lane.target.databaseUrl, /@other-pg:5432\//);
  assert.match(lane.fromHost.databaseUrl, /127\.0\.0\.1:55895\//);
  assert.equal(lane.seed.knowledgeBaseChunks, 5);
  assert.throws(() => instanceMigrationLane({ IM_SEED_KB_CHUNKS: "three" }), /non-negative integer/);
});

test("the reset runs the repository's script, with the caller's environment", () => {
  assert.ok(existsSync(RESET_SCRIPT), `${RESET_SCRIPT} does not exist`);
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const out = resetInstanceMigration({ IM_PORT: "7999" }, (file, args, options) => {
    calls.push({ file, args, env: options.env });
    return "Reset the instance migration lane in 1234 ms.\n";
  });
  assert.match(out, /Reset the instance migration lane/);
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [["bash", [RESET_SCRIPT]]]);
  assert.equal(calls[0].env.IM_PORT, "7999");
});

test("a reset that fails is re-thrown with the script's own words, never swallowed", () => {
  assert.throws(
    () =>
      resetInstanceMigration({}, () => {
        const error = Object.assign(new Error("Command failed: bash reset"), {
          stderr: "ERROR: the target database still holds 64 table(s).\n",
        });
        throw error;
      }),
    (error: Error) =>
      /still holds 64 table/.test(error.message) && /start-langflow-instance-migration\.sh/.test(error.message),
  );
});
