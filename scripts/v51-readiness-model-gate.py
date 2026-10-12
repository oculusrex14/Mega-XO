#!/usr/bin/env python3
"""Fail-closed research-evidence review helper. NEVER approves or publishes a model.

Main may integrate this after emitting full pair records plus source/model bindings.
Current ten-game-sample league reports remain diagnostic, not qualification receipts.
Defaults preserve the documented >=70% point target, >=65% lower CI gate and >=200
families. A stricter >=70% lower CI is a separate engineering-policy decision.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import re


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def uint_rng(seed):
    """Exact uint32 Mulberry32 used by src/bot/contracts.js (bootstrap seed 731)."""
    n, mask = seed, 0xffffffff
    while True:
        n = (n + 0x6d2b79f5) & mask
        t = ((n ^ (n >> 15)) * (n | 1)) & mask
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & mask)) & mask
        yield ((t ^ (t >> 14)) & mask) / 4294967296


def bootstrap(pairs):
    rng, scores = uint_rng(731), []
    for _ in range(2000):
        scores.append(sum(pairs[int(next(rng) * len(pairs))] for _ in pairs) / len(pairs))
    scores.sort()
    return [scores[50], scores[1950]]


def evaluate(report, *, expected_model, expected_source, min_families=200, min_score=0.70, min_lower=0.65):
    reasons = []
    policy = {'minFamilies': min_families, 'minPointScore': min_score, 'minLower95': min_lower}
    def result(**extra):
        return {'researchEvidenceQualified': not reasons, 'productionApproved': False,
                'policy': policy, 'reasons': reasons,
                'remainingGates': ['preregistration/untouched-confirmation review', 'canonical full-trace and inference diagnostics',
                                   'physical-device total runtime/latency/memory', 'quantization non-inferiority', 'owner release approval'], **extra}
    if not (isinstance(expected_model, str) and re.fullmatch('[0-9a-f]{64}', expected_model)
            and isinstance(expected_source, str) and re.fullmatch('[0-9a-f]{40}', expected_source)):
        reasons.append('EXPECTED_BINDING_INVALID'); return result()
    if type(min_families) is not int or min_families < 2 or not all(finite(v) and 0 <= v <= 1 for v in (min_score, min_lower)):
        reasons.append('POLICY_INVALID'); return result()
    if not isinstance(report, dict):
        reasons.append('REPORT_INVALID'); return result()
    if report.get('status') != 'COMPLETED': reasons.append('REPORT_NOT_COMPLETED')
    if report.get('modelSha256') != expected_model: reasons.append('MODEL_BINDING_MISMATCH')
    if report.get('sourceSha') != expected_source: reasons.append('SOURCE_BINDING_MISMATCH')
    matchups = report.get('matchups')
    if not isinstance(matchups, list):
        reasons.append('MATCHUPS_MISSING'); return result()
    matches = [m for m in matchups if isinstance(m, dict) and m.get('engineA') == 'policyValuePUCT' and m.get('engineB') == 'improvedExpert']
    if len(matches) != 1:
        reasons.append('EXACT_REFERENCE_MATCHUP_REQUIRED'); return result()
    match = matches[0]
    summary, games = match.get('summary'), match.get('games')
    if not isinstance(summary, dict):
        reasons.append('SUMMARY_MISSING'); return result()
    for key in ('games', 'pairs', 'wins', 'draws', 'losses'):
        if type(summary.get(key)) is not int or summary[key] < 0:
            reasons.append('COUNT_INVALID:' + key)
    if any(r.startswith('COUNT_INVALID:') for r in reasons): return result()
    count = summary['games']
    if count != 2 * summary['pairs'] or count < 2 or sum(summary[k] for k in ('wins', 'draws', 'losses')) != count:
        reasons.append('COUNT_MISMATCH'); return result()
    score = (summary['wins'] + 0.5 * summary['draws']) / count
    if not finite(summary.get('pointScore')) or abs(summary['pointScore'] - score) > 1e-12:
        reasons.append('SCORE_MISMATCH')
    interval = summary.get('pairBootstrap95')
    if not (isinstance(interval, list) and len(interval) == 2 and all(finite(v) for v in interval) and 0 <= interval[0] <= interval[1] <= 1):
        reasons.append('INTERVAL_INVALID')
    if not isinstance(games, list) or len(games) != count:
        reasons.append('FULL_PAIR_RECORDS_REQUIRED'); return result(pointScore=score)
    families = defaultdict(list)
    for game in games:
        if not isinstance(game, dict): reasons.append('GAME_RECORD_INVALID'); continue
        family = game.get('openingFamily')
        if not isinstance(family, str) or not family: reasons.append('OPENING_FAMILY_MISSING'); continue
        if (type(game.get('swap')) is not bool or game.get('first') not in ('X', 'O') or
            game.get('a') != 'policyValuePUCT' or game.get('b') != 'improvedExpert' or
            not finite(game.get('point')) or game['point'] not in (0, 0.5, 1)):
            reasons.append('GAME_RECORD_INVALID'); continue
        a_side = 'O' if game['swap'] else 'X'
        if game.get('winner') not in ('X', 'O', 'DRAW') or game['point'] != (0.5 if game['winner'] == 'DRAW' else int(game['winner'] == a_side)):
            reasons.append('OUTCOME_MISMATCH')
        families[family].append(game)
    pairs, raw_points = [], []
    for rows in families.values():
        if len(rows) != 2 or {r['swap'] for r in rows} != {False, True} or len({r['first'] for r in rows}) != 1:
            reasons.append('PAIR_NOT_REVERSED_OR_DUPLICATED'); continue
        pairs.append(sum(r['point'] for r in rows) / 2)
        raw_points.extend(r['point'] for r in rows)
    if len(pairs) != summary['pairs'] or len(pairs) < min_families:
        reasons.append('INSUFFICIENT_INDEPENDENT_FAMILIES')
    if [raw_points.count(v) for v in (1, .5, 0)] != [summary[k] for k in ('wins', 'draws', 'losses')]:
        reasons.append('RAW_RESULT_MISMATCH')
    if reasons: return result(pointScore=score)
    measured_interval = bootstrap(pairs)
    if any(abs(a-b) > 1e-12 for a,b in zip(interval, measured_interval)):
        reasons.append('BOOTSTRAP_MISMATCH')
    if score < min_score: reasons.append('POINT_TARGET_NOT_MET')
    if measured_interval[0] < min_lower: reasons.append('CONFIDENCE_TARGET_NOT_MET')
    return result(pointScore=score, recomputedPairBootstrap95=measured_interval, independentFamilies=len(pairs))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--model-sha256', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        data = json.loads(args.report.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('non-finite JSON: ' + value)))
    except (OSError, ValueError) as exc:
        parser.exit(2, f'MODEL_EVIDENCE_REFUSED: {exc}\n')
    result = evaluate(data, expected_model=args.model_sha256, expected_source=args.source_sha)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    return 0 if result['researchEvidenceQualified'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
