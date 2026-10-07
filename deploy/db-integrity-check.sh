#!/usr/bin/env bash
set -euo pipefail
umask 077
root=${1:?Pass the deployment directory}
[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Invalid deployment root.' >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
mkdir -p "$root/monitoring"
tmp="$root/monitoring/.db-integrity.$$.json"
trap 'rm -f "$tmp"' EXIT
docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" exec -T app node scripts/db-maintenance.js check > "$tmp"
docker run --rm --platform linux/arm64 -v "$root/monitoring:/m:ro" node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.ok!==true||x.quickCheck!=="ok"||x.foreignKeyViolations!==0)process.exit(2)' "/m/.db-integrity.$$.json"
mv -f "$tmp" "$root/monitoring/db-integrity-last.json"
chmod 600 "$root/monitoring/db-integrity-last.json"
trap - EXIT
echo 'MEGA_XO_DATABASE_INTEGRITY_OK'
