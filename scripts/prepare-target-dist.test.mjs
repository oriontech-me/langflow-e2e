// Unit tests for scripts/prepare-target-dist.sh.
// Run with: npm run test:scripts
//
// What these protect: the refusals. This script's whole value is that it will not
// leave the target serving something other than the version it was told to serve —
// and every way of getting that wrong ends in a GREEN run against the wrong product,
// which is the one outcome a comparison lane cannot survive.
//
//   - Being TOLD the version, never guessing it. An empty TARGET_VERSION is refused
//     rather than passed along: `langflow==` is not a pin, it asks the index for
//     whatever is newest, and it SUCCEEDS — so nothing downstream would notice.
//   - The cross-registry check. The expectation comes from the published image, the
//     wheel comes from PyPI, and nothing makes the two agree. When they disagree the
//     script refuses with both numbers on screen. This is the refusal that has never
//     fired on the machine; a test is the only thing that has ever executed it.
//   - The frontend is located THROUGH the installed package, not through a path
//     built from the interpreter version. The fixture installs into a directory no
//     `lib/python3.14/site-packages` guess would produce, so a regression to the
//     guessed path fails here instead of on the target.
//   - The venv is destroyed before the install, so every refusal above inspects what
//     was installed now rather than what survived from yesterday.
//   - stdout carries only key=value, so the caller can capture the summary without
//     parsing prose — the same contract prepare-target-source.sh has.
//
// `uv` and the venv's `python` are stubbed through a PATH shim: nothing is downloaded
// and no interpreter is created. The shim is deliberately dumb — it records what it
// was asked for and answers from fixture files, so a test that wants two registries
// to disagree just says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "prepare-target-dist.sh");
const VERSION = "1.13.0.dev12";

/**
 * A PATH shim for `uv`, plus the fake venv python it creates.
 *
 * `uv venv` writes a `python` that answers the two `-c` programs the script runs:
 * the installed version, and where the package lives. Both answers come from files
 * `uv pip install` drops in the venv, which is what lets a test make the install
 * report a version other than the one it was asked for.
 */
function setup({
  withUv = true,
  venvFails = false,
  installFails = false,
  installedVersion = null, // null → whatever was asked for
  frontend = true,
  packageImportable = true,
} = {}) {
  const dir = makeTempDir("prepare-target-dist-test-");
  const uvBin = join(dir, "uv-bin");
  const venv = join(dir, "venv-target");
  mkdirSync(uvBin, { recursive: true });

  const uvLog = join(dir, "uv.log");
  writeFileSync(
    join(uvBin, "uv"),
    `#!/usr/bin/env bash
echo "$*" >> "${uvLog}"
sub="$1"; shift
if [ "$sub" = "venv" ]; then
  ${venvFails ? "exit 1" : ""}
  target="$1"
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PYEOF'
#!/usr/bin/env bash
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$1" != "-c" ]; then exit 1; fi
case "$2" in
  *importlib.metadata*)
    if [ ! -f "$root/.installed-version" ]; then exit 1; fi
    cat "$root/.installed-version" ;;
  *__file__*)
    if [ ! -f "$root/.pkg-dir" ]; then exit 1; fi
    printf '%s/frontend\\n' "$(cat "$root/.pkg-dir")" ;;
  *) exit 1 ;;
esac
PYEOF
  chmod +x "$target/bin/python"
  exit 0
fi
if [ "$sub" = "pip" ]; then
  ${installFails ? "exit 1" : ""}
  spec=""
  pyarg=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--python" ]; then pyarg="$2"; shift; fi
    spec="$1"
    shift
  done
  want="\${spec#*==}"
  root="$(cd "$(dirname "$pyarg")/.." && pwd)"
  printf '%s' "${installedVersion === null ? '$want' : installedVersion}" > "$root/.installed-version"
  ${packageImportable ? "" : 'rm -f "$root/.installed-version"'}
  pkgdir="$root/site/langflow"
  mkdir -p "$pkgdir/frontend"
  ${frontend ? 'printf "<!doctype html>" > "$pkgdir/frontend/index.html"' : ""}
  printf '%s' "$pkgdir" > "$root/.pkg-dir"
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(uvBin, "uv"), 0o755);

  return { dir, uvBin, venv, uvLog, withUv };
}

function run(ctx, env = {}) {
  // The shim first; the real PATH is NOT inherited, so dropping the shim directory
  // is the only way `command -v uv` can fail on a machine that has a real uv.
  const parts = [];
  if (ctx.withUv) parts.push(ctx.uvBin);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${parts.join(":")}:/usr/bin:/bin`,
      HOME: ctx.dir,
      TARGET_VERSION: VERSION,
      LANGFLOW_DIST_VENV: ctx.venv,
      ...env,
    },
  });
  const summary = {};
  for (const line of (r.stdout || "").split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) summary[m[1]] = m[2];
  }
  return { ...r, summary };
}

