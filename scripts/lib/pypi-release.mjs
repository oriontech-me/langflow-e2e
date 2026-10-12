// What PyPI's JSON for one release of langflow says about installing it on the qa, for
// ops/vm/run-on-demand.sh: whether the release is the one asked for, whether it has
// files to install, and which interpreter its requires_python allows.
//
//   node scripts/lib/pypi-release.mjs <release.json> <version>
//
// prints key=value lines: verdict=ok|absent|nofiles|yanked|other, version=<PyPI's>,
// python=<x.y> (empty when none this machine runs is allowed), requires=<as published>.
// Never throws on the JSON's shape: what it cannot read it says so, and the caller
// lets the install decide.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The interpreters the executor may give a venv, newest first: the daily's is first. */
export const PYTHONS = ["3.14", "3.13", "3.12"];

const nums = (v) => v.split(".").map(Number);
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether interpreter `py` ("3.13") satisfies a requires_python specifier, as x.y.0;
 * null when the specifier has a clause this does not read, so the caller keeps its
 * default rather than trusting a guess.
 */
export function allows(spec, py) {
  if (spec === null || spec === undefined || spec.trim() === "") return true;
  const have = [...nums(py), 0];
  for (const clause of spec.split(",")) {
    const m = clause.trim().match(/^(~=|===|==|!=|<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+)*)(\.\*)?$/);
    if (!m) return null;
    const [, op, raw, star] = m;
    const want = nums(raw);
    if (star) {
      if (op !== "==" && op !== "!=") return null;
      const same = want.every((n, i) => have[i] === n);
      if ((op === "==") !== same) return false;
      continue;
    }
    const c = cmp(have, want);
    const ok = {
      "==": c === 0, "===": c === 0, "!=": c !== 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0,
      // ~=X.Y means >=X.Y and ==X.*; ~=X.Y.Z means >=X.Y.Z and ==X.Y.*.
      "~=": c >= 0 && want.length > 1 && want.slice(0, -1).every((n, i) => have[i] === n),
    }[op];
    if (!ok) return false;
  }
  return true;
}

/** The newest of PYTHONS the release allows; "" when none is; PYTHONS[0] when unreadable. */
export function pythonFor(spec) {
  let unread = false;
  for (const py of PYTHONS) {
    const a = allows(spec, py);
    if (a === true) return py;
    if (a === null) unread = true;
  }
  return unread ? PYTHONS[0] : "";
}

/** The release's verdict from its JSON (an object), for the version asked. */
export function judge(json, asked) {
  const info = json && typeof json === "object" ? json.info : null;
  const urls = json && typeof json === "object" ? json.urls : null;
  const version = info && typeof info.version === "string" ? info.version : "";
  const requires = info && typeof info.requires_python === "string" ? info.requires_python : "";
  // PyPI answers 1.12 for 1.12.0: the same release, spelled another way. The run's
  // gate compares exactly, so only PyPI's own spelling is taken.
  if (version !== asked) return { verdict: version ? "other" : "absent", version, python: "", requires };
  if (!Array.isArray(urls) || urls.length === 0) return { verdict: "nofiles", version, python: "", requires };
  if (urls.every((f) => f && f.yanked === true)) return { verdict: "yanked", version, python: "", requires };
  return { verdict: "ok", version, python: pythonFor(requires), requires };
}

// Run as a command, compared by real path: the clone may be reached through a symlink.
const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (process.argv[1] && isMain()) {
  let json = null;
  try { json = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch { json = null; }
  const r = judge(json, process.argv[3] ?? "");
  const clean = (v) => String(v).replace(/[\r\n]/g, " ").slice(0, 200);
  process.stdout.write(`verdict=${r.verdict}\nversion=${clean(r.version)}\npython=${r.python}\nrequires=${clean(r.requires)}\n`);
}
