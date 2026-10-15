#!/usr/bin/env bash
set -euo pipefail
umask 077
# deploy/v5/host-health-monitor.sh - V5 production host operational-health monitor.
#
# The V5 successor to deploy/host-health-monitor.sh. The V4 monitor probed the `app` compose
# service and shelled `scripts/ops.js health` INSIDE that container; after the V5 cutover that
# container is deliberately retired (fenced, restart disabled), so the V4 probe reports a false
# "app container is missing" every five minutes.
#
# This monitor probes the live V5 stack instead, and it keeps the SAME meaning: it is an
# OPERATIONS check (recovery material + real service health), never a process-liveness echo.
#   * the V5 authority service is active;
#   * the co-located edge container (the single 80/443 ingress) is running and has not restarted;
#   * the public operations probe /opsz answers ok:true - which is backup-aware and queue-aware;
#   * the scheduled freshness unit's state file is present, recent and fresh.
# A false alarm wastes the on-call channel, so a check is only red when the thing it names is
# genuinely unhealthy. Alerts go through the same Resend path and the same last-state transition
# semantics the V4 monitor used, so an operator sees one coherent alert stream across the cutover.
#
# Usage: host-health-monitor.sh <absolute deployment root>

root=${1:?Usage: host-health-monitor.sh /absolute/deployment/root}
[[ "$root" = /* && "$root" != / ]] || { echo 'Invalid deployment root.' >&2; exit 64; }

STATE_DIR=${V5_STATE_DIR:-/opt/mega-xo-v5-production/state}
SERVICE=${V5_SERVICE:-mega-xo-v5-production.service}
EDGE_CONTAINER=${V5_EDGE_CONTAINER:-mega-xo-production-edge-1}
OPSZ_URL=${V5_OPSZ_URL:-http://172.18.0.1:8080/opsz}
FRESHNESS_MAX_AGE_S=${V5_FRESHNESS_MAX_AGE_S:-1200}
# The Resend key lives with the V4 ops material, which the V5 freshness tool ALSO reads
# (v5-freshness.js: RESEND_KEY = /opt/mega-xo/secrets/resend_api_key). Keeping one path means one
# operator alert stream across the cutover rather than two.
RESEND_KEY_FILE=${V5_RESEND_KEY_FILE:-/opt/mega-xo/secrets/resend_api_key}

mkdir -p "$root/monitoring"
chmod 700 "$root/monitoring"
state_file="$root/monitoring/last-state"
reason=''

# 1. The authority service must be running. A failed unit is the loudest possible signal.
if ! systemctl is-active --quiet "$SERVICE"; then
  reason='V5 production authority service is not active'
fi

# 2. The edge container owns 80/443. It must be running and freshly started, never restart-looping.
edge_running=$(docker inspect -f '{{.State.Running}}' "$EDGE_CONTAINER" 2>/dev/null || echo false)
if [[ "$edge_running" != true ]]; then
  reason="${reason:+$reason; }edge ingress container is not running"
else
  edge_restarts=$(docker inspect -f '{{.RestartCount}}' "$EDGE_CONTAINER" 2>/dev/null || echo 999)
  [[ "$edge_restarts" =~ ^[0-9]+$ ]] || edge_restarts=999
  (( edge_restarts <= 3 )) || reason="${reason:+$reason; }edge ingress restarted $edge_restarts times"
fi

# 3. The public operations probe: backup-aware and queue-aware, so this single check covers the
#    recovery material and the durable worker pipeline. A non-200 is a real operational failure.
if ! curl -fsS -m 10 "$OPSZ_URL" >/dev/null 2>&1; then
  reason="${reason:+$reason; }operations probe /opsz is not ok"
fi

# 4. The scheduled freshness state file must exist, be recent, and declare a fresh backup. This is
#    redundant with /opsz by design: if the probe itself is broken (e.g. the service cannot read
#    state), the state file still tells the truth.
freshness_file="$STATE_DIR/freshness-state.json"
if [[ ! -s "$freshness_file" ]]; then
  reason="${reason:+$reason; }backup freshness state is missing"
else
  freshness_age=$(( $(date +%s) - $(stat -c %Y "$freshness_file" 2>/dev/null || echo 0) ))
  (( freshness_age <= FRESHNESS_MAX_AGE_S )) || reason="${reason:+$reason; }backup freshness state is stale"
  grep -q '"state": *"fresh"' "$freshness_file" || reason="${reason:+$reason; }newest verified backup is stale"
fi

new_state=healthy
[[ -z "$reason" ]] || new_state=unhealthy
old_state=$(cat "$state_file" 2>/dev/null || echo unknown)

send_alert(){
  local subject=$1 text=$2 key cfg payload
  [[ -s "$RESEND_KEY_FILE" ]] || { echo 'Operations alert not sent: Resend key missing.' >&2; return 1; }
  key=$(tr -d '\r\n' < "$RESEND_KEY_FILE")
  [[ "$key" =~ ^re_[A-Za-z0-9_-]+$ ]] || { unset key; echo 'Operations alert not sent: invalid Resend key.' >&2; return 1; }
  cfg=$(mktemp)
  chmod 600 "$cfg"
  {
    printf 'url = "https://api.resend.com/emails"\n'
    printf 'request = "POST"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$key"
    printf 'header = "Content-Type: application/json"\n'
    printf 'silent\nshow-error\nfail-with-body\nmax-time = 15\n'
  } > "$cfg"
  unset key
  payload=$(printf '{"from":"Mega XO Ops <contact@antimatterinnovations.com>","to":["contact@antimatterinnovations.com"],"subject":"%s","text":"%s"}' "$subject" "$text")
  curl --config "$cfg" --data-binary "$payload" >/dev/null
  rm -f "$cfg"
}

transition_notified=true
if [[ "$new_state" != "$old_state" ]]; then
  host=$(hostname -s 2>/dev/null || echo mega-xo)
  if [[ "$new_state" = unhealthy ]]; then
    safe_reason=$(printf '%s' "$reason" | tr -cd 'A-Za-z0-9 .,:;_/-' | cut -c1-500)
    send_alert 'Mega XO operational alert' "Mega XO V5 on $host is unhealthy: $safe_reason. Connect through Tailscale and inspect the V5 authority service, the edge container and the backup freshness state." || transition_notified=false
  elif [[ "$old_state" = unhealthy ]]; then
    send_alert 'Mega XO recovered' "Mega XO V5 on $host returned to healthy operational state." || transition_notified=false
  fi
fi

if $transition_notified; then
  printf '%s\n' "$new_state" > "$state_file"
  chmod 600 "$state_file"
else
  echo 'Alert delivery failed; state transition will be retried on the next health run.' >&2
fi

if [[ "$new_state" = unhealthy ]]; then
  echo "MEGA_XO_UNHEALTHY: $reason" >&2
  exit 2
fi
echo 'MEGA_XO_HEALTHY'
