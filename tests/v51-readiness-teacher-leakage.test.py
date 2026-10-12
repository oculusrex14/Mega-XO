import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('unsloth_teacher', ROOT / 'training' / 'bot' / 'unsloth_teacher.py')
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)


def row(rid, split, family, best='3,4', win='true'):
    return {'id': rid, 'split': split, 'family': family,
            'state': 'board', 'gold': {'winNow': {'label': win}, 'opponentThreat': {'label': 'false'},
                                       'bestMove': {'label': best}},
            'questions': {'winNow': {'instructions': 'i'}, 'opponentThreat': {'instructions': 'i'},
                          'bestMove': {'instructions': 'i', 'criteria': 'c'}}}


class TeacherLeakageTests(unittest.TestCase):
    def test_holdout_is_confirmation_never_calibration(self):
        rows = [row('a', 'train', 'f1'), row('b', 'validation', 'f2'),
                row('c', 'holdout', 'f3'), row('d', 'holdout', 'f4')]
        splits = T.split_evaluation(rows)
        self.assertEqual([r['id'] for r in splits['train']], ['a'])
        self.assertEqual([r['id'] for r in splits['calibration']], ['b'],
                         'calibration must be validation ONLY; holdout is not pooled in')
        self.assertEqual(sorted(r['id'] for r in splits['confirmation']), ['c', 'd'],
                         'holdout families are the untouched confirmation set')

    def test_missing_or_invalid_answer_counts_as_failure(self):
        items = [row('x', 'holdout', 'fx', best='3,4'), row('y', 'holdout', 'fy', best='5,5')]
        answers = {'x': {'bestMove': {'answer': '3,4'}}, 'y': {}}  # y returns nothing -> failure
        scored = T.score_answers(items, answers)
        self.assertEqual(scored['perQuestion']['bestMove']['correct'], 1)
        self.assertEqual(scored['perQuestion']['bestMove']['total'], 2,
                         'a missing answer is a denominator entry, not silently dropped')
        self.assertEqual(scored['perQuestion']['bestMove']['accuracy'], 0.5)
        self.assertEqual(scored['perQuestion']['winNow']['total'], 2,
                         'every scored question keeps its full denominator')

    def test_family_level_results_present(self):
        items = [row('x', 'holdout', 'fx'), row('y', 'holdout', 'fy')]
        scored = T.score_answers(items, {'x': {'winNow': {'answer': 'true'}}, 'y': {'winNow': {'answer': 'true'}}})
        self.assertIn('fx', scored['perQuestion']['winNow']['families'])
        self.assertEqual(len(scored['families']), 2)


if __name__ == '__main__':
    unittest.main()
