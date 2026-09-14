#!/usr/bin/env bash
# Put the PUBLISHED DISTRIBUTION of a given Langflow version into the target's venv.
#
# ## Why this exists next to prepare-target-source.sh
#
# The two are siblings with one job — make the machine under test serve the product
# the CI is testing — and they differ only in the artefact they place. The source
# preparer moves a clone and builds it; this one installs the wheel that upstream
# published for the version the resolver named. Everything else is the same contract:
# the caller is TOLD what to place, this script places it or refuses, and it announces
# on stdout what it actually did so the run can record it.
#
# The VM lane switched to this artefact on 2026-09-10. The reason is measured and
# lives in the migration record: the source clone wedges under the traces family with
# tracing on (#1720), and the published distribution serves the same family without
# wedging. Sixteen tests came back the day the target changed.
#
# scripts/prepare-target-source.sh does NOT go away, and the division is not
# preference. A `release-*` branch has no published wheel until the nightly builds
# one, so testing a commit before that point is only possible from source. This
# script is for the days the CI is testing something upstream has published.
#
# ## Why the venv is destroyed and rebuilt every time
#
# An incremental install leaves the question this script exists to answer as a claim
# about history: `uv pip install langflow==X` into a venv that already holds Y can
# succeed while leaving a dependency resolved for Y behind. The refusals below are
# only worth anything if what they inspect was installed now, for this version. A
# fresh venv costs a download and a resolve; it buys the right to say the installed
# tree belongs to the version that was asked for.
#
# ## Why BOTH langflow and langflow-base are verified
#
# `langflow` is a thin meta-package: measured on the target on 2026-09-14, it ships
# EIGHT files. The backend, and the built UI this script gates on, come from
# `langflow-base`, which ships 2746. So "langflow reports the right version" is not
# the same claim as "the product under test is the right version".
#
# On the nightly path they are pinned together (`langflow==1.13.0.dev12` requires
# `langflow-base==1.13.0.dev12`, exactly). On a stable version the dependency is a
# RANGE, and a range is resolved by a third system nobody here controls — the same
# argument that justifies comparing the two registries at all. Checking only the
# meta-package leaves one path on which every refusal passes and the machine serves a
# backend and a UI the image never contained, which is the silent
# green-run-against-the-wrong-product this whole file exists to prevent.
#
# ## Why the versions are compared canonically, not as strings
#
# PEP 440 accepts spellings that are equal without being identical: `v1.13.0.dev12`
# installs exactly the same wheel as `1.13.0.dev12`, and `importlib.metadata` then
# reports the normalized form. A raw string comparison calls that "the two registries
# disagree" — a false accusation against upstream, on an input this repository
# produces itself: `resolve-target-version.mjs` puts the `v` form in its `ref` field,
# and the sibling preparer takes it as `TARGET_REF=v1.13.0.dev1`.
#
# `packaging` does the normalizing when it is importable, which on a venv holding
# Langflow it always is. The fallback is deliberately narrow — strip a leading `v` and
# surrounding space — because a wrong canonicalization here would hide the very
# disagreement the comparison exists to catch.
#
# ## Why the package directory comes from find_spec
#
# Two guesses were rejected. A path built from the interpreter version
# (`lib/python3.14/site-packages/…`) stops being true the day the interpreter moves,
# and the refusal then reads "the distribution carries no built frontend" about a
# distribution that carries one. Importing the package answers correctly but EXECUTES
# it: measured on the target, importing langflow prints a transformers banner, and
# anything on that import path that writes to stdout instead of stderr lands inside
# the captured path and breaks the key=value contract.
#
# `find_spec` answers the same question without running a line of the package.
#
# ## Usage
#
#   TARGET_VERSION=1.13.0.dev12 LANGFLOW_DIST_VENV=$HOME/venv-target \
#     ./scripts/prepare-target-dist.sh
#
# Run ON the target, the same way its sibling is:
#
#   ssh <bin> "TARGET_VERSION=$v bash -s" < scripts/prepare-target-dist.sh
#
# Human progress goes to stderr; stdout carries ONLY `key=value` lines, so a caller
# can capture the summary without parsing prose:
#
#   prepared_version=<v>  prepared_base_version=<v>  venv=<path>
#   python=<x.y>  frontend_dir=<path>  install_s=<n>  total_s=<n>
#
# Environment:
#   TARGET_VERSION          required — the version to install, exactly
#   LANGFLOW_DIST_VENV      where the venv goes (default: $HOME/venv-target)
#   LANGFLOW_DIST_PYTHON    interpreter for the venv (default: 3.14)
set -euo pipefail

