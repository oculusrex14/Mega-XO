#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: enable-backups.sh /absolute/deployment/root --initialize-new-repository}
confirm=${2:-}
[[ "$confirm" = --initialize-new-repository ]] || { echo 'Explicit --initialize-new-repository is required.' >&2; exit 64; }
[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" && -f "$root/backup.env" ]] || { echo 'Deployment must already have a current image and backup configuration.' >&2; exit 64; }

here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
[[ "$MEGA_IMAGE" =~ ^ghcr\.io/oculusrex14/mega-xo@sha256:[a-f0-9]{64}$ ]] || { echo 'Current image is not an immutable GHCR digest.' >&2; exit 65; }

dc(){ docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" --profile backup "$@"; }

dc config --quiet
[[ -s "$root/secrets/backup_access_key" && -s "$root/secrets/backup_secret_key" && -s "$root/secrets/restic_password" ]] || { echo 'Backup secrets are incomplete.' >&2; exit 65; }
grep -q '^RESTIC_REPOSITORY=s3:https://' "$root/backup.env" || { echo 'Backup repository is not configured.' >&2; exit 65; }

echo 'Initializing encrypted Restic repository...'
dc run --rm --no-deps backup node scripts/backup-run.js init --confirm-new-repository

echo 'Creating first off-box backup...'
dc run --rm --no-deps backup node scripts/backup-run.js once

echo 'Checking repository integrity...'
dc run --rm --no-deps backup node scripts/backup-run.js check

snapshot=$(sed -n 's/.*"snapshotId":"\([^"]*\)".*/\1/p' "$root/backup-status/last-success.json")
[[ "$snapshot" =~ ^[a-f0-9]{8,64}$ ]] || { echo 'Backup status did not contain a valid snapshot ID.' >&2; exit 65; }

echo 'Retrieving and verifying the first encrypted snapshot...'
dc run --rm --no-deps backup node scripts/backup-run.js retrieve "$snapshot"

echo 'Starting the 15-minute backup worker...'
dc up -d backup

echo 'Off-box backups enabled. Preserve the Restic recovery password outside both the VPS and Cloudflare account.'
