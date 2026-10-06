#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: host-health-monitor.sh /absolute/deployment/root}
[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Invalid deployment root.' >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)
[[ -f "$here/compose.yaml" && -x "$here/check-health.sh" ]] || { echo 'Monitoring assets are incomplete.' >&2; exit 65; }

export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
dc(){ docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }

mkdir -p "$root/monitoring"
chmod 700 "$root/monitoring"
state_file="$root/monitoring/last-state"
reason=''

if ! "$here/check-health.sh" "$root" >/dev/null 2>&1; then
  reason='application/backup/disk/storage health check failed'
fi

integrity_file="$root/monitoring/db-integrity-last.json"
if [[ ! -s "$integrity_file" ]]; then
  reason="${reason:+$reason; }database integrity result is missing"
else
  integrity_age=$(( $(date +%s) - $(stat -c %Y "$integrity_file" 2>/dev/null || echo 0) ))
  (( integrity_age <= 93600 )) || reason="${reason:+$reason; }database integrity result is stale"
  grep -q '"ok":true' "$integrity_file" || reason="${reason:+$reason; }database integrity check failed"
fi

for service in app edge; do
  id=$(dc ps -q "$service" 2>/dev/null || true)
  if [[ -z "$id" ]]; then reason="${reason:+$reason; }$service container is missing"; continue; fi
  running=$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || echo false)
  restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 999)
  [[ "$running" = true ]] || reason="${reason:+$reason; }$service container is not running"
  [[ "$restarts" =~ ^[0-9]+$ ]] || restarts=999
  (( restarts <= 3 )) || reason="${reason:+$reason; }$service restarted $restarts times"
done

if grep -q '^RESTIC_REPOSITORY=s3:https://' "$root/backup.env" 2>/dev/null; then
  backup_id=$(dc --profile backup ps -q backup 2>/dev/null || true)
  if [[ -z "$backup_id" ]] || [[ $(docker inspect -f '{{.State.Running}}' "$backup_id" 2>/dev/null || echo false) != true ]]; then
    reason="${reason:+$reason; }backup worker is not running"
  fi
fi

new_state=healthy
[[ -z "$reason" ]] || new_state=unhealthy
old_state=$(cat "$state_file" 2>/dev/null || echo unknown)

send_alert(){
  local subject=$1 text=$2 key cfg payload
  [[ -s "$root/secrets/resend_api_key" ]] || { echo 'Operations alert not sent: Resend key missing.' >&2; return 1; }
  key=$(tr -d '\r\n' < "$root/secrets/resend_api_key")
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
    send_alert 'Mega XO operational alert' "Mega XO on $host is unhealthy: $safe_reason. Connect through Tailscale and run the V4 health runbook." || transition_notified=false
  elif [[ "$old_state" = unhealthy ]]; then
    send_alert 'Mega XO recovered' "Mega XO on $host returned to healthy operational state." || transition_notified=false
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