test("it refuses an empty TARGET_VERSION instead of installing whatever is newest", () => {
  const ctx = setup();
  const r = run(ctx, { TARGET_VERSION: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TARGET_VERSION is empty/);
  assert.match(r.stderr, /whatever is newest/);
  // Nothing was attempted: an empty pin must not reach the index at all.
  assert.equal(existsSync(ctx.uvLog), false);
});

test("it refuses when uv is absent, and names where it lives", () => {
  const ctx = setup({ withUv: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uv is not on PATH/);
  assert.match(r.stderr, /\.local\/bin/);
});

test("a venv it cannot create is a refusal, not a fallback to what was there", () => {
  const ctx = setup({ venvFails: true });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not create a venv/);
  assert.match(r.stderr, /rather than something stale/);
});

test("a version the index does not carry is refused as the two registries disagreeing", () => {
  const ctx = setup({ installFails: true });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no published distribution for langflow==1\.13\.0\.dev12/);
});

test("THE cross-registry check: a wheel that is not the resolved version is fatal here", () => {
  const ctx = setup({ installedVersion: "1.13.0.dev11" });
  const r = run(ctx);
  assert.equal(r.status, 2);
  // Both numbers on screen, because the whole point is that a reader can tell which
  // registry said what without going to another machine.
  assert.match(r.stderr, /installed 1\.13\.0\.dev11/);
  assert.match(r.stderr, /resolved 1\.13\.0\.dev12/);
  assert.match(r.stderr, /registries disagree/);
});

test("a package that reports no version at all is refused rather than started", () => {
  const ctx = setup({ packageImportable: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reports no version after installing/);
});

test("a distribution without the built frontend is refused", () => {
  const ctx = setup({ frontend: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /carries no built frontend/);
});

test("the frontend is located through the installed package, not a guessed python path", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0);
  // The fixture installs under `site/langflow`, which no `lib/python3.14/site-packages`
  // guess produces. A regression to the guessed path reports a directory that does not
  // exist and refuses a distribution that carries a frontend.
  assert.equal(r.summary.frontend_dir, join(ctx.venv, "site/langflow/frontend"));
});

test("the venv is destroyed before the install, so the checks inspect this install", () => {
  const ctx = setup();
  mkdirSync(ctx.venv, { recursive: true });
  const leftover = join(ctx.venv, "yesterday.txt");
  writeFileSync(leftover, "a dependency resolved for another version\n");
  const r = run(ctx);
  assert.equal(r.status, 0);
  assert.equal(existsSync(leftover), false);
});

test("it installs exactly what it was told, pinned", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0);
  const log = readFileSync(ctx.uvLog, "utf8");
  assert.match(log, /pip install --python .* langflow==1\.13\.0\.dev12/);
});

test("stdout carries only key=value, and the summary names what was prepared", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0);
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    assert.match(line, /^[a-z_]+=.*$/, `prose on stdout would break a caller: ${line}`);
  }
  assert.equal(r.summary.prepared_version, VERSION);
  assert.equal(r.summary.venv, ctx.venv);
  assert.equal(r.summary.python, "3.14");
  assert.match(r.summary.install_s, /^\d+$/);
  assert.match(r.summary.total_s, /^\d+$/);
});
