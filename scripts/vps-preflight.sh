#!/usr/bin/env bash
set -euo pipefail

root=${1:-/opt/mega-xo}
fail(){ printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok(){ printf 'OK: %s\n' "$*"; }
warn(){ printf 'WARN: %s\n' "$*" >&2; }

[[ "$(uname -s)" = Linux ]] || fail 'production host must be Linux'
arch=$(uname -m)
case "$arch" in
  aarch64|arm64) ok "ARM64 host detected ($arch)" ;;
  *) fail "expected Oracle ARM64 host, got $arch" ;;
esac

command -v docker >/dev/null || fail 'Docker is not installed'
docker info >/dev/null 2>&1 || fail 'Docker daemon is not reachable'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is not available'
ok "$(docker --version)"
ok "$(docker compose version)"

command -v tailscale >/dev/null || fail 'Tailscale is not installed'
tailscale status --json >/dev/null 2>&1 || fail 'Tailscale is not connected'
ok 'Tailscale is connected'

command -v flock >/dev/null || fail 'flock is required for the single-coordinator lock'
command -v curl >/dev/null || fail 'curl is required for health checks'
command -v openssl >/dev/null || fail 'openssl is required for bootstrap secrets'

parent=$(dirname "$root")
probe=$parent
while [[ ! -e "$probe" && "$probe" != / ]]; do probe=$(dirname "$probe"); done
fstype=$(findmnt -n -o FSTYPE -T "$probe" 2>/dev/null || true)
case "$fstype" in
  nfs*|cifs|smb*|fuse.*|9p) fail "SQLite data must be on local storage, not $fstype" ;;
  '') warn 'could not determine deployment filesystem type' ;;
  *) ok "deployment filesystem is $fstype" ;;
esac

available_kb=$(df -Pk "$probe" | awk 'NR==2{print $4}')
(( available_kb >= 10*1024*1024 )) || fail 'less than 10 GiB free on deployment filesystem'
ok "$((available_kb/1024/1024)) GiB free on deployment filesystem"

if command -v timedatectl >/dev/null; then
  sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
  [[ "$sync" = yes ]] && ok 'system clock is NTP synchronized' || warn 'system clock is not confirmed NTP synchronized'
fi

if command -v ss >/dev/null; then
  listeners=$(ss -H -ltn 2>/dev/null || true)
  for p in 80 443; do
    if awk '{print $4}' <<<"$listeners" | grep -Eq "(^|:)${p}$"; then
      fail "TCP port $p is already listening; identify the process before deploying Caddy"
    fi
  done
  ok 'TCP ports 80 and 443 are free'
else
  warn 'ss is unavailable; port ownership was not checked'
fi

docker run --rm --platform linux/arm64 \
  node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  node -e "process.exit(process.arch==='arm64'?0:1)" >/dev/null
ok 'pinned Node ARM64 image runs on this host'

printf '\nVPS preflight passed. No firewall, DNS, users, or application data were changed.\n'
