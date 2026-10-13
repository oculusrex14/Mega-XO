#!/usr/bin/env bash
# Parallel strong-search-label generation on a DGX node (CPU-bound Node search).
set -euo pipefail
REPO="${REPO:?REPO required}"; NODE="${NODE:?NODE required}"; OUT="${OUT:?OUT required}"
SHARDS="${SHARDS:-16}"; GAMES="${GAMES:-12}"; SEED="${SEED:-8000}"; SIMS="${SIMS:-96}"; BUDGET="${BUDGET:-400}"
OUTDIR="$(dirname "$OUT")"; mkdir -p "$OUTDIR/shard"
pids=()
for i in $(seq 0 $((SHARDS-1))); do
  s=$((SEED + i*100000))
  ( cd "$REPO" && "$NODE" training/bot/search-labels.cjs "$OUTDIR/shard/s$i.jsonl" "$GAMES" "$s" "$SIMS" "$BUDGET" "${DEPTH:-}" >"$OUTDIR/shard/s$i.log" 2>&1 ) &
  pids+=($!)
  # throttle to ~cores-2
  if (( (i+1) % (SHARDS) == 0 )); then :; fi
  while (( $(jobs -rp | wc -l) >= $(nproc) )); do sleep 1; done
done
wait
# Merge shards in seed order, recomputing the manifest.
python3 - "$OUT" "$SHARDS" "$GAMES" "$SEED" "$SIMS" "$BUDGET" <<'PY2'
import json, sys, hashlib, os, glob
out, shards, games, seed, sims, budget = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
outdir = os.path.dirname(out); rows = []; counts = {'train':0,'validation':0,'holdout':0}; ids=[]; h=hashlib.sha256()
with open(out+'.tmp','w') as fo:
    for i in range(shards):
        p = f"{outdir}/shard/s{i}.jsonl"
        if not os.path.exists(p): continue
        for line in open(p):
            if not line.strip(): continue
            fo.write(line); h.update(line.encode()); r=json.loads(line); counts[r['split']]+=1
        mp = p + '.manifest.json'
        if os.path.exists(mp): ids.append(json.load(open(mp))['gameIndex'])
open(out,'w').write(open(out+'.tmp').read()); os.remove(out+'.tmp')
manifest = {'schemaVersion':1,'records':sum(counts.values()),'games':games*shards,'seed':seed,'simulations':sims,'budgetMs':budget,
            'counts':counts,'sha256':h.hexdigest(),'trainingStatus':'STRONG_SEARCH_LABELS','shards':shards,
            'splitPolicy':'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
            'targetPolicy':'POLICY=deep search visits; VALUE=deep-search root score normalised',
            'teacher':{'budgetMs':budget,'simulations':sims}}
open(out+'.manifest.json','w').write(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'merged':sum(counts.values()),'counts':counts}))
PY2
