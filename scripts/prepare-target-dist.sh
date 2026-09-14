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
# ## Why the version is compared after the install
#
# The expectation comes from the published IMAGE — scripts/resolve-target-version.mjs
# matches `latest`'s digest against the other published tags — and the wheel comes
# from PyPI. Two registries, and nothing makes them agree: an image can ship while the
# corresponding wheel is absent, held back, or yanked. So the agreement is CHECKED,
# and a disagreement is fatal HERE, in preparation, where it is loud and names both
# numbers — instead of silent in a comparison of two lanes running two products.
#
# It has never fired. That is the expected state, not evidence it is unnecessary: it
# guards a difference between two systems we do not control, on the one day they
# disagree.
#
# ## Why the frontend is checked through the installed package
#
# The wheel carries the built UI, and that is the whole reason this artefact can serve
# a browser suite at all. Checking it by a guessed path — `lib/python3.14/site-packages/…`
# — makes the gate fail for the wrong reason the day the interpreter changes: the path
# cannot exist, so the refusal reads "the distribution carries no built frontend" about
# a distribution that carries one. Asking the installed package where it lives answers
# the question that was actually being asked.
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
#   prepared_version=<v>  venv=<path>  python=<x.y>
#   frontend_dir=<path>  install_s=<n>  total_s=<n>
#
# Environment:
#   TARGET_VERSION          required — the version to install, exactly
#   LANGFLOW_DIST_VENV      where the venv goes (default: $HOME/venv-target)
#   LANGFLOW_DIST_PYTHON    interpreter for the venv (default: 3.14)
#   LANGFLOW_DIST_PACKAGE   package name (default: langflow)
set -euo pipefail

TARGET_VERSION="${TARGET_VERSION:-}"
VENV="${LANGFLOW_DIST_VENV:-${HOME}/venv-target}"
PYTHON_VERSION="${LANGFLOW_DIST_PYTHON:-3.14}"
PACKAGE="${LANGFLOW_DIST_PACKAGE:-langflow}"

# uv lives in ~/.local/bin and cron does not load it — the same trap the orchestrator
# already exports a PATH for. Repeated here because this script is also invoked over
# `ssh <host> 'bash -s'`, where the same non-interactive shell applies.
export PATH="${HOME}/.local/bin:${PATH}"

say() { echo "$*" >&2; }
emit() { echo "$*"; }
die() { echo "ERROR: $*" >&2; exit 2; }

# --- What we were asked to install ----------------------------------------------
# An empty version is refused rather than passed along. `langflow==` is not a pin: it
# asks the index for whatever is newest, which is precisely the "serve whatever was
# there" outcome the caller is trying to avoid — and it would succeed, so nothing
# downstream would notice.
[ -n "${TARGET_VERSION}" ] \
  || die "TARGET_VERSION is empty. This script does not pick a version:
scripts/resolve-target-version.mjs does, from the published image. An empty pin asks
the index for whatever is newest, and a run against that describes the product's
changelog instead of the environment."

command -v uv > /dev/null 2>&1 \
  || die "uv is not on PATH, and it is what installs this. It usually lives in
~/.local/bin, which a non-interactive shell (cron, \`ssh host 'bash -s'\`) does not
load — check with \`ssh <host> 'command -v uv'\`, not from a login shell."

START_S="$(date +%s)"

# --- A venv that holds only what this version needs -------------------------------
say "target: ${PACKAGE}==${TARGET_VERSION}"
say "venv:   ${VENV} (python ${PYTHON_VERSION}, recreated)"
rm -rf "${VENV}"
uv venv "${VENV}" --python "${PYTHON_VERSION}" > /dev/null 2>&1 \
  || die "could not create a venv at ${VENV} with python ${PYTHON_VERSION}.
Nothing is installed, so the target is serving nothing rather than something stale."

T="$(date +%s)"
say "installing..."
uv pip install --python "${VENV}/bin/python" "${PACKAGE}==${TARGET_VERSION}" > /dev/null 2>&1 \
  || die "no published distribution for ${PACKAGE}==${TARGET_VERSION}.
The image listing named this version; the index does not carry it. That is the two
registries disagreeing, which is the case this preparation exists to catch."
INSTALL_S=$(( $(date +%s) - T ))
say "installed in ${INSTALL_S}s"

# --- Is what landed what was asked for? ------------------------------------------
GOT="$("${VENV}/bin/python" -c \
  "import importlib.metadata as m; print(m.version('${PACKAGE}'))" 2> /dev/null || true)"
[ -n "${GOT}" ] \
  || die "${PACKAGE} reports no version after installing. The install claimed success
and the package is not importable — refusing rather than starting a target whose
identity cannot be read."
[ "${GOT}" = "${TARGET_VERSION}" ] \
  || die "the wheel installed ${GOT} while the image resolved ${TARGET_VERSION} — the
two registries disagree. Refusing here, where both numbers are on screen, rather than
in a comparison of two lanes that would look like a product difference."

# --- Does it carry the built UI? -------------------------------------------------
# Asked of the installed package, not of a path built from the interpreter version.
FRONTEND_DIR="$("${VENV}/bin/python" -c \
  "import os.path, ${PACKAGE}; print(os.path.join(os.path.dirname(${PACKAGE}.__file__), 'frontend'))" \
  2> /dev/null || true)"
[ -n "${FRONTEND_DIR}" ] \
  || die "could not locate the installed ${PACKAGE} package to check its frontend."
[ -f "${FRONTEND_DIR}/index.html" ] \
  || die "the distribution carries no built frontend at ${FRONTEND_DIR}.
Serving it would answer the root with JSON and fail every UI spec on a difference the
lane did not introduce."

TOTAL_S=$(( $(date +%s) - START_S ))
say "venv ready: ${PACKAGE}==${GOT}"

emit "prepared_version=${GOT}"
emit "venv=${VENV}"
emit "python=${PYTHON_VERSION}"
emit "frontend_dir=${FRONTEND_DIR}"
emit "install_s=${INSTALL_S}"
emit "total_s=${TOTAL_S}"
