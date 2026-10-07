#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Usage: install-secrets.sh /absolute/deployment/root [options]}
shift
[[ "$root" = /* && "$root" != / && -d "$root/secrets" && -f "$root/app.env" ]] || { echo 'Initialize the deployment directory first.' >&2; exit 64; }

resend_file=''
audit_file=''
google_file=''
apple_file=''
google_play_file=''
apple_roots_file=''
verify_only=false

while (($#)); do
  case "$1" in
    --resend-file) resend_file=${2:?Missing path}; shift 2 ;;
    --audit-file) audit_file=${2:?Missing path}; shift 2 ;;
    --google-file) google_file=${2:?Missing path}; shift 2 ;;
    --apple-file) apple_file=${2:?Missing path}; shift 2 ;;
    --google-play-file) google_play_file=${2:?Missing path}; shift 2 ;;
    --apple-store-roots-file) apple_roots_file=${2:?Missing path}; shift 2 ;;
    --verify-only) verify_only=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

secret_dir="$root/secrets"
owner_args=()
if [[ $(id -u) = 0 ]]; then owner_args=(-o 1000 -g 1000); fi

# Audit secret first: existing roots predate it, and validation below requires it.
if ! $verify_only && [[ -n "$audit_file" ]]; then write_secret audit_secret "$audit_file"; fi

write_secret() {
  local name=$1 source=$2 tmp
  [[ "$source" = /* && -f "$source" ]] || { echo "Secret source for $name must be an absolute regular file." >&2; exit 64; }
  [[ ! -L "$source" ]] || { echo "Secret source for $name must not be a symlink." >&2; exit 64; }
  tmp=$(mktemp "$secret_dir/.${name}.XXXXXX")
  trap 'rm -f "$tmp"' RETURN
  cat -- "$source" > "$tmp"
  [[ -s "$tmp" ]] || { echo "Secret $name is empty." >&2; exit 65; }
  chmod 600 "$tmp"
  if ((${#owner_args[@]})); then chown 1000:1000 "$tmp"; fi
  mv -f -- "$tmp" "$secret_dir/$name"
  trap - RETURN
}

prompt_resend() {
  local tmp value
  tmp=$(mktemp)
  chmod 600 "$tmp"
  trap 'rm -f "$tmp"' RETURN
  read -rsp 'Paste Resend API key: ' value </dev/tty
  printf '\n' >/dev/tty
  [[ "$value" =~ ^re_[A-Za-z0-9_-]+$ ]] || { unset value; echo 'Invalid Resend API key format.' >&2; exit 65; }
  printf '%s\n' "$value" > "$tmp"
  unset value
  write_secret resend_api_key "$tmp"
  rm -f "$tmp"
  trap - RETURN
}

validate_hex_secret() {
  local name=$1 value
  [[ -f "$secret_dir/$name" && ! -L "$secret_dir/$name" ]] || { echo "Missing $name." >&2; exit 65; }
  value=$(tr -d '\r\n' < "$secret_dir/$name")
  [[ "$value" =~ ^[A-Fa-f0-9]{64}$ ]] || { unset value; echo "$name must contain one 256-bit hex secret." >&2; exit 65; }
  unset value
}

validate_permissions() {
  local file=$1 mode
  mode=$(stat -c '%a' "$file")
  [[ "$mode" = 600 ]] || { echo "Insecure secret permissions on $file: expected 600, got $mode." >&2; exit 65; }
}

validate_hex_secret otp_secret
validate_hex_secret proxy_secret
validate_hex_secret audit_secret
validate_hex_secret restic_password
[[ "$(tr -d '\r\n' < "$secret_dir/otp_secret")" != "$(tr -d '\r\n' < "$secret_dir/proxy_secret")" ]] || { echo 'OTP and proxy secrets must be independent.' >&2; exit 65; }
[[ "$(tr -d '\r\n' < "$secret_dir/audit_secret")" != "$(tr -d '\r\n' < "$secret_dir/otp_secret")" && "$(tr -d '\r\n' < "$secret_dir/audit_secret")" != "$(tr -d '\r\n' < "$secret_dir/proxy_secret")" ]] || { echo 'Audit secret must be independent.' >&2; exit 65; }

if ! $verify_only; then
  if [[ -n "$resend_file" ]]; then write_secret resend_api_key "$resend_file"; else prompt_resend; fi
  [[ -z "$google_file" ]] || write_secret google_client_secret "$google_file"
  [[ -z "$apple_file" ]] || write_secret apple_private_key "$apple_file"
  [[ -z "$google_play_file" ]] || write_secret google_play_service_account "$google_play_file"
  [[ -z "$apple_roots_file" ]] || write_secret apple_store_roots "$apple_roots_file"
fi

[[ -s "$secret_dir/resend_api_key" ]] || { echo 'Resend API key is not installed.' >&2; exit 65; }
resend=$(tr -d '\r\n' < "$secret_dir/resend_api_key")
[[ "$resend" =~ ^re_[A-Za-z0-9_-]+$ ]] || { unset resend; echo 'Stored Resend API key has invalid format.' >&2; exit 65; }
unset resend

if [[ -s "$secret_dir/google_play_service_account" ]]; then
  node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!x.client_email||!x.private_key||!x.private_key.includes("BEGIN PRIVATE KEY"))process.exit(1)' "$secret_dir/google_play_service_account" || { echo 'Google Play service account JSON is invalid.' >&2; exit 65; }
fi

if [[ -s "$secret_dir/apple_store_roots" ]]; then
  grep -q -- '-----BEGIN CERTIFICATE-----' "$secret_dir/apple_store_roots" || { echo 'Apple Store trust roots do not contain PEM certificates.' >&2; exit 65; }
fi

if [[ -s "$secret_dir/apple_private_key" ]]; then
  grep -q -- '-----BEGIN PRIVATE KEY-----' "$secret_dir/apple_private_key" || { echo 'Apple private key does not look like a PEM private key.' >&2; exit 65; }
fi

for file in otp_secret proxy_secret audit_secret restic_password resend_api_key google_client_secret apple_private_key google_play_service_account apple_store_roots; do
  [[ -e "$secret_dir/$file" ]] || continue
  chmod 600 "$secret_dir/$file"
  if ((${#owner_args[@]})); then chown 1000:1000 "$secret_dir/$file"; fi
  validate_permissions "$secret_dir/$file"
done

echo 'Secret installation verified. No secret values were printed.'
