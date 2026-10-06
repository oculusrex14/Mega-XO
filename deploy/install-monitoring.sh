#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) = 0 ]] || { echo 'Run monitoring installation with sudo/root.' >&2; exit 77; }
root=${1:?Usage: install-monitoring.sh /absolute/production/root}
[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Production must be deployed first.' >&2; exit 64; }
grep -qx 'MEGA_ENV=production' "$root/app.env" || { echo 'This installer is for production monitoring.' >&2; exit 64; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 69; }
[[ -s "$root/secrets/resend_api_key" ]] || { echo 'Install the Resend API key before monitoring.' >&2; exit 65; }

here=$(cd "$(dirname "$0")" && pwd)
ops="$root/ops-bin"
install -d -m 700 -o root -g root "$ops"
install -m 700 -o root -g root "$here/check-health.sh" "$ops/check-health.sh"
install -m 700 -o root -g root "$here/host-health-monitor.sh" "$ops/host-health-monitor.sh"
install -m 600 -o root -g root "$here/compose.yaml" "$ops/compose.yaml"
install -m 600 -o root -g root "$here/Caddyfile" "$ops/Caddyfile"
install -m 600 -o root -g root "$here/Caddyfile.staging" "$ops/Caddyfile.staging"

service=/etc/systemd/system/mega-xo-health.service
timer=/etc/systemd/system/mega-xo-health.timer

cat > "$service" <<EOF
[Unit]
Description=Mega XO production operational health check
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ops/host-health-monitor.sh $root
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$root/monitoring
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
EOF

cat > "$timer" <<'EOF'
[Unit]
Description=Run Mega XO operational health check every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
Unit=mega-xo-health.service

[Install]
WantedBy=timers.target
EOF

chmod 644 "$service" "$timer"
systemctl daemon-reload

# Refuse to silently install a monitor that is already failing.
"$ops/host-health-monitor.sh" "$root"

systemctl enable --now mega-xo-health.timer
systemctl status mega-xo-health.timer --no-pager
echo 'Local production monitoring installed. Configure the independent external /opsz monitor next.'
