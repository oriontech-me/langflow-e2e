// Unit tests for scripts/prepare-target-dist.sh.
// Run with: npm run test:scripts
//
// What these protect: the refusals. This script's whole value is that it will not
// leave the target serving something other than the version it was told to serve —
// and every way of getting that wrong ends in a GREEN run against the wrong product,
// which is the one outcome a comparison lane cannot survive.
//
// WHY THE VENV'S PYTHON IS REAL
//
// The first version of this file stubbed it with a shell script that matched the
// program TEXT (`case "$2" in *importlib.metadata*)`) and answered from a canned
// file. An independent review measured what that bought: nine mutations survived a
// full green run, and three of them lived INSIDE the probe — changing `frontend` to
// `static`, dropping the path join, and reading `langflow-base`'s version where
// `langflow`'s was meant. A stub shaped like the implementation tests the stub.
//
// So the probe runs under the real `python3`, against a fixture that is a real
// package directory with real `.dist-info` metadata. `importlib.metadata`,
// `find_spec` and the canonicalisation are then exercised rather than imitated, and
// an edit inside the probe fails here instead of on the target.
//
// `-S` is deliberate: without it the host's site-packages leak in, and whether the
// `packaging` branch or its fallback runs would depend on the developer's machine.
// With it, sys.path is the fixture plus the stdlib, so both paths are addressable.
//
// The fixture's `langflow/__init__.py` PRINTS ON STDOUT. That is the point: it is
// how "the package directory is found without executing the package" becomes a fact
// a test can check, rather than a claim in a header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "prepare-target-dist.sh");
const VERSION = "1.13.0.dev12";
const BANNER = "[fixture] langflow/__init__.py ran";

// Loudly, not skipped: a lane that quietly stops covering the probe is the state
// this file was rewritten to leave.
const PYTHON3 = execFileSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
if (!PYTHON3) throw new Error("python3 is required: the venv probe is executed for real here");
const HOST_PY = execFileSync(PYTHON3, ["-c", 'import sys; print("%d.%d" % sys.version_info[:2])'], {
  encoding: "utf8",
}).trim();

/**
 * A faithful-enough `uv`, plus a venv whose `python` is the real interpreter.
 *
 * The shim parses its arguments the way uv accepts them — flags in any order, the
 * spec anywhere, `--python` required — rather than the way this script happens to
 * write them. Rearranging the real command must not break these tests.
 */
