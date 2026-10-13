#!/usr/bin/env python3
"""Combine several family-split datasets into one, refusing any family that crosses a split.

Because `splitFor(family)` is deterministic, the same opening family must map to the same split in every
source; a conflict is a hard error (it would leak). Adds `games` (distinct game ids) so `validate-data.cjs`
accepts the manifest. Usage: combine-datasets.py <in1.jsonl> <in2.jsonl> ... <out.jsonl>
"""
import hashlib
import json
import os
import sys


def main() -> int:
    *sources, out = sys.argv[1:]
    counts = {"train": 0, "validation": 0, "holdout": 0}
    families, games = {}, set()
    digest = hashlib.sha256()
    with open(out + ".tmp", "w") as merged:
        for source in sources:
            with open(source) as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    family, split = row["openingFamily"], row["split"]
                    if families.setdefault(family, split) != split:
                        raise SystemExit(f"SPLIT_CONFLICT {family} {families[family]} {split}")
                    games.add(row["gameId"])
                    merged.write(line)
                    digest.update(line.encode())
                    counts[split] += 1
    os.replace(out + ".tmp", out)
    records = sum(counts.values())
    manifest = {
        "schemaVersion": 1, "records": records, "games": len(games), "counts": counts,
        "sha256": digest.hexdigest(), "trainingStatus": "STRONG_SEARCH_LABELS_COMBINED",
        "sources": sources, "families": len(families),
        "splitPolicy": "whole games grouped by D4-normalized four-ply opening; no family crosses splits",
        "targetPolicy": "POLICY=deep search visits; VALUE=deep-search root score normalised",
    }
    with open(out + ".manifest.json", "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps({"records": records, "counts": counts, "families": len(families)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
