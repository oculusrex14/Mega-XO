#!/usr/bin/env python3
"""Dataset hygiene: audit committed datasets, detect duplicate/cross-dataset positions, and extract a
reserved qualification set.

Motivated by measured facts (2026-10-13): `sp-combined.jsonl.gz` is a SUPERSET of
`search-labels-combined.jsonl.gz` (80,254/91,121 positions identical) - the same canonical position
carried DIFFERENT labels in two committed files, and a mixed/superset file must never be blended into
training with the file it supersets (double counting + label conflict). Splits within one file are
family-safe (0 cross-split positions).

Usage:
  audit <a.jsonl[.gz]> [b.jsonl[.gz] ...]      # per-file + pairwise overlap + value-source mix
  dedup <in.jsonl> <out.jsonl>                 # keep first occurrence of each canonical position
  qualification <in.jsonl> <out.jsonl>         # rows whose split == qualification (reserved families)
  positions <in.jsonl>                         # emit one canonical position key per line (for diffing)

A canonical position key is the exact (moves, side-to-move) pair - the full game prefix plus whose turn
it is - which is precisely the tensor the network sees. Two rows with the same key are the same input.
"""
from __future__ import annotations
import gzip, hashlib, io, json, sys
from collections import Counter, defaultdict


def _open(path: str):
    if path.endswith('.gz'):
        return io.TextIOWrapper(gzip.open(path, 'rb'))
    return open(path)


def _key(row: dict):
    if 'moves' not in row or 'player' not in row:
        return None  # e.g. the LLM decision dataset uses a different schema
    return hashlib.sha1(json.dumps([row['moves'], row['player']], sort_keys=True).encode()).hexdigest()


def _iter(path: str):
    for line in _open(path):
        line = line.strip()
        if line:
            yield json.loads(line)


def audit(paths: list[str]) -> dict:
    per_file, keysets = {}, {}
    for p in paths:
        keys, splits, sources, rows, other = set(), Counter(), Counter(), 0, 0
        for r in _iter(p):
            rows += 1
            k = _key(r)
            if k is None:
                other += 1
                continue
            keys.add(k)
            splits[r['split']] += 1
            sources[r.get('valueTargetSource') or 'terminal-outcome'] += 1
        per_file[p] = {'rows': rows, 'uniquePositions': len(keys), 'duplicateRows': len(keys) and rows - other - len(keys),
                       'otherSchemaRows': other, 'splits': dict(splits), 'valueTargetSources': dict(sources)}
        keysets[p] = keys
    pairwise = {}
    for i, a in enumerate(paths):
        for b in paths[i + 1:]:
            inter = len(keysets[a] & keysets[b])
            if inter:
                pairwise[f'{a} & {b}'] = {'sharedPositions': inter,
                                          'pctOfSmaller': round(100 * inter / min(len(keysets[a]), len(keysets[b])), 1)}
    return {'generatedBy': 'dataset-audit.py', 'files': per_file, 'pairwiseOverlap': pairwise}


def positions(path: str) -> None:
    for k in sorted({_key(r) for r in _iter(path)}):
        sys.stdout.write(k + '\n')


def dedup(inp: str, outp: str) -> dict:
    seen, kept, dropped = set(), 0, 0
    with open(outp, 'w') as fo:
        for r in _iter(inp):
            k = _key(r)
            if k in seen:
                dropped += 1
                continue
            seen.add(k); kept += 1
            fo.write(json.dumps(r) + '\n')
    return {'kept': kept, 'dropped': dropped, 'output': outp}


def qualification(inp: str, outp: str) -> dict:
    kept, families = 0, set()
    with open(outp, 'w') as fo:
        for r in _iter(inp):
            if r['split'] == 'qualification':
                kept += 1; families.add(r['openingFamily'])
                fo.write(json.dumps(r) + '\n')
    return {'kept': kept, 'qualificationFamilies': len(families), 'output': outp}


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__); return 2
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == 'audit':
        print(json.dumps(audit(rest), indent=2))
    elif cmd == 'positions':
        positions(rest[0])
    elif cmd == 'dedup':
        print(json.dumps(dedup(rest[0], rest[1]), indent=2))
    elif cmd == 'qualification':
        print(json.dumps(qualification(rest[0], rest[1]), indent=2))
    else:
        print(__doc__); return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