function setup({
  withUv = true,
  uvOnPathOnlyViaHome = false,
  venvFails = false,
  installFails = false,
  installedVersion = null, // null → whatever was asked for
  installedBaseVersion = null, // null → same as langflow's
  langflowMetadata = true,
  baseMetadata = true,
  packageDir = true,
  frontend = true,
  withPackaging = false,
} = {}) {
  const dir = makeTempDir("prepare-target-dist-test-");
  const uvBin = uvOnPathOnlyViaHome ? join(dir, ".local/bin") : join(dir, "uv-bin");
  const venv = join(dir, "venv-target");
  mkdirSync(uvBin, { recursive: true });

  const uvLog = join(dir, "uv.log");
  const wanted = installedVersion === null ? "$want" : installedVersion;
  const wantedBase =
    installedBaseVersion === null ? (installedVersion === null ? "$want" : installedVersion) : installedBaseVersion;

  writeFileSync(
    join(uvBin, "uv"),
    `#!/usr/bin/env bash
# A stand-in for uv that is strict about the CALL and permissive about its shape.
echo "$*" >> "${uvLog}"
echo "fake uv: chatter that must never reach stdout of the caller"
sub="\${1:-}"; shift || true

if [ "$sub" = "venv" ]; then
  ${venvFails ? 'echo "fake uv: cannot create the venv" >&2; exit 1' : ""}
  target=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --python) shift 2 ;;
      --*) shift ;;
      *) target="$1"; shift ;;
    esac
  done
  if [ -z "$target" ]; then echo "fake uv: no venv path given" >&2; exit 2; fi
  mkdir -p "$target/bin" "$target/site"
  printf 'home = /usr/bin\\n' > "$target/pyvenv.cfg"
  cat > "$target/bin/python" <<PYWRAP
#!/usr/bin/env bash
# The venv interpreter: the REAL python3, with only the fixture on sys.path.
export PYTHONPATH="$target/site"
exec "${PYTHON3}" -S "\\$@"
PYWRAP
  chmod +x "$target/bin/python"
  exit 0
fi

if [ "$sub" = "pip" ]; then
  if [ "\${1:-}" != "install" ]; then echo "fake uv: unsupported pip subcommand: \${1:-}" >&2; exit 2; fi
  shift
  ${installFails ? 'echo "fake uv: refusing to install" >&2; exit 1' : ""}
  py=""; spec=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --python) py="$2"; shift 2 ;;
      --*) shift ;;
      *)
        if [ -n "$spec" ]; then echo "fake uv: two specs given" >&2; exit 2; fi
        spec="$1"; shift ;;
    esac
  done
  if [ -z "$py" ]; then echo "fake uv: --python was not given" >&2; exit 2; fi
  case "$spec" in
    *==*) want="\${spec#*==}" ;;
    *) echo "fake uv: the spec is not pinned with ==: $spec" >&2; exit 2 ;;
  esac
  root="$(cd "$(dirname "$py")/.." && pwd)"
  site="$root/site"
  mkdir -p "$site"
  ${
    packageDir
      ? `mkdir -p "$site/langflow"
  printf '%s\\n' 'print("${BANNER}")' > "$site/langflow/__init__.py"`
      : ""
  }
  ${frontend && packageDir ? `mkdir -p "$site/langflow/frontend"; printf '<!doctype html>' > "$site/langflow/frontend/index.html"` : ""}
  ${
    langflowMetadata
      ? `d="$site/langflow-${wanted}.dist-info"; mkdir -p "$d"
  printf "Metadata-Version: 2.1\\nName: langflow\\nVersion: ${wanted}\\n" > "$d/METADATA"`
      : ""
  }
  ${
    baseMetadata
      ? `b="$site/langflow_base-${wantedBase}.dist-info"; mkdir -p "$b"
  printf "Metadata-Version: 2.1\\nName: langflow-base\\nVersion: ${wantedBase}\\n" > "$b/METADATA"`
      : ""
  }
  ${
    withPackaging
      ? `mkdir -p "$site/packaging"
  : > "$site/packaging/__init__.py"
  cat > "$site/packaging/version.py" <<'PKG'
class Version:
    """Enough PEP 440 to be distinguishable from the shell fallback.

    The fallback only strips a leading 'v'; this also drops leading zeros in a dev
    segment, so a test can tell which of the two actually ran.
    """

    def __init__(self, raw):
        text = raw.strip().lstrip("vV")
        if not text:
            raise ValueError("empty version")
        if ".dev" in text:
            head, _, dev = text.partition(".dev")
            text = head + ".dev" + str(int(dev or 0))
        self._text = text

    def __str__(self):
        return self._text
PKG`
      : ""
  }
  exit 0
fi
echo "fake uv: unsupported subcommand: $sub" >&2
exit 2
`,
  );
  chmodSync(join(uvBin, "uv"), 0o755);

  return { dir, uvBin, venv, uvLog, withUv, uvOnPathOnlyViaHome };
}

