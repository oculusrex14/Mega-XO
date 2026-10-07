#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: prepare-staging.sh /absolute/staging/root}
[[ "$root" = /* && "$root" != / && -f "$root/app.env" && -f "$root/compose.env" ]] || { echo 'Initialize staging first.' >&2; exit 64; }
grep -qx 'MEGA_ENV=staging' "$root/app.env" || { echo 'Refusing to prepare a non-staging deployment.' >&2; exit 64; }
[[ -s "$root/secrets/staging_access_password" ]] || { echo 'Missing staging access password.' >&2; exit 65; }

caddy_image='caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f'
hash=$(docker run --rm   -v "$root/secrets/staging_access_password:/run/staging-password:ro"   --entrypoint sh "$caddy_image" -ec   'caddy hash-password --plaintext "$(tr -d "\r\n" < /run/staging-password)"')

[[ "$hash" = '$2a$'* || "$hash" = '$2b$'* || "$hash" = '$2y$'* || "$hash" = '$argon2id$'* ]] || { unset hash; echo 'Caddy did not return a recognized password hash.' >&2; exit 65; }

tmp=$(mktemp "$root/secrets/.staging_password_hash.XXXXXX")
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$hash" > "$tmp"
unset hash
chmod 600 "$tmp"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$tmp"; fi
mv -f "$tmp" "$root/secrets/staging_password_hash"
trap - EXIT

echo 'Staging access hash prepared. The plaintext password was not printed.'
echo "Retrieve the password locally only when needed: sudo cat $root/secrets/staging_access_password"
