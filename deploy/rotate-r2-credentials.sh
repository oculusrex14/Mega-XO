#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: rotate-r2-credentials.sh /absolute/deployment/root /absolute/access-key-file /absolute/secret-key-file}
access_source=${2:?Access key file required}
secret_source=${3:?Secret key file required}

[[ "$root" = /* && "$root" != / && -f "$root/current-image" && -f "$root/compose.env" ]] || { echo 'Deployment root is not initialized/deployed.' >&2; exit 64; }
for file in "$access_source" "$secret_source"; do
  [[ "$file" = /* && -f "$file" && ! -L "$file" && -s "$file" ]] || { echo 'Each R2 credential must be a non-empty absolute regular non-symlink file.' >&2; exit 64; }
done

here=$(cd "$(dirname "$0")" && pwd)
export MEGA_ROOT="$root" MEGA_IMAGE
MEGA_IMAGE=$(cat "$root/current-image")
dc(){ docker compose --env-file "$root/compose.env" -f "$here/compose.yaml" "$@"; }

for name in backup_access_key backup_secret_key; do
  [[ -f "$root/secrets/$name" && ! -L "$root/secrets/$name" ]] || { echo "Existing $name is missing or unsafe." >&2; exit 65; }
done

exec 9>"$root/secret-rotation.lock"
flock -n 9 || { echo 'Another secret rotation is running.' >&2; exit 73; }

old_access=$(mktemp "$root/secrets/.old-r2-access.XXXXXX")
old_secret=$(mktemp "$root/secrets/.old-r2-secret.XXXXXX")
new_access=$(mktemp "$root/secrets/.new-r2-access.XXXXXX")
new_secret=$(mktemp "$root/secrets/.new-r2-secret.XXXXXX")
chmod 600 "$old_access" "$old_secret" "$new_access" "$new_secret"
cp "$root/secrets/backup_access_key" "$old_access"
cp "$root/secrets/backup_secret_key" "$old_secret"
cat "$access_source" > "$new_access"
cat "$secret_source" > "$new_secret"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$old_access" "$old_secret" "$new_access" "$new_secret"; fi

rollback(){
  set +e
  cp "$old_access" "$root/secrets/backup_access_key"
  cp "$old_secret" "$root/secrets/backup_secret_key"
  chmod 600 "$root/secrets/backup_access_key" "$root/secrets/backup_secret_key"
  dc --profile backup up -d --no-deps --force-recreate backup >/dev/null 2>&1
  rm -f "$old_access" "$old_secret" "$new_access" "$new_secret"
  echo 'R2 rotation failed; previous credential pair restored.' >&2
}
trap rollback ERR INT TERM

mv -f "$new_access" "$root/secrets/backup_access_key"
mv -f "$new_secret" "$root/secrets/backup_secret_key"
chmod 600 "$root/secrets/backup_access_key" "$root/secrets/backup_secret_key"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$root/secrets/backup_access_key" "$root/secrets/backup_secret_key"; fi

dc --profile backup up -d --no-deps --force-recreate backup
dc --profile backup run --rm --no-deps backup node scripts/backup-run.js check

rm -f "$old_access" "$old_secret"
trap - ERR INT TERM

echo 'R2 credential pair rotated and repository access verified. Secret values were not printed.'
