import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('model_gate', ROOT / 'scripts/v51-readiness-model-gate.py')
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)
MODEL, SOURCE = 'a'*64, 'b'*40


def valid():
    games = []
    for i in range(4):
        for swap in (False, True):
            games.append({'openingFamily': f'family-{i}', 'swap': swap, 'first': 'X',
                          'a': 'policyValuePUCT', 'b': 'improvedExpert', 'point': 1,
                          'winner': 'O' if swap else 'X'})
    return {'status':'COMPLETED', 'modelSha256':MODEL, 'sourceSha':SOURCE,
            'matchups':[{'engineA':'policyValuePUCT', 'engineB':'improvedExpert', 'games':games,
                         'summary':{'games':8,'pairs':4,'wins':8,'draws':0,'losses':0,'pointScore':1,'pairBootstrap95':[1,1]}}]}


def check(report, **kwargs):
    return G.evaluate(report, expected_model=MODEL, expected_source=SOURCE, min_families=4, **kwargs)


class GateTests(unittest.TestCase):
    def test_valid_research_evidence_does_not_approve_production(self):
        result = check(valid())
        self.assertTrue(result['researchEvidenceQualified'], result)
        self.assertFalse(result['productionApproved'])
        self.assertTrue(result['remainingGates'])

    def test_wrong_or_ambiguous_opponent(self):
        for field,value in [('engineA','not-policyValuePUCT'), ('engineB','beginner')]:
            report = valid(); report['matchups'][0][field] = value
            self.assertIn('EXACT_REFERENCE_MATCHUP_REQUIRED',check(report)['reasons'])
        report = valid(); report['matchups'] *= 2
        self.assertFalse(check(report)['researchEvidenceQualified'])

    def test_numbers_fail_closed(self):
        for field,value in [('pointScore',float('nan')),('pointScore',True),('wins',True),
                            ('pairBootstrap95',[.9,.1]),('pairBootstrap95',[float('inf'),1]),
                            ('pairBootstrap95',[True,1]),('games',7),('wins',7),('pointScore',.99)]:
            with self.subTest(field=field,value=value):
                report = valid(); report['matchups'][0]['summary'][field] = value
                self.assertFalse(check(report)['researchEvidenceQualified'])

    def test_bound_to_complete_exact_candidate_and_source(self):
        for field,value in [('status','STARTED'),('modelSha256','c'*64),('sourceSha','d'*40)]:
            report = valid(); report[field] = value
            self.assertFalse(check(report)['researchEvidenceQualified'])

    def test_truncated_duplicate_or_unpaired_games(self):
        report = valid(); report['matchups'][0]['games'].pop()
        self.assertIn('FULL_PAIR_RECORDS_REQUIRED',check(report)['reasons'])
        report = valid(); report['matchups'][0]['games'][1]['swap'] = False
        self.assertFalse(check(report)['researchEvidenceQualified'])
        report = valid(); report['matchups'][0]['games'][0]['openingFamily'] = 'family-1'
        self.assertFalse(check(report)['researchEvidenceQualified'])
        report = valid(); del report['matchups'][0]['games'][0]['openingFamily']
        self.assertFalse(check(report)['researchEvidenceQualified'])

    def test_smoke_is_not_qualification(self):
        result = G.evaluate(valid(),expected_model=MODEL,expected_source=SOURCE)
        self.assertIn('INSUFFICIENT_INDEPENDENT_FAMILIES',result['reasons'])

    def test_summary_and_bootstrap_recomputed_from_raw_pairs(self):
        report = valid(); report['matchups'][0]['games'][0]['point'] = 0
        self.assertIn('OUTCOME_MISMATCH',check(report)['reasons'])
        report = valid(); report['matchups'][0]['summary']['pairBootstrap95'] = [.7,1]
        self.assertIn('BOOTSTRAP_MISMATCH',check(report)['reasons'])

    def test_policy_cannot_use_nan_or_bool(self):
        self.assertIn('POLICY_INVALID',check(valid(),min_score=float('nan'))['reasons'])
        self.assertIn('POLICY_INVALID',check(valid(),min_lower=True)['reasons'])

    def test_below_point_target_even_with_acceptable_lower_bound(self):
        report = valid(); match = report['matchups'][0]
        # Four paired draws: adequate lower bound under this explicit test policy,
        # but still below the independently enforced 70 percent point target.
        for game in match['games']: game.update(point=.5,winner='DRAW')
        match['summary'].update(wins=0,draws=8,pointScore=.5,pairBootstrap95=[.5,.5])
        result = check(report,min_lower=.4)
        self.assertEqual(result['reasons'],['POINT_TARGET_NOT_MET'])

    def test_bootstrap_matches_repository_node_implementation(self):
        code = "const L=require('./training/bot/neural_league.cjs'); console.log(JSON.stringify(L.summarize([0,1,.5,1,0,0,1,1].map(point=>({point}))).pairBootstrap95));"
        result = subprocess.run(['node','-e',code],cwd=ROOT,capture_output=True,text=True,timeout=10,check=True)
        self.assertEqual(G.bootstrap([.5,.75,0,1]),json.loads(result.stdout))


if __name__ == '__main__':
    unittest.main()
