#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: staging-smoke.sh /absolute/staging/root}
[[ "$root" = /* && "$root" != / && -f "$root/app.env" && -f "$root/compose.env" ]] || { echo 'Invalid staging root.' >&2; exit 64; }
grep -qx 'MEGA_ENV=staging' "$root/app.env" || { echo 'Refusing to test a non-staging deployment.' >&2; exit 64; }
[[ -s "$root/secrets/staging_access_password" ]] || { echo 'Missing staging access password.' >&2; exit 65; }

origin=$(awk -F= '$1=="MEGA_ORIGIN"{print substr($0,index($0,"=")+1)}' "$root/app.env")
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo 'Staging origin must be a public HTTPS hostname.' >&2; exit 65; }

password=$(tr -d '\r\n' < "$root/secrets/staging_access_password")
cfg=$(mktemp)
headers=$(mktemp)
body=$(mktemp)
cookies=$(mktemp)
cleanup(){ rm -f "$cfg" "$headers" "$body" "$cookies"; unset password; }
trap cleanup EXIT
cat > "$cfg" <<EOF
silent
show-error
user = "staging:$password"
connect-timeout = 5
max-time = 15
EOF
unset password

status(){ curl --config "$cfg" -o "$body" -D "$headers" -w '%{http_code}' "$@"; }
expect(){ local got=$1 want=$2 label=$3; [[ "$got" = "$want" ]] || { echo "FAIL: $label returned $got, expected $want" >&2; cat "$body" >&2; exit 1; }; echo "OK: $label"; }

# Basic Auth must be enforced before application traffic.
unauth=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$origin/livez")
expect "$unauth" 401 'staging authentication'

code=$(status "$origin/livez"); expect "$code" 200 'live endpoint'
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$headers" || { echo 'FAIL: staging noindex header missing' >&2; exit 1; }

code=$(status "$origin/readyz"); expect "$code" 200 'ready endpoint'

for private in /metrics /status /server/production/main.js /deploy/compose.yaml /.git/config /.env; do
  code=$(status "$origin$private")
  expect "$code" 404 "private path $private"
done

code=$(curl --config "$cfg" -c "$cookies" -b "$cookies" -o "$body" -D "$headers" -w '%{http_code}' "$origin/api/account/session")
expect "$code" 200 'guest session bootstrap'
grep -qi '^set-cookie: __Host-mega_session=' "$headers" || { echo 'FAIL: secure session cookie missing' >&2; exit 1; }
grep -qi 'HttpOnly' "$headers" || { echo 'FAIL: session cookie is not HttpOnly' >&2; exit 1; }
grep -qi 'Secure' "$headers" || { echo 'FAIL: session cookie is not Secure' >&2; exit 1; }

# A hostile Origin must be rejected before any email/OTP action.
code=$(curl --config "$cfg" -c "$cookies" -b "$cookies" -o "$body" -D "$headers" -w '%{http_code}'   -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.invalid'   --data '{"action":"forgot","email":"nobody@example.invalid"}' "$origin/api/account/email")
expect "$code" 403 'cross-origin email request'

echo "Staging smoke passed for $origin"
