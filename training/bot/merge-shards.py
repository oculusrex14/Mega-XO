#!/usr/bin/env python3
"""Merge shards written by the parallel strong-search-label generator into one dataset + manifest.

Each shard is a `search-labels.cjs` output (`s<i>.jsonl` + `s<i>.jsonl.manifest.json`). Shards are merged
in seed order; the manifest's `sha256` is recomputed over the merged bytes so `validate-data.cjs` and
`train.py` accept it. Usage: merge-shards.py <out.jsonl> <shards> <gamesPerShard> <seed> <simulations> <budgetMs>
"""
import hashlib
import json
import os
import sys


def main() -> int:
    out, shards, games, seed, sims, budget = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
    outdir = os.path.dirname(out)
    counts = {"train": 0, "validation": 0, "holdout": 0}
    digest, records = hashlib.sha256(), 0
    with open(out + ".tmp", "w") as merged:
        for i in range(shards):
            path = f"{outdir}/shard/s{i}.jsonl"
            if not os.path.exists(path):
                continue
            with open(path) as shard:
                for line in shard:
                    if not line.strip():
                        continue
                    merged.write(line)
                    digest.update(line.encode())
                    counts[json.loads(line)["split"]] += 1
                    records += 1
    os.replace(out + ".tmp", out)
    manifest = {
        "schemaVersion": 1, "records": records, "games": games * shards, "seed": seed,
        "simulations": sims, "budgetMs": budget, "counts": counts, "sha256": digest.hexdigest(),
        "trainingStatus": "STRONG_SEARCH_LABELS", "shards": shards,
        "splitPolicy": "whole games grouped by D4-normalized four-ply opening; no family crosses splits",
        "targetPolicy": "POLICY=deep search visits; VALUE=deep-search root score normalised",
        "teacher": {"budgetMs": budget, "simulations": sims},
    }
    with open(out + ".manifest.json", "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps({"merged": records, "counts": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
