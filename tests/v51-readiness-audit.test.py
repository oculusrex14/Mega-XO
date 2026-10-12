"""R01 tooling tests, not game-release acceptance."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit', ROOT / 'scripts/v51-readiness-audit.py')
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)


class AuditTests(unittest.TestCase):
    def test_no_status_laundering(self):
        for status in ('COMPLETE', 'DONE', 'PASS', 'CHECKED', 'IMPLEMENTED', 'TESTED_LOCAL'):
            with self.subTest(status=status):
                r = A.view({'id': 'x'}, status, 'source')
                self.assertFalse(r['releaseAccepted'])
                self.assertTrue(all(v == 'NOT_INDEPENDENTLY_EVIDENCED' for v in r['validation'].values()))

    def test_explicit_blocked_and_deferred(self):
        self.assertEqual(A.view({}, 'BLOCKED', 's')['disposition'], 'BLOCKED')
        self.assertEqual(A.view({}, 'DEFERRED', 's')['disposition'], 'EXPLICITLY_DEFERRED')

    def test_inherited_bot_fields_replace_not_merge(self):
        ledger = {'defaults': {'ci': 'NOT_RUN', 'evidence': []}, 'checkpoints': {'C0': {'ci': 'claimed pass', 'evidence': ['old']}}}
        before = copy.deepcopy(ledger)
        row = A.resolve_bot(ledger, {'checkpoint': 'C0', 'status': 'PARTIAL', 'evidence': ['new']})
        self.assertEqual(row['ci'], 'claimed pass')
        self.assertEqual(row['evidence'], ['new'])
        self.assertEqual(before, ledger)

    def test_unknown_checkpoint_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'UNKNOWN_BOT_CHECKPOINT'):
            A.resolve_bot({}, {'checkpoint': 'invented'})

    def test_duplicate_task_ids_rejected(self):
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_ID'):
            A.index([{'id': 'A01'}, {'id': 'A01'}], 'cases')

    def test_table_code_and_escaped_pipes(self):
        self.assertEqual(A.table_cells(r'| a | `one|two` | three\|four |'), ['a', '`one|two`', 'three\\|four'])

    def test_table_overflow_preserved_as_defect(self):
        text = '| ID | State |\n| --- | --- |\n| R01 | PARTIAL | hidden note |'
        self.assertEqual(A.table_errors(text), [{'line': 3, 'kind': 'TABLE_WIDTH', 'expected': 2, 'actual': 3}])

    def test_checkbox_ids_do_not_shift_when_other_items_close(self):
        text = '# H\n- [ ] First\n- [ ] Second'
        rows = A.checkbox_rows(text)
        changed = A.checkbox_rows(text.replace('[ ] First', '[x] First'))
        self.assertEqual([r['id'] for r in rows], [r['id'] for r in changed])
        self.assertEqual(rows[1]['id'], A.checkbox_rows('# H\n- [ ] Second')[0]['id'])

    def test_explicit_checkbox_identity(self):
        self.assertEqual(A.checkbox_rows('- [ ] P21-G005: actual')[0]['id'], 'P21-G005')

    def test_real_inventory_complete_ids(self):
        r = A.inventory(ROOT)
        self.assertEqual(len(r['phases']), 25)
        self.assertEqual(len(r['platformTasks']), 117)
        self.assertEqual({c['id'] for c in r['acceptanceCases']}, {f'A{i:02d}' for i in range(1,41)})
        self.assertEqual(len(r['botTasks']), 82)
        self.assertFalse(r['releaseAccepted'])
        self.assertTrue(all(not c['releaseAccepted'] for c in r['acceptanceCases']))
        self.assertIn('AUTHORIZED_WEBSITE', next(p for p in r['phases'] if p['id']=='P21')['scope'])
        self.assertIn('superseded', r['acceptanceCases'][-1]['scopeOverride'])


if __name__ == '__main__':
    unittest.main()
