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

 # ---- change-aware skip (infrastructure brief 2026-10-19, part G) -----------
 # Sol P1 #3b: this probe runs AFTER the approval flags, credential paths and CA
 # are exported (readTarget/assertTarget refuse a production backup source
 # without them) and after PATH carries the docker wrapper, so the probe uses the
 # exact same pinned image and protected inputs as the dump itself.
 # A full dump every cycle streams the whole database from Neon even when not a
 # single row changed. The WAL LSN is server-side durable state that advances for
 # EVERY writer commit, and the recorded value is taken BEFORE a dump starts, so
 # any later commit forces the next cycle to dump: a skip only ever happens when
 # no tracked-table row changed since the recorded probe (the change-check owns
 # the ephemeral-table exception; see v5-change-check.js). Losing the state file
 # fails open to a full dump.
 # ONE atomic probe moment for the whole decision: the change-check prints the LSN and the
 # per-table counters captured in the same query, and the caller persists BOTH halves from
 # THIS payload - never from a second, later probe (a state pair from different moments
 # could silently exclude writes between them from every future delta).
 CC_STATUS=0
 CC_OUT=$("$NODE" "$BIN/v5-change-check.js" --source "$STATE/prod-source.json") || CC_STATUS=$?
 if [[ $CC_STATUS -ne 0 && $CC_STATUS -ne 42 ]]; then die 'change check failed closed'; fi
 IFS='|' read -r CURRENT_LSN TABLES_STATE_DOC <<<"$("$NODE" -e '
  let raw="";process.stdin.on("data",d=>{raw+=d;}).on("end",()=>{
   const lines=raw.trim().split("\n");const last=lines[lines.length-1];
   let doc;try{doc=JSON.parse(last);}catch{process.exit(3);}
   if(doc.event!=="change_check"||!/^[0-9A-F]+\/[0-9A-F]+$/.test(doc.current||"")||typeof doc.tablesStateDoc!=="string"||!doc.tablesStateDoc.startsWith("{"))process.exit(4);
   process.stdout.write(doc.current+"|"+doc.tablesStateDoc);
  });' <<<"$CC_OUT")" || die 'change check output unparsable'
 [[ -n $CURRENT_LSN && -n $TABLES_STATE_DOC ]] || die 'change check output incomplete'
 status=$CC_STATUS
 if [[ ${status:-0} -eq 42 ]]; then
   # Sol P1 #5: the marker binds the verified-unchanged proof to the newest LOCAL archive
   # identity. v5-freshness.js refuses a marker whose backupId is not the newest R2 manifest,
   # whose lsn != previous, or whose checkedAt falls outside the RPO - a stale, moved or
   # mismatched recovery point can never be vouched for by a newer probe.
   NEWEST_MANIFEST=$(find "$ARCHIVES" -maxdepth 1 -type f -name 'v5-p15-*.manifest.json' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- | head -1)
   [[ -n $NEWEST_MANIFEST ]] || die 'skip refused: no local manifest to bind the marker to'
   MARKER_BACKUP_ID=$(basename "$NEWEST_MANIFEST" .manifest.json)
   "$NODE" -e '
    const fs=require("node:fs"),p=process.argv[1],id=process.argv[2],lsn=process.argv[3];
    const marker=JSON.stringify({checkedAt:new Date().toISOString(),backupId:id,lsn,previous:lsn})+"\n";
    const tmp=p+".tmp";fs.writeFileSync(tmp,marker,{mode:0o600});fs.renameSync(tmp,p);
   ' "$STATE/backup-unchanged.json" "$MARKER_BACKUP_ID" "$CURRENT_LSN" || die 'marker write failed'
   # The counter baseline advances with a proven no-data-change skip; the LSN watermark
   # deliberately stays at the last dump so any data write still forces the next dump.
   umask 077; printf '%s\n' "$TABLES_STATE_DOC" > "$STATE/last-backup-tables.json"
   log "backup skipped: no tracked-table change since the last dump (marker bound to $MARKER_BACKUP_ID)"
   exit 0
 fi
 [[ ${status:-0} -eq 0 ]] || die 'change check failed closed'

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
# The pre-dump LSN is now the durable watermark: any commit after it (during or
# after this dump) makes the next comparison unequal and forces a fresh dump.
 # Persist BOTH halves of the decision probe (LSN + counter baseline) from the SAME atomic
 # moment, so no write can ever fall between the two baselines.
 umask 077
 printf '%s\n' "$CURRENT_LSN" > "$STATE/last-backup-lsn"
 printf '%s\n' "$TABLES_STATE_DOC" > "$STATE/last-backup-tables.json"
 rm -f "$STATE/backup-unchanged.json"

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
