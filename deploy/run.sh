#!/bin/sh
set -eu
umask 077
: "${MEGA_DB:=/data/mega.sqlite}"
export MEGA_DB
case "$MEGA_DB" in /*) ;; *) echo 'MEGA_DB must be absolute' >&2; exit 64;; esac
mkdir -p "$(dirname "$MEGA_DB")"
command -v flock >/dev/null 2>&1 || { echo 'Linux flock is required' >&2; exit 69; }
# The lock file must not be deleted. The kernel releases the lock on exit/crash.
# --no-fork preserves the lock across exec; a second coordinator exits 73.
export MEGA_COORDINATOR_LOCKED=1
exec flock -n -E 73 --no-fork "$MEGA_DB.coordinator.lock" node server/production/main.js "$@"
