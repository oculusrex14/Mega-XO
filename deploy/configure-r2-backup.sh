#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: configure-r2-backup.sh /absolute/deployment/root ACCOUNT_ID BUCKET [options]}
account=${2:?Cloudflare account ID required}
bucket=${3:?R2 bucket name required}
shift 3

[[ "$root" = /* && "$root" != / && -d "$root/secrets" && -f "$root/backup.env" ]] || { echo 'Initialize the deployment directory first.' >&2; exit 64; }
[[ "$account" =~ ^[A-Fa-f0-9]{32}$ ]] || { echo 'Cloudflare account ID must be 32 hexadecimal characters.' >&2; exit 64; }
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo 'Invalid R2 bucket name.' >&2; exit 64; }

access_file=''
secret_file=''
jurisdiction=''
while (($#)); do
  case "$1" in
    --access-key-file) access_file=${2:?Missing path}; shift 2 ;;
    --secret-key-file) secret_file=${2:?Missing path}; shift 2 ;;
    --jurisdiction)
      jurisdiction=${2:?Missing jurisdiction}
      [[ "$jurisdiction" = eu || "$jurisdiction" = us ]] || { echo 'Supported jurisdiction values are eu or us; omit for automatic placement.' >&2; exit 64; }
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

secret_dir="$root/secrets"
write_from_file() {
  local target=$1 source=$2 tmp
  [[ "$source" = /* && -f "$source" && ! -L "$source" ]] || { echo "Use an absolute regular file for $target." >&2; exit 64; }
  tmp=$(mktemp "$secret_dir/.${target}.XXXXXX")
  trap 'rm -f "$tmp"' RETURN
  cat -- "$source" > "$tmp"
  [[ -s "$tmp" ]] || { echo "$target is empty." >&2; exit 65; }
  chmod 600 "$tmp"
  if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$tmp"; fi
  mv -f "$tmp" "$secret_dir/$target"
  trap - RETURN
}
prompt_secret() {
  local target=$1 label=$2 value tmp
  tmp=$(mktemp); chmod 600 "$tmp"; trap 'rm -f "$tmp"' RETURN
  read -rsp "$label: " value </dev/tty; printf '\n' >/dev/tty
  [[ -n "$value" ]] || { unset value; echo "$target cannot be empty." >&2; exit 65; }
  printf '%s\n' "$value" > "$tmp"; unset value
  write_from_file "$target" "$tmp"; rm -f "$tmp"; trap - RETURN
}

if [[ -n "$access_file" ]]; then write_from_file backup_access_key "$access_file"; else prompt_secret backup_access_key 'Paste R2 Access Key ID'; fi
if [[ -n "$secret_file" ]]; then write_from_file backup_secret_key "$secret_file"; else prompt_secret backup_secret_key 'Paste R2 Secret Access Key'; fi

endpoint="$account"
[[ -z "$jurisdiction" ]] || endpoint="$account.$jurisdiction"
repository="s3:https://$endpoint.r2.cloudflarestorage.com/$bucket/mega-xo-v4"

stage=$(awk -F= '$1=="MEGA_ENV"{print $2}' "$root/app.env")
[[ "$stage" = production || "$stage" = staging ]] || { echo 'Invalid deployment stage.' >&2; exit 65; }

cat > "$root/backup.env.tmp" <<EOF
RESTIC_REPOSITORY=$repository
MEGA_BACKUP_BUDGET_BYTES=2147483648
MEGA_BACKUP_HOST=mega-xo-$stage
AWS_DEFAULT_REGION=auto
EOF
chmod 600 "$root/backup.env.tmp"
if [[ $(id -u) = 0 ]]; then chown 1000:1000 "$root/backup.env.tmp"; fi
mv -f "$root/backup.env.tmp" "$root/backup.env"

echo "R2 backup configuration installed for bucket $bucket. Credentials were not printed."
echo 'Next: initialize and prove the Restic repository with deploy/enable-backups.sh.'