TARGET_VERSION="${TARGET_VERSION:-}"
VENV="${LANGFLOW_DIST_VENV:-${HOME}/venv-target}"
PYTHON_VERSION="${LANGFLOW_DIST_PYTHON:-3.14}"

# uv lives in ~/.local/bin and cron does not load it — the same trap the orchestrator
# already exports a PATH for. Repeated here because this script is also invoked over
# `ssh <host> 'bash -s'`, where the same non-interactive shell applies.
export PATH="${HOME}/.local/bin:${PATH}"

say() { echo "$*" >&2; }
emit() { echo "$*"; }
die() { echo "ERROR: $*" >&2; exit 2; }

# --- What we were asked to install ----------------------------------------------
# Refused rather than passed along. `uv pip install 'langflow=='` is a PARSE ERROR,
# not a silent install of the newest release -- measured with the real uv on the
# target: "Failed to parse: `langflow==` ... Unexpected end of version specifier".
# So this guard does not prevent a wrong install; it fails BEFORE the venv is
# destroyed, and names the caller's mistake instead of handing over uv's parse error
# for a string the caller never typed.
[ -n "${TARGET_VERSION}" ] \
  || die "TARGET_VERSION is empty. This script does not pick a version:
scripts/resolve-target-version.mjs does, from the published image. Refusing before
anything is touched, so the target keeps serving what it has until a caller says
which version it should serve."

# Before the venv is destroyed, not after. A cron run without uv on PATH that deletes
# the working venv and only then refuses leaves the target serving nothing over a
# fixable PATH problem -- the same ordering its sibling keeps for npm.
command -v uv > /dev/null 2>&1 \
  || die "uv is not on PATH, and it is what installs this. It usually lives in
