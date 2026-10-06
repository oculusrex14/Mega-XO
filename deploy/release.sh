#!/usr/bin/env bash
set -euo pipefail
umask 077
root=${1:?Usage: release.sh /absolute/deployment/root ghcr.io/oculusrex14/mega-xo@sha256:DIGEST [--allow-recovery]}
image=${2:?An immutable image digest is required}
flag=${3:-}
[[ "$root" = /* && "$root" != / && -f "$root/compose.env" ]] || { echo 'Initialize the deployment directory first' >&2; exit 64; }
[[ "$image" =~ ^ghcr\.io/oculusrex14/mega-xo@sha256:[a-f0-9]{64}$ ]] || { echo 'Use the tested GHCR image digest, not a mutable tag' >&2; exit 64; }
[[ -z "$flag" || "$flag" = --allow-recovery ]] || exit 64
here=$(cd "$(dirname "$0")" && pwd)
exec 9>"$root/release.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 73; }
export MEGA_ROOT="$root" MEGA_IMAGE="$image"
dc() { docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }
old=''
if [[ -f "$root/current-image" ]]; then old=$(cat "$root/current-image"); fi
[[ -z "$old" || "$old" =~ ^ghcr\.io/oculusrex14/mega-xo@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid recorded rollback image' >&2; exit 65; }
dc config --quiet
dc pull app
# Configuration-only check: no database mutation or second coordinator.
dc run --rm --no-deps app node server/production/main.js --check-config
if [[ -n "$old" ]]; then
  dc exec -T app node scripts/ops.js maintenance on
  elapsed=0
  while [[ $(dc exec -T app node scripts/ops.js active) != 0 ]]; do
    if [[ "$flag" = --allow-recovery ]]; then echo 'Explicit recovery accepted: unfinished matches will follow the restart/refund policy.'; break; fi
    if ((elapsed >= 600)); then dc exec -T app node scripts/ops.js maintenance off; echo 'Drain timed out; deployment cancelled, existing image retained.' >&2; exit 75; fi
    sleep 5; elapsed=$((elapsed+5))
  done
  if ! dc exec -T app node server/production/backup.js snapshot /data/mega.sqlite "/data/predeploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite"; then
    dc exec -T app node scripts/ops.js maintenance off
    echo 'Pre-deployment snapshot failed; deployment cancelled.' >&2; exit 74
  fi
else
  [[ ! -f "$root/data/mega.sqlite" ]] || { echo 'Existing data without a recorded image: use the migration runbook, not bootstrap.' >&2; exit 65; }
fi
# Stop then replace: never blue/green two coordinators against one database.
dc stop app || true
ready() {
  for _ in $(seq 1 45); do
    if dc exec -T app node -e "fetch('http://127.0.0.1:8080/livez',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      dc exec -T app node scripts/ops.js maintenance off >/dev/null
      dc exec -T app node -e "fetch('http://127.0.0.1:8080/readyz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0
    fi
    sleep 2
  done
  return 1
}
if ! dc up -d --no-deps app || ! ready; then
  echo 'New image did not become ready. No database will be rewound automatically.' >&2
  dc stop app || true
  if [[ -n "$old" ]]; then
    export MEGA_IMAGE="$old"
    dc up -d --no-deps app
    if ready; then echo 'Previous application image restored against current data.'; else echo 'Rollback cannot open current schema. Keep maintenance and follow the explicit restore runbook.' >&2; fi
  fi
  exit 1
fi
# Pin the actual Caddy image in compose.env before a public release.
dc up -d --no-deps edge
printf '%s\n' "$image" > "$root/current-image.tmp"
mv "$root/current-image.tmp" "$root/current-image"
printf '%s\n' "$(date -u +%FT%TZ) $image" >> "$root/releases/history.log"
echo 'Application ready. Check HTTPS and off-box backup health before inviting players.'
