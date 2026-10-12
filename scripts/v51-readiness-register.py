#!/usr/bin/env python3
"""Audit R01-R34 identity; prepare a lossless, hash-bound repair for Main to review.

Does NOT write the shared owner register. Run --output-dir .artifacts/register-repair,
review proposed.md and repair.patch, then integration owner may git apply --check.
The two recovered contracts come from commit 99353a6bcf65bcd9039114bdeece4530af1fe3fa.
"""
from __future__ import annotations
import argparse
from collections import Counter
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RELATIVE = 'docs/v5.1/release/OPEN-WORK-AND-OWNERS.md'
spec = importlib.util.spec_from_file_location('readiness_inventory', ROOT / 'scripts/v51-readiness-audit.py')
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
EXPECTED = [f'R{i:02d}' for i in range(1, 35)]
RECOVERED = {
 'R26': '| R26 | P1 | Main agent | ChatGPT WebUI | CONDITIONAL | Distill only a useful teacher and prove student improvement | B04.09 depends on real teacher value; no distillation result exists. Distilling a weak or biased teacher may make the compact bot worse. | Generate calibrated soft legal-policy targets on training families only; mix with stronger search targets; compare otherwise identical students with/without teacher and selected value head. | Paired controlled student ablation demonstrates worthwhile gain at final phone budget or records justified rejection. | R25 | B04.09,CL22-CL23 |',
 'R28': '| R28 | P0 | Main agent | Codex app | BLOCKED_MODEL | Approve and distribute a genuinely strong optional model | No candidate reaches the70% score vs improved Expert gate; approved catalog correctly remains empty. | Complete independent frozen league, all tactics, device/runtime validation and owner release approval; publish immutable version/hash manifest and trusted assets, keeping per-match pin and rollback. | Approved model meets strength+device gates; consent/progress/retry/removal/offline recovery work; unapproved models cannot be selected. | R20,R24 or R26,R27 | B05.06,B06.03,B06.05,B06.08,B07.10 |',
}


def owner_rows(text):
    return [(i, A.table_cells(line)) for i, line in enumerate(text.splitlines())
            if re.match(r'^\| R\d{2} \|', line)]


def inspect(text):
    rows = owner_rows(text)
    counts = Counter(c[0] for _, c in rows)
    return {'missing': sorted(set(EXPECTED)-set(counts)),
            'unknown': sorted(set(counts)-set(EXPECTED)),
            'duplicates': {k: v for k, v in counts.items() if v > 1},
            'malformedRows': [{'id': c[0], 'line': i+1, 'columns': len(c)} for i,c in rows if len(c)!=11]}


def repair(text):
    """Only repair the observed corruption pattern; unfamiliar damage fails closed."""
    rows = owner_rows(text)
    if len(rows) != 34:
        raise ValueError('EXPECTED_34_OWNER_ROWS')
    actual = [cells[0] for _, cells in rows]
    known = EXPECTED.copy(); known[25] = 'R25'; known[27] = 'R24'
    if actual not in (EXPECTED, known):
        raise ValueError('UNRECOGNIZED_OWNER_ID_PATTERN')
    if actual == EXPECTED and not inspect(text)['malformedRows']:
        return text
    lines = text.splitlines(keepends=True)
    preserved = []
    for expected, (i, original) in zip(EXPECTED, rows):
        if len(original) < 11:
            raise ValueError('MISSING_OWNER_CELLS:' + expected)
        cells = list(original)
        if cells[0] != expected:
            preserved.append(lines[i].rstrip('\r\n'))
            cells = A.table_cells(RECOVERED[expected])
        if len(cells) > 11:
            extra = ' <br> '.join(cells[11:])
            cells[6] += ' <br> Latest source notes (claims, not new acceptance): ' + extra
            cells = cells[:11]
        if expected == 'R02':
            ids = 'A02,P17,B07.09'
            if cells[10].startswith(ids) and cells[10] != ids:
                cells[6] += ' <br> Preserved repair note: ' + cells[10][len(ids):].strip()
                cells[10] = ids
        lines[i] = '| ' + ' | '.join(cells) + ' |\n'
    if preserved:
        appendix = ('\n### Preserved duplicate-row source notes\n\n'
                    'R26 and R28 contracts restored from `99353a6bcf65bcd9039114bdeece4530af1fe3fa`. '
                    'The following duplicated R25/R24 rows are retained verbatim as historical source notes, '
                    'not additional task identities or acceptance. See [independent audit](WEBUI-AUDIT-20261012.md).\n\n')
        appendix += '\n\n'.join('    ' + line for line in preserved) + '\n\n'
        lines.insert(rows[-1][0] + 1, appendix)
    proposed = ''.join(lines)
    finding = inspect(proposed)
    if any(finding.values()) or A.table_errors(proposed):
        raise ValueError('REPAIR_DID_NOT_SATISFY_SCHEMA')
    return proposed


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source', type=Path, default=ROOT / RELATIVE)
    ap.add_argument('--output-dir', type=Path, required=True)
    args = ap.parse_args()
    targets = [args.output_dir / name for name in ('proposed.md','repair.patch','manifest.json')]
    if args.source.resolve() in {p.resolve() for p in targets}:
        ap.error('output must not overwrite source')
    original = args.source.read_bytes()
    text = original.decode('utf-8')
    finding = inspect(text)
    try:
        proposed = repair(text)
    except ValueError as exc:
        ap.exit(2, f'REGISTER_REPAIR_REFUSED: {exc}\n')
    patch = ''.join(difflib.unified_diff(text.splitlines(True), proposed.splitlines(True),
                                        fromfile='a/'+RELATIVE, tofile='b/'+RELATIVE))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    targets[0].write_text(proposed)
    targets[1].write_text(patch)
    report = {'sourcePath': str(args.source), 'sourceSha256': hashlib.sha256(original).hexdigest(),
              'proposedSha256': hashlib.sha256(proposed.encode()).hexdigest(),
              'recoveredContractCommit': '99353a6bcf65bcd9039114bdeece4530af1fe3fa',
              'findings': finding, 'sharedSourceModified': False,
              'instruction': 'Main: verify source hash, review diff, git apply --check then serialize integration. No task acceptance is changed.'}
    targets[2].write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
