#!/usr/bin/env bash
# Copy the three data series off the machine that writes them.
#
# ## Why this exists
#
# Since the lane switch, the VM's ledger IS the authoritative history, and it lives in
# exactly one place: `$LEDGER_DIR`, outside the clone (`run-e2e.sh` refuses a ledger
# inside it, so a run cannot dirty the tree and break the next `git pull --ff-only`).
# The repository's `reports/` copy holds the other lane's era. Merging the two waits on
# a write path that does not exist yet — so until then the newer era has one copy, on
# one machine, and losing the machine loses the window in which both lanes ran side by
# side. That window is what makes the switch auditable.
#
# ## The three things it refuses to do
#
#  - It will not write an archive that does not hold what it claims. A backup shaped
#    like a backup and holding nothing is worse than no backup, because it stops anyone
#    looking. So the archive is opened and counted BEFORE it is sent.
#  - It will not call a transfer successful because a command exited 0. The archive's
#    digest is compared at the destination.
#  - It will not fail quietly. Every outcome — including "not configured" — ends as one
#    line in $BACKUP_LOG, which the caller points at the run's log directory, where
#    triage already reads.
#
# It is also not allowed to turn a green run red: the caller ignores the exit code, and
# the exit code exists for tests and for a human running it by hand.
#
# ## Environment
#
#   LEDGER_DIR   (required) directory holding the three series
#   BACKUP_DEST  where to put the archive, as `<ssh-alias>:<dir>` or `local:<dir>`.
#                EMPTY = not configured: reported as disabled, exit 0. A hostname is
#                never hardcoded here — this repository is public.
#   BACKUP_KEEP  how many archives to keep at the destination (default 14)
#   BACKUP_LOG   file to append the verdict to (default: stdout only)
#   SSH_OPTS     extra options for ssh/scp, e.g. a HostName override
#
# Exit: 0 ok or disabled · 1 refused (bad source) · 2 transfer or verification failed

set -euo pipefail

LEDGER_DIR="${LEDGER_DIR:-}"
BACKUP_DEST="${BACKUP_DEST:-}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_LOG="${BACKUP_LOG:-}"
SSH_OPTS="${SSH_OPTS:-}"

# The three series by name. Named rather than globbed on purpose: a glob would happily
# archive two of them the day someone renames the third, and report success.
SERIES=(daily-history.jsonl token-history.jsonl spec-durations.json)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="langflow-e2e-ledger-${STAMP}.tgz"

say() { # verdict line: one line, greppable, always emitted
  printf '[backup-ledger] %s\n' "$1"
  [ -n "$BACKUP_LOG" ] && printf '%s [backup-ledger] %s\n' "$STAMP" "$1" >> "$BACKUP_LOG"
  return 0
}

die() { say "$2"; exit "$1"; }

# sha256sum is GNU; macOS ships `shasum`. The test lane runs on both, and a backup tool
# that only verifies on one of them verifies on neither in practice.
sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1
  else shasum -a 256 "$1" | cut -d" " -f1; fi
}

[ -n "$LEDGER_DIR" ] || die 1 "REFUSED: LEDGER_DIR is empty — nothing names the source"
[ -d "$LEDGER_DIR" ] || die 1 "REFUSED: LEDGER_DIR is not a directory ($LEDGER_DIR)"

for f in "${SERIES[@]}"; do
  [ -f "$LEDGER_DIR/$f" ] || die 1 "REFUSED: $f is missing from $LEDGER_DIR"
  [ -s "$LEDGER_DIR/$f" ] || die 1 "REFUSED: $f is empty — an empty series is not a series"
done

if [ -z "$BACKUP_DEST" ]; then
  say "DISABLED: BACKUP_DEST is not set, nothing was copied"
  exit 0
fi

case "$BACKUP_DEST" in
  *:*) DEST_HOST="${BACKUP_DEST%%:*}"; DEST_DIR="${BACKUP_DEST#*:}" ;;
  *)   die 1 "REFUSED: BACKUP_DEST must be <host>:<dir> or local:<dir>, got '$BACKUP_DEST'" ;;
