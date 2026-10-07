#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: rotate-secret.sh /absolute/deployment/root SECRET_NAME /absolute/new-secret-file}
name=${2:?Secret name required}
source=${3:?Absolute new secret file required}

[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Deployment root is not initialized/deployed.' >&2; exit 64; }
[[ "$source" = /* && -f "$source" && ! -L "$source" ]] || { echo 'New secret must be an absolute regular non-symlink file.' >&2; exit 64; }
[[ -s "$source" ]] || { echo 'New secret file is empty.' >&2; exit 65; }

case "$name" in
  resend_api_key|google_client_secret|apple_private_key|proxy_secret|otp_secret) ;;
  backup_access_key|backup_secret_key) echo 'R2 credentials must be rotated together with rotate-r2-credentials.sh.' >&2; exit 64 ;;
  restic_password) echo 'Do not rotate Restic encryption by replacing its password file. Use the Restic key-rotation procedure in INCIDENT-RUNBOOK.md.' >&2; exit 64 ;;
  *) echo 'Unsupported secret name.' >&2; exit 64 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
dc(){ docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }
target="$root/secrets/$name"
[[ -f "$target" && ! -L "$target" ]] || { echo "Existing $name secret file is missing or unsafe." >&2; exit 65; }

value=$(tr -d '\r\n' < "$source")
case "$name" in
  resend_api_key) [[ "$value" =~ ^re_[A-Za-z0-9_-]+$ ]] || { unset value; echo 'Invalid Resend API key format.' >&2; exit 65; } ;;
  proxy_secret|otp_secret) [[ "$value" =~ ^[A-Fa-f0-9]{64}$ ]] || { unset value; echo "$name must be a 256-bit hex value." >&2; exit 65; } ;;
  apple_private_key) grep -q -- '-----BEGIN PRIVATE KEY-----' "$source" || { unset value; echo 'Apple key is not a PEM private key.' >&2; exit 65; } ;;
  *) [[ ${#value} -ge 8 ]] || { unset value; echo "$name is implausibly short." >&2; exit 65; } ;;
esac
unset value

if [[ "$name" = proxy_secret || "$name" = otp_secret ]]; then
  status=$(dc exec -T app node scripts/operator.js incident-status)
  node -e 'const x=JSON.parse(process.argv[1]);if(!x.lockdown)process.exit(1)' "$status" || {
    echo "$name rotation requires an active audited incident lockdown first." >&2
    echo "Run: docker compose ... exec -T app node scripts/operator.js incident-lockdown --operator NAME --reason '...'" >&2
    exit 65
  }
fi

if [[ "$name" = otp_secret ]]; then
  other=$(tr -d '\r\n' < "$root/secrets/proxy_secret")
  next=$(tr -d '\r\n' < "$source")
  [[ "$next" != "$other" ]] || { unset other next; echo 'OTP and proxy secrets must remain independent.' >&2; exit 65; }
  unset other next
elif [[ "$name" = proxy_secret ]]; then
  other=$(tr -d '\r\n' < "$root/secrets/otp_secret")
  next=$(tr -d '\r\n' < "$source")
  [[ "$next" != "$other" ]] || { unset other next; echo 'Proxy and OTP secrets must remain independent.' >&2; exit 65; }
  unset other next
fi

exec 9>"$root/secret-rotation.lock"
flock -n 9 || { echo 'Another secret rotation is running.' >&2; exit 73; }

backup=$(mktemp "$root/secrets/.rotation-$name.XXXXXX")
tmp=$(mktemp "$root/secrets/.new-$name.XXXXXX")
chmod 600 "$backup" "$tmp"
cp -- "$target" "$backup"
cat -- "$source" > "$tmp"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$backup" "$tmp"; fi

restore(){
  set +e
  if [[ -f "$backup" ]]; then cp -- "$backup" "$target"; chmod 600 "$target"; fi
  case "$name" in
    proxy_secret) dc up -d --no-deps --force-recreate app edge >/dev/null 2>&1 ;;
    *) dc up -d --no-deps --force-recreate app >/dev/null 2>&1 ;;
  esac
  rm -f "$backup" "$tmp"
  echo 'Rotation failed; previous secret restored.' >&2
}
trap restore ERR INT TERM

mv -f -- "$tmp" "$target"
chmod 600 "$target"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$target"; fi

wait_app(){
  for _ in $(seq 1 30); do
    if dc exec -T app node -e "fetch('http://127.0.0.1:8080/livez',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

case "$name" in
  proxy_secret)
    dc stop edge
    dc up -d --no-deps --force-recreate app
    wait_app
    dc up -d --no-deps --force-recreate edge
    ;;
  resend_api_key|google_client_secret|apple_private_key|otp_secret)
    dc up -d --no-deps --force-recreate app
    wait_app
    ;;
esac

rm -f "$backup"
trap - ERR INT TERM
echo "$name rotation completed without printing the old or new secret."
if [[ "$name" = proxy_secret || "$name" = otp_secret ]]; then
  echo 'Incident lockdown remains active. Validate the service and explicitly clear the incident before leaving maintenance.'
fi
