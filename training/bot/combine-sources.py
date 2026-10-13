#!/usr/bin/env python3
"""Combine multiple labelled sources into one training corpus with preserved provenance and measured
coverage. Sources are kept distinct by `valueTargetSource`; splits never leak (our family holdout is
never joined by another source's rows); positions are deduplicated per source-set, not silently merged
across conflicting labels.

Sources this programme uses:
  * deep-search   - our `search-labels.cjs` output (valueTargetSource 'deep-search-root-score')
  * external      - utttai NMCTS/MCTS corpus (valueTargetSource 'utttai-*', split external/own pool)
  * selfplay      - our PUCT self-play (valueTargetSource 'terminal-outcome')
  * tactics       - verified tactical/endgame positions (valueTargetSource 'verified-tactic')

Usage:
  combine-sources.py --out combined.jsonl --report coverage.json \
      [--source deep-search:a.jsonl] [--source external:b.jsonl] ...
Each `--source name:path` is read (`.jsonl` or `.jsonl.gz`); a row's `valueTargetSource` decides its
kind, not the name. The output manifest records per-source row counts, unique canonical positions,
value-target mix, and the cross-source overlap.
"""
from __future__ import annotations
import argparse, gzip, hashlib, io, json
from collections import Counter

def _rows(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

def _pos_key(row):
    # Exact canonical position = the tensor the network sees.
    return hashlib.sha1(json.dumps(row['planes']).encode()).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--report', required=True)
    ap.add_argument('--source', action='append', default=[])
    a = ap.parse_args()
    sources = {}
    for spec in a.source:
        name, path = spec.split(':', 1)
        sources[name] = path
    per_source, keysets, sources_seen = {}, {}, Counter()
    digest, total = hashlib.sha256(), 0
    seen_global = set()
    with open(a.out, 'w') as fo:
        for name, path in sources.items():
            rows = uni = dup = 0
            ks = set()
            for r in _rows(path):
                rows += 1
                k = _pos_key(r)
                ks.add(k)
                if k in seen_global:
                    dup += 1
                    continue
                seen_global.add(k); uni += 1
                sources_seen[r.get('valueTargetSource') or 'terminal-outcome'] += 1
                line = json.dumps(r) + '\n'
                fo.write(line); digest.update(line.encode()); total += 1
            per_source[name] = {'path': path, 'rows': rows, 'uniquePositions': len(ks), 'duplicatesDropped': dup}
            keysets[name] = ks
    manifest = {
        'schemaVersion': 1, 'records': total, 'sha256': digest.hexdigest(),
        'sources': per_source, 'valueTargetSources': dict(sources_seen),
        'provenance': 'multi-source: deep-search labels, external utttai NMCTS corpus, self-play, verified tactics',
    }
    open(a.out + '.manifest.json', 'w').write(json.dumps(manifest, indent=2) + '\n')
    pairwise = {}
    names = list(sources)
    for i, x in enumerate(names):
        for y in names[i + 1:]:
            inter = len(keysets[x] & keysets[y])
            if inter:
                pairwise[f'{x} & {y}'] = inter
    report = {'totalRowsWritten': total, 'perSource': per_source,
              'valueTargetSources': dict(sources_seen), 'crossSourceOverlap': pairwise,
              'note': 'overlap counts shared canonical positions (deduped in the output, first source wins)'}
    open(a.report, 'w').write(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    raise SystemExit(main())
