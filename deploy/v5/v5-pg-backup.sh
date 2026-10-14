#!/usr/bin/env bash
# Mega XO V5 supervised production PostgreSQL backup.
#
# One cycle: streaming pg_dump (postgres:16-alpine container, direct TLS as
# backup_reader) | P15 sealed-archive sealer (AES-256-GCM, RSA-3072 recipient)
# -> private archive dir, then R2 upload of ciphertext + manifest with
# If-None-Match:* and an independent reader-credential readback that re-hashes
# both objects. Fails closed at every step: a partial archive is never left
# behind, a failed upload stores nothing, and no secret is ever printed.
#
# Never deletes a remote object. Local archives are pruned to the newest
# V5_LOCAL_KEEP (default 12); remote retention is an owner decision.
set -euo pipefail
umask 077

ROOT=${V5_ROOT:-/opt/mega-xo-v5-production}
BIN=$ROOT/bin
LIB=$ROOT/lib
STATE=$ROOT/state
ARCHIVES=$ROOT/archives
NODE=$BIN/node-24/bin/node
IMAGE_FILE=$STATE/pg-image-ref
LOCAL_KEEP=${V5_LOCAL_KEEP:-12}

die(){ printf 'V5_BACKUP_FAILED: %s\n' "$1" >&2; exit 2; }
log(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

# ---- serialization: no two runs may overlap -------------------------------
mkdir -p "$STATE" "$ARCHIVES"
chmod 700 "$STATE" "$ARCHIVES"
exec 9>"$STATE/backup.lock"
flock -n 9 || die 'another backup run holds the lock (overlap refused)'

# ---- protected inputs ------------------------------------------------------
[[ $EUID -eq 0 ]] || die 'must run as root (needs the Resend key path and the docker socket)'
for f in pgpass neon-ca.pem recovery-public.pem r2-credentials.json \
         prod-source.json r2-target.json pg-image-ref; do
  p=$STATE/$f
  [[ -f $p && ! -L $p ]] || die "missing protected file $f"
  [[ $(stat -c '%a' "$p") == 600 ]] || die "protected file $f is not mode 0600"
done
for d in "$ARCHIVES" "$STATE"; do
  [[ $(stat -c '%a' "$d") == 700 ]] || die "$d must be mode 0700"
done
[[ -x $NODE ]] || die 'tree-local node runtime missing'
[[ -f $LIB/scripts/v5/p15/backup-cli.js ]] || die 'P15 sealer library missing'
IMAGE=$(tr -d '\r\n' < "$IMAGE_FILE")
[[ $IMAGE =~ ^postgres:16-alpine@sha256:[0-9a-f]{64}$ ]] || die 'pinned postgres:16-alpine image reference invalid'

SOURCE_SHA=$("$NODE" -e '
 const fs=require("node:fs");
 const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
 if(!/^[0-9a-f]{40}$/.test(t.sourceSha||""))process.exit(3);
 process.stdout.write(t.sourceSha);
' "$STATE/prod-source.json") || die 'production target source SHA invalid'

# ---- cycle -----------------------------------------------------------------
started=$(date +%s)
before=$(date +%s%N)

# PATH puts the docker pg_dump wrapper first; the sealer resolves `pg_dump`
# through it exactly as it would a local client binary (same argv, byte-exact
# stdout, propagated exit status).
export PATH=$BIN:/usr/bin:/bin
export V5_PG_IMAGE=$IMAGE
export P15_SOURCE_SHA=$SOURCE_SHA
export P15_OWNER_APPROVE_PRODUCTION_BACKUP=1
export P15_OWNER_CONFIRMS_PRODUCTION=1
export P15_PGPASSFILE=$STATE/pgpass
export P15_PGSSLROOTCERT=$STATE/neon-ca.pem

log "backup start sourceSha=$SOURCE_SHA image=$IMAGE"
summary=$("$NODE" "$LIB/scripts/v5/p15/backup-cli.js" \
  --source "$STATE/prod-source.json" \
  --recipient "$STATE/recovery-public.pem" \
  --out "$ARCHIVES" \
  --confirm-nonserving-production-backup) || die 'sealed backup refused or failed; no archive published'
sealed=$(( ($(date +%s%N) - before) / 1000000 ))

backup_id=$("$NODE" -e '
 let raw="";process.stdin.on("data",d=>{raw+=d;}).on("end",()=>{
  const lines=raw.trim().split("\n");const last=lines[lines.length-1];
  let doc;try{doc=JSON.parse(last);}catch{process.exit(3);}
  if(doc.format!=="mega-v5-p15-backup-manifest/v1"||!/^v5-p15-[\w-]+$/.test(doc.backupId))process.exit(4);
  process.stdout.write(doc.backupId);
 });' <<<"$summary") || die 'sealed backup summary unparsable'
manifest=$ARCHIVES/$backup_id.manifest.json
archive=$ARCHIVES/$backup_id.mxb
[[ -f $manifest && -f $archive ]] || die 'archive/manifest pair incomplete after sealing'
log "sealed backupId=$backup_id bytes=$(stat -c '%s' "$archive") seal_ms=$sealed"

# ---- upload + independent readback ----------------------------------------
before=$(date +%s%N)
"$NODE" "$BIN/v5-r2-upload.js" \
  --credentials "$STATE/r2-credentials.json" \
  --target "$STATE/r2-target.json" \
  --manifest "$manifest" \
  --archive "$archive" \
  --receipt "$ARCHIVES/$backup_id.r2-receipt.json" \
  --source-sha "$SOURCE_SHA" || die 'R2 upload/independent readback failed (no object rollback attempted)'
transferred=$(( ($(date +%s%N) - before) / 1000000 ))
log "r2 upload+readback verified receipt=$ARCHIVES/$backup_id.r2-receipt.json ms=$transferred"

# ---- bounded local retention (never touches the remote bucket) ------------
mapfile -t local_manifests < <(find "$ARCHIVES" -maxdepth 1 -type f -name 'v5-p15-*.manifest.json' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
if (( ${#local_manifests[@]} > LOCAL_KEEP )); then
  for stale in "${local_manifests[@]:LOCAL_KEEP}"; do
    # The upload receipt is bound to the archive it describes, so it is pruned
    # with the pair it belongs to and never independently of it.
    rm -f -- "$stale" "${stale%.manifest.json}.mxb" "${stale%.manifest.json}.r2-receipt.json"
  done
  log "local retention pruned to newest $LOCAL_KEEP archives"
fi

elapsed=$(( $(date +%s) - started ))
log "backup complete backupId=$backup_id elapsed_s=$elapsed"