esac
[ -n "$DEST_DIR" ] || die 1 "REFUSED: BACKUP_DEST names no directory ('$BACKUP_DEST')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# `-C` with a named parent so the archive unpacks as langflow-e2e/<file> — the shape the
# copies taken by hand already use, so old and new are interchangeable.
STAGE="$TMP/langflow-e2e"
mkdir -p "$STAGE"
for f in "${SERIES[@]}"; do cp -p "$LEDGER_DIR/$f" "$STAGE/$f"; done
tar czf "$TMP/$ARCHIVE" -C "$TMP" langflow-e2e

# --- refusal 1: the archive must hold what it claims -------------------------------
members="$(tar tzf "$TMP/$ARCHIVE" | grep -c '^langflow-e2e/[^/]\+$' || true)"
[ "$members" -eq "${#SERIES[@]}" ] \
  || die 1 "REFUSED: archive holds $members series, expected ${#SERIES[@]} — not sending it"

src_rows="$(wc -l < "$LEDGER_DIR/daily-history.jsonl" | tr -d ' ')"
arc_rows="$(tar xzf "$TMP/$ARCHIVE" -O langflow-e2e/daily-history.jsonl | wc -l | tr -d ' ')"
[ "$src_rows" = "$arc_rows" ] \
  || die 1 "REFUSED: archive has $arc_rows daily rows against $src_rows at the source"

sum_local="$(sha "$TMP/$ARCHIVE")"

# --- transfer ----------------------------------------------------------------------
if [ "$DEST_HOST" = "local" ]; then
  mkdir -p "$DEST_DIR" || die 2 "FAILED: cannot create $DEST_DIR"
  cp "$TMP/$ARCHIVE" "$DEST_DIR/$ARCHIVE" || die 2 "FAILED: copy to $DEST_DIR"
  sum_remote="$(sha "$DEST_DIR/$ARCHIVE")"
  kept=0
  while IFS= read -r old; do [ -n "$old" ] && rm -f "$old" && kept=$((kept+1)); done <<EOF
$(ls -1t "$DEST_DIR"/langflow-e2e-ledger-*.tgz 2>/dev/null | tail -n +"$((BACKUP_KEEP+1))")
EOF
else
  # shellcheck disable=SC2086
  ssh $SSH_OPTS -o BatchMode=yes "$DEST_HOST" "mkdir -p '$DEST_DIR'" \
    || die 2 "FAILED: cannot reach $DEST_HOST or create $DEST_DIR"
  # shellcheck disable=SC2086
  scp $SSH_OPTS -q -B "$TMP/$ARCHIVE" "$DEST_HOST:$DEST_DIR/$ARCHIVE" \
    || die 2 "FAILED: copy to $DEST_HOST:$DEST_DIR"
  # shellcheck disable=SC2086
  sum_remote="$(ssh $SSH_OPTS -o BatchMode=yes "$DEST_HOST" "sha256sum '$DEST_DIR/$ARCHIVE'" | cut -d' ' -f1)" \
    || die 2 "FAILED: cannot read back the archive on $DEST_HOST"
  # shellcheck disable=SC2086
  kept="$(ssh $SSH_OPTS -o BatchMode=yes "$DEST_HOST" \
    "ls -1t '$DEST_DIR'/langflow-e2e-ledger-*.tgz 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | wc -l")"
  # shellcheck disable=SC2086
  ssh $SSH_OPTS -o BatchMode=yes "$DEST_HOST" \
    "ls -1t '$DEST_DIR'/langflow-e2e-ledger-*.tgz 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | xargs -r rm -f" || true
fi

# --- refusal 2: the bytes that landed are the bytes that left -----------------------
[ "$sum_local" = "$sum_remote" ] \
  || die 2 "FAILED: digest mismatch at the destination — local $sum_local, there $sum_remote"

say "ok: $ARCHIVE -> $BACKUP_DEST ($src_rows daily rows, digest verified, ${kept:-0} old archive(s) pruned)"