function run(ctx, env = {}) {
  // `|| "/nonexistent"` matters: an EMPTY PATH component is the current directory
  // under POSIX, so `parts.join(":")` on an empty list would put the repo root on
  // PATH and a stray ./uv would silently defeat the "uv is absent" test.
  const parts = [];
  if (ctx.withUv && !ctx.uvOnPathOnlyViaHome) parts.push(ctx.uvBin);
  const shimPath = parts.join(":") || "/nonexistent";
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${shimPath}:/usr/bin:/bin`,
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

/** A venv-shaped directory, so "it was destroyed" is distinguishable from "absent". */
function seedVenv(ctx, marker = "yesterday.txt") {
  mkdirSync(ctx.venv, { recursive: true });
  writeFileSync(join(ctx.venv, "pyvenv.cfg"), "home = /usr/bin\n");
  const path = join(ctx.venv, marker);
  writeFileSync(path, "a dependency resolved for another version\n");
  return path;
}

// --- being told what to place ----------------------------------------------------

test("an empty TARGET_VERSION is refused before anything is touched", () => {
  const ctx = setup();
  const leftover = seedVenv(ctx);
  const r = run(ctx, { TARGET_VERSION: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /TARGET_VERSION is empty/);
  assert.equal(existsSync(ctx.uvLog), false, "uv must not be reached");
  // The refusal is only worth having if it happens before the destruction.
  assert.equal(existsSync(leftover), true, "the existing venv must survive");
});

test("uv missing is refused BEFORE the venv is destroyed", () => {
  const ctx = setup({ withUv: false });
  const leftover = seedVenv(ctx);
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uv is not on PATH/);
  // The whole reason the check sits where it does: a cron run with a broken PATH
  // must leave the target serving yesterday's version, not nothing.
  assert.equal(existsSync(leftover), true, "the venv must still be there");
});

test("uv is found through the PATH the script exports, not the caller's", () => {
  // uv lives ONLY in $HOME/.local/bin and is absent from PATH — the shape of a cron
  // run. Deleting the script's `export PATH` line makes this fail.
  const ctx = setup({ uvOnPathOnlyViaHome: true });
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary.prepared_version, VERSION);
});

test("a path that is not a virtualenv is not deleted", () => {
  const ctx = setup();
  mkdirSync(ctx.venv, { recursive: true });
  const precious = join(ctx.venv, "somebody-elses-work.txt");
  writeFileSync(precious, "not a venv\n");
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has no pyvenv\.cfg/);
  assert.equal(existsSync(precious), true);
});

// --- uv's own failures ------------------------------------------------------------

test("a venv it cannot create is a refusal, not a fallback to what was there", () => {
  const ctx = setup({ venvFails: true });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not create a venv/);
  assert.match(r.stderr, /nothing rather than something stale/);
  assert.match(r.stderr, /fake uv: cannot create the venv/, "uv's reason must survive");
});

test("an install it cannot complete is refused, and uv's reason is not swallowed", () => {
  const ctx = setup({ installFails: true });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not install langflow==1\.13\.0\.dev12/);
  // It must not claim the index lacks the version: an unreachable index and a full
  // disk fail the same way. Found in the field on 2026-09-14.
  assert.match(r.stderr, /cannot tell them apart/);
  assert.match(r.stderr, /fake uv: refusing to install/);
});

// --- the calls themselves ---------------------------------------------------------

test("the venv is created with the interpreter it was configured for", () => {
  const ctx = setup();
  const r = run(ctx, { LANGFLOW_DIST_PYTHON: "3.13" });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(ctx.uvLog, "utf8");
  // Without this, dropping `--python` from the uv venv call is a green run whose
  // record still claims the configured interpreter.
  assert.match(log, /^venv \S+ --python 3\.13$/m);
});

test("it installs exactly what it was told, pinned", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(ctx.uvLog, "utf8");
  assert.match(log, /pip install --python \S+ langflow==1\.13\.0\.dev12/);
});

test("the venv is destroyed before the install, so the checks inspect this install", () => {
  const ctx = setup();
  const leftover = seedVenv(ctx);
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(leftover), false);
});

// --- what actually landed ---------------------------------------------------------

test("THE cross-registry check: a wheel that is not the resolved version is fatal here", () => {
  const ctx = setup({ installedVersion: "1.13.0.dev11" });
  const r = run(ctx);
  assert.equal(r.status, 2);
  // Both numbers on screen, because the point is that a reader can tell which
  // registry said what without going to another machine.
  assert.match(r.stderr, /installed 1\.13\.0\.dev11/);
  assert.match(r.stderr, /resolved 1\.13\.0\.dev12/);
  assert.match(r.stderr, /registries disagree/);
});

test("a non-canonical spelling of the SAME version is not an accusation", () => {
  // `v1.13.0.dev12` installs the identical wheel and metadata reports the normalised
  // form. A string comparison called that "the two registries disagree" — a false
  // accusation on an input this repo produces itself, in resolve-target-version's
  // `ref` field. Found by review on 2026-09-14 and verified against the real uv.
  const ctx = setup({ installedVersion: VERSION });
  const r = run(ctx, { TARGET_VERSION: `v${VERSION}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary.prepared_version, VERSION);
});

