#!/usr/bin/env bash
set -euo pipefail
root=${1:?Pass the deployment directory}
here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
# Logs contain operational counters only. Failure is suitable for a systemd
# OnFailure action or an independently configured monitoring integration.
if ! docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" exec -T app node scripts/ops.js health --require-backup; then
  echo 'MEGA_XO_HEALTH_FAILED: inspect readiness, disk usage and off-box backup age.' >&2
  exit 2
fi
