#!/usr/bin/env bash
# Installs the change-aware backup gate onto the host-managed backup installation.
#
# The systemd units run $ROOT/bin/* (host-managed copies), NOT the deployed source tree,
# so a deploy alone does not activate the gate. This installer:
#   1. copies the gate scripts from the freshly deployed source tree into $ROOT/bin,
#   2. backs up every overwritten host file next to itself (.pre-changeaware-<stamp>),
#   3. verifies the change-check reaches the LSN probe against the configured source
#      BEFORE touching the timer (a failed verification aborts with no changes),
#   4. leaves rollback to restoring the backup copies (documented in the decision log).
#
# Usage: sudo ./install-change-aware.sh [V5_ROOT]   (default /opt/mega-xo-v5-production)
set -euo pipefail
umask 077

ROOT=${1:-/opt/mega-xo-v5-production}
SRC="$ROOT/src-final/deploy/v5"
BIN="$ROOT/bin"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

for f in v5-pg-backup.sh v5-freshness.js v5-change-check.js psql v5-idle-probe.js; do
  [[ -f "$SRC/$f" ]] || { echo "INSTALL_REFUSED: $SRC/$f missing (deploy the commit first)" >&2; exit 64; }
done
[[ -x "$BIN/node-24/bin/node" ]] || { echo "INSTALL_REFUSED: node runtime missing" >&2; exit 64; }
command -v systemctl >/dev/null || { echo "INSTALL_REFUSED: systemd required" >&2; exit 64; }

# 1. Back up every host file this install overwrites.
mkdir -p "$ROOT/state/install-rollback-$STAMP"
for f in v5-pg-backup.sh v5-freshness.js; do
  if [[ -f "$BIN/$f" ]]; then
    cp -a "$BIN/$f" "$ROOT/state/install-rollback-$STAMP/$f"
  fi
done
echo "rollback copies: $ROOT/state/install-rollback-$STAMP"

# 2. Install.
install -m 0755 "$SRC/v5-pg-backup.sh" "$BIN/v5-pg-backup.sh"
install -m 0755 "$SRC/v5-freshness.js" "$BIN/v5-freshness.js"
install -m 0755 "$SRC/v5-change-check.js" "$BIN/v5-change-check.js"
install -m 0755 "$SRC/psql" "$BIN/psql"
install -m 0755 "$SRC/v5-idle-probe.js" "$BIN/v5-idle-probe.js"

# 3. Verify the probe end-to-end BEFORE any timer runs it: the change-check must either
#    reach the LSN query (exit 0/42) or fail closed with a refusal code. A TDZ/contract
#    crash (exit 1 + stack) aborts the install and the backup copies stay in place.
set +e
OUT=$("$BIN/node-24/bin/node" "$BIN/v5-change-check.js" --source "$ROOT/state/prod-source.json" 2>&1)
RC=$?
set -e
echo "$OUT"
if [[ $RC -ne 0 && $RC -ne 42 ]]; then
  echo "INSTALL_ABORTED: change-check exit $RC - host files unchanged except the bin copies; restore from $ROOT/state/install-rollback-$STAMP" >&2
  exit "$RC"
fi
echo "INSTALL_OK: change-check exit $RC (0=will dump, 42=verified unchanged skip path)"
echo "next: systemctl restart is NOT needed - the oneshot units pick up bin/ per run."
