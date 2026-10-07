#!/bin/sh
set -eu
umask 077
# The backup profile is opt-in. Repository initialization is a separate command.
# No delete/prune operation runs automatically from this loop.
mkdir -p /work /backup-status
exec 9>/work/backup.lock
flock -n 9 || { echo 'Another backup worker holds the lock' >&2; exit 73; }
trap 'exit 0' TERM INT
while :; do
  started=$(date +%s)
  if node scripts/backup-run.js once; then
    :
  else
    echo '{"event":"backup_cycle_failed"}' >&2
  fi
  elapsed=$(( $(date +%s) - started ))
  remaining=$((900 - elapsed))
  if [ "$remaining" -lt 30 ]; then remaining=30; fi
  sleep "$remaining" &
  wait $! || true
done