~/.local/bin, which a non-interactive shell (cron, \`ssh host 'bash -s'\`) does not
load — check with \`ssh <host> 'command -v uv'\`, not from a login shell.
Nothing has been touched."

# The venv is about to be deleted, so it is worth one look first. The sibling refuses
# to move a clone carrying somebody's uncommitted work for the same reason; this is
# the cheapest equivalent -- a path that exists and is not a virtualenv is far more
# likely to be a typo in LANGFLOW_DIST_VENV than a venv worth destroying.
if [ -e "${VENV}" ] && [ ! -f "${VENV}/pyvenv.cfg" ]; then
  die "${VENV} exists and has no pyvenv.cfg, so it is not a virtualenv. Refusing to
delete it. If LANGFLOW_DIST_VENV is right, remove that path by hand and run again."
fi

START_S="$(date +%s)"

# --- A venv that holds only what this version needs -------------------------------
say "target: langflow==${TARGET_VERSION}"
say "venv:   ${VENV} (python ${PYTHON_VERSION}, recreated)"
rm -rf "${VENV}"
# uv's own output goes to stderr rather than /dev/null. The refusals below can only
# say WHAT failed; uv is the only thing that knows WHY, and discarding it leaves the
# operator with a confident message about a cause this script cannot actually
# determine. stdout stays clean, so the key=value contract is unaffected.
uv venv "${VENV}" --python "${PYTHON_VERSION}" >&2 \
  || die "could not create a venv at ${VENV} with python ${PYTHON_VERSION} — uv's
reason is above. Nothing is installed, so the target is serving
nothing rather than something stale."

T="$(date +%s)"
say "installing..."
uv pip install --python "${VENV}/bin/python" "langflow==${TARGET_VERSION}" >&2 \
  || die "could not install langflow==${TARGET_VERSION} — uv's reason is above.
If the index does not carry this version, that is the published image and PyPI
disagreeing, which is the case this preparation exists to catch; an unreachable index
or a full disk fails here too, and this script cannot tell them apart. The venv has
already been recreated, so the target now serves nothing — which is the intended
outcome either way: the caller refuses the run rather than testing yesterday's
version."
INSTALL_S=$(( $(date +%s) - T ))
say "installed in ${INSTALL_S}s"

# --- What actually landed --------------------------------------------------------
# One probe rather than three, so the facts are read once from the environment that
# will serve them. Its stderr is NOT redirected: command substitution captures only
# stdout, so a traceback reaches the operator instead of being replaced by a sentence
# this script guessed.
if ! PROBE="$("${VENV}/bin/python" - <<'PY'
import os
import sys
import importlib.metadata as md
import importlib.util as iu


def canon(raw):
    """PEP 440 normal form, so `v1.2.3` and `1.2.3` are not reported as a conflict."""
    try:
        from packaging.version import Version
    except ImportError:
        # Narrow on purpose: a clever fallback could normalise away a real difference,
        # which is the one thing the comparison must never do.
        return raw.strip().lstrip("vV")
    try:
        return str(Version(raw))
    except Exception:
        return raw.strip()


def installed(name):
    try:
        return md.version(name)
    except md.PackageNotFoundError:
        return ""


spec = iu.find_spec("langflow")
locations = list(spec.submodule_search_locations or []) if spec else []

facts = {
    "version": installed("langflow"),
    "base_version": installed("langflow-base"),
    "want_canon": canon(os.environ.get("TARGET_VERSION", "")),
    "package_dir": locations[0] if locations else "",
    "python_version": "%d.%d" % sys.version_info[:2],
}
facts["version_canon"] = canon(facts["version"])
facts["base_version_canon"] = canon(facts["base_version"])
for key, value in facts.items():
    print("%s=%s" % (key, value))
PY
)"; then
  die "the venv's python could not report what was installed — its output is above.
Refusing rather than starting a target whose identity could not be read."
fi

probe() { printf '%s\n' "${PROBE}" | sed -n "s/^${1}=//p"; }
GOT="$(probe version)"
GOT_CANON="$(probe version_canon)"
BASE_GOT="$(probe base_version)"
BASE_CANON="$(probe base_version_canon)"
WANT_CANON="$(probe want_canon)"
PACKAGE_DIR="$(probe package_dir)"
PYTHON_ACTUAL="$(probe python_version)"

[ -n "${GOT}" ] \
  || die "the install reported success and no langflow distribution metadata exists in
${VENV}. Refusing rather than starting a target whose identity cannot be read."

[ "${GOT_CANON}" = "${WANT_CANON}" ] \
  || die "the wheel installed ${GOT} while the image resolved ${TARGET_VERSION} — the
two registries disagree. Refusing here, where both numbers are on screen, rather than
in a comparison of two lanes that would look like a product difference."

# langflow-base is the product: the backend and the built UI both come from it, while
# `langflow` is eight files of metadata. A missing or mismatched base is the one way
# every check above can pass while the machine serves something else.
[ -n "${BASE_GOT}" ] \
  || die "langflow ${GOT} is installed and langflow-base is not. The backend and the
built UI both come from langflow-base, so there is nothing here to serve."

[ "${BASE_CANON}" = "${WANT_CANON}" ] \
  || die "langflow is ${GOT} but langflow-base is ${BASE_GOT}, and langflow-base is
what serves the product. On a stable version the dependency is a range, so the
resolver is free to pick a base the published image never contained — which would
make the whole run describe a product nobody asked for."

# --- Does it carry the built UI? -------------------------------------------------
[ -n "${PACKAGE_DIR}" ] \
  || die "langflow ${GOT} is installed and find_spec cannot locate its package
directory. Refusing: the built UI is inside that directory, so there is no way to
tell whether this distribution can serve a browser at all."
FRONTEND_DIR="${PACKAGE_DIR}/frontend"
[ -f "${FRONTEND_DIR}/index.html" ] \
  || die "the distribution carries no built frontend at ${FRONTEND_DIR}.
Serving it would answer the root with JSON and fail every UI spec on a difference the
lane did not introduce."

TOTAL_S=$(( $(date +%s) - START_S ))
say "venv ready: langflow==${GOT} (langflow-base ${BASE_GOT}, python ${PYTHON_ACTUAL})"

emit "prepared_version=${GOT}"
emit "prepared_base_version=${BASE_GOT}"
emit "venv=${VENV}"
emit "python=${PYTHON_ACTUAL}"
emit "frontend_dir=${FRONTEND_DIR}"
emit "install_s=${INSTALL_S}"
emit "total_s=${TOTAL_S}"