test("packaging does the canonicalising when it is there", () => {
  const ctx = setup({ withPackaging: true, installedVersion: VERSION });
  const r = run(ctx, { TARGET_VERSION: "1.13.0.dev012" });
  assert.equal(r.status, 0, r.stderr);
});

test("and without packaging the narrow fallback refuses rather than guessing", () => {
  // The fallback only strips a leading `v`. Normalising more than that in shell
  // would risk hiding a real disagreement, which is the one thing it must not do —
  // so `dev012` is refused here, and the refusal names both numbers.
  const ctx = setup({ withPackaging: false, installedVersion: VERSION });
  const r = run(ctx, { TARGET_VERSION: "1.13.0.dev012" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /registries disagree/);
});

test("no langflow metadata at all is refused", () => {
  const ctx = setup({ langflowMetadata: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no langflow distribution metadata/);
});

// --- langflow-base is the product -------------------------------------------------

test("langflow-base missing is refused: the meta-package serves nothing", () => {
  const ctx = setup({ baseMetadata: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /langflow-base is not/);
});

test("langflow-base at a DIFFERENT version is refused, and this is the silent path", () => {
  // `langflow` ships eight files; the backend and the built UI come from
  // langflow-base. On a stable version the dependency is a range, so every other
  // check here can pass while the machine serves a product the image never carried.
  const ctx = setup({ installedVersion: VERSION, installedBaseVersion: "1.12.1" });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /langflow is 1\.13\.0\.dev12 but langflow-base is 1\.12\.1/);
  assert.match(r.stderr, /what serves the product/);
});

// --- the built UI -----------------------------------------------------------------

test("a distribution whose package directory cannot be found is refused", () => {
  const ctx = setup({ packageDir: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /find_spec cannot locate its package/);
});

test("a distribution without the built frontend is refused", () => {
  const ctx = setup({ frontend: false });
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /carries no built frontend/);
});

test("the frontend is the real package directory's, and the package is NOT executed", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary.frontend_dir, join(ctx.venv, "site/langflow/frontend"));
  // The fixture's __init__.py prints on stdout. find_spec never runs it; `import`
  // would, and the banner would land inside the captured path — which is exactly
  // how a real transformers banner behaves on the target.
  assert.equal(r.stdout.includes(BANNER), false, "the package must not be imported");
  assert.equal(r.stderr.includes(BANNER), false);
});

// --- the contract with the caller -------------------------------------------------

test("stdout carries only key=value, even though uv is chatty on stdout", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    assert.match(line, /^[a-z_]+=.*$/, `prose on stdout would break a caller: ${line}`);
  }
  // The shim writes to stdout on every call, so dropping either `>&2` fails here.
  assert.match(r.stderr, /fake uv: chatter/);
});

test("the summary reports the interpreter that exists, not the one requested", () => {
  const ctx = setup();
  const r = run(ctx, { LANGFLOW_DIST_PYTHON: "9.99" });
  assert.equal(r.status, 0, r.stderr);
  // Echoing LANGFLOW_DIST_PYTHON back would make the run record a wish.
  assert.equal(r.summary.python, HOST_PY);
  assert.notEqual(r.summary.python, "9.99");
});

test("the summary names both distributions and the venv", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary.prepared_version, VERSION);
  assert.equal(r.summary.prepared_base_version, VERSION);
  assert.equal(r.summary.venv, ctx.venv);
  assert.match(r.summary.install_s, /^\d+$/);
  assert.match(r.summary.total_s, /^\d+$/);
});
