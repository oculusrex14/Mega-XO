#!/usr/bin/env bash
# Safely install the host-managed change-aware backup scripts.
# Unlike the old installer, this stages AND executes the pinned read-only PostgreSQL LSN probe
# BEFORE overwriting any host binary. A failed preflight leaves the running backup untouched.
#
# Usage: sudo ./install-change-aware.sh [V5_ROOT]
# No service restart or timer enablement is performed by this script.
set -euo pipefail
umask 077

ROOT=${1:-/opt/mega-xo-v5-production}
[[ "$ROOT" = /* && "$ROOT" != / && -d "$ROOT" ]] || {
  echo 'INSTALL_REFUSED: invalid absolute deployment root' >&2; exit 64;
}
ROOT=$(realpath -e -- "$ROOT")
SRC="$ROOT/src-final/deploy/v5"
BIN="$ROOT/bin"
STATE="$ROOT/state"
NODE="$BIN/node-24/bin/node"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILES=(v5-pg-backup.sh v5-freshness.js v5-change-check.js psql v5-idle-probe.js)

[[ "$EUID" -eq 0 ]] || { echo 'INSTALL_REFUSED: root required for host-managed scripts' >&2; exit 64; }
[[ -x "$NODE" && -d "$BIN" && -d "$STATE" ]] || {
  echo 'INSTALL_REFUSED: private deployment tree or Node runtime missing' >&2; exit 64;
}
[[ ! -L "$BIN" && ! -L "$STATE" ]] || {
  echo 'INSTALL_REFUSED: symlinked deployment directories' >&2; exit 64;
}
command -v systemctl >/dev/null || { echo 'INSTALL_REFUSED: systemd required' >&2; exit 64; }
command -v flock >/dev/null || { echo 'INSTALL_REFUSED: flock required' >&2; exit 64; }
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" && ! -L "$SRC/$f" && ! -L "$BIN/$f" ]] || {
    echo "INSTALL_REFUSED: missing, unexpected or symlinked $f" >&2; exit 64;
  }
done
for f in pgpass neon-ca.pem pg-image-ref prod-source.json; do
  [[ -f "$STATE/$f" && ! -L "$STATE/$f" && $(stat -c '%a' "$STATE/$f") == 600 ]] || {
    echo "INSTALL_REFUSED: unsafe or missing protected $f" >&2; exit 64;
  }
done

# Share the backup service's lock. The timer can never execute a half-installed gate.
exec 9>"$STATE/backup.lock"
flock -n 9 || { echo 'INSTALL_REFUSED: scheduled backup is active; retry after it completes' >&2; exit 75; }

STAGE=$(mktemp -d "$STATE/.changeaware-stage.XXXXXXXX")
ROLLBACK=''
mutation_started=0
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  if [[ "$mutation_started" == 1 ]]; then
    restored=true
    for f in "${FILES[@]}"; do
      if [[ -f "$ROLLBACK/$f" ]]; then
        cp -p -- "$ROLLBACK/$f" "$BIN/$f" || restored=false
      else
        rm -f -- "$BIN/$f" || restored=false
      fi
    done
    if [[ "$restored" == true ]]; then
      echo "INSTALL_ROLLED_BACK: restored all host scripts from $ROLLBACK" >&2
    else
      echo "INSTALL_ROLLBACK_FAILED: use the preserved snapshot at $ROLLBACK" >&2
    fi
  fi
  rm -rf -- "$STAGE"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stage the exact reviewed sources without touching $BIN.
for f in "${FILES[@]}"; do install -m 0755 "$SRC/$f" "$STAGE/$f"; done
bash -n "$STAGE/v5-pg-backup.sh"
sh -n "$STAGE/psql"
for f in v5-freshness.js v5-change-check.js v5-idle-probe.js; do "$NODE" --check "$STAGE/$f"; done

# The P15 direct-target contract refuses production probing unless all authority flags and
# mode-0600 protected credentials exist. Use the STAGED psql wrapper and the EXACT backup-reader
# env used by v5-pg-backup.sh, never whichever psql happens to be first on PATH.
#
# --print-lsn ALWAYS invokes real pg_current_wal_lsn(), even when last-backup-lsn is missing.
# That is the only honest test that Docker, pinned PG16, TLS and credential bindings work.
probe() {
  env V5_ROOT="$ROOT" V5_PSQL_BIN="$STAGE/psql" PATH="$BIN:/usr/bin:/bin" \
    P15_OWNER_APPROVE_PRODUCTION_BACKUP=1 P15_OWNER_CONFIRMS_PRODUCTION=1 \
    P15_PGPASSFILE="$STATE/pgpass" P15_PGSSLROOTCERT="$STATE/neon-ca.pem" \
    "$NODE" "$STAGE/v5-change-check.js" "$@"
}
set +e
LSN=$(probe --print-lsn --source "$STATE/prod-source.json" 2>/dev/null)
PROBE_RC=$?
set -e
if [[ "$PROBE_RC" -ne 0 || ! "$LSN" =~ ^[0-9A-F]+/[0-9A-F]+$ ]]; then
  echo 'INSTALL_REFUSED: staged LSN probe failed; host scripts are unchanged' >&2
  exit 65
fi
set +e
probe --source "$STATE/prod-source.json" >/dev/null 2>&1
PROBE_RC=$?
set -e
if [[ "$PROBE_RC" -ne 0 && "$PROBE_RC" -ne 42 ]]; then
  echo 'INSTALL_REFUSED: staged changed/unchanged contract failed; host scripts are unchanged' >&2
  exit 65
fi
echo "INSTALL_PREFLIGHT_OK: verified scoped TLS backup_reader LSN; decision exit=$PROBE_RC"

# Preflight succeeded. Snapshot ALL overwritten files, including the psql wrapper/idle probe,
# before modifying the host bin. A partial install automatically restores the snapshot.
ROLLBACK="$STATE/install-rollback-$STAMP"
mkdir -m 0700 -- "$ROLLBACK"
for f in "${FILES[@]}"; do
  if [[ -f "$BIN/$f" ]]; then cp -p -- "$BIN/$f" "$ROLLBACK/$f"; fi
done
mutation_started=1
for f in "${FILES[@]}"; do install -m 0755 "$STAGE/$f" "$BIN/$f"; done
mutation_started=0
echo "INSTALL_OK: five host-managed files installed; rollback=$ROLLBACK"
echo 'One-shot backup and freshness units use the new files on their next scheduled invocation.'
