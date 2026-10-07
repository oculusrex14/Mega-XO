#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the locally built image}
platform=${2:-linux/amd64}
caddy_image='caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f'
name="mega-v4-smoke-${RANDOM}"
volume="$name-data"
work=$(mktemp -d)
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
# Test values only. No account keys, live ads, payments or production mail.
otp=$(printf 'a%.0s' {1..64}); proxy=$(printf 'b%.0s' {1..64}); audit=$(printf 'c%.0s' {1..64})
docker volume create "$volume" >/dev/null
docker run --rm --platform "$platform" --user 0 -v "$volume:/data" --entrypoint sh "$image" -c 'chown 1000:1000 /data'
args=(--platform "$platform" --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=128m,mode=1777 -v "$volume:/data" -e MEGA_ORIGIN=https://game.test -e "MEGA_OTP_SECRET=$otp" -e "MEGA_PROXY_SECRET=$proxy" -e "MEGA_AUDIT_SECRET=$audit")
docker run -d --name "$name" "${args[@]}" -p 127.0.0.1::8080 "$image" >/dev/null
address=$(docker port "$name" 8080/tcp | head -1)
for _ in $(seq 1 40); do if curl -fsS "http://$address/readyz" > /dev/null; then break; fi; sleep 1; done
curl -fsS "http://$address/readyz" > /dev/null
[[ $(docker exec "$name" id -u) = 1000 ]]
if docker exec "$name" sh -c 'touch /app/should-not-write' 2>/dev/null; then echo 'Image root is writable' >&2; exit 1; fi
[[ $(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: game.test' "http://$address/api/account/session") = 403 ]]
curl -fsS -D "$work/headers" -H 'Host: game.test' -H "X-Mega-Proxy-Key: $proxy" -H 'X-Mega-Client-IP: 198.51.100.2' "http://$address/api/account/session" > "$work/session.json"
grep -qi 'content-security-policy:' "$work/headers"
grep -q 'HttpOnly' "$work/headers"
set +e
docker run --rm "${args[@]}" "$image" > "$work/second-process.log" 2>&1
second=$?
set -e
[[ "$second" = 73 ]] || { echo 'Second coordinator was not refused' >&2; exit 1; }
docker exec "$name" node server/production/backup.js snapshot /data/mega.sqlite /tmp/snapshot.sqlite
docker exec -e RESTIC_PASSWORD=ci-only-not-a-production-key "$name" sh -ec '
 restic --no-cache -r /tmp/restic-repo init --repository-version 2
 restic --no-cache -r /tmp/restic-repo backup /tmp/snapshot.sqlite /tmp/snapshot.sqlite.json
 restic --no-cache -r /tmp/restic-repo check
 restic --no-cache -r /tmp/restic-repo restore latest --target /tmp/recovered
 node server/production/backup.js verify /tmp/recovered/tmp/snapshot.sqlite
'
docker stop -t 25 "$name" >/dev/null
[[ $(docker inspect "$name" --format '{{.State.ExitCode}}') = 0 ]]
docker start "$name" >/dev/null
address=$(docker port "$name" 8080/tcp | head -1)
for _ in $(seq 1 30); do if curl -fsS "http://$address/readyz" >/dev/null; then break; fi; sleep 1; done
curl -fsS "http://$address/readyz" >/dev/null
staging_hash=$(docker run --rm "$caddy_image" caddy hash-password --plaintext ci-only-staging-password)
for config in Caddyfile Caddyfile.staging; do
 extra=()
 if [[ "$config" = Caddyfile.staging ]]; then extra=(-e "MEGA_STAGING_PASSWORD_HASH=$staging_hash"); fi
 docker run --rm -e MEGA_HOSTNAME=game.test -e ACME_EMAIL=contact@antimatterinnovations.com -e "MEGA_PROXY_SECRET=$proxy" "${extra[@]}" -v "$PWD/deploy:/etc/mega:ro" "$caddy_image" caddy validate --config "/etc/mega/$config" --adapter caddyfile
done
node scripts/init-vps.js game.test "$work/config" staging >/dev/null
MEGA_IMAGE="$image" MEGA_ROOT="$work/config" docker compose --env-file "$work/config/compose.env" -f deploy/compose.yaml config --quiet
echo "Container, backup, proxy and Compose smoke passed for $platform"
