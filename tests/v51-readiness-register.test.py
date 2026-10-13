import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('register_repair', ROOT/'scripts/v51-readiness-register.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


def fixture():
    header = '| ' + ' | '.join(['ID'] + ['field']*10) + ' |\n'
    header += '| ' + ' | '.join(['---']*11) + ' |\n'
    return header + ''.join('| ' + ' | '.join([identity] + ['retained']*10) + ' |\n' for identity in R.EXPECTED)


class RegisterTests(unittest.TestCase):
    def test_correct_register_is_unchanged(self):
        self.assertEqual(R.repair(fixture()), fixture())

    def test_missing_and_duplicate_id_detection(self):
        text = fixture().replace('| R26 |', '| R25 |').replace('| R28 |', '| R24 |')
        result = R.inspect(text)
        self.assertEqual(result['missing'], ['R26', 'R28'])
        self.assertEqual(result['duplicates'], {'R24':2, 'R25':2})

    def test_recovered_contracts_and_entire_notes_preserved(self):
        text = fixture().replace('| R26 |', '| R25 |').replace('| R28 |', '| R24 |')
        repaired = R.repair(text)
        self.assertIn(R.RECOVERED['R26'], repaired)
        self.assertIn(R.RECOVERED['R28'], repaired)
        self.assertIn('    | R25 | retained', repaired)
        self.assertFalse(any(R.inspect(repaired).values()))
        self.assertEqual(R.repair(repaired), repaired)

    def test_unfamiliar_damage_refused(self):
        with self.assertRaisesRegex(ValueError, 'UNRECOGNIZED'):
            R.repair(fixture().replace('| R12 |', '| R13 |'))
        with self.assertRaisesRegex(ValueError, '34_OWNER'):
            R.repair(fixture().split('| R34 |')[0])

    def test_overflow_notes_not_lost(self):
        text = fixture().replace('| R03 |' + ' retained |'*10,
                                 '| R03 |' + ' retained |'*10 + ' evidence one | evidence two |')
        repaired = R.repair(text)
        self.assertIn('evidence one', repaired)
        self.assertIn('evidence two', repaired)
        self.assertFalse(R.inspect(repaired)['malformedRows'])

    def test_append_only_new_owner_packages_preserve_original_contracts(self):
        original = fixture()
        additional = ''.join('| ' + ' | '.join([f'R{i:02d}'] + ['retained'] * 10) + ' |\n'
                             for i in range(35, 39))
        text = original + additional
        self.assertEqual(R.repair(text), text)
        self.assertFalse(any(R.inspect(text).values()))
        self.assertTrue(R.repair(text).endswith(additional))
        self.assertEqual(original, R.repair(text)[:len(original)])

    def test_appended_owner_gaps_and_duplicates_are_rejected(self):
        valid = fixture() + '| R35 |' + ' retained |' * 10 + '\n'
        duplicate = valid + '| R35 |' + ' retained |' * 10 + '\n'
        missing = fixture() + '| R36 |' + ' retained |' * 10 + '\n'
        self.assertIn('R36', R.inspect(duplicate)['missing'])
        self.assertEqual(R.inspect(duplicate)['duplicates'], {'R35': 2})
        self.assertIn('R35', R.inspect(missing)['missing'])
        with self.assertRaisesRegex(ValueError, 'UNRECOGNIZED_ADDITIONAL'):
            R.repair(duplicate)
        with self.assertRaisesRegex(ValueError, 'UNRECOGNIZED_ADDITIONAL'):
            R.repair(missing)

    def test_real_register_can_be_repaired_without_ledger_loss(self):
        text = (ROOT/R.RELATIVE).read_text()
        fixed = R.repair(text)
        self.assertFalse(any(R.inspect(fixed).values()))
        marker = '## Original 25 phases'
        if marker in text:
            self.assertEqual(text.split(marker,1)[1], fixed.split(marker,1)[1])
        self.assertEqual(R.repair(fixed), fixed)
        self.assertEqual((ROOT/R.RELATIVE).read_text(), text)


if __name__ == '__main__':
    unittest.main()
