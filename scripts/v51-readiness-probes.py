#!/usr/bin/env python3
"""Executable independent negative contracts; no training, networking or production writes.

Exit 2 means a reproduced source defect or an inconclusive probe, NOT a passing release gate.
Only temporary run directories are modified. Main owns fixes in the exercised implementation.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
OPERATOR = ROOT / 'training/bot/champion_cycle.py'
spec = importlib.util.spec_from_file_location('champion_cycle_audit', OPERATOR)
CC = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CC)


def gate_case(a, b, score, interval):
    value = {'matchups': [{'engineA': a, 'engineB': b,
                           'summary': {'pointScore': score, 'pairBootstrap95': interval}}]}
    try:
        result = CC.evaluate_gate(value)
    except (ValueError, TypeError, KeyError):
        return {'defectPresent': False, 'observed': 'malformed evidence refused'}
    return {'defectPresent': result.get('promote') is True, 'observed': result}


def leased_mutation():
    with tempfile.TemporaryDirectory(prefix='v51-readiness-') as temp:
        owner = CC.Operator('owned', Path(temp), {})
        owner._acquire_lease()
        before = owner.state_path.read_bytes()
        try:
            try:
                CC.Operator('owned', Path(temp), {'games': 48})
            except (SystemExit, ValueError, RuntimeError):
                pass
            after = owner.state_path.read_bytes()
            return {'defectPresent': before != after, 'observed': 'active leased run.json changed' if before != after else 'active state preserved'}
        finally:
            owner._release_lease()


def tampered_artifact():
    with tempfile.TemporaryDirectory(prefix='v51-readiness-') as temp:
        op = CC.Operator('integrity', Path(temp), {})
        output = Path(temp) / 'frozen.txt'
        output.write_text('original')
        original = CC.sha256_file(output)
        op._mark('GENERATING', 'complete', artifacts={output.name: {'path': output.name, 'sha256': original, 'bytes': 8}})
        output.write_text('tampered')
        try:
            op._run_stage('GENERATING', [sys.executable, '-c', 'raise SystemExit(9)'], [output])
        except (SystemExit, ValueError, RuntimeError):
            return {'defectPresent': False, 'observed': 'tampered output not silently reused'}
        return {'defectPresent': CC.sha256_file(output) != original,
                'observed': 'completed stage returned normally despite mismatched artifact hash'}


def exclusive_lease():
    with tempfile.TemporaryDirectory(prefix='v51-readiness-') as temp:
        operators = [CC.Operator('same-run', Path(temp), {}) for _ in range(2)]
        barrier = threading.Barrier(2, timeout=3)
        for op in operators:
            read_holder = op._lease_holder
            def observed_read(read_holder=read_holder):
                result = read_holder()
                barrier.wait()
                return result
            op._lease_holder = observed_read
        def acquire(op):
            try:
                op._acquire_lease()
                return 'ACQUIRED'
            except (SystemExit, FileExistsError):
                return 'REFUSED'
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(acquire, operators))
        return {'defectPresent': outcomes.count('ACQUIRED') > 1, 'observed': outcomes}


def neural_feedback():
    code = """const D=require('./training/bot/generate.cjs');
try { D.game({seed:1,simulations:1,neuralEngine:{version:'probe',choose(){throw Error('PROBE_STOP_AFTER_FEEDBACK_ACCEPTED')}}}); }
catch(e) { console.log(JSON.stringify({name:e.name,message:e.message})); }
"""
    result = subprocess.run(['node', '-e', code], cwd=ROOT, text=True, capture_output=True, timeout=10)
    if result.returncode: raise RuntimeError('node probe failed: ' + result.stderr[-500:])
    observed = json.loads(result.stdout)
    return {'defectPresent': observed['name'] == 'TypeError' and 'move' in observed['message'], 'observed': observed}


def run_probes():
    checks = [
        ('WEB-AI-01a', 'research gate must reject unrelated opponents', lambda: gate_case('random','beginner',0.9,[0.8,0.99])),
        ('WEB-AI-01b', 'research gate must enforce its declared 70 percent point-score target', lambda: gate_case('policyValuePUCT','improvedExpert',0.69,[0.66,0.8])),
        ('WEB-AI-01c', 'research gate must reject reversed confidence intervals', lambda: gate_case('policyValuePUCT','improvedExpert',0.95,[0.9,0.1])),
        ('WEB-AI-02a', 'constructor must not mutate another active lease', leased_mutation),
        ('WEB-AI-02b', 'lease acquisition must be atomic', exclusive_lease),
        ('WEB-AI-03', 'resume must verify frozen output hashes', tampered_artifact),
        ('WEB-AI-04', 'neural feedback must not dereference a null analysis', neural_feedback),
    ]
    rows = []
    for identity, contract, check in checks:
        try:
            row = {'id': identity, 'contract': contract, **check()}
            row['status'] = 'DEFECT_REPRODUCED' if row['defectPresent'] else 'NEGATIVE_CONTRACT_PASSED'
        except Exception as exc:
            row = {'id': identity, 'contract': contract, 'status': 'INCONCLUSIVE', 'error': f'{type(exc).__name__}: {exc}'}
        rows.append(row)
    paths = ['training/bot/champion_cycle.py', 'training/bot/generate.cjs']
    return {'schemaVersion': 1, 'sourceHashes': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths},
            'environment': {'python': sys.version.split()[0], 'platform': sys.platform},
            'scope': 'Temporary-state probes only; no training, SSH, provider, device or production operation',
            'releaseAccepted': False, 'results': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = run_probes()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 2 if any(r['status'] != 'NEGATIVE_CONTRACT_PASSED' for r in report['results']) else 0


if __name__ == '__main__':
    raise SystemExit(main())
