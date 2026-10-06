#!/usr/bin/env bash
set -euo pipefail
umask 077
root=${1:?Usage: restore.sh /deployment/root /verified/snapshot.sqlite --confirm-replace}
source=${2:?A recovered snapshot path is required}
[[ ${3:-} = --confirm-replace ]] || { echo 'Explicit --confirm-replace is required; this rewinds persisted game data.' >&2; exit 64; }
[[ "$root" = /* && "$source" = /* && -f "$source" && -f "$source.json" && -f "$root/current-image" ]] || exit 64
here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
[[ "$MEGA_IMAGE" =~ ^ghcr\.io/oculusrex14/mega-xo@sha256:[a-f0-9]{64}$ ]] || exit 64
exec 9>"$root/release.lock"
flock -n 9 || { echo 'Another deployment or restore is running' >&2; exit 73; }
dc() { docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }
directory=$(dirname "$source"); file=$(basename "$source")
# Verify before taking the service offline; the recovery mount is read-only.
dc run --rm --no-deps -v "$directory:/restore:ro" app node server/production/backup.js verify "/restore/$file"
dc --profile backup stop edge backup app
dc run --rm --no-deps -v "$directory:/restore:ro" app sh -ec '
 export MEGA_COORDINATOR_LOCKED=1
 exec flock -n -E 73 --no-fork /data/mega.sqlite.coordinator.lock node server/production/backup.js restore "$1" /data/mega.sqlite --confirm-replace
' sh "/restore/$file"
dc up -d --no-deps app
echo 'Database restored; a pre-restore snapshot was retained. Edge and backups remain stopped.'
echo 'Inspect private status and account data, then explicitly resume traffic and backups using the operations runbook.'
