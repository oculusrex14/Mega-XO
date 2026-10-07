#!/usr/bin/env bash
set -euo pipefail

root=${1:?Usage: audit-perimeter.sh /absolute/production/root}
[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Invalid production root.' >&2; exit 64; }
grep -qx 'MEGA_ENV=production' "$root/app.env" || { echo 'Perimeter audit is for production.' >&2; exit 64; }

here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
dc(){ docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }

fail(){ echo "FAIL: $*" >&2; exit 1; }
ok(){ echo "OK: $*"; }

dc config --quiet
app=$(dc ps -q app); edge=$(dc ps -q edge)
[[ -n "$app" && -n "$edge" ]] || fail 'app and edge containers must both exist'

check_container(){
  local id=$1 name=$2
  [[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true ]] || fail "$name root filesystem is writable"
  [[ "$(docker inspect -f '{{.Config.User}}' "$id")" = 1000:1000 || "$name" = edge ]] || fail "$name must run as uid/gid 1000"
  docker inspect -f '{{json .HostConfig.CapDrop}}' "$id" | grep -q '"ALL"' || fail "$name does not drop all capabilities"
  docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$id" | grep -q 'no-new-privileges:true' || fail "$name lacks no-new-privileges"
  ok "$name container hardening"
}
check_container "$app" app
check_container "$edge" edge

app_ports=$(docker port "$app" 2>/dev/null || true)
grep -q '^9091/tcp -> 127\.0\.0\.1:' <<<"$app_ports" || fail 'metrics port is not loopback-only'
! grep -q '^8080/tcp' <<<"$app_ports" || fail 'application port 8080 is published on the host'
ok 'application port is private and metrics are loopback-only'

edge_ports=$(docker port "$edge" 2>/dev/null || true)
grep -Eq '^80/tcp -> (0\.0\.0\.0|\[::\]):80$' <<<"$edge_ports" || fail 'edge HTTP port is not publicly bound'
grep -Eq '^443/tcp -> (0\.0\.0\.0|\[::\]):443$' <<<"$edge_ports" || fail 'edge HTTPS port is not publicly bound'
ok 'only edge web ports are published'

if command -v ss >/dev/null; then
  listeners=$(ss -H -ltn)
  for port in 2375 2376 8080; do
    if awk '{print $4}' <<<"$listeners" | grep -Eq "(^|0\.0\.0\.0:|\[::\]:).*:${port}$"; then fail "sensitive TCP port $port is listening publicly"; fi
  done
  if awk '{print $4}' <<<"$listeners" | grep -Eq '(^|0\.0\.0\.0:|\[::\]:).*:9091$'; then fail 'metrics port 9091 is listening publicly'; fi
  ok 'host listeners do not expose Docker API, app, or metrics ports'
fi

[[ -d "$root/secrets" ]] || fail 'secrets directory missing'
while IFS= read -r file; do
  mode=$(stat -c '%a' "$file")
  [[ "$mode" = 600 ]] || fail "secret file $file has mode $mode instead of 600"
done < <(find "$root/secrets" -maxdepth 1 -type f -print)
ok 'secret files are owner-only'

[[ -d "$root/data" ]] || fail 'data directory missing'
data_mode=$(stat -c '%a' "$root/data")
[[ "$data_mode" = 700 ]] || fail "data directory mode is $data_mode instead of 700"
if [[ -e "$root/data/mega.sqlite" ]]; then
  db_mode=$(stat -c '%a' "$root/data/mega.sqlite")
  [[ "$db_mode" =~ ^6[04]0$|^600$ ]] || fail "database mode $db_mode is broader than expected"
fi
ok 'database path is private'

grep -q '^ admin off$' "$here/Caddyfile" || fail 'Caddy admin API is not explicitly disabled'
grep -q 'header -Server' "$here/Caddyfile" || fail 'Caddy Server header suppression missing'
grep -q 'Strict-Transport-Security' "$here/Caddyfile" || fail 'HSTS header missing'
ok 'edge configuration disables admin API and server fingerprint'

if command -v tailscale >/dev/null; then
  tailscale status --json >/dev/null 2>&1 || fail 'Tailscale is installed but not connected'
  ok 'Tailscale administrative path is connected'
else
  fail 'Tailscale is required before public SSH is closed'
fi

echo 'Host perimeter audit passed. Run scripts/external-perimeter-probe.js from a machine outside the VPS next.'
